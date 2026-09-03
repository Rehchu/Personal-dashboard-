# Dyer Town — the whole village, in one small always-on container.
# Runs on your Claude subscription (no per-token billing) via a headless
# OAuth token; persists its world and every villager's workshop on a volume.

FROM node:22-slim

# git    — the villagers commit and push their real work
# curl   — installs the Claude CLI as a fallback runtime (see below)
# ca-certificates — outbound HTTPS to the Anthropic + GitHub + Cloudflare APIs
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The Agent SDK bundles a native binary as an OPTIONAL npm dependency; if that
# binary can't run in this image, the SDK falls back to `claude` on PATH. Install
# the CLI as belt-and-suspenders — best effort, never fails the build.
RUN curl -fsSL https://code.claude.com/install.sh | sh || true
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Install deps WITHOUT --omit=optional — the SDK's bundled binary lives there.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY town.mjs ./
COPY public ./public
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The town's world, the workshops, and the SDK's session files (~/.claude) all
# land on the mounted volume, so nothing is lost when the code image is rebuilt
# on a redeploy. HOME must be writable for ~/.claude.
ENV TOWN_DATA_DIR=/data \
    HOME=/data/home \
    NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]
