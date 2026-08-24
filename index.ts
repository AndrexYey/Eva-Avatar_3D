/**
 * EVA — text + voice chat with a 3D TalkingHead avatar.
 *
 * The browser never sees the API key. Chat requests go to our same-origin
 * `/api/chat` endpoint; the server calls Google's `generateContent` with the
 * key attached server-side. The model can steer the avatar's body through
 * function calling: `set_mood`, `make_hand_gesture`, `make_facial_expression`
 * come back as `toolCalls` and are relayed to the browser, which executes
 * them on the TalkingHead stage and returns the results for the next round.
 *
 * Speech-to-text runs in the browser (Web Speech API). Text-to-speech runs
 * server-side via Piper TTS (Python service on port 5000).
 *
 * Environment:
 *   GEMINI_API_KEY    (required) — Google AI Studio API key.
 *   GEMINI_CHAT_MODEL (optional) — REST chat model, default gemini-2.5-flash.
 *   PORT              (optional) — default 3000.
 *   TTS_URL           (optional) — Piper TTS service URL, default http://127.0.0.1:5000.
 */

import index from "./index.html";

export const GEMINI_REST_BASE_URL = "https://generativelanguage.googleapis.com";
/** REST chat model (free tier): no Live API involved. */
const DEFAULT_CHAT_MODEL = "gemini-3.5-flash";
/**
 * Ordered fallbacks tried when the requested model is unavailable (404,
 * "model not found", quota/overload). Newest first, oldest last.
 */
const MODEL_FALLBACKS = ["gemini-3.6-flash", "gemini-3-flash-preview", "gemini-2.5-flash"];
/** Bump when the app's architecture changes (for cache diagnosis). */
export const APP_VERSION = "3-avatar";

export interface CreateServerOptions {
  apiKey?: string;
  chatModel?: string;
  port?: number;
  restBaseUrl?: string;
  ttsUrl?: string;
}

/**
 * Create the Bun HTTP server.
 * @param {CreateServerOptions} [opts]
 */
export function createServer(opts: CreateServerOptions = {}) {
  // Mutable so a key verified via /api/verify-key can replace it at runtime.
  let apiKey = (opts.apiKey ?? Bun.env.GEMINI_API_KEY ?? "").trim();
  const chatModel = (opts.chatModel ?? Bun.env.GEMINI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL).trim();
  const port = opts.port ?? Number(Bun.env.PORT ?? 3000);
  const restBaseUrl = opts.restBaseUrl ?? GEMINI_REST_BASE_URL;
  const ttsUrl = opts.ttsUrl ?? Bun.env.TTS_URL ?? "http://127.0.0.1:5000";

  /** Candidates in try-order: the requested model first, then fallbacks. */
  const candidateModels = [chatModel, ...MODEL_FALLBACKS.filter((m) => m !== chatModel)];
  /** Sticky index: once a model answers, later requests start there. */
  let activeModelIndex = 0;

  /**
   * Chat against Gemini `generateContent`, passing the conversation through
   * in Gemini's own `contents` shape so function calls survive the round-trip.
   */
  async function handleChat(req: Request): Promise<Response> {
    if (!apiKey) {
      return Response.json({ error: "GEMINI_API_KEY is not configured on the server." }, { status: 503 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const instructions = typeof body?.instructions === "string" ? body.instructions.trim() : "";
    const contents = Array.isArray(body?.contents)
      ? body.contents.filter((c: any) => c && typeof c.role === "string" && Array.isArray(c.parts))
      : [];
    if (contents.length === 0) {
      return Response.json({ error: "At least one message (contents) is required." }, { status: 400 });
    }
    const tools = Array.isArray(body?.tools)
      ? body.tools.filter((t: any) => t && typeof t.name === "string")
      : [];

    const payload: Record<string, any> = { contents };
    // Headroom: on 3.x models thinking burns output tokens, which starved the
    // visible reply (empty responses with finishReason MAX_TOKENS).
    // Brevity comes from the system instructions, not from a tight cap.
    payload.generationConfig = {
      maxOutputTokens: 512,
      temperature: 0.7,
      topP: 0.9,
    };
    if (instructions) payload.systemInstruction = { parts: [{ text: instructions }] };
    if (tools.length) {
      // `function_declarations` has no `type` field (that was the Live API
      // format) — strip it defensively in case a client sends it.
      payload.tools = [
        {
          functionDeclarations: tools.map((t: any) => {
            const { type: _type, ...decl } = t;
            return decl;
          }),
        },
      ];
    }

    // Try models starting from the sticky active one, rotating through the
    // rest of the chain so a dead active model recovers too.
    const order = [
      ...candidateModels.slice(activeModelIndex),
      ...candidateModels.slice(0, activeModelIndex),
    ];
    let lastFailure: { status: number; message: string } | null = null;

    for (const model of order) {
      // Per-model sampling/thinking config. Gemini 3.x: keep vendor defaults
      // for reasoning quality, just minimize thinking; 2.5 series disables
      // thinking via the legacy numeric budget.
      if (model.startsWith("gemini-3")) {
        payload.generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
        delete payload.generationConfig.temperature;
        delete payload.generationConfig.topP;
      } else {
        payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        payload.generationConfig.temperature = 0.7;
        payload.generationConfig.topP = 0.9;
      }

      const genUrl = `${restBaseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let upstream: Response;
      try {
        upstream = await fetch(genUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timeout);
        if (err?.name === "AbortError") {
          return Response.json({ error: "Gemini API timed out (15 s)." }, { status: 504 });
        }
        return Response.json({ error: err?.message ?? "Network error calling Gemini." }, { status: 502 });
      }
      clearTimeout(timeout);
      const data: any = await upstream.json().catch(() => null);

      if (!upstream.ok) {
        const message = data?.error?.message ?? `Gemini API error (HTTP ${upstream.status})`;
        console.warn(`Gemini generateContent failed on ${model} (${upstream.status}): ${message}`);
        lastFailure = { status: upstream.status, message };
        // Walk the chain when the model itself is unavailable or not
        // functional (not found, quota exhausted, overloaded).
        const modelUnavailable =
          upstream.status === 404 ||
          upstream.status === 429 ||
          upstream.status === 503 ||
          (upstream.status === 400 && /not found|not supported|unsupported|invalid model/i.test(message));
        if (modelUnavailable) continue;
        return Response.json({ error: message }, { status: upstream.status });
      }

      if (model !== candidateModels[activeModelIndex]) {
        console.log(`Gemini model switched to ${model}.`);
      }
      activeModelIndex = candidateModels.indexOf(model);
      return chatResult(data);
    }

    return Response.json(
      { error: lastFailure?.message ?? "No Gemini model is available right now." },
      { status: lastFailure?.status ?? 502 },
    );
  }

  /** Extract text / tool calls from a successful `generateContent` body. */
  function chatResult(data: any): Response {
    const content = data?.candidates?.[0]?.content ?? null;
    const parts = content?.parts ?? [];
    const text = parts
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("");
    const toolCalls = parts
      .filter((p: any) => p?.functionCall && typeof p.functionCall.name === "string")
      .map((p: any) => {
        const fc = p.functionCall;
        let args: Record<string, unknown> = {};
        if (typeof fc.args === "string") {
          try {
            args = JSON.parse(fc.args);
          } catch {
            args = {};
          }
        } else if (fc.args && typeof fc.args === "object") {
          args = fc.args;
        }
        return { id: typeof fc.id === "string" ? fc.id : "", name: fc.name, args };
      });

    if (!text && toolCalls.length === 0) {
      const finishReason = data?.candidates?.[0]?.finishReason ?? "unknown";
      console.warn(
        `Gemini returned no content (finishReason: ${finishReason}, usage: ${JSON.stringify(data?.usageMetadata ?? {})})`,
      );
      return Response.json(
        { error: `Gemini devolvió una respuesta vacía (${finishReason}). Inténtalo de nuevo.` },
        { status: 502 },
      );
    }

    const out: Record<string, any> = { text };
    // The raw model turn (may hold functionCall parts) so the browser can
    // append it to `contents` and drive the tool loop faithfully.
    if (content) out.modelContent = content;
    if (toolCalls.length) out.toolCalls = toolCalls;
    return Response.json(out);
  }

  /**
   * Verify a Gemini API key by listing models with it. A key supplied in the
   * request body replaces the server's active key when valid, so the app can
   * be configured live from the browser without a restart.
   */
  async function handleVerifyKey(req: Request): Promise<Response> {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // No body: verify the currently configured key instead.
    }
    const candidate = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!candidate && !apiKey) {
      return Response.json(
        { valid: false, error: "No API key provided and none configured on the server." },
        { status: 400 },
      );
    }

    const keyToCheck = candidate || apiKey;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let upstream: Response;
    try {
      upstream = await fetch(`${restBaseUrl}/v1beta/models?pageSize=1`, {
        headers: { "x-goog-api-key": keyToCheck },
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === "AbortError") {
        return Response.json({ valid: false, error: "Gemini API timed out (15 s)." }, { status: 504 });
      }
      return Response.json({ valid: false, error: err?.message ?? "Network error calling Gemini." }, { status: 502 });
    }
    clearTimeout(timeout);
    const data: any = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const message = data?.error?.message ?? `Gemini API error (HTTP ${upstream.status})`;
      console.warn(`Gemini key check failed (${upstream.status}): ${message}`);
      return Response.json({ valid: false, error: message }, { status: upstream.status });
    }

    if (candidate && candidate !== apiKey) {
      apiKey = candidate;
      console.log("Gemini API key updated via /api/verify-key.");
    }
    return Response.json({ valid: true, chatModel });
  }

  const server = Bun.serve({
    port,
    // `/` is the bundled frontend (HTML import). Bun's bundler serves the
    // module graph it references (`/src/app.js`, `/src/style.css`, and their
    // node_modules imports) — so no manual static serving is needed. Only
    // runtime-fetched binary assets bypass the bundler.
    routes: {
      "/": index,

      "/api/config": {
        GET: () =>
          Response.json({ configured: Boolean(apiKey), chatModel, version: APP_VERSION }),
      },

      "/api/chat": {
        POST: (req) => handleChat(req),
      },

      "/api/verify-key": {
        POST: (req) => handleVerifyKey(req),
      },

      "/api/tts": {
        POST: async (req) => {
          let body: any;
          try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
          const text = typeof body?.text === "string" ? body.text.trim() : "";
          if (!text) return Response.json({ error: "Missing text" }, { status: 400 });
          try {
            const upstream = await fetch(`${ttsUrl}/tts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text }),
              signal: AbortSignal.timeout(30000),
            });
            if (!upstream.ok) {
              const errText = await upstream.text().catch(() => "TTS service error");
              return Response.json({ error: errText }, { status: upstream.status });
            }
            const audioBuf = await upstream.arrayBuffer();
            return new Response(audioBuf, {
              headers: { "Content-Type": "audio/wav", "Cache-Control": "no-cache" },
            });
          } catch (err: any) {
            return Response.json({ error: `TTS service unreachable: ${err?.message}` }, { status: 502 });
          }
        },
      },

      "/api/stt": {
        POST: async (req) => {
          let upstreamResp: Response;
          try {
            // Relay the multipart form (audio blob) to the Python STT service
            const formData = await req.formData();
            upstreamResp = await fetch(`${ttsUrl}/stt`, {
              method: "POST",
              body: formData,
              signal: AbortSignal.timeout(30000),
            });
          } catch (err: any) {
            return Response.json({ error: `STT service unreachable: ${err?.message}` }, { status: 502 });
          }
          if (!upstreamResp.ok) {
            const errBody = await upstreamResp.json().catch(() => ({ error: "STT error" }));
            return Response.json(errBody, { status: upstreamResp.status });
          }
          const data = await upstreamResp.json().catch(() => null);
          return Response.json(data ?? { text: "" });
        },
      },

      // The avatar GLB is fetched at runtime by three.js — don't bundle it.
      "/avatars/:name": (req) => {
        const name = req.params.name ?? "";
        // Only plain filenames: blocks "../" traversal out of public/avatars.
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
          return new Response("Not found", { status: 404 });
        }
        const file = Bun.file(`${import.meta.dir}/public/avatars/${name}`);
        return new Response(file, {
          headers: { "Cache-Control": "public, max-age=86400" },
        });
      },
    },

    development:
      Bun.env.NODE_ENV === "production"
        ? false
        : {
            hmr: true,
            console: true,
          },
  });

  return server;
}

if (import.meta.main) {
  const server = createServer();
  const keySet = Boolean((Bun.env.GEMINI_API_KEY ?? "").trim());
  console.log(`gemma-avatar (EVA) listening on ${server.url}`);
  console.log(keySet ? "Gemini API key: configured" : "warning: GEMINI_API_KEY not set — /api/chat will refuse requests");
}
