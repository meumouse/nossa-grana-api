import type { Prisma, PrismaClient, RecurrenceFrequency } from '@prisma/client';
import { addMonths, startOfDayUTC } from '../../lib/dates';
import { occurrencesBetween } from '../../lib/recurrence';

/** Horizonte de materialização (meses à frente) do workspace, com default. */
async function forecastUntil(db: PrismaClient, workspaceId: string): Promise<Date> {
  const settings = await db.workspaceSettings.findUnique({ where: { workspaceId } });
  return addMonths(startOfDayUTC(new Date()), settings?.forecastHorizon ?? 12);
}

export interface CreateRecurringInput {
  clientId?: string;
  accountId: string;
  type: 'INCOME' | 'EXPENSE';
  amount: number;
  description: string;
  categoryId?: string | null;
  frequency: RecurrenceFrequency;
  interval?: number;
  anchorDay?: number | null;
  startDate: Date;
  endDate?: Date | null;
  autoConfirm?: boolean;
  /**
   * Ids de transações JÁ existentes que pertencem a esta série (criação a partir
   * do extrato ou de uma sugestão da IA). Elas são VINCULADAS ao template em vez
   * de recriadas, e a materialização passa a começar só DEPOIS da última delas —
   * assim nenhuma ocorrência PENDING nasce sobre um período já lançado.
   */
  linkTransactionIds?: string[];
}

/**
 * Cria um template de recorrência e materializa as próximas ocorrências.
 *
 * Quando `linkTransactionIds` é informado, as transações existentes (validadas
 * por workspace e mesma conta) são vinculadas ao template e `materializedUntil`
 * é ancorado na data da última delas — garantindo que a criação a partir de um
 * lançamento do extrato NÃO duplique valores já existentes.
 */
export async function createRecurring(
  db: PrismaClient,
  workspaceId: string,
  input: CreateRecurringInput,
) {
  const { linkTransactionIds, ...fields } = input;

  let linkIds: string[] = [];
  let materializedUntil: Date | null = null;
  if (linkTransactionIds && linkTransactionIds.length > 0) {
    const linked = await db.transaction.findMany({
      where: {
        id: { in: linkTransactionIds },
        workspaceId,
        deletedAt: null,
        accountId: fields.accountId, // só transações da mesma conta da recorrência
      },
      select: { id: true, date: true },
    });
    linkIds = linked.map((t) => t.id);
    for (const t of linked) {
      const d = startOfDayUTC(t.date);
      if (!materializedUntil || d > materializedUntil) materializedUntil = d;
    }
  }

  const data: Prisma.RecurringTransactionUncheckedCreateInput = {
    ...fields,
    workspaceId,
    // Só ancora o materializedUntil quando há transações vinculadas; sem isso,
    // mantém null para preservar o comportamento normal (1ª ocorrência = startDate).
    ...(materializedUntil ? { materializedUntil } : {}),
  };
  const rec = await db.recurringTransaction.create({ data });

  if (linkIds.length > 0) {
    await db.transaction.updateMany({
      where: { id: { in: linkIds }, workspaceId },
      data: { recurringTransactionId: rec.id },
    });
  }

  await materializeOne(db, rec.id, await forecastUntil(db, workspaceId));
  return rec;
}

/**
 * Materializa ocorrências futuras de um template de recorrência como
 * Transactions. As que caem no futuro nascem PENDING (entram na previsão); se
 * `autoConfirm` e a data já passou, nascem COMPLETED. `materializedUntil`
 * garante idempotência — nunca regeramos o que já foi criado.
 */
export async function materializeOne(
  db: PrismaClient,
  recurringId: string,
  until: Date,
): Promise<number> {
  const rec = await db.recurringTransaction.findFirst({
    where: { id: recurringId, isActive: true, deletedAt: null },
  });
  if (!rec) return 0;

  const dates = occurrencesBetween(
    {
      frequency: rec.frequency,
      interval: rec.interval,
      anchorDay: rec.anchorDay,
      startDate: rec.startDate,
      endDate: rec.endDate,
    },
    rec.materializedUntil,
    until,
  );
  if (dates.length === 0) {
    if (!rec.materializedUntil || rec.materializedUntil < until) {
      await db.recurringTransaction.update({
        where: { id: rec.id },
        data: { materializedUntil: until },
      });
    }
    return 0;
  }

  const today = startOfDayUTC(new Date());

  await db.$transaction([
    db.transaction.createMany({
      data: dates.map((date) => {
        const autoDone = rec.autoConfirm && date <= today;
        return {
          workspaceId: rec.workspaceId,
          accountId: rec.accountId,
          type: rec.type,
          status: autoDone ? ('COMPLETED' as const) : ('PENDING' as const),
          amount: rec.amount,
          description: rec.description,
          categoryId: rec.categoryId,
          date,
          dueDate: date,
          paidAt: autoDone ? date : null,
          recurringTransactionId: rec.id,
        };
      }),
    }),
    db.recurringTransaction.update({
      where: { id: rec.id },
      data: { materializedUntil: until },
    }),
  ]);

  return dates.length;
}

/** Materializa todas as recorrências ativas de um workspace até o horizonte. */
export async function materializeWorkspace(db: PrismaClient, workspaceId: string): Promise<number> {
  const settings = await db.workspaceSettings.findUnique({ where: { workspaceId } });
  const horizon = settings?.forecastHorizon ?? 12;
  const until = addMonths(startOfDayUTC(new Date()), horizon);

  const recs = await db.recurringTransaction.findMany({
    where: { workspaceId, isActive: true, deletedAt: null },
    select: { id: true },
  });

  let total = 0;
  for (const r of recs) total += await materializeOne(db, r.id, until);
  return total;
}

/** Materializa para todos os workspaces (usado pelo job). */
export async function materializeAll(db: PrismaClient): Promise<number> {
  const workspaces = await db.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  let total = 0;
  for (const w of workspaces) total += await materializeWorkspace(db, w.id);
  return total;
}
