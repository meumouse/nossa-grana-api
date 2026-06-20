import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../../lib/errors';

const acceptSchema = z.object({ token: z.string().min(1) });

/**
 * Aceitar convite — rota NÃO escopada (o usuário ainda não é membro). Exige só
 * autenticação. Cria o Member e marca o convite como ACCEPTED.
 */
export default async function invitationAcceptRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.post('/accept', async (request) => {
    const { token } = acceptSchema.parse(request.body);

    const invitation = await app.prisma.invitation.findUnique({ where: { token } });
    if (!invitation || invitation.status !== 'PENDING') throw BadRequest('Convite inválido');
    if (invitation.expiresAt < new Date()) {
      await app.prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'EXPIRED' } });
      throw BadRequest('Convite expirado');
    }

    const user = await app.prisma.user.findUnique({ where: { id: request.userId! } });
    if (!user) throw BadRequest('Usuário inválido');
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw BadRequest('Este convite foi enviado para outro e-mail');
    }

    const member = await app.prisma.$transaction(async (tx) => {
      const m = await tx.member.upsert({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
        update: { role: invitation.role, deletedAt: null },
        create: { workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role },
      });
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      return m;
    });

    return { member, workspaceId: invitation.workspaceId };
  });
}
