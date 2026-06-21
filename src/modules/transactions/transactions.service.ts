import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { randomUUID } from '../../lib/tokens';
import { getOrCreateOpenInvoice } from '../invoices/invoices.service';
import { getExtractor, resolveLlmConfig } from '../../lib/llm';
import type {
  analyzeSchema,
  createTxSchema,
  transferSchema,
  updateTxSchema,
  listQuerySchema,
} from './transactions.schemas';

type CreateInput = z.infer<typeof createTxSchema>;
type UpdateInput = z.infer<typeof updateTxSchema>;
type TransferInput = z.infer<typeof transferSchema>;
type ListInput = z.infer<typeof listQuerySchema>;
type AnalyzeInput = z.infer<typeof analyzeSchema>;

const txInclude = {
  category: { select: { id: true, name: true, kind: true, nature: true, color: true, icon: true } },
  account: { select: { id: true, name: true, type: true } },
  tags: { select: { id: true, name: true, color: true } },
} satisfies Prisma.TransactionInclude;

async function assertAccount(db: PrismaClient, workspaceId: string, accountId: string) {
  const acc = await db.account.findFirst({
    where: { id: accountId, workspaceId, deletedAt: null },
    select: {
      id: true,
      workspaceId: true,
      type: true,
      statementClosingDay: true,
      paymentDueDay: true,
    },
  });
  if (!acc) throw BadRequest('Conta inválida para este workspace');
  return acc;
}

async function tagConnect(db: PrismaClient, workspaceId: string, tagIds?: string[]) {
  if (!tagIds || tagIds.length === 0) return undefined;
  const count = await db.tag.count({ where: { id: { in: tagIds }, workspaceId } });
  if (count !== tagIds.length) throw BadRequest('Uma ou mais tags são inválidas');
  return { connect: tagIds.map((id) => ({ id })) };
}

export async function listTransactions(db: PrismaClient, workspaceId: string, q: ListInput) {
  const where: Prisma.TransactionWhereInput = {
    workspaceId,
    deletedAt: null,
    ...(q.accountId ? { accountId: q.accountId } : {}),
    ...(q.categoryId ? { categoryId: q.categoryId } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.from || q.to
      ? { date: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
    ...(q.search ? { description: { contains: q.search, mode: 'insensitive' } } : {}),
  };

  const items = await db.transaction.findMany({
    where,
    include: txInclude,
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });

  const hasMore = items.length > q.limit;
  const page = hasMore ? items.slice(0, q.limit) : items;
  return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
}

/**
 * Verificação de inconsistências do extrato com IA. Recebe as transações do
 * cliente (offline-first: inclui lançamentos ainda não sincronizados) e devolve
 * os achados da IA. Stateless — não grava nada; o cliente decide o que fazer.
 */
export async function analyzeStatement(
  db: PrismaClient,
  workspaceId: string,
  input: AnalyzeInput,
) {
  const settings = await db.workspaceSettings.findUnique({
    where: { workspaceId },
    select: { llmProvider: true, llmModel: true, llmApiKey: true },
  });
  const extractor = getExtractor(resolveLlmConfig(settings));

  const categories = await db.category.findMany({
    where: { workspaceId, deletedAt: null, archived: false },
    select: { name: true },
  });

  const result = await extractor.analyzeTransactions({
    transactions: input.transactions,
    checks: input.checks,
    categoryNames: categories.map((c) => c.name),
  });
  return result;
}

export async function createTransaction(
  db: PrismaClient,
  ctx: { workspaceId: string; userId: string },
  input: CreateInput,
) {
  const account = await assertAccount(db, ctx.workspaceId, input.accountId);
  const tags = await tagConnect(db, ctx.workspaceId, input.tagIds);

  // Compra no cartão: vincula automaticamente à fatura do ciclo, se não veio uma.
  let invoiceId = input.creditCardInvoiceId ?? null;
  if (!invoiceId && input.type === 'EXPENSE' && account.type === 'CREDIT_CARD') {
    const invoice = await getOrCreateOpenInvoice(db, account, input.date);
    invoiceId = invoice?.id ?? null;
  }

  const tx = await db.transaction.create({
    data: {
      workspaceId: ctx.workspaceId,
      clientId: input.clientId ?? null,
      accountId: input.accountId,
      type: input.type,
      status: input.status,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      notes: input.notes ?? null,
      categoryId: input.categoryId ?? null,
      date: input.date,
      dueDate: input.dueDate ?? null,
      paidAt: input.status === 'COMPLETED' ? input.paidAt ?? input.date : input.paidAt ?? null,
      creditCardInvoiceId: invoiceId,
      createdById: ctx.userId,
      tags,
    },
    include: txInclude,
  });

  await logActivity(db, {
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    action: 'transaction.created',
    entityType: 'Transaction',
    entityId: tx.id,
    metadata: { amount: tx.amount.toString(), type: tx.type, description: tx.description },
  });

  return tx;
}

export async function updateTransaction(
  db: PrismaClient,
  ctx: { workspaceId: string },
  id: string,
  input: UpdateInput,
) {
  const existing = await db.transaction.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
  });
  if (!existing) throw NotFound('Transação não encontrada');
  if (existing.type === 'TRANSFER') {
    throw BadRequest('Edite transferências excluindo e recriando (mantém as duas pernas íntegras)');
  }

  if (input.accountId) await assertAccount(db, ctx.workspaceId, input.accountId);
  const tags = input.tagIds ? await tagConnect(db, ctx.workspaceId, input.tagIds) : undefined;

  return db.transaction.update({
    where: { id },
    data: {
      accountId: input.accountId,
      type: input.type,
      status: input.status,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      notes: input.notes,
      categoryId: input.categoryId,
      date: input.date,
      dueDate: input.dueDate,
      paidAt: input.paidAt,
      ...(tags ? { tags: { set: [], ...tags } } : {}),
    },
    include: txInclude,
  });
}

export async function deleteTransaction(db: PrismaClient, workspaceId: string, id: string) {
  const existing = await db.transaction.findFirst({
    where: { id, workspaceId, deletedAt: null },
  });
  if (!existing) throw NotFound('Transação não encontrada');

  // Transferência: remove as duas pernas juntas.
  if (existing.transferId) {
    await db.transaction.updateMany({
      where: { transferId: existing.transferId, workspaceId },
      data: { deletedAt: new Date() },
    });
    return;
  }
  await db.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
}

/**
 * Pagar/receber: efetiva uma transação PENDING (conta a pagar/receber). Vira
 * COMPLETED e ganha paidAt — só então entra no saldo.
 */
export async function payTransaction(
  db: PrismaClient,
  workspaceId: string,
  id: string,
  paidAt?: Date,
) {
  const existing = await db.transaction.findFirst({
    where: { id, workspaceId, deletedAt: null },
  });
  if (!existing) throw NotFound('Transação não encontrada');
  if (existing.status === 'COMPLETED') throw BadRequest('Transação já está efetivada');

  return db.transaction.update({
    where: { id },
    data: { status: 'COMPLETED', paidAt: paidAt ?? new Date() },
    include: txInclude,
  });
}

/**
 * Transferência entre contas: duas pernas TRANSFER ligadas por transferId.
 * A perna de origem guarda amount NEGATIVO; a de destino, POSITIVO — assim o
 * saldo de cada conta fica correto sem criar/destruir dinheiro (arquitetura §5).
 */
export async function createTransfer(
  db: PrismaClient,
  ctx: { workspaceId: string; userId: string },
  input: TransferInput,
) {
  if (input.fromAccountId === input.toAccountId) {
    throw BadRequest('Origem e destino devem ser contas diferentes');
  }
  await assertAccount(db, ctx.workspaceId, input.fromAccountId);
  await assertAccount(db, ctx.workspaceId, input.toAccountId);

  const transferId = randomUUID();
  const common = {
    workspaceId: ctx.workspaceId,
    type: 'TRANSFER' as const,
    status: input.status,
    currency: 'BRL',
    description: input.description,
    notes: input.notes ?? null,
    date: input.date,
    paidAt: input.status === 'COMPLETED' ? input.date : null,
    transferId,
    createdById: ctx.userId,
  };

  const [outLeg, inLeg] = await db.$transaction([
    db.transaction.create({
      data: {
        ...common,
        clientId: input.clientId ? `${input.clientId}:out` : null,
        accountId: input.fromAccountId,
        counterAccountId: input.toAccountId,
        amount: -Math.abs(input.amount), // saída
      },
      include: txInclude,
    }),
    db.transaction.create({
      data: {
        ...common,
        clientId: input.clientId ? `${input.clientId}:in` : null,
        accountId: input.toAccountId,
        counterAccountId: input.fromAccountId,
        amount: Math.abs(input.amount), // entrada
      },
      include: txInclude,
    }),
  ]);

  await logActivity(db, {
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    action: 'transfer.created',
    entityType: 'Transaction',
    entityId: outLeg.id,
    metadata: { amount: input.amount, transferId },
  });

  return { transferId, legs: [outLeg, inLeg] };
}
