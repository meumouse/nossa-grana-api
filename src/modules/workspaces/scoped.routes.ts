import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  iconColor: z.string().max(20).optional(),
});

const settingsSchema = z.object({
  baseCurrency: z.string().length(3).optional(),
  monthStartDay: z.number().int().min(1).max(28).optional(),
  forecastHorizon: z.number().int().min(1).max(36).optional(),
  variableLookback: z.number().int().min(1).max(12).optional(),
  weekStartsOnMonday: z.boolean().optional(),
});

/**
 * Rotas escopadas ao workspace ativo: detalhe, atualização, exclusão e settings.
 * Montadas dentro do grupo que já roda authenticate + resolveWorkspace.
 */
export default async function workspaceScopedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const ws = await app.prisma.workspace.findFirst({
      where: { id: request.workspace!.id, deletedAt: null },
      include: { settings: true, _count: { select: { members: true } } },
    });
    if (!ws) throw NotFound('Workspace não encontrado');
    return { workspace: ws, role: request.workspace!.role };
  });

  app.patch('/', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const body = updateSchema.parse(request.body);
    const workspace = await app.prisma.workspace.update({
      where: { id: request.workspace!.id },
      data: body,
    });
    return { workspace };
  });

  app.delete('/', { preHandler: [requireRole('OWNER')] }, async (request, reply) => {
    await app.prisma.workspace.update({
      where: { id: request.workspace!.id },
      data: { deletedAt: new Date() },
    });
    return reply.code(204).send();
  });

  app.get('/settings', async (request) => {
    const settings = await app.prisma.workspaceSettings.findUnique({
      where: { workspaceId: request.workspace!.id },
    });
    return { settings };
  });

  app.patch('/settings', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const body = settingsSchema.parse(request.body);
    const settings = await app.prisma.workspaceSettings.upsert({
      where: { workspaceId: request.workspace!.id },
      update: body,
      create: { workspaceId: request.workspace!.id, ...body },
    });
    return { settings };
  });
}
