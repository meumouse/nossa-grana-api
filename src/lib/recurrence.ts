import type { RecurrenceFrequency } from '@prisma/client';
import { addDays, addMonths, startOfDayUTC, withDayOfMonth } from './dates';

export interface RecurrenceSpec {
  frequency: RecurrenceFrequency;
  interval: number;
  anchorDay: number | null;
  startDate: Date;
  endDate: Date | null;
}

function step(d: Date, freq: RecurrenceFrequency, interval: number, anchorDay: number | null): Date {
  switch (freq) {
    case 'DAILY':
      return addDays(d, interval);
    case 'WEEKLY':
      return addDays(d, 7 * interval);
    case 'MONTHLY': {
      const next = addMonths(d, interval);
      if (anchorDay != null) {
        return withDayOfMonth(next.getUTCFullYear(), next.getUTCMonth(), anchorDay);
      }
      return next;
    }
    case 'YEARLY':
      return addMonths(d, 12 * interval);
    default:
      return addMonths(d, interval);
  }
}

/**
 * Datas de ocorrência no intervalo (afterExclusive, until], respeitando
 * endDate. Usado pelo job que materializa recorrências como Transactions PENDING.
 */
export function occurrencesBetween(
  spec: RecurrenceSpec,
  afterExclusive: Date | null,
  until: Date,
): Date[] {
  const interval = Math.max(spec.interval, 1);
  const limit = spec.endDate && spec.endDate < until ? spec.endDate : until;

  let cursor =
    spec.anchorDay != null && spec.frequency === 'MONTHLY'
      ? withDayOfMonth(
          spec.startDate.getUTCFullYear(),
          spec.startDate.getUTCMonth(),
          spec.anchorDay,
        )
      : startOfDayUTC(spec.startDate);

  // Garante começar dentro do range se startDate < cursor por causa do anchor.
  if (cursor < startOfDayUTC(spec.startDate)) {
    cursor = step(cursor, spec.frequency, interval, spec.anchorDay);
  }

  const out: Date[] = [];
  let guard = 0;
  while (cursor <= limit && guard < 5000) {
    guard += 1;
    if (!afterExclusive || cursor > afterExclusive) {
      out.push(cursor);
    }
    cursor = step(cursor, spec.frequency, interval, spec.anchorDay);
  }
  return out;
}
