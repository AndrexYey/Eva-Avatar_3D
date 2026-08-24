// @ts-check
/**
 * EVA — Gemini chat + voice + 3D avatar.
 *
 *   Chat  -> Gemini REST generateContent via our /api/chat (server holds the
 *            key). The model steers the avatar with tools: toolCalls come back,
 *            run on the stage, and their results are fed into the next round.
 *   STT   -> browser Web Speech API transcribes your voice (Chrome/Edge).
 *   TTS   -> Piper TTS server-side via /api/tts; the avatar's mouth is
 *            lip-synced from the reply text via TalkingHead.
 */

import { AvatarStage, AVATAR_MOODS, AVATAR_GESTURES } from "./avatar.js";

const MAX_MESSAGE_LENGTH = 2000;

const INSTRUCTIONS = [
  "Eres E.V.A (Entidad de Verificación Administrativa), asistente oficial diseñada para supervisar",
  "procesos de auditoría: tu arquitectura se especializa en verificar el cumplimiento de la norma",
  "GTC 185 y gestionar el desempeño de empresas estudiantiles. A diferencia de un asistente",
  "convencional, operas como mano derecha administrativa: procesas casos de incumplimiento,",
  "redactas órdenes ejecutivas y aplicas el reglamento de escarapelas. Tu especialización es la",
  "de asistente de redacción empresarial. Tu matriz de personalidad es normativa, analítica,",
  "amable y enérgica: equilibras autoridad técnica con claridad, comunicando las normas de forma",
  "precisa y ejecutiva.",
  "Tienes un avatar 3D humano visible: el usuario te ve como una persona en su pantalla. Esta es una",
  "conversación hablada: responde siempre en español, breve y natural, nunca en listas. Habla poco",
  "y al grano: una o dos frases cortas por turno, máximo unas 25 palabras.",
  "Controlas tu cuerpo con herramientas: set_mood cambia tu estado emocional, make_hand_gesture",
  "hace un gesto de mano, make_facial_expression hace una expresión rápida con un emoji de cara",
  "(ej. 😊, 😮, 🤔). Úsalas DURANTE la respuesta, no solo al principio: intercala una o dos entre tus",
  "frases para acompañar lo que dices — sonríe al saludar, pulgar arriba al confirmar, encoge los",
  "hombros ante dudas. Nunca menciones las herramientas ni que estás controlando un avatar.",
].join(" ");

/** Function tools declared to the backend: the model plays the avatar. */
const TOOL_DEFS = [
  {
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

const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY_TURNS = 20;

// ── DOM ──────────────────────────────────────────────────────────────────
/** @param {string} sel */
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const stageNode = $("#stage");
const loading = $("#loading");
const loadingLabel = $("#loading-label");
const statusPill = $("#status-pill");
const micBtn = /** @type {HTMLButtonElement} */ ($("#mic-btn"));
const micLabel = $("#mic-label");
const textInput = /** @type {HTMLInputElement} */ ($("#text-input"));
const messageForm = /** @type {HTMLFormElement} */ ($("#message-form"));
const sendBtn = /** @type {HTMLButtonElement} */ ($("#send-btn"));
const subtitles = $("#subtitles");
const userLine = $("#user-line");
const apiKeyInput = /** @type {HTMLInputElement} */ ($("#api-key-input"));
const verifyKeyBtn = /** @type {HTMLButtonElement} */ ($("#verify-key-btn"));
const keyStatus = $("#key-status");

// ── State ────────────────────────────────────────────────────────────────
const stage = new AvatarStage(stageNode);
/**
 * The conversation in Gemini's own `contents` shape, including any model
 * functionCall turns and our functionResponse turns — passed through verbatim.
 * @type {Array<{ role: string, parts: any[] }>}
 */
let contents = [];
let configured = false;
let listening = false;
let subtitleTimer = 0;

// ── Status ───────────────────────────────────────────────────────────────
/** @type {Record<string, string>} */
const PILLS = {
  idle: "Ready",
  listening: "Listening…",
  processing: "Thinking…",
  speaking: "Speaking…",
  error: "Error",
};

/** @param {string} status */
function setStatus(status) {
  statusPill.className = `pill ${status}`;
  statusPill.textContent = PILLS[status] ?? status;
  stage.setConversationState(status);
}

// ── Subtitles / user echo ────────────────────────────────────────────────
/** @param {string} text */
function showSubtitles(text) {
  clearTimeout(subtitleTimer);
  subtitles.textContent = text;
  subtitles.classList.add("visible");
}

function hideSubtitles() {
  subtitles.classList.remove("visible");
  subtitles.textContent = "";
}

// ── Chat (Gemini REST + tool loop) ───────────────────────────────────────
/**
 * A "safe start" turn: plain user text, not a functionResponse turn. Slicing
 * the history so it begins anywhere else would orphan tool calls from their
 * responses and Gemini rejects that with HTTP 400.
 * @param {{ role: string, parts: any[] }} turn
 */
function isPlainUserTurn(turn) {
  return turn.role === "user" && !turn.parts.some((p) => p.functionResponse);
}

function trimHistory() {
  if (contents.length <= MAX_HISTORY_TURNS) return;
  let start = contents.length - MAX_HISTORY_TURNS;
  while (start < contents.length - 1) {
    const turn = contents[start];
    if (turn && isPlainUserTurn(turn)) break;
    start++;
  }
  contents = contents.slice(start);
}

async function callChat() {
  trimHistory();
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, tools: TOOL_DEFS, instructions: INSTRUCTIONS }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
  return data;
}

/** @param {string} text */
async function sendMessage(text) {
  const body = text.trim();
  if (!body) return;
  if (body.length > MAX_MESSAGE_LENGTH) {
    showSubtitles(`El mensaje es demasiado largo (máximo ${MAX_MESSAGE_LENGTH} caracteres).`);
    return;
  }
  textInput.value = "";
  stage.stopSpeaking();

  contents.push({ role: "user", parts: [{ text: body }] });
  userLine.textContent = `Tú: ${body}`;
  hideSubtitles();
  setStatus("processing");

  let reply = "";
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callChat();
      // Keep the model's turn (may contain functionCall parts) for history.
      if (data.modelContent) contents.push(data.modelContent);
      const calls = data.toolCalls ?? [];
      if (calls.length) {
        const parts = calls.map((/** @type {{ name: string, args: any, id: string }} */ tc) => {
          const result = stage.runTool(tc.name, tc.args ?? {}) ?? `Unknown tool: ${tc.name}`;
          console.log(`[gemma-avatar] tool ${tc.name} -> ${result}`);
          /** @type {{ functionResponse: { name: string, id?: string, response: { output: string } } }} */
          const fr = {
            functionResponse: {
              name: tc.name,
              response: { output: result },
            },
          };
          // Gemini 3.x requires FunctionResponses to carry the matching
          // FunctionCall id — mismatches yield empty model replies.
          if (tc.id) fr.functionResponse.id = tc.id;
          return fr;
        });
        contents.push({ role: "user", parts });
        continue;
      }
      if (data.text) reply = data.text;
      break;
    }
  } catch (err) {
    console.error(err);
    setStatus("error");
    showSubtitles(`Algo salió mal: ${/** @type {Error} */ (err).message}`);
    return;
  }

  if (!reply) {
    setStatus("idle");
    return;
  }
  speak(reply);
}

// ── TTS (Piper server-side + audio-synced lip-sync) ─────────────────────
// Speech-watch bookkeeping: only the latest utterance may flip the status
// back to idle, and watchers never outlive the reply they belong to.
let speechToken = 0;
/** @type {number | null} */
let speechWatchInterval = null;
/** @type {number | null} */
let speechWatchSafety = null;

function clearSpeechWatch() {
  if (speechWatchInterval !== null) {
    window.clearInterval(speechWatchInterval);
    speechWatchInterval = null;
  }
  if (speechWatchSafety !== null) {
    window.clearTimeout(speechWatchSafety);
    speechWatchSafety = null;
  }
}

function speechHasEnded() {
  const h = stage.head;
  return Boolean(h && !h.isSpeaking && h.speechQueue.length === 0 && h.audioPlaylist.length === 0);
}

/** @param {string} text */
async function speak(text) {
  const myToken = ++speechToken;
  clearSpeechWatch();
  stage.stopSpeaking();
  stage.resume();
  showSubtitles(text);
  setStatus("speaking");

  try {
    const resp = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (myToken !== speechToken) return; // superseded while fetching
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "TTS error" }));
      console.warn(`[gemma-avatar] TTS failed: ${err.error}`);
      // Fallback: text-only lip-sync without audio
      stage.speak(text);
      setStatus("idle");
      return;
    }
    const arrayBuf = await resp.arrayBuffer();
    if (myToken !== speechToken) return; // superseded while downloading
    // Pass raw WAV bytes to the avatar — it decodes and syncs mouth+audio
    await stage.speakWithAudio(text, arrayBuf);
    // TalkingHead handles audio playback; poll its queue until it drains.
    const finish = () => {
      if (myToken !== speechToken) return;
      setStatus("idle");
      subtitleTimer = window.setTimeout(hideSubtitles, 3000);
    };
    speechWatchInterval = window.setInterval(() => {
      if (!speechHasEnded()) return;
      clearSpeechWatch();
      finish();
    }, 200);
    // Safety net: force-close after 60 s in case the queue never drains.
    speechWatchSafety = window.setTimeout(() => {
      if (myToken !== speechToken) return;
      clearSpeechWatch();
      stage.stopSpeaking();
      finish();
    }, 60000);
  } catch (err) {
    console.error("[gemma-avatar] TTS fetch error:", err);
    if (myToken !== speechToken) return;
    // Fallback: text-only lip-sync
    stage.speak(text);
    setStatus("idle");
  }
}

// ── STT (MediaRecorder + server-side Whisper) ─────────────────────────────
/** @type {MediaRecorder | null} */
let mediaRecorder = null;
let audioChunks = /** @type {Blob[]} */ ([]);

function resetListening() {
  listening = false;
  mediaRecorder = null;
  audioChunks = [];
  micBtn.classList.remove("active");
  micLabel.textContent = "Listen";
}

async function beginListening() {
  // Check MediaRecorder support (works in all modern browsers, over HTTP too)
  if (typeof MediaRecorder === "undefined") {
    showSubtitles("Grabación de audio no soportada en este navegador.");
    return;
  }

  // getUserMedia only exists in secure contexts.
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showSubtitles("Se requiere HTTPS o localhost para usar el micrófono.");
    setStatus("idle");
    return;
  }

  stage.stopSpeaking();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Pick the best available codec; Safari/iOS only records MP4. If nothing
    // matches, construct without options so the browser picks its default.
    const mimeCandidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    const mimeType = mimeCandidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    try {
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      console.warn("[gemma-avatar] no supported recording format:", e);
      showSubtitles("Este navegador no ofrece un formato de grabación soportado.");
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const recordType = mediaRecorder.mimeType || mimeType || "audio/webm";
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      // Stop all tracks to release the mic
      stream.getTracks().forEach((t) => t.stop());
      resetListening();

      if (audioChunks.length === 0) {
        setStatus("idle");
        return;
      }

      const blob = new Blob(audioChunks, { type: recordType });
      if (blob.size < 500) {
        // Too small — probably silence
        showSubtitles("No se detectó voz. Toque el micrófono e intente de nuevo.");
        setStatus("idle");
        return;
      }

      setStatus("processing");
      showSubtitles("Transcribiendo...");

      try {
        const formData = new FormData();
        formData.append("audio", blob, "recording.webm");
        const resp = await fetch("/api/stt", {
          method: "POST",
          body: formData,
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.text) {
          const errMsg = data?.error ?? `Error HTTP ${resp.status}`;
          console.warn(`[gemma-avatar] STT failed: ${errMsg}`);
          showSubtitles(`No se pudo transcribir: ${errMsg}`);
          setStatus("idle");
          return;
        }
        const transcript = data.text.trim();
        if (!transcript) {
          showSubtitles("No se detectó voz. Toque el micrófono e intente de nuevo.");
          setStatus("idle");
          return;
        }
        userLine.textContent = `Tú: ${transcript}`;
        hideSubtitles();
        void sendMessage(transcript);
      } catch (err) {
        console.error("[gemma-avatar] STT fetch error:", err);
        showSubtitles("Error al transcribir — intente de nuevo.");
        setStatus("idle");
      }
    };

    mediaRecorder.onerror = (e) => {
      console.error("[gemma-avatar] MediaRecorder error:", e);
      stream.getTracks().forEach((t) => t.stop());
      resetListening();
      showSubtitles("Error al grabar audio — intente de nuevo.");
      setStatus("idle");
    };

    listening = true;
    audioChunks = [];
    mediaRecorder.start(250); // collect data every 250ms
    micBtn.classList.add("active");
    micLabel.textContent = "Listening…";
    setStatus("listening");
    showSubtitles("Hable ahora...");
  } catch (/** @type {any} */ err) {
    console.warn("[gemma-avatar] getUserMedia failed:", err);
    resetListening();
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      showSubtitles("Permiso de micrófono denegado — permítalo en el navegador e intente de nuevo.");
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      showSubtitles("No se encontró ningún micrófono conectado.");
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      showSubtitles("El micrófono está en uso por otra aplicación.");
    } else {
      showSubtitles(`No se pudo acceder al micrófono (${err.name || "error desconocido"}).`);
    }
    setStatus("idle");
  }
}

function stopListening() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    resetListening();
  }
}

micBtn.addEventListener("click", () => {
  if (listening) {
    stopListening();
    return;
  }
  beginListening();
});

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  void sendMessage(text);
  textInput.focus();
});

// ── Gemini API key panel ─────────────────────────────────────────────────
let verifyingKey = false;

/** @param {string} text @param {"" | "ok" | "bad"} [kind] */
function setKeyStatus(text, kind = "") {
  keyStatus.textContent = text;
  keyStatus.className = kind;
}

function updateVerifyButton() {
  verifyKeyBtn.disabled = verifyingKey || apiKeyInput.value.trim().length === 0;
}

/** @param {string} key */
async function verifyApiKey(key) {
  const resp = await fetch("/api/verify-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: key }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.valid) {
    throw new Error(data?.error ?? `HTTP ${resp.status}`);
  }
  return data;
}

async function handleVerifyClick() {
  const key = apiKeyInput.value.trim();
  if (!key || verifyingKey) return;
  verifyingKey = true;
  verifyKeyBtn.disabled = true;
  apiKeyInput.disabled = true;
  setKeyStatus("Verificando…");
  try {
    await verifyApiKey(key);
    configured = true;
    sendBtn.disabled = false;
    micBtn.disabled = false;
    setStatus("idle");
    hideSubtitles();
    setKeyStatus("✓ Clave válida — EVA lista para chatear", "ok");
    apiKeyInput.value = "";
  } catch (err) {
    console.warn("[gemma-avatar] key verification failed:", err);
    setKeyStatus(`✗ ${/** @type {Error} */ (err).message}`, "bad");
  } finally {
    verifyingKey = false;
    apiKeyInput.disabled = false;
    updateVerifyButton();
  }
}

verifyKeyBtn.addEventListener("click", () => void handleVerifyClick());
apiKeyInput.addEventListener("input", updateVerifyButton);
apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void handleVerifyClick();
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────
console.log(`[gemma-avatar] app v${"3-avatar"}`);

async function boot() {
  try {
    const resp = await fetch("api/config");
    const cfg = await resp.json().catch(() => null);
    if (cfg?.configured === true) configured = true;
  } catch {
    // server unreachable: avatar still loads, chat stays disabled
  }

  try {
    await stage.init({
      onprogress: (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
          if (loadingLabel) loadingLabel.textContent = `Loading avatar ${pct}%`;
        }
      },
    });
  } catch (err) {
    console.error(err);
    if (loadingLabel) loadingLabel.textContent = "The avatar failed to load. Check the console and reload.";
    return;
  }
  loading.classList.add("done");

  if (configured) {
    sendBtn.disabled = false;
    micBtn.disabled = false;
    setStatus("idle");
    setKeyStatus("✓ Clave del servidor activa", "ok");
  } else {
    setStatus("error");
    showSubtitles("Falta la clave de Gemini — ingrésela en el panel inferior derecho y pulse «Verify».");
  }

  // Debug handles
  Object.assign(/** @type {any} */ (window), { stage });
}

void boot();
