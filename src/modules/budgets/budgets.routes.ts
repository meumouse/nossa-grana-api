import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { addMonths, firstDayOfMonth } from '../../lib/dates';
import { Decimal } from '../../lib/money';

const upsertSchema = z.object({
  clientId: z.string().uuid().optional(),
  categoryId: z.string().nullable().optional(),
  month: z.coerce.date(),
  amount: z.coerce.number().nonnegative(),
  rollover: z.boolean().optional(),
});

export default async function budgetsRoutes(app: FastifyInstance): Promise<void> {
  // Lista os orçamentos de um mês + quanto já foi gasto em cada categoria.
  app.get('/', async (request) => {
    const { month } = z.object({ month: z.coerce.date() }).parse(request.query);
    const monthStart = firstDayOfMonth(month);
    const monthEnd = addMonths(monthStart, 1);

    const budgets = await app.prisma.budget.findMany({
      where: { workspaceId: request.workspace!.id, month: monthStart },
      include: { category: { select: { id: true, name: true, color: true, icon: true } } },
    });

    // Gasto por categoria no mês (despesas efetivadas).
    const spentByCategory = await app.prisma.transaction.groupBy({
      by: ['categoryId'],
      where: {
        workspaceId: request.workspace!.id,
        type: 'EXPENSE',
        status: 'COMPLETED',
        deletedAt: null,
        date: { gte: monthStart, lt: monthEnd },
      },
      _sum: { amount: true },
    });

    const spentMap = new Map<string | null, Decimal>();
    let totalSpent = new Decimal(0);
    for (const g of spentByCategory) {
      const v = g._sum.amount ?? new Decimal(0);
      spentMap.set(g.categoryId, v);
      totalSpent = totalSpent.plus(v);
    }

    const result = budgets.map((b) => {
      const spent = b.categoryId ? spentMap.get(b.categoryId) ?? new Decimal(0) : totalSpent;
      const amount = new Decimal(b.amount);
      return {
        ...b,
        spent,
        remaining: amount.minus(spent),
        progress: amount.gt(0) ? Number(spent.div(amount).toFixed(4)) : 0,
      };
    });

    return { month: monthStart, budgets: result };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = upsertSchema.parse(request.body);
    const month = firstDayOfMonth(body.month);
    const categoryId = body.categoryId ?? null;

    // Upsert manual: o categoryId nulo (orçamento global) não compõe bem a chave
    // composta tipada do Prisma, então resolvemos via findFirst + create/update.
    const existing = await app.prisma.budget.findFirst({
      where: { workspaceId: request.workspace!.id, categoryId, month },
      select: { id: true },
    });

    const budget = existing
      ? await app.prisma.budget.update({
          where: { id: existing.id },
          data: { amount: body.amount, rollover: body.rollover },
        })
      : await app.prisma.budget.create({
          data: {
            workspaceId: request.workspace!.id,
            categoryId,
            month,
            amount: body.amount,
            rollover: body.rollover ?? false,
            clientId: body.clientId ?? null,
          },
        });
    return reply.code(201).send({ budget });
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.budget.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!existing) throw NotFound('Orçamento não encontrado');
    await app.prisma.budget.delete({ where: { id } });
    return reply.code(204).send();
  });
}
