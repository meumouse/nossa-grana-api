import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env';
import { BadRequest, NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { addDays } from '../../lib/dates';
import { randomToken } from '../../lib/tokens';
import { logActivity } from '../../lib/activity';
import { sendInvitationEmail } from '../../lib/email';

const createSchema = z
  .object({
    email: z.string().email().optional(),
    // E.164 (ex.: +5511988887777) — o cliente já normaliza via intl-tel-input.
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/, 'Telefone inválido (use formato internacional)')
      .optional(),
    displayName: z.string().trim().max(60).optional(),
    role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
  })
  .refine((b) => b.email || b.phone, {
    message: 'Informe um e-mail ou telefone para convidar',
  });

/** Link de aceite que o convidante compartilha (WhatsApp/copiar) ou vai no e-mail. */
function acceptUrl(token: string): string {
  return `${env.APP_URL}/invite?token=${encodeURIComponent(token)}`;
}

/** Rotas escopadas: criar/listar/revogar convites do workspace. */
export default async function invitationsScopedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const invitations = await app.prisma.invitation.findMany({
      where: { workspaceId: request.workspace!.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    return {
      invitations: invitations.map((inv) => ({ ...inv, acceptUrl: acceptUrl(inv.token) })),
    };
  });

  app.post('/', { preHandler: [requireRole('ADMIN')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const email = body.email?.toLowerCase().trim() || null;
    const phone = body.phone?.trim() || null;

    // Já é membro? (casa por e-mail OU telefone da conta existente)
    const already = await app.prisma.member.findFirst({
      where: {
        workspaceId: request.workspace!.id,
        deletedAt: null,
        user: { OR: [email ? { email } : undefined, phone ? { phone } : undefined].filter(Boolean) as object[] },
      },
    });
    if (already) throw BadRequest('Essa pessoa já é membro do perfil');

    // Evita convites duplicados pendentes para o mesmo contato.
    const pending = await app.prisma.invitation.findFirst({
      where: {
        workspaceId: request.workspace!.id,
        status: 'PENDING',
        OR: [email ? { email } : undefined, phone ? { phone } : undefined].filter(Boolean) as object[],
      },
    });
    if (pending) throw BadRequest('Já existe um convite pendente para esse contato');

    const token = randomToken(24);
    const invitation = await app.prisma.invitation.create({
      data: {
        workspaceId: request.workspace!.id,
        email,
        phone,
        displayName: body.displayName || null,
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
      metadata: { email, phone },
    });

    // Convite por e-mail: dispara o e-mail (no-op se Resend não configurado).
    if (email) {
      const [workspace, inviter] = await Promise.all([
        app.prisma.workspace.findUnique({ where: { id: request.workspace!.id }, select: { name: true } }),
        app.prisma.user.findUnique({ where: { id: request.userId! }, select: { name: true } }),
      ]);
      try {
        await sendInvitationEmail(email, {
          inviterName: inviter?.name,
          workspaceName: workspace?.name ?? 'Nossa Grana',
          url: acceptUrl(token),
        });
      } catch (err) {
        // Falha de e-mail não invalida o convite — o link ainda pode ser compartilhado.
        request.log.warn({ err }, 'falha ao enviar e-mail de convite');
      }
    }

    // Devolve o link p/ o cliente compartilhar (WhatsApp/copiar), independente do canal.
    return reply.code(201).send({ invitation: { ...invitation, acceptUrl: acceptUrl(token) } });
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
