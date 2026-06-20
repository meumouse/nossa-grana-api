import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env';
import { BadRequest, NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { addDays } from '../../lib/dates';
import { randomToken } from '../../lib/tokens';
import { logActivity } from '../../lib/activity';

const createSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

/** Rotas escopadas: criar/listar/revogar convites do workspace. */
export default async function invitationsScopedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const invitations = await app.prisma.invitation.findMany({
      where: { workspaceId: request.workspace!.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    return { invitations };
  });

  app.post('/', { preHandler: [requireRole('ADMIN')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const email = body.email.toLowerCase().trim();

    // Já é membro?
    const already = await app.prisma.member.findFirst({
      where: { workspaceId: request.workspace!.id, user: { email }, deletedAt: null },
    });
    if (already) throw BadRequest('Esse e-mail já é membro do workspace');

    const token = randomToken(24);
    const invitation = await app.prisma.invitation.create({
      data: {
        workspaceId: request.workspace!.id,
        email,
        role: body.role,
        token,
        invitedById: request.userId!,
        expiresAt: addDays(new Date(), env.INVITATION_TTL_DAYS),
      },
    });

    await logActivity(app.prisma, {
      workspaceId: request.workspace!.id,
      actorId: request.userId,
      action: 'invitation.created',
      entityType: 'Invitation',
      entityId: invitation.id,
      metadata: { email },
    });

    // O token vai por e-mail num app real; aqui devolvemos p/ o cliente montar o link.
    return reply.code(201).send({ invitation });
  });

  app.post('/:id/revoke', { preHandler: [requireRole('ADMIN')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const inv = await app.prisma.invitation.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!inv) throw NotFound('Convite não encontrado');

    await app.prisma.invitation.update({ where: { id }, data: { status: 'REVOKED' } });
    return reply.code(204).send();
  });
}
