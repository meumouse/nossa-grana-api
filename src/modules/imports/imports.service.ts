import type { ImportSource, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import { randomUUID } from '../../lib/tokens';
import { getExtractor, resolveLlmConfig, type ExtractedTransaction } from '../../lib/llm';
import { buildKey, getDownloadUrl, isStorageEnabled, putObject } from '../../lib/storage';
import { createTransaction } from '../transactions/transactions.service';
import { parseCsv, parseOfx, type ParsedRow } from './parsers';
import type { confirmSchema, patchItemSchema } from './imports.schemas';

type Ctx = { workspaceId: string; userId: string };
type PatchInput = z.infer<typeof patchItemSchema>;
type ConfirmInput = z.infer<typeof confirmSchema>;

const batchInclude = {
  items: { orderBy: { date: 'asc' } },
} satisfies Prisma.ImportBatchInclude;

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
    include: { _count: { select: { items: true } } },
  });
  return { items };
}

export async function getBatch(db: PrismaClient, workspaceId: string, id: string) {
  const batch = await db.importBatch.findFirst({
    where: { id, workspaceId, deletedAt: null },
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
}

/**
 * Cria o lote, roda a extração (IA p/ PDF/imagem; parser p/ CSV/OFX) e grava os
 * itens em PENDING_REVIEW. Em caso de erro, o lote fica FAILED com a mensagem.
 */
export async function createBatch(db: PrismaClient, ctx: Ctx, input: CreateBatchInput) {
  if (input.defaultAccountId) await assertAccount(db, ctx.workspaceId, input.defaultAccountId);

  const settings = await db.workspaceSettings.findUnique({
    where: { workspaceId: ctx.workspaceId },
    select: { llmProvider: true, llmModel: true, llmApiKey: true },
  });
  const extractor = getExtractor(resolveLlmConfig(settings));
  const batch = await db.importBatch.create({
    data: {
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
      source: input.source,
      status: 'PROCESSING',
      filename: input.filename,
      mimeType: input.mimeType,
      model: extractor.modelLabel,
    },
  });

  // Persiste o documento original em storage (best-effort): uma falha aqui não
  // derruba a importação, que é a função principal. A chave fica no batch p/
  // auditoria e eventual reprocessamento.
  if (isStorageEnabled) {
    try {
      const key = buildKey({
        workspaceId: ctx.workspaceId,
        prefix: 'imports',
        ownerId: ctx.userId,
        filename: input.filename,
      });
      await putObject({ key, body: input.data, contentType: input.mimeType });
      await db.importBatch.update({ where: { id: batch.id }, data: { fileKey: key } });
    } catch {
      // segue sem persistir o arquivo — não bloqueia a extração
    }
  }

  try {
    const categories = await loadCategories(db, ctx.workspaceId);
    const categoryNames = categories.map((c) => c.name);

    let extracted: ExtractedTransaction[];
    let raw: Prisma.InputJsonValue;

    if (input.source === 'PDF' || input.source === 'IMAGE') {
      const result = await extractor.extractFromDocument({
        data: input.data,
        mimeType: input.mimeType,
        filename: input.filename,
        source: input.source,
        categoryNames,
      });
      extracted = result.items;
      raw = result as unknown as Prisma.InputJsonValue;
    } else {
      const text = input.data.toString('utf8');
      const rows: ParsedRow[] = input.source === 'CSV' ? parseCsv(text) : parseOfx(text);
      const suggestions = await extractor.categorizeRows({
        rows: rows.map((r) => ({ description: r.description, type: r.type })),
        categoryNames,
      });
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

    await db.importItem.createMany({
      data: extracted.map((it) => {
        const d = new Date(it.date);
        return {
          batchId: batch.id,
          date: Number.isNaN(d.getTime()) ? new Date() : d,
          description: it.description.slice(0, 200),
          amount: it.amount,
          type: it.type,
          suggestedCategory: it.suggestedCategory ?? null,
          categoryId: matchCategory(categories, it.suggestedCategory),
          accountId: input.defaultAccountId ?? null,
          confidence: it.confidence ?? null,
          status: 'PENDING' as const,
        };
      }),
    });

    await db.importBatch.update({
      where: { id: batch.id },
      data: { status: 'PENDING_REVIEW', rawExtraction: raw },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao processar o documento';
    await db.importBatch.update({
      where: { id: batch.id },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    throw err;
  }

  return getBatch(db, ctx.workspaceId, batch.id);
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
  if (input.categoryId) await assertCategory(db, workspaceId, input.categoryId);

  return db.importItem.update({
    where: { id: itemId },
    data: {
      date: input.date,
      description: input.description,
      amount: input.amount,
      type: input.type,
      categoryId: input.categoryId,
      accountId: input.accountId,
      status: input.status,
    },
  });
}

/**
 * Confirma o lote: cada item ACCEPTED vira uma Transaction (reusa
 * createTransaction — regras de cartão/fatura, tags e log num só lugar).
 * Itens já IMPORTED são ignorados, então reexecutar não duplica.
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
  if (batch.status === 'CANCELED' || batch.status === 'FAILED') {
    throw BadRequest('Esta importação não pode ser confirmada.');
  }
  if (input.defaultAccountId) await assertAccount(db, ctx.workspaceId, input.defaultAccountId);

  const items = await db.importItem.findMany({
    where: { batchId, status: 'ACCEPTED' },
  });
  if (items.length === 0) throw BadRequest('Nenhum item marcado para importar.');

  let imported = 0;
  for (const item of items) {
    const accountId = item.accountId ?? input.defaultAccountId;
    if (!accountId) {
      throw BadRequest(`Defina a conta do lançamento "${item.description}" antes de confirmar.`);
    }

    const tx = await createTransaction(db, ctx, {
      clientId: randomUUID(),
      accountId,
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
  const result = await getBatch(db, ctx.workspaceId, batchId);
  return { batch: result, imported };
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
    data: { status: 'CANCELED', deletedAt: new Date() },
  });
}
