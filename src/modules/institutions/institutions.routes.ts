import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../../plugins/workspace';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  shortName: z.string().max(40).optional(),
  brandColor: z.string().max(20).optional(),
  logoUrl: z.string().url().optional(),
});

/** Catálogo de instituições: globais (seed) + customizadas do workspace. */
export default async function institutionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const institutions = await app.prisma.institution.findMany({
      where: { OR: [{ workspaceId: null }, { workspaceId: request.workspace!.id }] },
      orderBy: { name: 'asc' },
    });
    return { institutions };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const institution = await app.prisma.institution.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });
    return reply.code(201).send({ institution });
  });
}
