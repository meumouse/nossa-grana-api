import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';

const baseSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().max(20).optional(),
});

export default async function tagsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const tags = await app.prisma.tag.findMany({
      where: { workspaceId: request.workspace!.id },
      orderBy: { name: 'asc' },
    });
    return { tags };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = baseSchema.parse(request.body);
    const tag = await app.prisma.tag.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });
    return reply.code(201).send({ tag });
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.tag.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!existing) throw NotFound('Tag não encontrada');
    const body = baseSchema.partial().parse(request.body);
    const tag = await app.prisma.tag.update({ where: { id }, data: body });
    return { tag };
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.tag.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!existing) throw NotFound('Tag não encontrada');
    await app.prisma.tag.delete({ where: { id } });
    return reply.code(204).send();
  });
}
