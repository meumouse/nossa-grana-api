import type { CategoryNature, PrismaClient } from '@prisma/client';
import { Decimal } from '../../lib/money';
import { addMonths, financialMonthStart, lastDayOfMonth, startOfDayUTC } from '../../lib/dates';
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

export interface AccountInstallmentForecast {
  accountId: string;
  accountName: string;
  month: Date; // 1º dia (civil) do mês
  dueDate: Date; // último dia do mês — vencimento adotado p/ parcelas de conta
  total: Decimal;
  count: number;
}

/**
 * Previsão de "faturas" para parcelas vinculadas a CONTA/banco. Conta não tem o
 * conceito de fatura (isso é do cartão), então agrupamos as parcelas pendentes
 * por conta + mês civil, com vencimento no último dia do mês. As parcelas de
 * cartão já viram CreditCardInvoice (futuras) e saem por GET /invoices.
 */
export async function computeAccountInstallmentForecast(
  db: PrismaClient,
  workspaceId: string,
): Promise<AccountInstallmentForecast[]> {
  const parcelas = await db.transaction.findMany({
    where: {
      workspaceId,
      status: 'PENDING',
      deletedAt: null,
      installmentPlanId: { not: null },
      accountId: { not: null },
    },
    select: { accountId: true, amount: true, date: true, account: { select: { name: true } } },
    orderBy: { date: 'asc' },
  });

  const groups = new Map<string, AccountInstallmentForecast>();
  for (const p of parcelas) {
    if (!p.accountId) continue;
    const year = p.date.getUTCFullYear();
    const month = p.date.getUTCMonth();
    const key = `${p.accountId}:${year}-${month}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        accountId: p.accountId,
        accountName: p.account?.name ?? 'Conta',
        month: new Date(Date.UTC(year, month, 1)),
        dueDate: new Date(Date.UTC(year, month, lastDayOfMonth(year, month))),
        total: new Decimal(0),
        count: 0,
      };
      groups.set(key, group);
    }
    group.total = group.total.plus(p.amount);
    group.count += 1;
  }

  return [...groups.values()].sort((a, b) => a.month.getTime() - b.month.getTime());
}
