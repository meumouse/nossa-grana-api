import type { ImportSource, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { env, queueEnabled } from '../../env';
import { BadRequest, NotFound } from '../../lib/errors';
import { enqueueConfirmImport, enqueueExtractImport } from '../../lib/queue';
import { randomUUID } from '../../lib/tokens';
import {
  categorizeRowsChunked,
  extractDocumentChunked,
  getExtractor,
  resolveLlmConfig,
  type ExtractedTransaction,
} from '../../lib/llm';
import { buildKey, getDownloadUrl, getObject, isStorageEnabled, putObject } from '../../lib/storage';
import { createTransaction } from '../transactions/transactions.service';
import { parseCsv, parseOfx, type ParsedRow } from './parsers';
import type { confirmSchema, patchItemSchema } from './imports.schemas';

type Ctx = { workspaceId: string; userId: string };
type PatchInput = z.infer<typeof patchItemSchema>;
type ConfirmInput = z.infer<typeof confirmSchema>;

const batchInclude = {
  items: { orderBy: { date: 'asc' } },
} satisfies Prisma.ImportBatchInclude;

// O blob do documento (fileData) nunca vai nas respostas — é grande e só serve
// internamente à extração. Omitido em toda leitura exposta ao cliente.
const omitFileData = { fileData: true } satisfies Prisma.ImportBatchOmit;

const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

async function loadCategories(db: PrismaClient, workspaceId: string) {
  return db.category.findMany({
    where: { workspaceId, deletedAt: null, archived: false },
    select: { id: true, name: true, kind: true },
  });
}

/** Resolve o nome cru sugerido pela IA para uma categoria existente do workspace. */
function matchCategory(
  categories: { id: string; name: string; kind: string }[],
  suggested?: string | null,
): string | null {
  if (!suggested) return null;
  const target = norm(suggested);
  const hit =
    categories.find((c) => norm(c.name) === target) ??
    categories.find((c) => norm(c.name).includes(target) || target.includes(norm(c.name)));
  return hit?.id ?? null;
}

async function assertAccount(db: PrismaClient, workspaceId: string, accountId: string) {
  const acc = await db.account.findFirst({
    where: { id: accountId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!acc) throw BadRequest('Conta inválida para este workspace');
}

async function assertCard(db: PrismaClient, workspaceId: string, creditCardId: string) {
  const card = await db.creditCard.findFirst({
    where: { id: creditCardId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!card) throw BadRequest('Cartão inválido para este workspace');
}

async function assertCategory(db: PrismaClient, workspaceId: string, categoryId: string) {
  const cat = await db.category.findFirst({
    where: { id: categoryId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!cat) throw BadRequest('Categoria inválida para este workspace');
}

export async function listBatches(
  db: PrismaClient,
  workspaceId: string,
  q: { status?: string; limit: number },
) {
  const items = await db.importBatch.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(q.status ? { status: q.status as never } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: q.limit,
    omit: omitFileData,
    include: { _count: { select: { items: true } } },
  });
  return { items };
}

export async function getBatch(db: PrismaClient, workspaceId: string, id: string) {
  const batch = await db.importBatch.findFirst({
    where: { id, workspaceId, deletedAt: null },
    omit: omitFileData,
    include: batchInclude,
  });
  if (!batch) throw NotFound('Importação não encontrada');
  return batch;
}

interface CreateBatchInput {
  source: ImportSource;
  filename: string;
  mimeType: string;
  data: Buffer;
  defaultAccountId?: string;
  defaultCreditCardId?: string;
}

/**
 * Estima o nº de páginas de um PDF sem dependência externa: conta as marcas
 * `/Type /Page` (e não `/Pages`) no conteúdo. É best-effort — só alimenta a
 * tela de confirmação ("dados do documento"); devolve null se não der p/ medir.
 */
export function estimatePdfPageCount(data: Buffer): number | null {
  try {
    const text = data.toString('latin1');
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    const n = matches ? matches.length : 0;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Cria o lote a partir do upload: valida o dono, mede o arquivo (tamanho/páginas)
 * e guarda os bytes no banco. NÃO roda a IA nem toca o storage — o upload é
 * leve e responde na hora, com o lote em UPLOADED aguardando o usuário confirmar
 * a extração (ver `startExtraction`).
 *
 * Os bytes ficam no banco (`fileData`) só até a extração, que os relê de lá (ou
 * do S3, se configurado) — é o que permite extrair em background na fila sem
 * depender de object storage.
 */
export async function createBatch(db: PrismaClient, ctx: Ctx, input: CreateBatchInput) {
  if (input.defaultAccountId) await assertAccount(db, ctx.workspaceId, input.defaultAccountId);
  if (input.defaultCreditCardId) await assertCard(db, ctx.workspaceId, input.defaultCreditCardId);

  const settings = await db.workspaceSettings.findUnique({
    where: { workspaceId: ctx.workspaceId },
    select: { llmProvider: true, llmModel: true, llmApiKey: true },
  });
  const extractor = getExtractor(resolveLlmConfig(settings));
  const pageCount = input.source === 'PDF' ? estimatePdfPageCount(input.data) : null;

  // Persiste o arquivo no object storage (quando configurado) e registra um
  // Document — é o que alimenta a página "Documentos" e permite reimportar com
  // IA depois. Sem storage, o fluxo degrada: segue só com `fileData` no banco
  // (a extração lê de lá) e o documento não fica disponível na listagem.
  let fileKey: string | null = null;
  let documentId: string | null = null;
  if (isStorageEnabled) {
    fileKey = buildKey({
      workspaceId: ctx.workspaceId,
      prefix: 'documents',
      ownerId: ctx.userId,
      filename: input.filename,
    });
    await putObject({ key: fileKey, body: input.data, contentType: input.mimeType });
    const doc = await db.document.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdById: ctx.userId,
        filename: input.filename,
        mimeType: input.mimeType,
        fileKey,
        fileSize: input.data.length,
        source: input.source,
        pageCount,
      },
    });
    documentId = doc.id;
  }

  const batch = await db.importBatch.create({
    data: {
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
      source: input.source,
      status: 'UPLOADED',
      filename: input.filename,
      mimeType: input.mimeType,
      fileKey,
      documentId,
      // Uint8Array novo: o Buffer do Node (ArrayBufferLike) não casa com o tipo
      // Bytes do Prisma (Uint8Array<ArrayBuffer>).
      fileData: new Uint8Array(input.data),
      fileSize: input.data.length,
      pageCount,
      model: extractor.modelLabel,
    },
  });

  return getBatch(db, ctx.workspaceId, batch.id);
}

/**
 * Dispara a extração (leitura com IA) de um lote já enviado.
 *
 * Valida que o lote aguarda extração (UPLOADED) ou é reprocessável (FAILED),
 * marca PROCESSING e:
 *  - com fila (Redis) e arquivo no storage: enfileira o job (o worker chama
 *    `processExtractBatch`) e retorna `{ queued: true }`; o front acompanha por
 *    polling.
 *  - senão: processa inline (lê o arquivo do storage) e retorna `{ queued: false }`.
 */
export async function startExtraction(db: PrismaClient, ctx: Ctx, batchId: string) {
  const batch = await db.importBatch.findFirst({
    where: { id: batchId, workspaceId: ctx.workspaceId, deletedAt: null },
  });
  if (!batch) throw NotFound('Importação não encontrada');
  if (batch.status === 'PROCESSING') throw BadRequest('Esta importação já está sendo processada.');
  if (batch.status !== 'UPLOADED' && batch.status !== 'FAILED') {
    throw BadRequest('Esta importação não está aguardando extração.');
  }

  await db.importBatch.update({
    where: { id: batchId },
    // Zera o progresso de chunks de uma execução anterior (retry de um FAILED).
    data: { status: 'PROCESSING', error: null, chunkDone: null, chunkTotal: null },
  });

  if (queueEnabled) {
    await enqueueExtractImport({ batchId, workspaceId: ctx.workspaceId, userId: ctx.userId });
    const result = await getBatch(db, ctx.workspaceId, batchId);
    return { batch: result, queued: true as const };
  }

  // Fallback sem fila: processa inline (lê os bytes do banco/storage).
  await processExtractBatch(db, ctx, batchId);
  const result = await getBatch(db, ctx.workspaceId, batchId);
  return { batch: result, queued: false as const };
}

/**
 * Faz a extração de fato: relê o documento (do storage, ou do buffer passado no
 * fluxo inline sem storage), roda a IA (PDF/imagem) ou os parsers (CSV/OFX),
 * grava os ImportItem e move o lote p/ PENDING_REVIEW.
 *
 * Idempotente: limpa os itens anteriores antes de recriar, então reprocessar um
 * lote (retry do BullMQ ou um FAILED reenviado) não acumula duplicatas. Em erro,
 * marca FAILED com a mensagem e relança (deixa o BullMQ aplicar o retry).
 * Executado pelo worker da fila ou inline por `createBatch`/`startExtraction`.
 */
export async function processExtractBatch(
  db: PrismaClient,
  ctx: Ctx,
  batchId: string,
  opts: { data?: Buffer } = {},
): Promise<void> {
  const batch = await db.importBatch.findFirst({
    where: { id: batchId, workspaceId: ctx.workspaceId, deletedAt: null },
  });
  if (!batch) throw NotFound('Importação não encontrada');

  // Reporta progresso do fracionamento gravando no lote (o front lê por polling).
  // Fire-and-forget e monotônico: não bloqueia a extração nem regride o contador.
  let lastDone = 0;
  const onProgress = (done: number, total: number) => {
    if (done < lastDone) return;
    lastDone = done;
    void db.importBatch
      .update({ where: { id: batchId }, data: { chunkDone: done, chunkTotal: total } })
      .catch(() => {});
  };

  try {
    const data =
      opts.data ??
      (batch.fileData ? Buffer.from(batch.fileData) : null) ??
      (batch.fileKey ? await getObject(batch.fileKey) : null);
    if (!data) throw BadRequest('Documento original indisponível para extração.');

    const settings = await db.workspaceSettings.findUnique({
      where: { workspaceId: ctx.workspaceId },
      select: { llmProvider: true, llmModel: true, llmApiKey: true },
    });
    const extractor = getExtractor(resolveLlmConfig(settings));

    const categories = await loadCategories(db, ctx.workspaceId);
    const categoryNames = categories.map((c) => c.name);
    const source = batch.source;
    const mimeType = batch.mimeType ?? 'application/octet-stream';
    const filename = batch.filename ?? 'documento';

    let extracted: ExtractedTransaction[];
    let raw: Prisma.InputJsonValue;

    if (source === 'PDF' || source === 'IMAGE') {
      // Fraciona PDFs grandes em chunks de páginas (melhora a leitura e evita
      // truncar a resposta); imagens/PDFs pequenos seguem em chamada única.
      const result = await extractDocumentChunked(
        extractor,
        { data, mimeType, filename, source, categoryNames },
        { pdfChunkPages: env.LLM_PDF_CHUNK_PAGES, concurrency: env.LLM_CHUNK_CONCURRENCY, onProgress },
      );
      extracted = result.items;
      raw = result as unknown as Prisma.InputJsonValue;
    } else {
      const text = data.toString('utf8');
      const rows: ParsedRow[] = source === 'CSV' ? parseCsv(text) : parseOfx(text);
      const suggestions = await categorizeRowsChunked(
        extractor,
        {
          rows: rows.map((r) => ({ description: r.description, type: r.type })),
          categoryNames,
        },
        env.LLM_CSV_CHUNK_ROWS,
        env.LLM_CHUNK_CONCURRENCY,
        onProgress,
      );
      extracted = rows.map((r, i) => ({
        date: r.date.toISOString().slice(0, 10),
        description: r.description,
        amount: r.amount,
        type: r.type,
        suggestedCategory: suggestions[i] ?? null,
        confidence: null,
      }));
      raw = { rows: rows.map((r) => ({ ...r, date: r.date.toISOString() })), suggestions } as Prisma.InputJsonValue;
    }

    if (extracted.length === 0) {
      throw BadRequest('Nenhuma transação foi reconhecida no documento.');
    }

    // Idempotência: reprocessar (retry/FAILED) não acumula itens. Nesta etapa o
    // lote ainda não tem itens IMPORTED (isso só acontece na confirmação).
    await db.importItem.deleteMany({ where: { batchId } });
    await db.importItem.createMany({
      data: extracted.map((it) => {
        const d = new Date(it.date);
        return {
          batchId,
          date: Number.isNaN(d.getTime()) ? new Date() : d,
          description: it.description.slice(0, 200),
          amount: it.amount,
          type: it.type,
          suggestedCategory: it.suggestedCategory ?? null,
          categoryId: matchCategory(categories, it.suggestedCategory),
          confidence: it.confidence ?? null,
          status: 'PENDING' as const,
        };
      }),
    });

    await db.importBatch.update({
      where: { id: batchId },
      // Zera os bytes (já extraídos) e o progresso de chunks (extração concluída).
      data: {
        status: 'PENDING_REVIEW',
        rawExtraction: raw,
        fileData: null,
        chunkDone: null,
        chunkTotal: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao processar o documento';
    await db.importBatch.update({
      where: { id: batchId },
      data: { status: 'FAILED', error: message.slice(0, 500), chunkDone: null, chunkTotal: null },
    });
    throw err;
  }
}

export async function patchItem(
  db: PrismaClient,
  workspaceId: string,
  batchId: string,
  itemId: string,
  input: PatchInput,
) {
  const item = await db.importItem.findFirst({
    where: { id: itemId, batchId, batch: { workspaceId, deletedAt: null } },
  });
  if (!item) throw NotFound('Item de importação não encontrado');
  if (item.status === 'IMPORTED') throw BadRequest('Item já foi importado e não pode ser editado');

  if (input.accountId) await assertAccount(db, workspaceId, input.accountId);
  if (input.creditCardId) await assertCard(db, workspaceId, input.creditCardId);
  if (input.categoryId) await assertCategory(db, workspaceId, input.categoryId);

  // Dono é exclusivo (conta XOR cartão): definir um zera o outro. Só mexe nos
  // campos de dono quando o patch realmente envia algum deles.
  const ownerPatch =
    input.accountId !== undefined || input.creditCardId !== undefined
      ? input.creditCardId
        ? { creditCardId: input.creditCardId, accountId: null }
        : { accountId: input.accountId ?? null, creditCardId: null }
      : {};

  return db.importItem.update({
    where: { id: itemId },
    data: {
      date: input.date,
      description: input.description,
      amount: input.amount,
      type: input.type,
      categoryId: input.categoryId,
      ...ownerPatch,
      status: input.status,
    },
  });
}

/**
 * Confirma o lote.
 *
 * Valida de forma síncrona (lote existe, há itens marcados, conta padrão ok) e
 * marca o lote como IMPORTING. A criação das transações em si é pesada para
 * listas grandes — fica fora do request:
 *  - com fila (Redis): enfileira o job e retorna `{ queued: true }` na hora; o
 *    worker chama `processConfirmBatch`. O front acompanha por polling.
 *  - sem fila (legado): processa inline e retorna `{ imported }`.
 */
export async function confirmBatch(
  db: PrismaClient,
  ctx: Ctx,
  batchId: string,
  input: ConfirmInput,
) {
  const batch = await db.importBatch.findFirst({
    where: { id: batchId, workspaceId: ctx.workspaceId, deletedAt: null },
  });
  if (!batch) throw NotFound('Importação não encontrada');
  if (batch.status === 'CANCELED') {
    throw BadRequest('Esta importação não pode ser confirmada.');
  }
  // IMPORTING = job em andamento; evita enfileirar/processar em duplicidade.
  // FAILED é reprocessável: o usuário corrige (ex.: conta faltando) e reconfirma.
  if (batch.status === 'IMPORTING') {
    throw BadRequest('Esta importação já está sendo processada.');
  }
  if (input.defaultAccountId) await assertAccount(db, ctx.workspaceId, input.defaultAccountId);
  if (input.defaultCreditCardId) await assertCard(db, ctx.workspaceId, input.defaultCreditCardId);

  const pending = await db.importItem.count({ where: { batchId, status: 'ACCEPTED' } });
  if (pending === 0) throw BadRequest('Nenhum item marcado para importar.');

  await db.importBatch.update({ where: { id: batchId }, data: { status: 'IMPORTING', error: null } });

  if (queueEnabled) {
    await enqueueConfirmImport({
      batchId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      defaultAccountId: input.defaultAccountId,
      defaultCreditCardId: input.defaultCreditCardId,
    });
    const result = await getBatch(db, ctx.workspaceId, batchId);
    return { batch: result, queued: true as const };
  }

  // Fallback sem fila: processa inline (modo legado).
  const imported = await processConfirmBatch(db, ctx, batchId, input);
  const result = await getBatch(db, ctx.workspaceId, batchId);
  return { batch: result, imported, queued: false as const };
}

/**
 * Processa de fato a confirmação: cada item ACCEPTED vira uma Transaction
 * (reusa createTransaction — regras de cartão/fatura, tags e log num só lugar).
 * Itens já IMPORTED são ignorados, então reexecutar não duplica.
 *
 * Move o lote para CONFIRMED ao terminar; em erro, marca FAILED com a mensagem
 * (o front mostra ao usuário) e relança. Executado pelo worker da fila ou,
 * sem fila, inline por `confirmBatch`.
 */
export async function processConfirmBatch(
  db: PrismaClient,
  ctx: Ctx,
  batchId: string,
  input: ConfirmInput,
): Promise<number> {
  try {
    const items = await db.importItem.findMany({ where: { batchId, status: 'ACCEPTED' } });

    let imported = 0;
    for (const item of items) {
      // Dono do lançamento: o do item tem prioridade; cai no padrão do lote.
      // Cartão prevalece sobre conta quando ambos resolverem (createTransaction
      // também ignora a conta se vier cartão).
      const creditCardId = item.creditCardId ?? (item.accountId ? null : input.defaultCreditCardId);
      const accountId = creditCardId ? null : item.accountId ?? input.defaultAccountId;
      if (!accountId && !creditCardId) {
        throw BadRequest(
          `Defina a conta ou o cartão do lançamento "${item.description}" antes de confirmar.`,
        );
      }

      const tx = await createTransaction(db, ctx, {
        clientId: randomUUID(),
        accountId: accountId ?? undefined,
        creditCardId: creditCardId ?? undefined,
        type: item.type as 'INCOME' | 'EXPENSE',
        status: 'COMPLETED',
        amount: Number(item.amount),
        currency: 'BRL',
        description: item.description,
        categoryId: item.categoryId ?? null,
        date: item.date,
      });

      await db.importItem.update({
        where: { id: item.id },
        data: { status: 'IMPORTED', transactionId: tx.id },
      });
      imported += 1;
    }

    await db.importBatch.update({ where: { id: batchId }, data: { status: 'CONFIRMED' } });
    return imported;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao confirmar a importação';
    await db.importBatch.update({
      where: { id: batchId },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    throw err;
  }
}

/**
 * Devolve uma URL assinada (temporária) p/ baixar o documento original do lote.
 * Lança se o storage estiver desligado ou o lote não tiver arquivo persistido.
 */
export async function getBatchFileUrl(db: PrismaClient, workspaceId: string, id: string) {
  if (!isStorageEnabled) throw BadRequest('Storage de documentos não está configurado.');
  const batch = await db.importBatch.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { fileKey: true, filename: true },
  });
  if (!batch) throw NotFound('Importação não encontrada');
  if (!batch.fileKey) throw NotFound('Documento original não disponível para esta importação');
  const url = await getDownloadUrl(batch.fileKey, batch.filename ?? undefined);
  return { url };
}

export async function cancelBatch(db: PrismaClient, workspaceId: string, id: string) {
  const batch = await db.importBatch.findFirst({
    where: { id, workspaceId, deletedAt: null },
  });
  if (!batch) throw NotFound('Importação não encontrada');
  await db.importBatch.update({
    where: { id },
    // Zera os bytes ao cancelar (caso a extração nunca tenha rodado).
    data: { status: 'CANCELED', deletedAt: new Date(), fileData: null },
  });
}
