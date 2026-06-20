# Nossa Grana — API

Backend headless do **Nossa Grana** (PWA de finanças pessoais & familiares).
Fastify + TypeScript + Prisma + PostgreSQL. Multi-tenant por workspace, auth JWT
(access + refresh rotativo), sync offline-first, importação por LLM e jobs.

O frontend vive em um repositório separado: **`nossa-grana-app`**.

## Stack

- **Fastify 5** + **TypeScript**
- **Prisma 6** + **PostgreSQL 16**
- **JWT** (`@fastify/jwt`), argon2 (`@node-rs/argon2`)
- **Zod** para validação
- **OpenAI** (importação de extratos/faturas por LLM — provider trocável via env)

## Rodando em dev

```bash
npm install
cp .env.example .env          # ajuste os segredos
npm run db:up                 # sobe só o Postgres (docker compose) na porta 5433
npm run prisma:migrate        # cria o schema (ou: npx prisma db push)
npm run seed                  # bancos BR + dados base
npm run dev                   # API em http://localhost:3333  (GET /health)
```

Sem Docker para o banco? Aponte `DATABASE_URL` no `.env` para o seu Postgres.

## Docker (API + banco)

```bash
docker network create nossa-grana-net   # uma vez (rede compartilhada com o app)
docker compose up -d                     # sobe db + api
```

A API publica em `:3333` e entra na rede `nossa-grana-net` com o alias `api`,
para o nginx do repo `nossa-grana-app` fazer proxy `/api → api:3333` sem CORS.

## Scripts

| Script | Descrição |
| --- | --- |
| `npm run dev` | API com reload (tsx watch) |
| `npm run build` | Compila para `dist/` |
| `npm start` | Roda `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:migrate` | `prisma migrate dev` |
| `npm run prisma:deploy` | `prisma migrate deploy` (prod) |
| `npm run prisma:studio` | Prisma Studio |
| `npm run seed` | Seed do banco |
| `npm run jobs` | Runner de jobs (recorrências, faturas) |

## Variáveis de ambiente

Veja [`.env.example`](.env.example). Principais: `DATABASE_URL`, `CORS_ORIGIN`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ACCESS_TOKEN_TTL`,
`REFRESH_TOKEN_TTL_DAYS`. Para importação por LLM: `OPENAI_API_KEY`
(+ `LLM_PROVIDER`, `LLM_MODEL`).
