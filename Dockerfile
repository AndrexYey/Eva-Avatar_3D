# Single container: Bun serves the bundled front-end AND the /api/session
# proxy. HF Spaces (sdk: docker) routes traffic to app_port, set to 7860.
FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=7860
# Public session API of the source demo. Not a secret. To talk to a pool
# directly instead, set LOAD_BALANCER_URL in the Space settings (a secret),
# which takes precedence in index.ts.
ENV SESSION_PROXY_URL=https://smolagents-hf-realtime-voice.hf.space/api

EXPOSE 7860

USER bun

CMD ["bun", "index.ts"]
