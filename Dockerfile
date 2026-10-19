# ---- build: bundle the Phaser client ----
FROM node:24.4-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY client ./client
COPY scripts ./scripts
RUN node scripts/build-client.ts

# ---- runtime: Node runs the TypeScript server directly (type stripping) ----
FROM node:24.4-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    SAVE_FILE=/app/data/world.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
