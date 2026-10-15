# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/home/node \
    QASE_HOST=0.0.0.0 \
    PORT=5173

WORKDIR /app

# Install browser dependencies from the locked Playwright release rather than
# mixing hand-picked Ubuntu library versions into this Debian image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npx playwright install --with-deps chromium firefox webkit \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force

COPY --chown=node:node public ./public
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/.qase /app/evidence \
    && chown -R node:node /app/.qase /app/evidence

ARG QASE_RELEASE_ID=qase-2026-10-16-single-browser-r4
LABEL org.opencontainers.image.title="QASE" \
      org.opencontainers.image.version=$QASE_RELEASE_ID

USER node
EXPOSE 5173 5180 9174 9175
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:5173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
