import type { FastifyInstance } from 'fastify';
import { Decimal } from '../../lib/money';
import { addMonths, financialMonthStart, startOfDayUTC } from '../../lib/dates';
import { workspaceBalances } from '../../lib/balance';
import { computeAccountInstallmentForecast, computeForecast } from './forecast.service';

export default async function forecastRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    return computeForecast(app.prisma, request.workspace!.id);
  });

  // Previsão de parcelas de CONTA/banco agrupadas por mês (último dia = vencimento).
  // As parcelas de cartão já saem como faturas futuras em GET /invoices.
  app.get('/invoices', async (request) => {
    const accounts = await computeAccountInstallmentForecast(app.prisma, request.workspace!.id);
    return { accounts };
  });

  // Resumo p/ o dashboard: saldo consolidado + fluxo do mês + pendências.
  app.get('/summary', async (request) => {
    const workspaceId = request.workspace!.id;
    const settings = await app.prisma.workspaceSettings.findUnique({ where: { workspaceId } });
    const monthStart = financialMonthStart(startOfDayUTC(new Date()), settings?.monthStartDay ?? 1);
    const monthEnd = addMonths(monthStart, 1);

    const balances = await workspaceBalances(app.prisma, workspaceId);
    const included = await app.prisma.account.findMany({
      where: { workspaceId, deletedAt: null, includeInTotal: true },
      select: { id: true },
    });
    let totalBalance = new Decimal(0);
    for (const a of included) totalBalance = totalBalance.plus(balances.get(a.id) ?? new Decimal(0));

    const [income, expense, overdue] = await Promise.all([
      app.prisma.transaction.aggregate({
        where: { workspaceId, type: 'INCOME', status: 'COMPLETED', deletedAt: null, date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
      app.prisma.transaction.aggregate({
        where: { workspaceId, type: 'EXPENSE', status: 'COMPLETED', deletedAt: null, date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
      app.prisma.transaction.aggregate({
        where: { workspaceId, status: 'PENDING', deletedAt: null, dueDate: { lt: new Date() } },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    return {
      month: monthStart,
      totalBalance,
      monthIncome: income._sum.amount ?? new Decimal(0),
      monthExpense: expense._sum.amount ?? new Decimal(0),
      overdue: { count: overdue._count, amount: overdue._sum.amount ?? new Decimal(0) },
    };
  });
}
