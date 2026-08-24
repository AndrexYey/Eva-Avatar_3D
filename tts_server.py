"""
Lightweight TTS + STT HTTP server.
  TTS: Piper (ONNX) — POST /tts { "text": "..." } -> WAV audio bytes.
  STT: faster-whisper — POST /stt (multipart audio) -> { "text": "..." }.
Voice: es_AR-daniela-high (Spanish female, ~108 MB model).
"""

import io
import json
import os
import signal
import sys
import tempfile
import wave
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# ── Piper TTS ────────────────────────────────────────────────────────────
try:
    from piper import PiperVoice
except Exception as e:
    print("[server] FATAL: falta el paquete 'piper-tts' — ejecuta el lanzador "
          f"Iniciar-EVA de tu sistema o: pip install piper-tts ({e})", file=sys.stderr)
    sys.exit(1)

# ── Piper TTS ────────────────────────────────────────────────────────────
MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices")
MODEL_ONNX = os.path.join(MODEL_DIR, "es_AR-daniela-high.onnx")
MODEL_JSON = os.path.join(MODEL_DIR, "es_AR-daniela-high.onnx.json")
PORT = int(os.environ.get("TTS_PORT", "5000"))
MAX_TEXT_LENGTH = 5000

print(f"[server] Loading Piper voice from {MODEL_ONNX} ...")
try:
    voice = PiperVoice.load(MODEL_ONNX, MODEL_JSON)
except Exception as e:
    print(f"[server] FATAL: Could not load Piper voice model: {e}", file=sys.stderr)
    sys.exit(1)
print(f"[server] Piper voice loaded. Sample rate: {voice.config.sample_rate}")

# ── faster-whisper STT ──────────────────────────────────────────────────
whisper_model = None
try:
    from faster_whisper import WhisperModel
    # 'base' transcribes real speech far better than 'tiny' (still fast int8/CPU).
    _model_size = os.environ.get("WHISPER_MODEL", "base")
    print(f"[server] Loading Whisper model '{_model_size}' (first run downloads) ...")
    whisper_model = WhisperModel(_model_size, device="cpu", compute_type="int8")
    print(f"[server] Whisper model loaded.")
except ImportError:
    print("[server] WARNING: faster-whisper not installed — /stt will be unavailable.", file=sys.stderr)
    print("[server]   Install with: pip install faster-whisper", file=sys.stderr)
except Exception as e:
    print(f"[server] WARNING: Could not load Whisper model: {e}", file=sys.stderr)


def synthesize_wav(text: str) -> bytes:
    """Synthesize text to WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(voice.config.sample_rate)
        for chunk in voice.synthesize(text):
            wav_file.writeframes(chunk.audio_int16_bytes)
    return buf.getvalue()


def parse_multipart_audio(content_type: str, body: bytes) -> bytes | None:
    """Extract the first audio file from a multipart/form-data body."""
    # Get boundary (may be quoted per RFC 2046)
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[len("boundary="):].strip().strip('"')
            break
    if not boundary:
        return None

    sep = f"--{boundary}".encode()
    # Split body by boundary
    parts = body.split(sep)
    for part in parts:
        # Each part: headers\r\n\r\n<data>
        if b"\r\n\r\n" not in part:
            continue
        headers_raw, data = part.split(b"\r\n\r\n", 1)
        headers_str = headers_raw.decode("utf-8", errors="replace")
        # Look for filename (indicates file upload)
        if 'name="' not in headers_str:
            continue
        # Strip trailing --\r\n if present
        if data.endswith(b"\r\n"):
            data = data[:-2]
        if data:
            return data
    return None


class TTSHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "voice": "es_AR-daniela-high",
                "stt": whisper_model is not None,
            }).encode())
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/tts":
            self._handle_tts()
        elif self.path == "/stt":
            self._handle_stt()
        else:
            self.send_error(404)

    def _handle_tts(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 1024 * 100:
            self.send_error(413, "Request too large")
            return

        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        text = data.get("text", "").strip()
        if not text:
            self.send_error(400, "Missing 'text' field")
            return

        if len(text) > MAX_TEXT_LENGTH:
            text = text[:MAX_TEXT_LENGTH]

        try:
            wav_bytes = synthesize_wav(text)
        except Exception as e:
            print(f"[server] TTS synthesis error: {e}")
            self.send_error(500, f"Synthesis failed: {e}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(wav_bytes)

    def _handle_stt(self):
        if whisper_model is None:
            self._json_response(503, {"error": "STT not available — faster-whisper not installed."})
            return

        content_type = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", 0))
        if length > 1024 * 1024 * 25:  # 25 MB max
            self.send_error(413, "Audio too large")
            return

        body = self.rfile.read(length)
        audio_data = parse_multipart_audio(content_type, body)
        if not audio_data or len(audio_data) < 500:
            self._json_response(400, {"error": "No audio data received or audio too short."})
            return

        # Write audio to temp file for Whisper (it needs a file path)
        suffix = ".webm"
        if "ogg" in content_type:
            suffix = ".ogg"
        elif "wav" in content_type:
            suffix = ".wav"

        tmp = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                f.write(audio_data)
                tmp = f.name

            segments, info = whisper_model.transcribe(
                tmp,
                language="es",
                beam_size=3,
                vad_filter=True,
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            print(f"[server] STT result: '{text}' (lang={info.language}, prob={info.language_probability:.2f})")
            self._json_response(200, {"text": text})
        except Exception as e:
            print(f"[server] STT error: {e}")
            self._json_response(500, {"error": f"Transcription failed: {e}"})
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    def _json_response(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, fmt, *args):
        print(f"[server] {fmt % args}")


def main():
    # Threaded: a long TTS synthesis must not block STT (or /health) requests.
    server = ThreadingHTTPServer(("0.0.0.0", PORT), TTSHandler)

    def shutdown(sig, frame):
        print("\n[server] Shutting down...")
        # server.shutdown() would deadlock here: it waits for serve_forever()
        # to exit, but this handler runs in the same thread. Unwind instead.
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
