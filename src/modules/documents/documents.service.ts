import type { ImportSource, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import {
  buildKey,
  deleteObject,
  getDownloadUrl,
  isStorageEnabled,
  putObject,
} from '../../lib/storage';
import { estimatePdfPageCount, startExtraction } from '../imports/imports.service';
import type { importSchema } from './documents.schemas';

type Ctx = { workspaceId: string; userId: string };
type ImportInput = z.infer<typeof importSchema>;

// Resumo dos lotes gerados a partir do documento — deixa o front mostrar se já
// foi importado (CONFIRMED) ou se há uma revisão pendente.
const documentInclude = {
  importBatches: {
    select: { id: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.DocumentInclude;

interface CreateDocumentInput {
  filename: string;
  mimeType: string;
  source: ImportSource;
  data: Buffer;
}

/** Sobe o arquivo ao storage e registra o Document. Requer storage configurado. */
export async function createDocument(db: PrismaClient, ctx: Ctx, input: CreateDocumentInput) {
  if (!isStorageEnabled) throw BadRequest('Storage de documentos não está configurado.');

  const fileKey = buildKey({
    workspaceId: ctx.workspaceId,
    prefix: 'documents',
    ownerId: ctx.userId,
    filename: input.filename,
  });
  await putObject({ key: fileKey, body: input.data, contentType: input.mimeType });

  const document = await db.document.create({
    data: {
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
      filename: input.filename,
      mimeType: input.mimeType,
      fileKey,
      fileSize: input.data.length,
      source: input.source,
      pageCount: input.source === 'PDF' ? estimatePdfPageCount(input.data) : null,
    },
    include: documentInclude,
  });
  return document;
}

export async function listDocuments(
  db: PrismaClient,
  workspaceId: string,
  q: { limit: number },
) {
  const items = await db.document.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: q.limit,
    include: documentInclude,
  });
  return { items };
}

/** URL assinada (temporária) p/ baixar o documento original. */
export async function getDocumentFileUrl(db: PrismaClient, workspaceId: string, id: string) {
  if (!isStorageEnabled) throw BadRequest('Storage de documentos não está configurado.');
  const doc = await db.document.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { fileKey: true, filename: true },
  });
  if (!doc) throw NotFound('Documento não encontrado');
  const url = await getDownloadUrl(doc.fileKey, doc.filename);
  return { url };
}

/** Soft-delete do registro + remoção best-effort do objeto no storage. */
export async function deleteDocument(db: PrismaClient, workspaceId: string, id: string) {
  const doc = await db.document.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true, fileKey: true },
  });
  if (!doc) throw NotFound('Documento não encontrado');
  await db.document.update({ where: { id }, data: { deletedAt: new Date() } });
  if (isStorageEnabled) {
    // Best-effort: a falha em remover o objeto não deve quebrar a exclusão.
    try {
      await deleteObject(doc.fileKey);
    } catch {
      /* objeto pode já não existir */
    }
  }
}

/**
 * (Re)importa o documento com IA: cria um ImportBatch apontando para o mesmo
 * arquivo no storage (fileKey) e dispara a extração reusando todo o fluxo de
 * `imports` (fila/inline). O arquivo é relido do storage na extração.
 */
export async function importDocument(
  db: PrismaClient,
  ctx: Ctx,
  id: string,
  input: ImportInput,
) {
  if (!isStorageEnabled) throw BadRequest('Storage de documentos não está configurado.');
  const doc = await db.document.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
  });
  if (!doc) throw NotFound('Documento não encontrado');

  if (input.accountId) {
    const acc = await db.account.findFirst({
      where: { id: input.accountId, workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!acc) throw BadRequest('Conta inválida para este workspace');
  }
  if (input.creditCardId) {
    const card = await db.creditCard.findFirst({
      where: { id: input.creditCardId, workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!card) throw BadRequest('Cartão inválido para este workspace');
  }

  const batch = await db.importBatch.create({
    data: {
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
      documentId: doc.id,
      source: doc.source,
      status: 'UPLOADED',
      filename: doc.filename,
      mimeType: doc.mimeType,
      fileKey: doc.fileKey,
      // fileData fica null: a extração relê do storage via fileKey.
      fileSize: doc.fileSize,
      pageCount: doc.pageCount,
    },
  });

  return startExtraction(db, ctx, batch.id);
}
