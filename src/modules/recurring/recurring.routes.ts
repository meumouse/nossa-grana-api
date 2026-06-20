import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { materializeOne } from './recurring.service';
import { addMonths, startOfDayUTC } from '../../lib/dates';

const baseSchema = z.object({
  clientId: z.string().uuid().optional(),
  accountId: z.string().min(1),
  type: z.enum(['INCOME', 'EXPENSE']),
  amount: z.coerce.number().positive(),
  description: z.string().min(1).max(200),
  categoryId: z.string().nullable().optional(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  interval: z.number().int().positive().default(1),
  anchorDay: z.number().int().min(1).max(31).nullable().optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  autoConfirm: z.boolean().optional(),
});

export default async function recurringRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const items = await app.prisma.recurringTransaction.findMany({
      where: { workspaceId: request.workspace!.id, deletedAt: null },
      include: { category: { select: { id: true, name: true, color: true, icon: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = baseSchema.parse(request.body);
    const rec = await app.prisma.recurringTransaction.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });

    // Já materializa as próximas ocorrências p/ aparecerem na previsão.
    const settings = await app.prisma.workspaceSettings.findUnique({
      where: { workspaceId: request.workspace!.id },
    });
    const until = addMonths(startOfDayUTC(new Date()), settings?.forecastHorizon ?? 12);
    await materializeOne(app.prisma, rec.id, until);

    return reply.code(201).send({ recurring: rec });
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.recurringTransaction.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Recorrência não encontrada');
    const body = baseSchema.partial().extend({ isActive: z.boolean().optional() }).parse(request.body);
    const rec = await app.prisma.recurringTransaction.update({ where: { id }, data: body });
    return { recurring: rec };
  });

  // Excluir: soft delete do template + remove ocorrências FUTURAS ainda PENDING.
  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.recurringTransaction.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Recorrência não encontrada');

    await app.prisma.$transaction([
      app.prisma.recurringTransaction.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      }),
      app.prisma.transaction.updateMany({
        where: {
          recurringTransactionId: id,
          status: 'PENDING',
          date: { gte: startOfDayUTC(new Date()) },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      }),
    ]);
    return reply.code(204).send();
  });
}
