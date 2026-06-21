import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  AccountChange,
  CreditCardChange,
  CategoryChange,
  TransactionChange,
} from './sync.schemas';

export interface PushPayload {
  accounts: AccountChange[];
  creditCards: CreditCardChange[];
  categories: CategoryChange[];
  transactions: TransactionChange[];
}

type IdMap = Map<string, string>;

function resolveRef(idMap: IdMap, value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  return idMap.get(value) ?? value;
}

/**
 * Resolve uma transação existente pela referência vinda do device. Normalmente é
 * o clientId (UUID do device); mas registros que nasceram no SERVIDOR (import sem
 * clientId, transferências) chegam ao device e passam a usar o `id` do servidor
 * como clientId local. Por isso procura por clientId e, na falha, pelo próprio id
 * — assim o push ATUALIZA em vez de duplicar (e o delete encontra o registro).
 */
async function findTransaction(db: PrismaClient, ref: string) {
  const byClient = await db.transaction.findUnique({
    where: { clientId: ref },
    select: { id: true, workspaceId: true, clientId: true },
  });
  if (byClient) return byClient;
  return db.transaction.findUnique({
    where: { id: ref },
    select: { id: true, workspaceId: true, clientId: true },
  });
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

  // 2) Cartões de crédito (paymentAccountId pode referenciar uma conta criada agora)
  for (const c of payload.creditCards) {
    if (c.deleted) {
      const found = await db.creditCard.findUnique({ where: { clientId: c.clientId }, select: { id: true, workspaceId: true } });
      if (found && found.workspaceId === workspaceId) {
        await db.creditCard.update({ where: { id: found.id }, data: { deletedAt: new Date() } });
        idMap.set(c.clientId, found.id);
      }
      continue;
    }
    if (!c.data) continue;
    const data = { ...c.data, paymentAccountId: resolveRef(idMap, c.data.paymentAccountId) ?? null };
    const rec = await db.creditCard.upsert({
      where: { clientId: c.clientId },
      create: { ...data, clientId: c.clientId, workspaceId },
      update: { ...data, deletedAt: null },
      select: { id: true },
    });
    idMap.set(c.clientId, rec.id);
  }

  // 3) Categorias (parentId pode referenciar uma categoria criada agora)
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

  // 4) Transações (resolve accountId/creditCardId/categoryId via idMap)
  for (const c of payload.transactions) {
    const existing = await findTransaction(db, c.clientId);
    // Não permite que um device altere registro de outro workspace.
    if (existing && existing.workspaceId !== workspaceId) continue;

    if (c.deleted) {
      if (existing) {
        await db.transaction.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
        idMap.set(c.clientId, existing.id);
      }
      continue;
    }
    if (!c.data) continue;
    const accountId = resolveRef(idMap, c.data.accountId) ?? null;
    const creditCardId = resolveRef(idMap, c.data.creditCardId) ?? null;
    // Precisa de exatamente um dono (conta ou cartão); sem isso, ignora.
    if (!accountId && !creditCardId) continue;
    const data = {
      accountId,
      creditCardId,
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
    let rec: { id: string };
    if (existing) {
      // Backfilla o clientId quando o registro nasceu no servidor (era null).
      rec = await db.transaction.update({
        where: { id: existing.id },
        data: { ...data, deletedAt: null, ...(existing.clientId ? {} : { clientId: c.clientId }) },
        select: { id: true },
      });
    } else {
      rec = await db.transaction.create({
        data: { ...data, clientId: c.clientId, workspaceId, createdById: userId },
        select: { id: true },
      });
    }
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

  const [accounts, creditCards, categories, transactions] = await Promise.all([
    db.account.findMany({ where: base, orderBy: { updatedAt: 'asc' } }),
    db.creditCard.findMany({ where: base, orderBy: { updatedAt: 'asc' } }),
    db.category.findMany({ where: base, orderBy: { updatedAt: 'asc' } }),
    db.transaction.findMany({
      where: base,
      include: { tags: { select: { id: true } } },
      orderBy: { updatedAt: 'asc' },
    }),
  ]);

  return { serverTime, accounts, creditCards, categories, transactions };
}
