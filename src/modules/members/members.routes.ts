import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, Forbidden, NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { logActivity } from '../../lib/activity';
import { memberCacheKey } from '../../lib/cache';

const updateSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']).optional(),
  displayName: z.string().max(60).nullable().optional(),
});

/** Rotas escopadas: gestão de membros do workspace. */
export default async function membersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const members = await app.prisma.member.findMany({
      where: { workspaceId: request.workspace!.id, deletedAt: null },
      select: {
        id: true,
        role: true,
        displayName: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { members };
  });

  app.patch('/:memberId', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const { memberId } = request.params as { memberId: string };
    const body = updateSchema.parse(request.body);

    const target = await app.prisma.member.findFirst({
      where: { id: memberId, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!target) throw NotFound('Membro não encontrado');

    // Só OWNER pode promover/rebaixar OWNER.
    if ((body.role === 'OWNER' || target.role === 'OWNER') && request.workspace!.role !== 'OWNER') {
      throw Forbidden('Apenas o OWNER gerencia o papel OWNER');
    }

    // Não deixar o workspace sem nenhum OWNER.
    if (target.role === 'OWNER' && body.role && body.role !== 'OWNER') {
      const owners = await app.prisma.member.count({
        where: { workspaceId: request.workspace!.id, role: 'OWNER', deletedAt: null },
      });
      if (owners <= 1) throw BadRequest('O workspace precisa de ao menos um OWNER');
    }

    const member = await app.prisma.member.update({
      where: { id: memberId },
      data: { role: body.role, displayName: body.displayName },
    });
    // Invalida o cache de membership (papel pode ter mudado) para o próximo
    // acesso já enxergar o novo papel sem esperar o TTL.
    await app.cache.del(memberCacheKey(request.workspace!.id, target.userId));
    return { member };
  });

  app.delete('/:memberId', { preHandler: [requireRole('ADMIN')] }, async (request, reply) => {
    const { memberId } = request.params as { memberId: string };

    const target = await app.prisma.member.findFirst({
      where: { id: memberId, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!target) throw NotFound('Membro não encontrado');

    if (target.role === 'OWNER') {
      const owners = await app.prisma.member.count({
        where: { workspaceId: request.workspace!.id, role: 'OWNER', deletedAt: null },
      });
      if (owners <= 1) throw BadRequest('Não é possível remover o último OWNER');
    }

    await app.prisma.member.update({ where: { id: memberId }, data: { deletedAt: new Date() } });
    // Revoga o acesso cacheado na hora — sem isso, o removido ainda passaria
    // no resolveWorkspace até o TTL expirar.
    await app.cache.del(memberCacheKey(request.workspace!.id, target.userId));
    await logActivity(app.prisma, {
      workspaceId: request.workspace!.id,
      actorId: request.userId,
      action: 'member.removed',
      entityType: 'Member',
      entityId: memberId,
    });
    return reply.code(204).send();
  });
}
