FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @verifco/api... install --frozen-lockfile --prod \
    && mkdir -p /app/storage && chown node:node /app/storage
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3333 STORAGE_DIR=/app/storage
WORKDIR /app/apps/api
USER node
EXPOSE 3333
CMD ["node", "--import", "tsx", "src/server.ts"]
