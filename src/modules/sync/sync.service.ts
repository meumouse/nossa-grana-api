import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  AccountChange,
  CategoryChange,
  TransactionChange,
} from './sync.schemas';

export interface PushPayload {
  accounts: AccountChange[];
  categories: CategoryChange[];
  transactions: TransactionChange[];
}

type IdMap = Map<string, string>;

function resolveRef(idMap: IdMap, value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  return idMap.get(value) ?? value;
}

/**
 * Recebe um lote de mutações idempotentes do dispositivo. Upsert por clientId →
 * reenviar a fila nunca duplica. Resolve referências criadas no mesmo lote via
 * idMap. Resolução de conflito: LWW por ORDEM DE CHEGADA (o último push aplica;
 * arquitetura §4) — o servidor é a autoridade de relógio.
 */
export async function push(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  payload: PushPayload,
): Promise<{ idMap: Array<{ clientId: string; id: string }>; serverTime: Date }> {
  const idMap: IdMap = new Map();

  // 1) Contas
  for (const c of payload.accounts) {
    if (c.deleted) {
      const found = await db.account.findUnique({ where: { clientId: c.clientId }, select: { id: true, workspaceId: true } });
      if (found && found.workspaceId === workspaceId) {
        await db.account.update({ where: { id: found.id }, data: { deletedAt: new Date() } });
        idMap.set(c.clientId, found.id);
      }
      continue;
    }
    if (!c.data) continue;
    const rec = await db.account.upsert({
      where: { clientId: c.clientId },
      create: { ...c.data, clientId: c.clientId, workspaceId },
      update: { ...c.data, deletedAt: null },
      select: { id: true },
    });
    idMap.set(c.clientId, rec.id);
  }

  // 2) Categorias (parentId pode referenciar uma categoria criada agora)
  for (const c of payload.categories) {
    if (c.deleted) {
      const found = await db.category.findUnique({ where: { clientId: c.clientId }, select: { id: true, workspaceId: true } });
      if (found && found.workspaceId === workspaceId) {
        await db.category.update({ where: { id: found.id }, data: { deletedAt: new Date() } });
        idMap.set(c.clientId, found.id);
      }
      continue;
    }
    if (!c.data) continue;
    const data = { ...c.data, parentId: resolveRef(idMap, c.data.parentId) ?? null };
    const rec = await db.category.upsert({
      where: { clientId: c.clientId },
      create: { ...data, clientId: c.clientId, workspaceId },
      update: { ...data, deletedAt: null },
      select: { id: true },
    });
    idMap.set(c.clientId, rec.id);
  }

  // 3) Transações (resolve accountId/categoryId via idMap)
  for (const c of payload.transactions) {
    if (c.deleted) {
      const found = await db.transaction.findUnique({ where: { clientId: c.clientId }, select: { id: true, workspaceId: true } });
      if (found && found.workspaceId === workspaceId) {
        await db.transaction.update({ where: { id: found.id }, data: { deletedAt: new Date() } });
        idMap.set(c.clientId, found.id);
      }
      continue;
    }
    if (!c.data) continue;
    const accountId = resolveRef(idMap, c.data.accountId);
    if (!accountId) continue;
    const data = {
      accountId,
      type: c.data.type,
      status: c.data.status,
      amount: c.data.amount,
      currency: c.data.currency,
      description: c.data.description,
      notes: c.data.notes ?? null,
      categoryId: resolveRef(idMap, c.data.categoryId) ?? null,
      date: c.data.date,
      dueDate: c.data.dueDate ?? null,
      paidAt: c.data.paidAt ?? null,
      duplicateDismissed: c.data.duplicateDismissed ?? false,
      shared: c.data.shared ?? false,
      shareCount: c.data.shareCount ?? null,
      // JSON do Prisma: null vira DbNull (limpa a coluna); array é gravado como tal.
      shares: c.data.shares == null ? Prisma.DbNull : (c.data.shares as Prisma.InputJsonValue),
    };
    const rec = await db.transaction.upsert({
      where: { clientId: c.clientId },
      create: { ...data, clientId: c.clientId, workspaceId, createdById: userId },
      update: { ...data, deletedAt: null },
      select: { id: true },
    });
    idMap.set(c.clientId, rec.id);
  }

  return {
    idMap: Array.from(idMap.entries()).map(([clientId, id]) => ({ clientId, id })),
    serverTime: new Date(),
  };
}

/**
 * Delta incremental: tudo que mudou (updatedAt > since), INCLUINDO removidos
 * (deletedAt preenchido) para o device propagar exclusões. `serverTime` vira o
 * novo watermark `since` do cliente.
 */
export async function pull(db: PrismaClient, workspaceId: string, since?: Date) {
  const serverTime = new Date();
  const updatedFilter = since ? { gt: since } : undefined;
  const base = { workspaceId, ...(updatedFilter ? { updatedAt: updatedFilter } : {}) };

  const [accounts, categories, transactions] = await Promise.all([
    db.account.findMany({ where: base, orderBy: { updatedAt: 'asc' } }),
    db.category.findMany({ where: base, orderBy: { updatedAt: 'asc' } }),
    db.transaction.findMany({
      where: base,
      include: { tags: { select: { id: true } } },
      orderBy: { updatedAt: 'asc' },
    }),
  ]);

  return { serverTime, accounts, categories, transactions };
}
