# Multi-service: Bun serves frontend + API, Python serves Piper TTS.
# HF Spaces (sdk: docker) routes traffic to app_port, set to 7860.
FROM oven/bun:1

# Install Python + pip + curl + ffmpeg (for Whisper audio decoding)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip curl ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python TTS + STT dependencies
RUN pip3 install --break-system-packages piper-tts faster-whisper

# Install Bun dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Download Piper voice model (Spanish female — Daniela)
RUN mkdir -p voices && \
    curl -L -o voices/es_AR-daniela-high.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_AR/daniela/high/es_AR-daniela-high.onnx?download=true" && \
    curl -L -o voices/es_AR-daniela-high.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_AR/daniela/high/es_AR-daniela-high.onnx.json?download=true"

ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860 5000

# Start both services with proper signal forwarding
STOPSIGNAL SIGTERM
CMD ["sh", "-c", "python3 tts_server.py & exec bun index.ts"]
