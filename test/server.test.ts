import { test, expect } from "bun:test";
import { createServer } from "../index.ts";

test("GET /api/config reports configured + chat model", async () => {
  const app = createServer({ apiKey: "secret", chatModel: "gemini-2.5-flash", port: 0 });
  try {
    const resp = await fetch(`http://localhost:${app.port}/api/config`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      configured: true,
      chatModel: "gemini-2.5-flash",
      version: "3-avatar",
    });
  } finally {
    app.stop(true);
  }
});

test("GET / serves the bundled app shell", async () => {
  const app = createServer({ apiKey: "secret", port: 0 });
  try {
    const resp = await fetch(`http://localhost:${app.port}/`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("id=\"stage\"");
    expect(html).toContain("id=\"mic-btn\"");
  } finally {
    app.stop(true);
  }
});

test("GET /avatars/brunette.glb serves the avatar model", async () => {
  const app = createServer({ apiKey: "secret", port: 0 });
  try {
    const resp = await fetch(`http://localhost:${app.port}/avatars/brunette.glb`);
    expect(resp.status).toBe(200);
    const buf = new Uint8Array(await resp.arrayBuffer());
    // glTF binary magic: "glTF" + version
    expect(String.fromCharCode(...buf.slice(0, 4))).toBe("glTF");
  } finally {
    app.stop(true);
  }
});

test("/api/live no longer exists (Live API removed)", async () => {
  const app = createServer({ apiKey: "secret", port: 0 });
  try {
    const resp = await fetch(`http://localhost:${app.port}/api/live`);
    expect(resp.status).toBe(404);
  } finally {
    app.stop(true);
  }
});

test("/api/chat relays contents + tools and returns the reply", async () => {
  let received: any = null;
  const rest = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      expect(url.pathname).toContain("generateContent");
      // API key now goes in x-goog-api-key header, not URL query
      expect(req.headers.get("x-goog-api-key")).toBe("test-key");
      received = await req.json();
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Hello from mock" }] } }],
      });
    },
  });

  const app = createServer({
    apiKey: "test-key",
    port: 0,
    restBaseUrl: `http://localhost:${rest.port}`,
  });

  try {
    const resp = await fetch(`http://localhost:${app.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ name: "set_mood", description: "Mood", parameters: { type: "object" } }],
        instructions: "Be terse",
      }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      text: "Hello from mock",
      modelContent: { parts: [{ text: "Hello from mock" }] },
    });
    const payload = received;
    expect(payload.systemInstruction).toEqual({ parts: [{ text: "Be terse" }] });
    expect(payload.tools).toEqual([
      { functionDeclarations: [{ name: "set_mood", description: "Mood", parameters: { type: "object" } }] },
    ]);
    expect(payload.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    // Gemini 3.x: minimal thinking so output tokens reach the visible reply.
    expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(payload.generationConfig.maxOutputTokens).toBeGreaterThan(150);
  } finally {
    app.stop(true);
    rest.stop(true);
  }
});

test("/api/chat relays toolCalls when the model calls a function", async () => {
  const rest = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "set_mood", args: { mood: "happy" } } }],
            },
          },
        ],
      });
    },
  });

  const app = createServer({
    apiKey: "test-key",
    port: 0,
    restBaseUrl: `http://localhost:${rest.port}`,
  });

  try {
    const resp = await fetch(`http://localhost:${app.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      text: "",
      modelContent: { role: "model", parts: [{ functionCall: { name: "set_mood", args: { mood: "happy" } } }] },
      toolCalls: [{ id: "", name: "set_mood", args: { mood: "happy" } }],
    });
  } finally {
    app.stop(true);
    rest.stop(true);
  }
});

test("/api/chat surfaces Gemini errors and refuses without a key", async () => {
  const rest = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ error: { message: "Model not found" } }, { status: 404 });
    },
  });

  const app = createServer({
    apiKey: "test-key",
    port: 0,
    restBaseUrl: `http://localhost:${rest.port}`,
  });
  const noKey = createServer({ apiKey: "", port: 0 });
  try {
    const resp = await fetch(`http://localhost:${app.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: "Model not found" });

    const refused = await fetch(`http://localhost:${noKey.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    expect(refused.status).toBe(503);
  } finally {
    app.stop(true);
    rest.stop(true);
    noKey.stop(true);
  }
});

test("/api/tts proxies to Piper TTS and returns WAV", async () => {
  // Mock Piper TTS server returning a minimal WAV
  const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF" magic
  const tts = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", voice: "test" });
      }
      const body = await req.json();
      expect(body.text).toBe("Hola mundo");
      return new Response(fakeWav, { headers: { "Content-Type": "audio/wav" } });
    },
  });

  const app = createServer({
    apiKey: "test-key",
    port: 0,
    ttsUrl: `http://localhost:${tts.port}`,
  });

  try {
    const resp = await fetch(`http://localhost:${app.port}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hola mundo" }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("audio/wav");
    const buf = new Uint8Array(await resp.arrayBuffer());
    expect(String.fromCharCode(...buf.slice(0, 4))).toBe("RIFF");
  } finally {
    app.stop(true);
    tts.stop(true);
  }
});

test("/api/tts returns 400 for empty text", async () => {
  const tts = Bun.serve({
    port: 0,
    fetch() { return Response.json({ status: "ok" }); },
  });

  const app = createServer({
    apiKey: "test-key",
    port: 0,
    ttsUrl: `http://localhost:${tts.port}`,
  });

  try {
    const resp = await fetch(`http://localhost:${app.port}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(resp.status).toBe(400);
  } finally {
    app.stop(true);
    tts.stop(true);
  }
});

test("/api/verify-key rejects bad keys and adopts good ones", async () => {
  const rest = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1beta/models") {
        if (req.headers.get("x-goog-api-key") === "good-key") {
          return Response.json({ models: [{ name: "models/gemini-2.5-flash" }] });
        }
        return Response.json(
          { error: { message: "API key not valid. Please pass a valid API key." } },
          { status: 400 },
        );
      }
      // generateContent — the adopted key must be used for chat.
      expect(req.headers.get("x-goog-api-key")).toBe("good-key");
      return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    },
  });

  const app = createServer({ apiKey: "", port: 0, restBaseUrl: `http://localhost:${rest.port}` });
  try {
    const post = (body: any) =>
      fetch(`http://localhost:${app.port}/api/verify-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // No key provided and none configured -> refused.
    expect((await post({})).status).toBe(400);

    // Bad key surfaces Gemini's error.
    const bad = await post({ apiKey: "stale-key" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      valid: false,
      error: "API key not valid. Please pass a valid API key.",
    });

    // Good key verifies...
    const good = await post({ apiKey: "good-key" });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ valid: true, chatModel: "gemini-3.5-flash" });

    // ...and is adopted as the active key for /api/chat.
    const chat = await fetch(`http://localhost:${app.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    expect(chat.status).toBe(200);
  } finally {
    app.stop(true);
    rest.stop(true);
  }
});

test("/api/chat falls back to another Gemini model when the primary is unavailable", async () => {
  const hits: string[] = [];
  const rest = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // /v1beta/models/<model>:generateContent
      const model = url.pathname.split("/")[3]!.split(":")[0]!;
      hits.push(model);
      if (model === "gemini-3.5-flash") {
        return Response.json(
          { error: { message: "models/gemini-3.5-flash is not found for API version v1beta." } },
          { status: 404 },
        );
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: `hello from ${model}` }] } }],
      });
    },
  });

  const app = createServer({
    apiKey: "test-key",
    chatModel: "gemini-3.5-flash",
    port: 0,
    restBaseUrl: `http://localhost:${rest.port}`,
  });

  try {
    const chat = () =>
      fetch(`http://localhost:${app.port}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      });

    // First request walks past the unavailable primary onto the next fallback.
    expect((await chat()).status).toBe(200);
    expect(hits).toEqual(["gemini-3.5-flash", "gemini-3.6-flash"]);

    // ...and stays on the working model for subsequent requests.
    hits.length = 0;
    const again = await chat();
    expect(await again.json()).toMatchObject({ text: "hello from gemini-3.6-flash" });
    expect(hits).toEqual(["gemini-3.6-flash"]);
  } finally {
    app.stop(true);
    rest.stop(true);
  }
});
