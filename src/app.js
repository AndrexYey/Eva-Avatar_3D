// @ts-check
/**
 * App wiring: the avatar stage + the speech-to-speech session.
 *
 * A session is one tap away: tap the button → mic → same-origin `/api/session`
 * handshake → WebSocket to the granted compute → talk. The avatar carries all
 * conversational state (listening, thinking, speaking) with its body; the
 * caption under it is a quiet machine-voice echo of the same state.
 */

import { S2sWsRealtimeClient } from "./s2s/s2s-ws-client.js";
import { AvatarStage, AVATAR_MOODS, AVATAR_GESTURES } from "./avatar.js";

const VOICES = [
  "Aiden",
  "Ryan",
  "Dylan",
  "Eric",
  "Ono_Anna",
  "Serena",
  "Sohee",
  "Uncle_Fu",
  "Vivian",
];
const DEFAULT_VOICE = "Aiden";

const DEFAULT_INSTRUCTIONS = [
  "You are a friendly voice assistant with a visible, human-like 3D avatar — the user",
  "sees you as a person on their screen. This is a spoken conversation: keep replies",
  "short, natural and warm, never list-like.",
  "You can control your avatar body with tools: set_mood changes your overall emotional",
  "state, make_hand_gesture plays a hand gesture, make_facial_expression makes a quick",
  "facial expression from a single face emoji. Use them naturally and sparingly to",
  "express yourself — smile when greeting, shrug when unsure, thumbs up when agreeing.",
  "Never mention the tools or that you are controlling an avatar.",
].join(" ");

const STORAGE_KEYS = {
  voice: "avatar.voice",
  instructions: "avatar.instructions",
  directUrl: "avatar.directUrl",
};

/** Function tools declared to the backend: the model plays the avatar. */
const TOOL_DEFS = [
  {
    type: "function",
    name: "set_mood",
    description: "Change your avatar's overall mood/emotional state.",
    parameters: {
      type: "object",
      properties: {
        mood: { type: "string", enum: AVATAR_MOODS, description: "Mood name." },
      },
      required: ["mood"],
    },
  },
  {
    type: "function",
    name: "make_hand_gesture",
    description: "Make a hand gesture with your avatar.",
    parameters: {
      type: "object",
      properties: {
        gesture: { type: "string", enum: AVATAR_GESTURES, description: "Gesture name." },
      },
      required: ["gesture"],
    },
  },
  {
    type: "function",
    name: "make_facial_expression",
    description: "Make a quick facial expression with your avatar, given as a single face emoji (e.g. 😊, 😮, 🤔).",
    parameters: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "A single face emoji." },
      },
      required: ["emoji"],
    },
  },
];

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const stageNode = $("#stage");
const mainBtn = /** @type {HTMLButtonElement} */ ($("#main-btn"));
const mainBtnLabel = $("#main-btn-label");
const muteBtn = /** @type {HTMLButtonElement} */ ($("#mute-btn"));
const caption = $("#caption");
const subtitles = $("#subtitles");
const loading = $("#loading");
const settingsBtn = /** @type {HTMLButtonElement} */ ($("#settings-btn"));
const settingsDialog = /** @type {HTMLDialogElement} */ ($("#settings"));
const inputVoice = /** @type {HTMLSelectElement} */ ($("#voice"));
const inputInstructions = /** @type {HTMLTextAreaElement} */ ($("#instructions"));
const inputDirectUrl = /** @type {HTMLInputElement} */ ($("#direct-url"));
const directUrlRow = $("#direct-url-row");

// ── State ────────────────────────────────────────────────────────────────
const stage = new AvatarStage(stageNode);
/** @type {S2sWsRealtimeClient | null} */
let client = null;
let muted = false;
let subtitleTimer = 0;
/** @type {{ lb: boolean, allowDirect: boolean }} */
let config = { lb: false, allowDirect: true };

function loadSettings() {
  return {
    voice: localStorage.getItem(STORAGE_KEYS.voice) || DEFAULT_VOICE,
    instructions: localStorage.getItem(STORAGE_KEYS.instructions) || "",
    directUrl: localStorage.getItem(STORAGE_KEYS.directUrl) || "",
  };
}
let settings = loadSettings();

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.voice, settings.voice);
  localStorage.setItem(STORAGE_KEYS.instructions, settings.instructions);
  localStorage.setItem(STORAGE_KEYS.directUrl, settings.directUrl);
}

/** Persona + whatever extra guidance the user typed in Settings. */
function effectiveInstructions() {
  const extra = settings.instructions.trim();
  return extra ? `${DEFAULT_INSTRUCTIONS}\n\nAdditional instructions from the user:\n${extra}` : DEFAULT_INSTRUCTIONS;
}

// ── Captions / subtitles ─────────────────────────────────────────────────
/** @param {string} text @param {""|"live"|"error"} [kind] */
function setCaption(text, kind = "") {
  caption.textContent = text;
  caption.className = kind;
}

/** @param {string} text */
function showSubtitles(text) {
  clearTimeout(subtitleTimer);
  subtitles.textContent = text;
  subtitles.classList.add("visible");
}

function fadeSubtitles(delayMs = 2600) {
  clearTimeout(subtitleTimer);
  subtitleTimer = window.setTimeout(() => subtitles.classList.remove("visible"), delayMs);
}

// ── Button ───────────────────────────────────────────────────────────────
/** @type {"start" | "join" | "stop" | "busy"} */
let mainAction = "start";

/** @param {"start" | "join" | "stop" | "busy"} action @param {string} label */
function setMainButton(action, label) {
  mainAction = action;
  mainBtnLabel.textContent = label;
  mainBtn.disabled = action === "busy";
  mainBtn.classList.toggle("live", action === "stop");
  muteBtn.hidden = action !== "stop";
}

// ── Status handling ──────────────────────────────────────────────────────
const CAPTIONS = {
  idle: "TAP TO TALK",
  "creating-session": "REQUESTING A SLOT…",
  queued: "WAITING IN LINE…",
  "your-turn": "YOUR TURN — TAP TO JOIN",
  connecting: "CONNECTING…",
  connected: "GO AHEAD, I'M LISTENING",
  "user-speaking": "LISTENING",
  processing: "THINKING…",
  "ai-speaking": "SPEAKING",
  closed: "TAP TO TALK",
  error: "SOMETHING BROKE — TAP TO RETRY",
};

/** @param {string} status */
function onStatus(status) {
  stage.setConversationState(status);
  setCaption(CAPTIONS[status] ?? status, status === "error" ? "error" : status === "idle" || status === "closed" ? "" : "live");

  switch (status) {
    case "idle":
    case "closed":
      setMainButton("start", "Start talking");
      break;
    case "error":
      setMainButton("start", "Retry");
      break;
    case "creating-session":
    case "connecting":
      setMainButton("busy", "Connecting…");
      break;
    case "queued":
      setMainButton("stop", "Leave queue");
      break;
    case "your-turn":
      setMainButton("join", "Join now");
      break;
    default:
      // connected / user-speaking / processing / ai-speaking
      setMainButton("stop", "End conversation");
      break;
  }

  if (status === "user-speaking") {
    subtitles.classList.remove("visible");
  }
}

// ── Tool executor ────────────────────────────────────────────────────────
/** @param {string} name @param {string} argsJson @param {string} callId */
function runTool(name, argsJson, callId) {
  if (!client) return;
  /** @type {Record<string, unknown>} */
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    // keep {}
  }
  const result = stage.runTool(name, args) ?? `Unknown tool: ${name}`;
  client.sendToolOutput(callId, result);
  // The turn continues after a tool call only when we ask for the follow-up.
  client.requestResponse();
}

// ── Session lifecycle ────────────────────────────────────────────────────
async function startSession() {
  // Everything audible hangs off the avatar's AudioContext; resume it inside
  // the tap gesture or iOS keeps it suspended (silent).
  stage.resume();

  let micStream;
  if (new URLSearchParams(location.search).has("fakemic")) {
    // Dev/testing hook: a silent synthetic mic, so the session can be driven
    // end-to-end (handshake, WS, TTS playback, lip-sync) without a real mic
    // or a native permission prompt.
    const ctx = /** @type {AudioContext} */ (stage.audioCtx);
    micStream = ctx.createMediaStreamDestination().stream;
  } else {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setCaption("MIC BLOCKED — ALLOW IT IN THE BROWSER AND RETRY", "error");
      return;
    }
  }

  const audioCtx = stage.audioCtx;
  const voiceSink = stage.voiceSink;
  if (!audioCtx || !voiceSink) return;

  const c = new S2sWsRealtimeClient({
    ...(config.lb ? { sessionUrl: "api/session" } : { directUrl: settings.directUrl }),
    voice: settings.voice,
    instructions: effectiveInstructions(),
    micStream,
    audioContext: audioCtx,
    outputNode: voiceSink,
    workletBaseUrl: "/worklets/",
    tools: TOOL_DEFS,
  });
  client = c;

  c.addEventListener("status", (e) => onStatus(/** @type {CustomEvent} */ (e).detail.status));

  c.addEventListener("queue", (e) => {
    const { position } = /** @type {CustomEvent} */ (e).detail;
    setCaption(position > 0 ? `#${position} IN LINE…` : "ALMOST THERE…", "live");
  });

  c.addEventListener("transcript", (e) => {
    const { role, text } = /** @type {CustomEvent} */ (e).detail;
    if (role === "assistant" && text) showSubtitles(text);
  });

  c.addEventListener("response-finished", () => {
    fadeSubtitles();
  });

  c.addEventListener("toolcall", (e) => {
    const { name, arguments: args, callId } = /** @type {CustomEvent} */ (e).detail;
    runTool(name, args, callId);
  });

  c.addEventListener("server-error", (e) => {
    console.warn("server error:", /** @type {CustomEvent} */ (e).detail.error);
  });

  c.addEventListener("error", () => {
    void endSession();
  });

  try {
    await c.connect();
  } catch (err) {
    const code = /** @type {Error & {code?: string}} */ (err)?.code;
    if (code === "limit") {
      setCaption("DAILY CONVERSATION LIMIT REACHED — TRY AGAIN TOMORROW", "error");
    } else if (code === "queue-full") {
      setCaption("EVERY SEAT IS TAKEN — TRY AGAIN SHORTLY", "error");
    } else if (code === "join-expired") {
      setCaption("YOUR SPOT EXPIRED — TAP TO TRY AGAIN", "error");
    } else if (code !== "aborted") {
      console.error(err);
      setCaption("COULD NOT CONNECT — TAP TO RETRY", "error");
    }
    await endSession(true);
    return;
  }
}

/** @param {boolean} [silent] Keep the current caption (e.g. an error). */
async function endSession(silent = false) {
  const c = client;
  client = null;
  if (c) {
    for (const track of c.options.micStream?.getTracks() ?? []) track.stop();
    await c.close().catch(() => {});
  }
  stage.setConversationState("idle");
  subtitles.classList.remove("visible");
  if (!silent) setCaption(CAPTIONS.idle);
  setMainButton("start", "Start talking");
}

// ── UI events ────────────────────────────────────────────────────────────
mainBtn.addEventListener("click", () => {
  if (mainAction === "start") void startSession();
  else if (mainAction === "join") {
    stage.resume(); // fresh gesture: re-arm audio before dialing
    client?.join();
  } else if (mainAction === "stop") void endSession();
});

muteBtn.addEventListener("click", () => {
  muted = !muted;
  client?.setMuted(muted);
  muteBtn.classList.toggle("active", muted);
  muteBtn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
});

settingsBtn.addEventListener("click", () => {
  inputVoice.value = settings.voice;
  inputInstructions.value = settings.instructions;
  inputDirectUrl.value = settings.directUrl;
  settingsDialog.showModal();
});

settingsDialog.addEventListener("close", () => {
  settings = {
    voice: inputVoice.value || DEFAULT_VOICE,
    instructions: inputInstructions.value,
    directUrl: inputDirectUrl.value.trim(),
  };
  saveSettings();
  // Voice/instructions apply live to an ongoing session.
  client?.updateSession({ voice: settings.voice, instructions: effectiveInstructions() });
});

window.addEventListener("beforeunload", () => {
  client?.close();
});

// ── Boot ─────────────────────────────────────────────────────────────────
async function boot() {
  for (const v of VOICES) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v.replaceAll("_", " ");
    inputVoice.append(o);
  }

  try {
    const resp = await fetch("api/config");
    if (resp.ok) config = { ...config, ...(await resp.json()) };
  } catch {
    // defaults keep direct mode available
  }
  directUrlRow.hidden = !config.allowDirect;

  setCaption("WAKING HER UP…");
  setMainButton("busy", "Loading…");
  try {
    await stage.init({
      onprogress: (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
          loading.textContent = `Loading avatar ${pct}%`;
        }
      },
    });
  } catch (err) {
    console.error(err);
    loading.textContent = "The avatar failed to load. Check the console and reload.";
    setCaption("AVATAR FAILED TO LOAD", "error");
    return;
  }
  loading.classList.add("done");
  setCaption(CAPTIONS.idle);
  setMainButton("start", "Start talking");

  // Debug handles
  Object.assign(window, { stage, getClient: () => client });
}

void boot();
