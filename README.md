---
title: Gemma Avatar
emoji: 🗣️
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
thumbnail: https://huggingface.co/spaces/victor/gemma-avatar/resolve/main/thumbnail.webp
short_description: Talk to Gemma 4 face to face, with a 3D lip-synced avatar
models:
  - google/gemma-4-31B-it
  - nvidia/parakeet-tdt-1.1b
  - Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
---

# Gemma Avatar

Realtime voice chat with a 3D talking-head avatar. Same AI stack as the
[smolagents/hf-realtime-voice](https://huggingface.co/spaces/smolagents/hf-realtime-voice)
Space ([blog post](https://huggingface.co/blog/cerebras-gemma4-voice-ai)), but the
orb visualization is replaced by a [TalkingHead](https://github.com/met4citizen/TalkingHead)
3D avatar with real-time audio-driven lip-sync.

## The pipeline

```
you speak → silero-VAD → parakeet-tdt-1.1b (STT) → gemma-4-31B-it on Cerebras → Qwen3-TTS → avatar speaks
```

Transport is the OpenAI Realtime GA protocol over WebSocket against Hugging
Face's speech-to-speech backend: mic PCM16 @ 16 kHz goes up as
`input_audio_buffer.append`, TTS PCM16 @ 16 kHz comes back as
`response.output_audio.delta`, transcripts stream alongside.

## How the avatar works

- **Rendering / body language** — [TalkingHead](https://github.com/met4citizen/TalkingHead)
  (three.js). Blinking, breathing, idle sway, moods, hand gestures, and emoji
  expressions are its built-in animation system.
- **Lip-sync** — the backend sends raw PCM only (no word timings, no visemes),
  so the mouth is driven from the audio itself with
  [HeadAudio](https://github.com/met4citizen/HeadAudio): an AudioWorklet that
  classifies MFCC frames into Oculus visemes (~50 ms latency, fully in-browser).
  The s2s playback worklet is routed into TalkingHead's audio graph
  (`audioAnalyzerNode → audioSpeechGainNode → reverb → speakers`) and HeadAudio
  taps the speech gain node.
- **The model plays the avatar** — three function tools are declared to the
  backend: `set_mood`, `make_hand_gesture`, `make_facial_expression`. Gemma
  calls them mid-conversation (smiles when greeting, shrugs when unsure,
  thumbs-up when agreeing).
- **Choreography** — client statuses drive presence: the avatar makes eye
  contact when you start talking, gestures with its hands on new utterances,
  and barge-in clears the playback buffer so the mouth settles instantly.

## Run it

```bash
bun install

# Pick a backend (one of):
LOAD_BALANCER_URL=https://…            bun run dev   # a speech-to-speech load balancer
SESSION_PROXY_URL=https://…/api        bun run dev   # piggyback another deployment's /api (dev)
bun run dev                                          # direct mode: paste a ws:// URL in Settings
```

Open http://localhost:3000 and tap **Start talking**.

`?fakemic=1` starts a session with a silent synthetic mic (useful for testing
the full loop without a microphone — trigger a reply from the console with
`getClient().requestResponse()`).

## Layout

```
index.ts                    Bun server: HTML import + /api/session proxy + static assets
index.html                  App shell (avatar hero, caption, subtitles, settings)
src/app.js                  Session wiring, tool executor, UI state
src/avatar.js               AvatarStage: TalkingHead + HeadAudio + choreography
src/s2s/s2s-ws-client.js    Realtime WS client (vendored from the Space; orb removed,
                            injectable output node + worklet base URL + shared-ctx close)
src/s2s/codec.js            PCM/base64 + transcript helpers (vendored, unchanged)
src/vendor/headaudio.min.mjs  HeadAudio node class (bundled)
public/worklets/            mic-capture + audio-playback AudioWorklets (vendored, unchanged)
public/vendor/              HeadAudio worklet processor + viseme model (runtime-loaded)
public/avatars/brunette.glb Default avatar (Ready Player Me; CC BY-NC 4.0 — non-commercial)
```

## Notes

- The avatar GLB must have a Mixamo-compatible rig plus ARKit and Oculus-viseme
  blend shapes. Ready Player Me avatars work with
  `?morphTargets=ARKit,Oculus%20Visemes` on the GLB URL.
- TalkingHead owns the AudioContext; the s2s client is handed `head.audioCtx`
  and never closes it.
- Everything animation-related runs on requestAnimationFrame — a backgrounded
  tab freezes the avatar (audio keeps playing).
