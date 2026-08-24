// @ts-check
/**
 * The avatar stage: a TalkingHead 3D avatar with text-driven lip-sync.
 *
 * How the mouth moves: the voice comes from server-side Piper TTS, which
 * returns WAV audio. Lip-sync is driven from the reply text itself using
 * TalkingHead's word→viseme engine. The viseme animation runs in parallel
 * with the audio playback, keeping the mouth in sync.
 *
 * Everything else — blinking, breathing, idle head sway, moods, gestures,
 * emojis — is TalkingHead's built-in animation system, steered from here and
 * by the model's avatar-control tools (see runTool).
 */

import { TalkingHead } from "@met4citizen/talkinghead";
// Registered statically instead of via TalkingHead's `lipsyncModules` option:
// that option would dynamically import `lipsync-en.mjs` at runtime, which the
// bundler can't follow (404 in the browser). Bundling it here keeps the
// text→viseme processor available for speakText.
import { LipsyncEn } from "@met4citizen/talkinghead/modules/lipsync-en.mjs";

export const AVATAR_MOODS = [
  "neutral",
  "happy",
  "angry",
  "sad",
  "fear",
  "disgust",
  "love",
  "sleep",
];

export const AVATAR_GESTURES = [
  "handup",
  "index",
  "ok",
  "thumbup",
  "thumbdown",
  "side",
  "shrug",
];

/** Emojis the choreography may sprinkle while she talks. */
const CHOREO_EMOJIS = ["😊", "😉", "🤔", "😮", "😌"];
/** Moods the choreography may drift through (kept subtle). */
const CHOREO_MOODS = ["neutral", "happy", "neutral"];

export class AvatarStage {
  /** @param {HTMLElement} container */
  constructor(container) {
    this._container = container;
    /** @type {TalkingHead | null} */
    this.head = null;
    /** @type {number | null} Choreography interval while speaking. */
    this._choreoTimer = null;
  }

  /**
   * Create the TalkingHead scene and load the avatar.
   * @param {{ avatarUrl?: string, body?: "F" | "M", onprogress?: (ev: ProgressEvent) => void }} [opt]
   */
  async init(opt = {}) {
    // Lighting all zeroed: the scene is lit by TalkingHead's built-in
    // RoomEnvironment IBL, which reads better on skin than the default lights
    // (same setup as met4citizen's own realtime speech-to-speech demo).
    this.head = new TalkingHead(this._container, {
      ttsEndpoint: "", // never used: the voice comes from speechSynthesis
      lipsyncModules: [], // processors are registered statically below
      lipsyncLang: "es",
      // Framing tuned by hand: close-up head-and-shoulders with ~7% headroom,
      // face centered (cameraX compensates the idle pose's slight lean). The
      // vertical FOV makes this framing hold across aspect ratios, so the same
      // values work for desktop and phones.
      cameraView: "upper",
      cameraDistance: -1.4,
      cameraY: -0.15,
      cameraX: -0.18,
      cameraRotateEnable: false,
      lightAmbientIntensity: 0,
      lightDirectIntensity: 0,
      lightSpotIntensity: 0,
      // modelPixelRatio is multiplied by devicePixelRatio internally — leave
      // it at 1 or retina displays get a 4x drawing buffer.
      avatarIdleEyeContact: 0.3,
      avatarSpeakingEyeContact: 0.7,
    });

    await this.head.showAvatar(
      {
        url: opt.avatarUrl ?? "/avatars/brunette.glb",
        body: opt.body ?? "F",
        avatarMood: "neutral",
      },
      opt.onprogress ?? null,
    );

    // Register the text→viseme processor directly, bypassing TalkingHead's
    // dynamic import (which the bundler can't follow).
    this.head.lipsync["en"] = new LipsyncEn();

    // TalkingHead's morph smoothing defaults are tuned for ~1s visemes; the
    // short text-driven visemes below would never visibly open the mouth. Give
    // viseme morphs a snappier response so the mouth actually moves.
    for (const [key, o] of Object.entries(this.head.mtAvatar)) {
      if (key.startsWith("viseme_")) {
        o.acc = 5 / 1000; // per ms²
        o.maxv = 30 / 1000; // per ms
      }
    }

    // Kick off the render loop; audio stays suspended until the first user
    // gesture (resume()), which we don't need for text-driven lip-sync.
    this.head.start();
  }

  /** The shared AudioContext (needed to re-arm audio from a user gesture). */
  get audioCtx() {
    return this.head?.audioCtx ?? null;
  }

  /** Resume the render/animation loop + audio from within a user gesture. */
  resume() {
    this.head?.start();
    if (this.head && this.head.audioCtx.state === "suspended") {
      this.head.audioCtx.resume().catch(() => {});
    }
  }

  /**
   * Speak a reply with perfectly synchronized lip-sync and audio.
   * The audio ArrayBuffer (from Piper TTS) and word timings are passed to
   * TalkingHead's speakAudio(), which plays the audio and drives the mouth
   * in lockstep — no more mouth-before-voice desync.
   * @param {string} text
   * @param {ArrayBuffer} audioBuffer  WAV bytes from Piper TTS
   */
  async speakWithAudio(text, audioBuffer) {
    const head = this.head;
    if (!head) return;
    head.stopSpeaking(); // clear any queued speech before starting the new utterance
    head.lookAtCamera(500);
    head.speakWithHands();
    this._startChoreography();

    // Decode WAV bytes → Web Audio AudioBuffer
    const audioCtx = head.audioCtx;
    let decoded;
    try {
      decoded = await audioCtx.decodeAudioData(audioBuffer);
    } catch (e) {
      console.warn("[avatar] decodeAudioData failed, falling back to text-only lip-sync", e);
      this._animateVisemes(text);
      return;
    }

    // Estimate word timings from text using the lipsync engine, then scale
    // them to match the actual audio duration so mouth and voice stay in sync.
    const words = text.split(/\s+/).filter(Boolean);
    const base = 120;
    const gap = 25;
    const wordDurations = [];
    for (const rawWord of words) {
      const word = head.lipsyncPreProcessText(rawWord, "en");
      const val = head.lipsyncWordsToVisemes(word, "en");
      const visCount = val && Array.isArray(val.visemes) ? val.visemes.length : 1;
      wordDurations.push(visCount * base + gap);
    }
    const textDuration = wordDurations.reduce((a, b) => a + b, 0) || 1;
    const audioDurationMs = decoded.duration * 1000;
    const scale = audioDurationMs / textDuration;

    // Build cumulative start times scaled to audio length
    const wtimes = [];
    const wdurations = [];
    let t = 0;
    for (let i = 0; i < words.length; i++) {
      const dur = Math.round((wordDurations[i] ?? base) * scale);
      wtimes.push(t);
      wdurations.push(dur);
      t += dur;
    }

    head.speakAudio({
      audio: decoded,
      words: words,
      wtimes,
      wdurations,
    }, { lipsyncLang: "en" });
  }

  /**
   * Speak a reply: text-driven lip-sync only (no audio).
   * Kept as fallback when audio decoding fails.
   * @param {string} text
   */
  speak(text) {
    const head = this.head;
    if (!head) return;
    head.stopSpeaking(); // clear any queued speech before starting the new utterance
    head.lookAtCamera(500);
    head.speakWithHands();
    this._startChoreography();
    this._animateVisemes(text);
  }

  /**
   * Drive the mouth from the reply text.
   *
   * TalkingHead's own `speakText(..., { avatarMute: true })` can't be used for
   * this: its "only animation" branch collapses every viseme's start/peak/end
   * timestamps into a single instant (the audio-less path is meant for
   * subtitles), so the mouth never visibly opens. Instead we use the same
   * word→viseme engine (`lipsyncPreProcessText` + `lipsyncWordsToVisemes`)
   * and push properly-timed [open → peak → close] envelopes straight into the
   * animation queue. `animClock` is TalkingHead's own animation clock, so the
   * entries blend with blinking/gestures as if they came from the library.
   * @param {string} text
   */
  _animateVisemes(text) {
    const head = this.head;
    if (!head || !head.lipsync?.en) return;
    const base = 120; // ms per relative viseme unit, tuned to ~speech pace
    const gap = 25; // ms of silence between words
    let t = 0;
    for (const rawWord of text.split(/\s+/)) {
      const word = head.lipsyncPreProcessText(rawWord, "en");
      const val = head.lipsyncWordsToVisemes(word, "en");
      if (val && Array.isArray(val.visemes) && val.visemes.length) {
        for (let j = 0; j < val.visemes.length; j++) {
          const viseme = val.visemes[j];
          const dur = (val.durations?.[j] ?? 1) * base;
          const peak = viseme === "PP" || viseme === "FF" ? 0.9 : 0.6;
          head.animQueue.push({
            template: { name: "viseme" },
            // [close → open → hold → close]: the peak is held for the middle
            // of the viseme so the mouth stays visibly open while she talks.
            ts: [
              head.animClock + t,
              head.animClock + t + dur * 0.3,
              head.animClock + t + dur * 0.7,
              head.animClock + t + dur,
            ],
            vs: { ["viseme_" + viseme]: [0, peak, peak, 0] },
          });
          t += dur;
        }
      }
      t += gap;
    }
    head.isSpeaking = true;
    // Safety net: if TTS is cut short, close the mouth
    // once the text-driven timeline has run out.
    const totalMs = t;
    window.setTimeout(() => this.stopSpeaking(), totalMs + 250);
  }

  /**
   * Continuous body language while speaking: every few seconds fire a
   * hand gesture, a facial emoji or a subtle mood shift so the avatar stays
   * expressive throughout the whole reply — not just the first moment.
   * Model-driven tools (set_mood etc.) blend on top of this.
   */
  _startChoreography() {
    this._stopChoreography();
    // First beat lands early in the reply, then keeps pulsing.
    window.setTimeout(() => this._choreoBeat(), 1400);
    this._choreoTimer = window.setInterval(() => this._choreoBeat(), 3200);
  }

  _stopChoreography() {
    if (this._choreoTimer !== null) {
      window.clearInterval(this._choreoTimer);
      this._choreoTimer = null;
    }
  }

  /** @param {Array<T>} arr @returns {T} @template T */
  static _pick(arr) {
    // Index is always in range by construction.
    return /** @type {T} */ (arr[Math.floor(Math.random() * arr.length)]);
  }

  _choreoBeat() {
    const head = this.head;
    if (!head || !head.isSpeaking) return;
    const roll = Math.random();
    if (roll < 0.5) {
      head.playGesture(AvatarStage._pick(AVATAR_GESTURES), 3);
    } else if (roll < 0.75) {
      head.speakEmoji(AvatarStage._pick(CHOREO_EMOJIS));
    } else {
      head.setMood(AvatarStage._pick(CHOREO_MOODS));
    }
  }

  /** Stop the mouth where it is (barge-in, TTS end). */
  stopSpeaking() {
    this._stopChoreography();
    // Full stop, not pause: also drops any still-queued lines so a cut-off
    // reply can't resurrect and talk over the next one.
    this.head?.stopSpeaking();
  }

  /**
   * Conversation-state choreography. Statuses come from the app layer.
   * @param {string} status
   */
  setConversationState(status) {
    const head = this.head;
    if (!head) return;
    switch (status) {
      case "listening":
        // The user is talking: give them the avatar's attention.
        this._stopChoreography();
        head.isSpeaking = false;
        head.lookAtCamera(800);
        break;
      case "speaking":
        head.isSpeaking = true;
        break;
      case "processing":
        this._stopChoreography();
        head.isSpeaking = false;
        break;
      case "idle":
      case "error":
        this._stopChoreography();
        head.isSpeaking = false;
        head.stopGesture(300);
        break;
      default:
        this._stopChoreography();
        head.isSpeaking = false;
    }
  }

  /**
   * Execute an avatar-control tool called by the model.
   * @param {string} name @param {Record<string, unknown>} args
   * @returns {string | null} Result text for the model, or null if `name`
   *   isn't an avatar tool.
   */
  runTool(name, args) {
    const head = this.head;
    if (!head) return null;
    if (name === "set_mood") {
      const mood = typeof args.mood === "string" ? args.mood : "";
      if (!AVATAR_MOODS.includes(mood)) return `Unknown mood: ${mood}`;
      head.setMood(mood);
      return `Mood set to ${mood}.`;
    }
    if (name === "make_hand_gesture") {
      const gesture = typeof args.gesture === "string" ? args.gesture : "";
      if (!AVATAR_GESTURES.includes(gesture)) return `Unknown gesture: ${gesture}`;
      head.playGesture(gesture, 3);
      return `Playing gesture ${gesture}.`;
    }
    if (name === "make_facial_expression") {
      const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
      if (!emoji) return "No emoji given.";
      head.speakEmoji(emoji);
      return `Expressing ${emoji}.`;
    }
    return null;
  }
}
