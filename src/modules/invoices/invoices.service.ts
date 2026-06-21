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
 * Garante (upsert) as faturas dos ciclos de uma lista de datas de compra e
 * devolve um mapa `data.getTime() -> invoiceId`. Usado pelo parcelamento para
 * vincular cada parcela à fatura (futura) do seu ciclo, deduplicando por ciclo
 * para fazer um único upsert por fatura. Mapa vazio se o cartão não tem ciclo
 * configurado.
 */
export async function ensureInvoicesForDates(
  db: Db,
  card: Pick<CreditCard, 'id' | 'workspaceId' | 'statementClosingDay' | 'paymentDueDay'>,
  dates: Date[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (card.statementClosingDay == null || card.paymentDueDay == null || dates.length === 0) {
    return map;
  }

  // Ciclo (closingDate/dueDate) de cada data; dedupe por closingDate.
  const cycleByClosing = new Map<number, { closingDate: Date; dueDate: Date }>();
  const closingOfDate = new Map<number, number>();
  for (const d of dates) {
    const cycle = cycleFor(d, card.statementClosingDay, card.paymentDueDay);
    const closingKey = cycle.closingDate.getTime();
    cycleByClosing.set(closingKey, cycle);
    closingOfDate.set(d.getTime(), closingKey);
  }

  const idByClosing = new Map<number, string>();
  for (const [closingKey, cycle] of cycleByClosing) {
    const invoice = await db.creditCardInvoice.upsert({
      where: { creditCardId_closingDate: { creditCardId: card.id, closingDate: cycle.closingDate } },
      update: {},
      create: {
        workspaceId: card.workspaceId,
        creditCardId: card.id,
        closingDate: cycle.closingDate,
        dueDate: cycle.dueDate,
        status: 'OPEN',
      },
      select: { id: true },
    });
    idByClosing.set(closingKey, invoice.id);
  }

  for (const [dateMs, closingKey] of closingOfDate) {
    const id = idByClosing.get(closingKey);
    if (id) map.set(dateMs, id);
  }
  return map;
}

/**
 * Remove faturas ABERTAS de um cartão que ficaram sem nenhum lançamento ativo
 * (ex.: após reeditar/excluir um parcelamento). Faturas vazias têm total zero e
 * são recriadas sob demanda na próxima compra — não há perda de informação.
 */
export async function pruneEmptyOpenInvoices(db: Db, workspaceId: string, creditCardId: string): Promise<void> {
  await db.creditCardInvoice.deleteMany({
    where: {
      workspaceId,
      creditCardId,
      status: 'OPEN',
      transactions: { none: { deletedAt: null } },
    },
  });
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
