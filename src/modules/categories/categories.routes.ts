import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';

const baseSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['INCOME', 'EXPENSE']),
  nature: z.enum(['FIXED', 'VARIABLE', 'LEISURE', 'INVESTMENT', 'INCOME', 'OTHER']).default('VARIABLE'),
  icon: z.string().max(20).optional(),
  color: z.string().max(20).optional(),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  clientId: z.string().uuid().optional(),
});

const updateSchema = baseSchema.partial().extend({ archived: z.boolean().optional() });

export default async function categoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const { includeArchived } = request.query as { includeArchived?: string };
    const categories = await app.prisma.category.findMany({
      where: {
        workspaceId: request.workspace!.id,
        deletedAt: null,
        ...(includeArchived === 'true' ? {} : { archived: false }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return { categories };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = baseSchema.parse(request.body);
    const category = await app.prisma.category.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });
    return reply.code(201).send({ category });
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.category.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Categoria não encontrada');
    const body = updateSchema.parse(request.body);
    const category = await app.prisma.category.update({ where: { id }, data: body });
    return { category };
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.category.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Categoria não encontrada');
    await app.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
    return reply.code(204).send();
  });
}
