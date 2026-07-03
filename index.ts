/**
 * Gemma Avatar — realtime voice chat with a 3D talking-head avatar.
 *
 * Same AI stack as the smolagents/hf-realtime-voice Space
 * (silero-VAD → parakeet STT → Gemma on Cerebras → Qwen3-TTS, spoken over the
 * OpenAI Realtime WebSocket protocol), but the orb is replaced by a
 * TalkingHead 3D avatar with real-time audio-driven lip-sync (HeadAudio).
 *
 * The browser never sees the speech-to-speech backend address: it POSTs the
 * same-origin `/api/session`, we forward the handshake server-side, and only
 * the per-session compute `connect_url` the backend hands back reaches the
 * client (which must dial it directly).
 *
 * Backend selection (first match wins):
 *   LOAD_BALANCER_URL   – a speech-to-speech load balancer (`<lb>/session`).
 *   SESSION_PROXY_URL   – another deployment's session API to piggyback on,
 *                         e.g. https://smolagents-hf-realtime-voice.hf.space/api
 *                         (handy for development; it is metered + queued).
 *   (neither)           – direct mode: the user pastes a realtime WS URL in
 *                         Settings and the browser dials it, no proxy.
 */

import index from "./index.html";

const LOAD_BALANCER_URL = (Bun.env.LOAD_BALANCER_URL ?? "").trim().replace(/\/$/, "");
const SESSION_PROXY_URL = (Bun.env.SESSION_PROXY_URL ?? "").trim().replace(/\/$/, "");
const UPSTREAM = LOAD_BALANCER_URL || SESSION_PROXY_URL;
const PORT = Number(Bun.env.PORT ?? 3000);

/**
 * The upstream (Space proxy mode) meters anonymous users by cookie. Pass each
 * visitor's cookies through both ways so every browser keeps its own identity
 * and daily budget upstream — a shared server-side jar would fold all visitors
 * into one anonymous user.
 */
function sanitizeSetCookie(sc: string): string {
  // The upstream's cookie must re-bind to OUR host, so drop any Domain attr.
  return sc
    .split(";")
    .map((p) => p.trim())
    .filter((p) => !/^domain=/i.test(p))
    .join("; ");
}

/** Forward a JSON call upstream with the visitor's cookies; relay the JSON
 *  body, status, and (re-bound) cookies back — never other upstream headers. */
async function proxy(path: string, req: Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("Cookie", cookie);
  const resp = await fetch(`${UPSTREAM}${path}`, { ...init, headers });
  const body = await resp.text();
  const out = new Response(body, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
  const setCookies =
    resp.headers.getSetCookie?.() ??
    (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie") as string] : []);
  for (const sc of setCookies) out.headers.append("Set-Cookie", sanitizeSetCookie(sc));
  return out;
}

function staticFile(dir: string, name: string): Response {
  // Route params never contain "/", so `name` is a single path segment.
  const file = Bun.file(`${import.meta.dir}/public/${dir}/${name}`);
  return new Response(file);
}

const server = Bun.serve({
  port: PORT,
  routes: {
    "/": index,

    "/api/config": {
      GET: () =>
        Response.json({
          lb: Boolean(UPSTREAM),
          allowDirect: !UPSTREAM,
        }),
    },

    "/api/session": {
      POST: async (req) => {
        if (!UPSTREAM) return Response.json({ error: "Not configured." }, { status: 404 });
        try {
          return await proxy("/session", req, { method: "POST", body: "{}" });
        } catch (err) {
          console.warn("session handshake failed:", err);
          return Response.json({ error: "Speech service unreachable." }, { status: 502 });
        }
      },
    },

    "/api/queue/:id": {
      GET: async (req) => {
        if (!UPSTREAM) return Response.json({ error: "Not configured." }, { status: 404 });
        try {
          return await proxy(`/queue/${encodeURIComponent(req.params.id)}`, req);
        } catch {
          return Response.json({ error: "Speech service unreachable." }, { status: 502 });
        }
      },
      DELETE: async (req) => {
        if (!UPSTREAM) return Response.json({ error: "Not configured." }, { status: 404 });
        try {
          return await proxy(`/queue/${encodeURIComponent(req.params.id)}`, req, { method: "DELETE" });
        } catch {
          return Response.json({ error: "Speech service unreachable." }, { status: 502 });
        }
      },
    },

    // Runtime-loaded assets that must NOT go through the bundler:
    // AudioWorklet modules, the HeadAudio viseme model, and the avatar GLB.
    "/worklets/:name": (req) => staticFile("worklets", req.params.name),
    "/vendor/:name": (req) => staticFile("vendor", req.params.name),
    "/avatars/:name": (req) => staticFile("avatars", req.params.name),
  },

  development:
    Bun.env.NODE_ENV === "production"
      ? false
      : {
          hmr: true,
          console: true,
        },
});

console.log(`gemma-avatar listening on ${server.url}`);
console.log(
  UPSTREAM
    ? `session backend: ${LOAD_BALANCER_URL ? "load balancer" : "session proxy"} (${UPSTREAM})`
    : "session backend: none — direct mode (set LOAD_BALANCER_URL or SESSION_PROXY_URL)",
);
