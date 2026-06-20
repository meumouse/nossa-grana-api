import type { PrismaClient } from '@prisma/client';
import { addMonths, startOfDayUTC } from '../../lib/dates';
import { occurrencesBetween } from '../../lib/recurrence';

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
