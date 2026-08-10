# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/home/node

WORKDIR /app

# Keep dependency resolution reproducible. Chromium and its OS libraries are
# installed once in the shared image because only worker replicas launch it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY --chown=node:node public ./public
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/.qase \
    && chown -R node:node /app/.qase

USER node
EXPOSE 5173 5180 9174 9175

CMD ["node", "server/index.js"]
