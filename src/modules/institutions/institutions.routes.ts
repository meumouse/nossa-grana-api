import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../../plugins/workspace';
import { env } from '../../env';
import { institutionsCacheKey } from '../../lib/cache';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  shortName: z.string().max(40).optional(),
  brandColor: z.string().max(20).optional(),
  logoUrl: z.string().url().optional(),
});

/** Catálogo de instituições: globais (seed) + customizadas do workspace. */
export default async function institutionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const wsId = request.workspace!.id;
    // Catálogo (seed global + customizadas do ws) muda raramente e é lido a cada
    // formulário de conta — cacheado por workspace, invalidado ao criar uma nova.
    const institutions = await app.cache.getOrSet(
      institutionsCacheKey(wsId),
      env.CACHE_TTL_INSTITUTIONS_SECONDS,
      () =>
        app.prisma.institution.findMany({
          where: { OR: [{ workspaceId: null }, { workspaceId: wsId }] },
          orderBy: { name: 'asc' },
        }),
    );
    return { institutions };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const institution = await app.prisma.institution.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });
    // Lista mudou — derruba o cache do catálogo deste workspace.
    await app.cache.del(institutionsCacheKey(request.workspace!.id));
    return reply.code(201).send({ institution });
  });
}
