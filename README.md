# Nossa Grana — API

Backend headless do **Nossa Grana** (PWA de finanças pessoais & familiares).
Fastify + TypeScript + Prisma + PostgreSQL. Multi-tenant por workspace, auth JWT
(access + refresh rotativo), sync offline-first, importação por LLM e jobs.

O frontend vive em um repositório separado: **`nossa-grana-app`**.

## Sumário

- [Stack](#stack)
- [Rodando em dev](#rodando-em-dev)
- [Docker (API + banco)](#docker-api--banco)
- [Scripts](#scripts)
- [Integrações](#integrações) — **inclui como obter credenciais**
  - [PostgreSQL](#1-postgresql-obrigatório)
  - [JWT / autenticação](#2-jwt--autenticação-obrigatório)
  - [Login com Google](#3-login-com-google-opcional)
  - [E-mail transacional (Resend)](#4-e-mail-transacional-resend-opcional)
  - [Importação por IA (LLM)](#5-importação-por-ia-llm-opcional)
  - [Object storage (S3 / R2 / MinIO)](#6-object-storage-s3--r2--minio-opcional)
  - [Redis (cache + fila)](#7-redis-cache--fila-opcional)
- [Referência de variáveis de ambiente](#referência-de-variáveis-de-ambiente)

## Stack

- **Fastify 5** + **TypeScript**
- **Prisma 6** + **PostgreSQL 16**
- **JWT** (`@fastify/jwt`), argon2 (`@node-rs/argon2`)
- **Zod** para validação
- **BullMQ** + **Redis** (fila de importação e cache — opcionais)
- **LLM** (OpenAI / Anthropic / Google) para importação de extratos/faturas — provider trocável por env
- **S3-compatível** (AWS S3 / Cloudflare R2 / MinIO) para documentos e anexos — opcional
- **Resend** para e-mail transacional — opcional

## Rodando em dev

Pré-requisitos: **Node ≥ 20** e (opcional) **Docker** para o banco.

```bash
npm install
cp .env.example .env          # ajuste os segredos (ver Integrações)
npm run db:up                 # sobe só o Postgres (docker compose) na porta 5433
npm run prisma:migrate        # cria o schema (ou: npx prisma db push)
npm run seed                  # bancos BR + categorias padrão
npm run dev                   # API em http://localhost:3333  (GET /health)

# opcionais, em outro terminal:
npm run redis:up              # sobe o Redis (porta 6380) p/ cache + fila
npm run worker                # worker da fila de importação (BullMQ)
npm run jobs                  # runner de jobs (recorrências, faturas)
```

Sem Docker para o banco? Aponte `DATABASE_URL` no `.env` para o seu Postgres.

> **Antes de concluir qualquer mudança**, rode `npm run typecheck` — é a principal
> rede de segurança (não há testes automatizados ainda).

## Docker (API + banco)

```bash
docker network create nossa-grana-net   # uma vez (rede compartilhada com o app)
docker compose up -d                     # sobe db + redis + api
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
| `npm run db:up` / `db:down` | Sobe/derruba o Postgres (docker) |
| `npm run redis:up` | Sobe o Redis (docker) |
| `npm run prisma:migrate` | `prisma migrate dev` |
| `npm run prisma:deploy` | `prisma migrate deploy` (prod) |
| `npm run prisma:studio` | Prisma Studio |
| `npm run seed` | Seed do banco (bancos BR + categorias padrão) |
| `npm run jobs` | Runner de jobs (recorrências, faturas) |
| `npm run worker` | Worker da fila BullMQ (importação) |

## Integrações

Cada integração abaixo lista **o que faz**, **as variáveis de ambiente** e **como
obter as credenciais**. Tudo, exceto PostgreSQL e os segredos JWT, é **opcional** —
a API sobe sem eles e apenas o recurso correspondente fica desligado. As variáveis
são validadas no boot por [`src/env.ts`](src/env.ts) (Zod); cada uma também vem
comentada no [`.env.example`](.env.example).

### 1. PostgreSQL (obrigatório)

Banco de dados principal. Todo o estado financeiro vive aqui.

| Variável | Descrição |
| --- | --- |
| `DATABASE_URL` | String de conexão (`postgresql://user:senha@host:porta/db?schema=public`) |

**Como obter:**

- **Dev (recomendado):** `npm run db:up` sobe um Postgres 16 em Docker na porta
  `5433` com usuário/senha/banco `nossagrana`. A `DATABASE_URL` do `.env.example`
  já aponta para ele.
- **Sem Docker:** instale o PostgreSQL 16, crie um banco e aponte a `DATABASE_URL`.
- **Produção:** use um Postgres gerenciado (EasyPanel, Neon, Supabase, RDS, etc.)
  e copie a connection string.

Depois, rode `npm run prisma:migrate` (dev) ou `npx prisma db push` (sincronizar
sem versionar migration — cenário atual do projeto) e `npm run seed`.

### 2. JWT / autenticação (obrigatório)

Assinatura dos tokens de acesso e refresh, e cifragem de segredos guardados no banco.

| Variável | Descrição |
| --- | --- |
| `JWT_ACCESS_SECRET` | Segredo do access token (mín. 24 chars) |
| `JWT_REFRESH_SECRET` | Segredo do refresh token (mín. 24 chars) |
| `ACCESS_TOKEN_TTL` | Validade do access token (ex.: `15m`) |
| `REFRESH_TOKEN_TTL_DAYS` | Validade do refresh token em dias (ex.: `30`) |
| `SETTINGS_ENCRYPTION_KEY` | (Opcional) chave p/ cifrar segredos no banco. Se ausente, deriva do `JWT_REFRESH_SECRET` |

**Como obter:** gere segredos longos e aleatórios:

```bash
openssl rand -hex 48
```

> ⚠️ **Não troque** `SETTINGS_ENCRYPTION_KEY` (nem o `JWT_REFRESH_SECRET`, quando
> ele é a fonte da chave) em um ambiente que já tem a chave de LLM por workspace
> salva — isso torna a chave cifrada ilegível.

### 3. Login com Google (opcional)

Permite "Entrar com Google" via **Google Identity Services**. O app obtém um
*ID token* e o backend o valida contra o Client ID (não precisa de client secret).
Se o e-mail já existir, a conta Google é vinculada à conta existente.

| Variável | Descrição |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID OAuth (usado como `audience` ao validar o ID token) |

No PWA, defina o **mesmo valor** em `VITE_GOOGLE_CLIENT_ID`. Sem essas variáveis,
o botão não aparece e o app segue com e-mail/senha.

**Como obter o Client ID:**

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/) e crie (ou
   selecione) um projeto.
2. Configure a **OAuth consent screen**: *APIs & Services → OAuth consent screen*.
   Escolha **External**, preencha nome do app, e-mail de suporte e domínio. Em dev
   pode ficar em modo *Testing*.
3. Vá em **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
4. Em **Application type**, escolha **Web application**.
5. Em **Authorized JavaScript origins**, adicione as origens do PWA:
   - Dev: `http://localhost:5173` (e `http://localhost:5180` se usar o launch.json)
   - Produção: `https://seu-dominio.app`
6. *(Authorized redirect URIs não é necessário — usamos o fluxo de ID token do GIS.)*
7. Copie o **Client ID** e cole em `GOOGLE_OAUTH_CLIENT_ID` (API) e
   `VITE_GOOGLE_CLIENT_ID` (App).

### 4. E-mail transacional (Resend) (opcional)

Envia recuperação de senha, verificação de e-mail e boas-vindas. **Sem a chave,
os e-mails são apenas logados e pulados** — o app funciona normalmente.

| Variável | Descrição |
| --- | --- |
| `RESEND_API_KEY` | Chave de API do Resend |
| `RESEND_FROM` | Remetente `Nome <endereco@dominio>` (domínio verificado) |
| `APP_URL` | URL pública do PWA — base dos links enviados por e-mail |
| `PASSWORD_RESET_TTL_MINUTES` | Validade do link de reset (default 30) |
| `EMAIL_VERIFICATION_TTL_HOURS` | Validade do link de verificação (default 24) |

**Como obter a chave:**

1. Crie uma conta em [resend.com](https://resend.com).
2. Vá em **API Keys** → [resend.com/api-keys](https://resend.com/api-keys) e gere
   uma chave. Cole em `RESEND_API_KEY`.
3. Para enviar de um domínio próprio, verifique-o em **Domains** (registros
   SPF/DKIM) e use-o no `RESEND_FROM`.
4. **Em testes**, use o sandbox: `RESEND_FROM="Nossa Grana <onboarding@resend.dev>"`.

### 5. Importação por IA (LLM) (opcional)

Lê extratos, faturas e comprovantes (PDF, imagem, CSV, OFX) com um modelo de
visão e extrai as transações. O **provider é trocável** e **cada workspace pode
configurar o seu próprio provider/modelo/chave** nas Configurações (a chave por
workspace é cifrada no banco). As variáveis abaixo são o **fallback global**.

| Variável | Descrição |
| --- | --- |
| `LLM_PROVIDER` | `openai` \| `anthropic` \| `google` (default `openai`) |
| `LLM_MODEL` | Modelo default (precisa suportar **visão**), ex.: `gpt-4o` |
| `OPENAI_API_KEY` | Chave OpenAI (necessária se `LLM_PROVIDER=openai`) |
| `ANTHROPIC_API_KEY` | Chave Anthropic (se `LLM_PROVIDER=anthropic`) |
| `GOOGLE_API_KEY` | Chave Google AI / Gemini (se `LLM_PROVIDER=google`) |
| `LLM_MAX_OUTPUT_TOKENS` | Teto de tokens de saída (default 8192; suba p/ docs grandes) |
| `LLM_PDF_CHUNK_PAGES` | Páginas por chunk ao fracionar PDFs grandes (0 = desliga) |
| `LLM_CHUNK_CONCURRENCY` | Chunks processados em paralelo (cuidado com rate limit) |
| `LLM_CSV_CHUNK_ROWS` | Linhas por lote ao categorizar CSV/OFX (0 = sem fracionar) |
| `IMPORT_MAX_FILE_MB` | Limite de upload do documento (default 15) |
| `EXTRACTION_CACHE_TTL_SECONDS` | TTL do cache de extração da IA (default 7 dias) |

**Como obter a chave (conforme o provider escolhido):**

- **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
  Modelos com visão: `gpt-4o`, `gpt-4.1` (este aceita até 32768 tokens de saída).
- **Anthropic (Claude)** — [console.anthropic.com](https://console.anthropic.com/)
  → *API Keys*.
- **Google (Gemini)** — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).

> Só é exigida a chave do provider **em uso**. Se `LLM_PROVIDER` aponta para um
> provider sem chave (nem global nem por workspace), a importação por IA falha
> até configurar. O resultado da extração é cacheado para não repagar tokens em
> reprocessamentos (persiste de verdade só com Redis).

### 6. Object storage (S3 / R2 / MinIO) (opcional)

Guarda os documentos enviados à IA e os comprovantes anexados às transações.
**Sem `S3_BUCKET` o storage fica desligado** — a importação por IA continua
processando o arquivo em memória, só não o persiste. Compatível com **AWS S3,
Cloudflare R2 e MinIO**.

| Variável | Descrição |
| --- | --- |
| `S3_BUCKET` | Nome do bucket (define se o storage está ligado) |
| `S3_REGION` | Região (default `us-east-1`) |
| `S3_ACCESS_KEY_ID` | Access key |
| `S3_SECRET_ACCESS_KEY` | Secret key |
| `S3_ENDPOINT` | Endpoint custom p/ R2/MinIO. Vazio = AWS S3 |
| `S3_FORCE_PATH_STYLE` | `true` p/ MinIO (bucket no path); `false` p/ AWS/R2 |
| `S3_PRESIGN_TTL_SECONDS` | Validade das URLs assinadas (default 900) |

**Como obter as credenciais:**

- **AWS S3** — crie um bucket no [console S3](https://s3.console.aws.amazon.com/)
  e um usuário IAM com permissão de `s3:PutObject`/`s3:GetObject` no bucket
  (Access Key + Secret no IAM). Deixe `S3_ENDPOINT` vazio e `S3_FORCE_PATH_STYLE=false`.
- **Cloudflare R2** — em *R2 → Manage R2 API Tokens*, gere um token (Access Key +
  Secret). `S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`,
  `S3_FORCE_PATH_STYLE=false`.
- **MinIO (self-hosted)** — crie o bucket e uma access key no console do MinIO.
  Defina `S3_ENDPOINT` para a URL do MinIO e `S3_FORCE_PATH_STYLE=true`.

### 7. Redis (cache + fila) (opcional)

Dois usos, ambos com fallback sem Redis:

1. **Cache** — sem `REDIS_URL`, roda **em memória** (in-process, zero infra). Com
   Redis, o cache é compartilhado entre instâncias e persiste entre restarts.
2. **Fila (BullMQ)** — com `REDIS_URL`, a confirmação de importação roda em
   background (`npm run worker`), evitando timeout (500) em listas grandes. Sem
   Redis, processa **inline** no request (ok p/ listas pequenas).

| Variável | Descrição |
| --- | --- |
| `REDIS_URL` | Ex.: `redis://localhost:6380`. Ausente = cache em memória + fila inline |
| `CACHE_MAX_MEMORY_ENTRIES` | Teto do cache em memória (ignorado no modo Redis) |
| `CACHE_DEFAULT_TTL_SECONDS` | TTL padrão do cache (default 60) |
| `CACHE_TTL_MEMBER_SECONDS` | TTL da associação usuário↔workspace (default 30) |
| `CACHE_TTL_INSTITUTIONS_SECONDS` | TTL do catálogo de instituições (default 300) |

**Como obter:** em dev, `npm run redis:up` sobe um Redis 7 em Docker na porta
`6380` (use `REDIS_URL=redis://localhost:6380`). Em produção, use um Redis
gerenciado e copie a URL.

## Referência de variáveis de ambiente

| Variável | Obrigatória | Default | Descrição |
| --- | :---: | --- | --- |
| `DATABASE_URL` | ✅ | — | Connection string do Postgres |
| `JWT_ACCESS_SECRET` | ✅ | — | Segredo do access token (≥24 chars) |
| `JWT_REFRESH_SECRET` | ✅ | — | Segredo do refresh token (≥24 chars) |
| `NODE_ENV` | | `development` | `development` \| `test` \| `production` |
| `HOST` | | `0.0.0.0` | Host de bind |
| `PORT` | | `3333` | Porta HTTP |
| `CORS_ORIGIN` | | `http://localhost:5173` | Origens permitidas (separadas por vírgula) |
| `LOG_LEVEL` | | `info` | `fatal`…`trace` \| `silent` |
| `ACCESS_TOKEN_TTL` | | `15m` | Validade do access token |
| `REFRESH_TOKEN_TTL_DAYS` | | `30` | Validade do refresh token (dias) |
| `SETTINGS_ENCRYPTION_KEY` | | (deriva do refresh) | Cifra segredos no banco |
| `GOOGLE_OAUTH_CLIENT_ID` | | — | Client ID p/ login com Google |
| `INVITATION_TTL_DAYS` | | `7` | Validade dos convites de família |
| `APP_URL` | | `http://localhost:5173` | Base dos links de e-mail |
| `RESEND_API_KEY` | | — | Chave do Resend (e-mail) |
| `RESEND_FROM` | | `Nossa Grana <onboarding@resend.dev>` | Remetente |
| `PASSWORD_RESET_TTL_MINUTES` | | `30` | Validade do link de reset |
| `EMAIL_VERIFICATION_TTL_HOURS` | | `24` | Validade do link de verificação |
| `LLM_PROVIDER` | | `openai` | `openai` \| `anthropic` \| `google` |
| `LLM_MODEL` | | `gpt-4o` | Modelo default (com visão) |
| `LLM_MAX_OUTPUT_TOKENS` | | `8192` | Teto de tokens de saída |
| `LLM_PDF_CHUNK_PAGES` | | `4` | Páginas por chunk de PDF (0 = off) |
| `LLM_CHUNK_CONCURRENCY` | | `3` | Chunks em paralelo |
| `LLM_CSV_CHUNK_ROWS` | | `200` | Linhas por lote CSV/OFX (0 = off) |
| `OPENAI_API_KEY` | condicional* | — | Chave OpenAI |
| `ANTHROPIC_API_KEY` | condicional* | — | Chave Anthropic |
| `GOOGLE_API_KEY` | condicional* | — | Chave Google/Gemini |
| `IMPORT_MAX_FILE_MB` | | `15` | Limite de upload (MB) |
| `S3_BUCKET` | | — | Bucket (liga o storage) |
| `S3_REGION` | | `us-east-1` | Região |
| `S3_ACCESS_KEY_ID` | condicional† | — | Access key |
| `S3_SECRET_ACCESS_KEY` | condicional† | — | Secret key |
| `S3_ENDPOINT` | | — | Endpoint custom (R2/MinIO) |
| `S3_FORCE_PATH_STYLE` | | `false` | `true` p/ MinIO |
| `S3_PRESIGN_TTL_SECONDS` | | `900` | Validade das URLs assinadas |
| `REDIS_URL` | | — | Liga cache Redis + fila BullMQ |
| `CACHE_MAX_MEMORY_ENTRIES` | | `5000` | Teto do cache em memória |
| `CACHE_DEFAULT_TTL_SECONDS` | | `60` | TTL padrão do cache |
| `CACHE_TTL_MEMBER_SECONDS` | | `30` | TTL da membership |
| `CACHE_TTL_INSTITUTIONS_SECONDS` | | `300` | TTL das instituições |
| `EXTRACTION_CACHE_TTL_SECONDS` | | `604800` | TTL do cache de extração (7 dias) |

\* Exigida apenas a chave do `LLM_PROVIDER` em uso (ou configurada por workspace).
† Exigidas se `S3_BUCKET` estiver definido.
