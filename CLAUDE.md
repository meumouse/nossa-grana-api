# Nossa Grana — API (convenções)

Backend headless: **Fastify 5 + TypeScript + Prisma 6 + PostgreSQL 16**.
Multi-tenant por workspace, auth JWT (access + refresh rotativo), sync
offline-first, importação por LLM e jobs (BullMQ).

> Leia primeiro o [`CLAUDE.md` da raiz](../CLAUDE.md) (princípios que valem nos
> dois serviços) e a [`ARQUITETURA.md`](../nossa-grana-app/ARQUITETURA.md)
> (fundação do modelo).

## Comandos

```bash
npm run dev          # tsx watch — reload em src/index.ts
npm run typecheck    # tsc --noEmit  ← rode SEMPRE antes de concluir
npm run build        # compila para dist/
npm run db:up        # sobe só o Postgres (docker) na porta 5433
npm run redis:up     # sobe o Redis (porta 6380) — opcional
npm run prisma:migrate   # prisma migrate dev
npm run seed         # bancos BR + categorias padrão
npm run jobs         # runner de jobs (recorrências, faturas)
npm run worker       # worker da fila BullMQ (importação)
```

## Estrutura

```
src/
  index.ts        entry point
  server.ts       setup do Fastify (cors, helmet, rate-limit, multipart, plugins)
  routes.ts       árvore de rotas — tudo sob /api
  env.ts          validação das envs com Zod (fonte da verdade de config)
  plugins/        auth, prisma, cache, workspace, error-handler (fastify-plugin)
  modules/        um diretório por domínio (ver padrão abaixo)
  lib/            utilitários compartilhados (llm, email, money, balance, storage…)
  jobs/           scheduler, runner, worker, import-worker (BullMQ)
prisma/
  schema.prisma   schema (fonte da verdade do modelo)
  seed.ts
```

## Padrão de um módulo

Cada domínio em `src/modules/<nome>/` segue **três arquivos** com sufixo:

- `<nome>.routes.ts` — `export default async function xRoutes(app: FastifyInstance)`.
  Só lida com HTTP: parse do input (Zod), chama o service, formata a resposta.
- `<nome>.service.ts` — lógica de negócio + acesso ao Prisma. Recebe `prisma` e o
  contexto (`{ workspaceId, userId }`) por parâmetro; **não** lê `request`.
- `<nome>.schemas.ts` — schemas Zod de request (e refinements de domínio).

Registre a rota nova em [`src/routes.ts`](src/routes.ts) no grupo correto
(público vs. escopado por workspace).

## Regras de ouro do backend

1. **Toda query filtra por `workspaceId`.** Use `request.workspace!.id` nas
   rotas escopadas. Nunca consulte uma entidade financeira sem esse filtro.
2. **Valide todo input com Zod** no início do handler:
   `const body = createTxSchema.parse(request.body)`. Nada de `request.body`
   acessado direto.
3. **Autorização por papel** com `requireRole(...)` no `preHandler`:
   ```ts
   app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => { … })
   ```
   Hierarquia: `OWNER` > `ADMIN` > `MEMBER` > `VIEWER`. `VIEWER` só lê;
   `MEMBER` cria/edita lançamentos; `ADMIN` mexe em membros/config; `OWNER`
   exclui workspace/billing.
4. **Soft delete:** filtre `deletedAt: null` em leituras; ao "excluir", set
   `deletedAt = new Date()` (não `delete`).
5. **Status HTTP:** `reply.code(201).send(...)` em criação. Erros de domínio
   passam pelo `error-handler` central — lance erros tipados, não monte
   resposta de erro na mão.
6. **Logging:** use o **Pino nativo do Fastify** (`src/lib/logger.ts` /
   `request.log`). **NÃO** adicione `pino-http`.
7. **LLM:** sempre via a abstração em `src/lib/llm/` (provider trocável por env:
   `LLM_PROVIDER`, `LLM_MODEL`). Nunca instancie o SDK do provider direto numa
   rota. Para Anthropic/Claude, consulte o skill `claude-api` antes (model ids,
   limites, caching).

## Banco (Prisma)

- `schema.prisma` é a fonte da verdade. Após editar, rode
  `npm run prisma:migrate` (dev) — ou `npx prisma db push` quando estiver só
  sincronizando o banco sem versionar migration (cenário atual do projeto).
- **Dinheiro:** `Decimal(18,2)`; quantidade/preço de ativo: `Decimal(18,8)`.
  Nunca `Float`/`Int` para valores monetários.
- `amount` sempre positivo; o sinal vem do `type`.
- Toda entidade financeira tem: `workspaceId`, `clientId`, `updatedAt`,
  `deletedAt`. Mantenha esse contrato em modelos novos (o sync depende dele).

## Sync (offline-first)

- `POST /sync/push`: lote de mutações idempotentes (upsert por `clientId`).
- `GET /sync/pull?since=`: delta incremental (`updatedAt > since`, inclui
  `deletedAt` preenchido = remoções).
- Conflito = **Last-Write-Wins por `updatedAt`**.

## Segredos / config sensível

- Toda env passa por `src/env.ts` (Zod). Adicione lá ao introduzir uma env nova,
  e documente em `.env.example`.
- A **chave de API LLM por workspace** é cifrada com
  `SETTINGS_ENCRYPTION_KEY ?? JWT_REFRESH_SECRET`. **Não troque esse segredo** em
  ambiente que já tem chave salva — torna a chave existente ilegível.
