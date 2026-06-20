# Build context = raiz do repo (nossa-grana-api).
FROM node:22-alpine AS build
WORKDIR /app

# Toolchain p/ módulos nativos (argon2) durante o npm ci.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run prisma:generate \
  && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copia o app já buildado + dependências (com Prisma client gerado).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

EXPOSE 3333

# Sobe o schema no banco (db push) + seed e inicia a API.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx prisma db seed && node dist/index.js"]
