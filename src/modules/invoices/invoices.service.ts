import type { CreditCard, Prisma, PrismaClient } from '@prisma/client';
import { startOfDayUTC, withDayOfMonth } from '../../lib/dates';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Calcula o ciclo (closingDate / dueDate) ao qual uma compra pertence, a partir
 * do dia de fechamento e de vencimento do cartão.
 */
export function cycleFor(
  purchaseDate: Date,
  closingDay: number,
  dueDay: number,
): { closingDate: Date; dueDate: Date } {
  const d = startOfDayUTC(purchaseDate);
  let closing = withDayOfMonth(d.getUTCFullYear(), d.getUTCMonth(), closingDay);
  if (d > closing) {
    // já passou do fechamento deste mês → cai no ciclo seguinte
    closing = withDayOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1, closingDay);
  }
  let due = withDayOfMonth(closing.getUTCFullYear(), closing.getUTCMonth(), dueDay);
  if (due <= closing) {
    due = withDayOfMonth(closing.getUTCFullYear(), closing.getUTCMonth() + 1, dueDay);
  }
  return { closingDate: closing, dueDate: due };
}

/**
 * Garante a fatura (aberta) do ciclo de uma compra no cartão. Idempotente via
 * unique (creditCardId, closingDate). Retorna null se o cartão não tem dias
 * configurados.
 */
export async function getOrCreateOpenInvoice(
  db: Db,
  card: Pick<CreditCard, 'id' | 'workspaceId' | 'statementClosingDay' | 'paymentDueDay'>,
  purchaseDate: Date,
): Promise<{ id: string } | null> {
  if (card.statementClosingDay == null || card.paymentDueDay == null) {
    return null;
  }
  const { closingDate, dueDate } = cycleFor(
    purchaseDate,
    card.statementClosingDay,
    card.paymentDueDay,
  );

  const invoice = await db.creditCardInvoice.upsert({
    where: { creditCardId_closingDate: { creditCardId: card.id, closingDate } },
    update: {},
    create: {
      workspaceId: card.workspaceId,
      creditCardId: card.id,
      closingDate,
      dueDate,
      status: 'OPEN',
    },
    select: { id: true },
  });
  return invoice;
}

/**
 * Job: fecha faturas cujo ciclo já passou (OPEN→CLOSED) e marca como OVERDUE as
 * fechadas e vencidas não pagas.
 */
export async function closeDueInvoices(db: PrismaClient): Promise<{ closed: number; overdue: number }> {
  const now = startOfDayUTC(new Date());

  const closed = await db.creditCardInvoice.updateMany({
    where: { status: 'OPEN', closingDate: { lt: now } },
    data: { status: 'CLOSED' },
  });

  const overdue = await db.creditCardInvoice.updateMany({
    where: { status: 'CLOSED', dueDate: { lt: now }, paidAt: null },
    data: { status: 'OVERDUE' },
  });

  return { closed: closed.count, overdue: overdue.count };
}
