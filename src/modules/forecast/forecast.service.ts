import type { CategoryNature, PrismaClient } from '@prisma/client';
import { Decimal } from '../../lib/money';
import { addMonths, financialMonthStart, startOfDayUTC } from '../../lib/dates';
import { workspaceBalances } from '../../lib/balance';

const VARIABLE_NATURES: CategoryNature[] = ['VARIABLE', 'LEISURE'];

export interface ForecastMonth {
  month: Date;
  startBalance: Decimal;
  knownIncome: Decimal;
  knownExpense: Decimal;
  estimatedVariable: Decimal;
  projectedBalance: Decimal;
  negative: boolean;
}

/**
 * Projeção de saldo (arquitetura §6):
 *   saldo_inicial + conhecidos (recorrências/parcelas/contas a pagar já
 *   materializadas como PENDING) ± estimativa de gastos VARIÁVEIS (média móvel).
 * Encadeia mês a mês até o horizonte, sinalizando meses negativos.
 */
export async function computeForecast(db: PrismaClient, workspaceId: string) {
  const settings = await db.workspaceSettings.findUnique({ where: { workspaceId } });
  const horizon = settings?.forecastHorizon ?? 12;
  const lookback = settings?.variableLookback ?? 3;
  const monthStartDay = settings?.monthStartDay ?? 1;

  // Saldo inicial = consolidado atual das contas que entram no total.
  const balances = await workspaceBalances(db, workspaceId);
  const includedAccounts = await db.account.findMany({
    where: { workspaceId, deletedAt: null, includeInTotal: true },
    select: { id: true },
  });
  let running = new Decimal(0);
  for (const a of includedAccounts) running = running.plus(balances.get(a.id) ?? new Decimal(0));

  // Média móvel de gastos variáveis dos últimos `lookback` meses (efetivados).
  const periodStart = financialMonthStart(startOfDayUTC(new Date()), monthStartDay);
  const historyStart = addMonths(periodStart, -lookback);
  const variableHistory = await db.transaction.aggregate({
    where: {
      workspaceId,
      type: 'EXPENSE',
      status: 'COMPLETED',
      deletedAt: null,
      date: { gte: historyStart, lt: periodStart },
      category: { nature: { in: VARIABLE_NATURES } },
    },
    _sum: { amount: true },
  });
  const avgVariable = (variableHistory._sum?.amount ?? new Decimal(0)).div(lookback);

  const months: ForecastMonth[] = [];

  for (let i = 0; i < horizon; i += 1) {
    const mStart = addMonths(periodStart, i);
    const mEnd = addMonths(periodStart, i + 1);
    const startBalance = running;

    const [incomeAgg, expenseAgg, pendingVariableAgg] = await Promise.all([
      db.transaction.aggregate({
        where: { workspaceId, type: 'INCOME', status: 'PENDING', deletedAt: null, date: { gte: mStart, lt: mEnd } },
        _sum: { amount: true },
      }),
      db.transaction.aggregate({
        where: { workspaceId, type: 'EXPENSE', status: 'PENDING', deletedAt: null, date: { gte: mStart, lt: mEnd } },
        _sum: { amount: true },
      }),
      db.transaction.aggregate({
        where: {
          workspaceId,
          type: 'EXPENSE',
          status: 'PENDING',
          deletedAt: null,
          date: { gte: mStart, lt: mEnd },
          category: { nature: { in: VARIABLE_NATURES } },
        },
        _sum: { amount: true },
      }),
    ]);

    const knownIncome = incomeAgg._sum?.amount ?? new Decimal(0);
    const knownExpense = expenseAgg._sum?.amount ?? new Decimal(0);
    const pendingVariable = pendingVariableAgg._sum?.amount ?? new Decimal(0);

    // Evita contar duas vezes: a estimativa só cobre o que ainda NÃO está agendado.
    const estimatedVariable = Decimal.max(avgVariable.minus(pendingVariable), new Decimal(0));

    running = startBalance.plus(knownIncome).minus(knownExpense).minus(estimatedVariable);

    months.push({
      month: mStart,
      startBalance,
      knownIncome,
      knownExpense,
      estimatedVariable,
      projectedBalance: running,
      negative: running.lt(0),
    });
  }

  return {
    horizon,
    lookback,
    avgVariableMonthly: avgVariable,
    months,
    firstNegativeMonth: months.find((m) => m.negative)?.month ?? null,
  };
}
