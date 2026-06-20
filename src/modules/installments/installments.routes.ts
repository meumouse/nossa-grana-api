import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { addMonths } from '../../lib/dates';
import { Decimal } from '../../lib/money';

const createSchema = z.object({
  clientId: z.string().uuid().optional(),
  accountId: z.string().min(1),
  description: z.string().min(1).max(200),
  totalAmount: z.coerce.number().positive(),
  installments: z.number().int().min(2).max(360),
  firstDueDate: z.coerce.date(),
  categoryId: z.string().nullable().optional(),
});

/** Divide o total em N parcelas (centavos do resto vão na última). */
function splitAmount(total: Decimal, n: number): Decimal[] {
  const base = total.div(n).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const parts = Array.from({ length: n - 1 }, () => base);
  const last = total.minus(base.times(n - 1));
  return [...parts, last];
}

export default async function installmentsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const items = await app.prisma.installmentPlan.findMany({
      where: { workspaceId: request.workspace!.id, deletedAt: null },
      include: { _count: { select: { transactions: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const plan = await app.prisma.installmentPlan.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
      include: { transactions: { where: { deletedAt: null }, orderBy: { installmentNumber: 'asc' } } },
    });
    if (!plan) throw NotFound('Parcelamento não encontrado');
    return { plan };
  });

  // Cria o plano + gera as N parcelas (PENDING) — já entram na previsão.
  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);

    const account = await app.prisma.account.findFirst({
      where: { id: body.accountId, workspaceId: request.workspace!.id, deletedAt: null },
      select: { id: true },
    });
    if (!account) throw BadRequest('Conta inválida para este workspace');

    const amounts = splitAmount(new Decimal(body.totalAmount), body.installments);

    const plan = await app.prisma.$transaction(async (tx) => {
      const created = await tx.installmentPlan.create({
        data: {
          workspaceId: request.workspace!.id,
          clientId: body.clientId ?? null,
          description: body.description,
          totalAmount: body.totalAmount,
          installments: body.installments,
          firstDueDate: body.firstDueDate,
          categoryId: body.categoryId ?? null,
        },
      });

      await tx.transaction.createMany({
        data: amounts.map((amount, i) => {
          const due = addMonths(body.firstDueDate, i);
          return {
            workspaceId: request.workspace!.id,
            accountId: body.accountId,
            type: 'EXPENSE' as const,
            status: 'PENDING' as const,
            amount,
            description: `${body.description} (${i + 1}/${body.installments})`,
            categoryId: body.categoryId ?? null,
            date: due,
            dueDate: due,
            installmentPlanId: created.id,
            installmentNumber: i + 1,
            createdById: request.userId!,
          };
        }),
      });

      return created;
    });

    return reply.code(201).send({ plan });
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.installmentPlan.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Parcelamento não encontrado');

    await app.prisma.$transaction([
      app.prisma.installmentPlan.update({ where: { id }, data: { deletedAt: new Date() } }),
      app.prisma.transaction.updateMany({
        where: { installmentPlanId: id, status: 'PENDING', deletedAt: null },
        data: { deletedAt: new Date() },
      }),
    ]);
    return reply.code(204).send();
  });
}
