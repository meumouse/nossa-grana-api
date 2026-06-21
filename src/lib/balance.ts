import type { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from './money';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Saldo é DERIVADO (arquitetura §2): openingBalance + Σ transações COMPLETED.
 * Convenção de sinal:
 *   - INCOME   → soma `amount` (amount > 0)
 *   - EXPENSE  → subtrai `amount` (amount > 0)
 *   - TRANSFER → soma `amount` JÁ ASSINADO (negativo na perna de origem,
 *                positivo na de destino). É a forma de manter o saldo de cada
 *                conta correto numa transferência sem "criar/destruir" dinheiro.
 */
async function sumByType(db: Db, where: Prisma.TransactionWhereInput) {
  const grouped = await db.transaction.groupBy({
    by: ['type'],
    where: { ...where, status: 'COMPLETED', deletedAt: null },
    _sum: { amount: true },
  });

  let income = new Decimal(0);
  let expense = new Decimal(0);
  let transfer = new Decimal(0);
  for (const g of grouped) {
    const v = g._sum.amount ?? new Decimal(0);
    if (g.type === 'INCOME') income = income.plus(v);
    else if (g.type === 'EXPENSE') expense = expense.plus(v);
    else transfer = transfer.plus(v);
  }
  return { income, expense, transfer };
}

/** Saldo atual de UMA conta. */
export async function accountBalance(db: Db, accountId: string): Promise<Decimal> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { openingBalance: true },
  });
  if (!account) return new Decimal(0);

  const { income, expense, transfer } = await sumByType(db, { accountId });
  return new Decimal(account.openingBalance).plus(income).minus(expense).plus(transfer);
}

/** Saldo de TODAS as contas (não arquivadas) de um workspace, em lote. */
export async function workspaceBalances(
  db: Db,
  workspaceId: string,
): Promise<Map<string, Decimal>> {
  const accounts = await db.account.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, openingBalance: true },
  });

  // accountId é nulável (transações de cartão usam creditCardId) — filtramos
  // para somar apenas as pernas que pertencem a uma conta.
  const grouped = await db.transaction.groupBy({
    by: ['accountId', 'type'],
    where: { workspaceId, status: 'COMPLETED', deletedAt: null, accountId: { not: null } },
    _sum: { amount: true },
  });

  const result = new Map<string, Decimal>();
  for (const a of accounts) result.set(a.id, new Decimal(a.openingBalance));

  for (const g of grouped) {
    if (g.accountId == null) continue;
    const current = result.get(g.accountId);
    if (!current) continue; // conta arquivada/excluída
    const v = g._sum.amount ?? new Decimal(0);
    if (g.type === 'INCOME') result.set(g.accountId, current.plus(v));
    else if (g.type === 'EXPENSE') result.set(g.accountId, current.minus(v));
    else result.set(g.accountId, current.plus(v)); // TRANSFER assinado
  }

  return result;
}

/**
 * Limite disponível de um cartão = creditLimit − Σ compras não pagas
 * (transações EXPENSE do cartão fora de fatura PAID). null se sem limite definido.
 */
export async function creditCardAvailable(
  db: Db,
  card: { id: string; creditLimit: Prisma.Decimal | null },
): Promise<Decimal | null> {
  if (card.creditLimit == null) return null;

  const unpaid = await db.transaction.aggregate({
    where: {
      creditCardId: card.id,
      type: 'EXPENSE',
      deletedAt: null,
      OR: [{ creditCardInvoice: { is: null } }, { creditCardInvoice: { status: { not: 'PAID' } } }],
    },
    _sum: { amount: true },
  });

  const used = unpaid._sum.amount ?? new Decimal(0);
  return new Decimal(card.creditLimit).minus(used);
}

/**
 * "Usado" (Σ compras não pagas) de TODOS os cartões de um workspace, em lote —
 * evita N+1 na listagem. O disponível = creditLimit − usado é montado na rota.
 */
export async function workspaceCardsUsed(
  db: Db,
  workspaceId: string,
): Promise<Map<string, Decimal>> {
  const grouped = await db.transaction.groupBy({
    by: ['creditCardId'],
    where: {
      workspaceId,
      type: 'EXPENSE',
      deletedAt: null,
      creditCardId: { not: null },
      OR: [{ creditCardInvoice: { is: null } }, { creditCardInvoice: { status: { not: 'PAID' } } }],
    },
    _sum: { amount: true },
  });

  const result = new Map<string, Decimal>();
  for (const g of grouped) {
    if (g.creditCardId == null) continue;
    result.set(g.creditCardId, g._sum.amount ?? new Decimal(0));
  }
  return result;
}
