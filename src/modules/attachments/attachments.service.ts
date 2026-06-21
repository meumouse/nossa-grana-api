import type { Attachment, PrismaClient } from '@prisma/client';
import { BadRequest, NotFound } from '../../lib/errors';
import {
  buildKey,
  deleteObject,
  getDownloadUrl,
  isStorageEnabled,
  putObject,
} from '../../lib/storage';

type Ctx = { workspaceId: string; userId: string };

/** Garante que a transação existe e pertence ao workspace; devolve o id. */
async function assertTransaction(db: PrismaClient, workspaceId: string, transactionId: string) {
  const tx = await db.transaction.findFirst({
    where: { id: transactionId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!tx) throw NotFound('Transação não encontrada');
}

/** Serializa um anexo já com a URL assinada de download (validade curta). */
async function withUrl(att: Attachment) {
  return {
    id: att.id,
    transactionId: att.transactionId,
    filename: att.filename,
    mimeType: att.mimeType,
    sizeBytes: att.sizeBytes,
    createdAt: att.createdAt,
    url: await getDownloadUrl(att.url, att.filename ?? undefined),
  };
}

export async function listAttachments(
  db: PrismaClient,
  workspaceId: string,
  transactionId: string,
) {
  await assertTransaction(db, workspaceId, transactionId);
  const items = await db.attachment.findMany({
    where: { transactionId },
    orderBy: { createdAt: 'desc' },
  });
  if (!isStorageEnabled) {
    // Sem storage não há como assinar URLs; devolve metadados sem `url`.
    return {
      items: items.map((a) => ({
        id: a.id,
        transactionId: a.transactionId,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt,
        url: null,
      })),
    };
  }
  return { items: await Promise.all(items.map(withUrl)) };
}

interface CreateAttachmentInput {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export async function createAttachment(
  db: PrismaClient,
  ctx: Ctx,
  transactionId: string,
  input: CreateAttachmentInput,
) {
  if (!isStorageEnabled) throw BadRequest('Storage de anexos não está configurado.');
  await assertTransaction(db, ctx.workspaceId, transactionId);

  const key = buildKey({
    workspaceId: ctx.workspaceId,
    prefix: 'attachments',
    ownerId: transactionId,
    filename: input.filename,
  });
  await putObject({ key, body: input.data, contentType: input.mimeType });

  const att = await db.attachment.create({
    data: {
      transactionId,
      url: key,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
    },
  });
  return withUrl(att);
}

/** Gera uma URL assinada de download para um anexo específico. */
export async function getAttachmentUrl(
  db: PrismaClient,
  workspaceId: string,
  transactionId: string,
  id: string,
) {
  if (!isStorageEnabled) throw BadRequest('Storage de anexos não está configurado.');
  const att = await db.attachment.findFirst({
    where: { id, transactionId, transaction: { workspaceId, deletedAt: null } },
  });
  if (!att) throw NotFound('Anexo não encontrado');
  return { url: await getDownloadUrl(att.url, att.filename ?? undefined) };
}

export async function deleteAttachment(
  db: PrismaClient,
  workspaceId: string,
  transactionId: string,
  id: string,
) {
  const att = await db.attachment.findFirst({
    where: { id, transactionId, transaction: { workspaceId, deletedAt: null } },
  });
  if (!att) throw NotFound('Anexo não encontrado');

  // Remove o objeto do storage (best-effort) antes de apagar a linha — se o
  // storage estiver fora, ainda assim limpamos o registro.
  if (isStorageEnabled) {
    try {
      await deleteObject(att.url);
    } catch {
      // objeto pode já não existir; segue p/ apagar o registro
    }
  }
  await db.attachment.delete({ where: { id: att.id } });
}
