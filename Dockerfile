# Refurbiz Inventory - imagen unica (API + web ya compilada)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build

FROM node:22-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --include-workspace-root && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 3000
# db-setup es idempotente: crea el usuario/base la primera vez y aplica migraciones pendientes en cada arranque.
CMD ["sh", "-c", "node server/dist/cli/db-setup.js && node server/dist/index.js"]
