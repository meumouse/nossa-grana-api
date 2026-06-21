import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import { logActivity } from '../../lib/activity';
import { memberCacheKey } from '../../lib/cache';

const tokenSchema = z.object({ token: z.string().min(1) });

/**
 * Rotas de convite NÃO escopadas (o usuário ainda não é membro do workspace).
 * Exigem apenas autenticação.
 *  - GET  /mine     → convites pendentes que casam o e-mail/telefone do usuário
 *                     (vira a notificação no painel de quem já tem conta).
 *  - POST /accept   → cria o Member (posse do token basta como prova).
 *  - POST /decline  → marca o convite como REVOKED.
 */
export default async function invitationAcceptRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/mine', async (request) => {
    const user = await app.prisma.user.findUnique({
      where: { id: request.userId! },
      select: { email: true, phone: true },
    });
    if (!user) throw BadRequest('Usuário inválido');

    const match: object[] = [{ email: user.email.toLowerCase() }];
    if (user.phone) match.push({ phone: user.phone });

    const invitations = await app.prisma.invitation.findMany({
      where: { status: 'PENDING', expiresAt: { gt: new Date() }, OR: match },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        token: true,
        role: true,
        displayName: true,
        createdAt: true,
        expiresAt: true,
        workspace: { select: { id: true, name: true } },
        invitedBy: { select: { name: true, surname: true } },
      },
    });
    return { invitations };
  });

  app.post('/accept', async (request) => {
    const { token } = tokenSchema.parse(request.body);

    const invitation = await app.prisma.invitation.findUnique({ where: { token } });
    if (!invitation || invitation.status !== 'PENDING') throw BadRequest('Convite inválido');
    if (invitation.expiresAt < new Date()) {
      await app.prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'EXPIRED' } });
      throw BadRequest('Convite expirado');
    }

    const user = await app.prisma.user.findUnique({ where: { id: request.userId! } });
    if (!user) throw BadRequest('Usuário inválido');

    // Posse do link basta como prova — não exigimos que e-mail/telefone batam.
    const member = await app.prisma.$transaction(async (tx) => {
      const m = await tx.member.upsert({
        where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
        update: { role: invitation.role, deletedAt: null, displayName: invitation.displayName },
        create: {
          workspaceId: invitation.workspaceId,
          userId: user.id,
          role: invitation.role,
          displayName: invitation.displayName,
        },
      });
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      return m;
    });

    // Limpa o cache de membership p/ o acesso valer imediatamente.
    await app.cache.del(memberCacheKey(invitation.workspaceId, user.id));
    await logActivity(app.prisma, {
      workspaceId: invitation.workspaceId,
      actorId: user.id,
      action: 'invitation.accepted',
      entityType: 'Invitation',
      entityId: invitation.id,
    });

    return { member, workspaceId: invitation.workspaceId };
  });

  app.post('/decline', async (request, reply) => {
    const { token } = tokenSchema.parse(request.body);
    const invitation = await app.prisma.invitation.findUnique({ where: { token } });
    if (!invitation) throw NotFound('Convite não encontrado');
    if (invitation.status === 'PENDING') {
      await app.prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'REVOKED' } });
    }
    return reply.code(204).send();
  });
}
