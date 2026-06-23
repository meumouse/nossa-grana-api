import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { createRecurring } from './recurring.service';
import { suggestRecurring } from './recurring.detect';
import { startOfDayUTC } from '../../lib/dates';
import { validWorkspaceTagIds } from '../../lib/tags';

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
  // Tags (ids do servidor) aplicadas ao template e propagadas às ocorrências.
  tagIds: z.array(z.string()).optional(),
});

// Criação aceita também ids de transações já existentes da série, p/ vincular
// (em vez de recriar) e evitar duplicidade — ver createRecurring.
const createSchema = baseSchema.extend({
  linkTransactionIds: z.array(z.string().min(1)).max(500).optional(),
});

export default async function recurringRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const items = await app.prisma.recurringTransaction.findMany({
      where: { workspaceId: request.workspace!.id, deletedAt: null },
      include: {
        category: { select: { id: true, name: true, color: true, icon: true } },
        tags: { select: { id: true, name: true, color: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  });

  // Sugestões de recorrência detectadas no extrato (séries regulares ainda sem
  // recorrência cadastrada). Híbrido: agrupamento determinístico + refino por IA.
  app.get('/suggestions', async (request) => {
    const suggestions = await suggestRecurring(app.prisma, request.workspace!.id);
    return { suggestions };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const rec = await createRecurring(app.prisma, request.workspace!.id, body);
    return reply.code(201).send({ recurring: rec });
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.recurringTransaction.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Recorrência não encontrada');
    const body = baseSchema.partial().extend({ isActive: z.boolean().optional() }).parse(request.body);
    const { tagIds, ...fields } = body;
    // tagIds não é coluna: vira um "set" da relação N:N (ignorando ids órfãos).
    let tagsData: { tags?: { set: { id: string }[] } } = {};
    if (tagIds !== undefined) {
      const valid = await validWorkspaceTagIds(app.prisma, request.workspace!.id, tagIds);
      tagsData = { tags: { set: valid.map((tid) => ({ id: tid })) } };
    }
    const rec = await app.prisma.recurringTransaction.update({
      where: { id },
      data: { ...fields, ...tagsData },
    });
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
