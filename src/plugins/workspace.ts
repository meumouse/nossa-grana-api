import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { MemberRole } from '@prisma/client';
import { Forbidden, Unauthorized } from '../lib/errors';
import { roleAtLeast } from '../lib/roles';
import { env } from '../env';
import { memberCacheKey } from '../lib/cache';

/** Forma mínima da membership que guardamos em cache e usamos no contexto. */
interface CachedMember {
  id: string;
  role: MemberRole;
  workspaceId: string;
}

/**
 * preHandler: resolve o workspace ativo a partir de `:workspaceId` na rota e do
 * usuário autenticado. Garante a regra inegociável da arquitetura — só acessa
 * quem é membro. Popula `request.workspace` { id, memberId, role }.
 *
 * Use SEMPRE depois de `app.authenticate`.
 */
export async function resolveWorkspace(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.userId) throw Unauthorized();

  const { workspaceId } = request.params as { workspaceId?: string };
  if (!workspaceId) throw Forbidden('workspaceId ausente na rota');

  // Cache curto da membership: essa checagem roda em TODA request escopada e o
  // dado muda raramente. Em miss bate no banco; mudanças de papel/remoção
  // invalidam a chave na hora (ver members.routes). Só cacheia membership
  // existente — quem não é membro sempre revalida (acesso vale assim que entra).
  const member = await request.server.cache.getOrSet<CachedMember | null>(
    memberCacheKey(workspaceId, request.userId),
    env.CACHE_TTL_MEMBER_SECONDS,
    () =>
      request.server.prisma.member.findFirst({
        where: { workspaceId, userId: request.userId, deletedAt: null },
        select: { id: true, role: true, workspaceId: true },
      }),
  );

  if (!member) throw Forbidden('Você não participa deste workspace');

  request.workspace = { id: member.workspaceId, memberId: member.id, role: member.role };
}

/**
 * preHandler factory: exige um papel mínimo no workspace ativo.
 * Ex.: `requireRole('ADMIN')`. Deve rodar depois de `resolveWorkspace`.
 */
export function requireRole(min: MemberRole): preHandlerHookHandler {
  return async (request) => {
    const ws = request.workspace;
    if (!ws) throw Forbidden('Workspace não resolvido');
    if (!roleAtLeast(ws.role, min)) {
      throw Forbidden(`Ação requer papel mínimo ${min} (você é ${ws.role})`);
    }
  };
}
