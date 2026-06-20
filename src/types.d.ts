import 'fastify';
import type { PrismaClient, MemberRole } from '@prisma/client';

/** Contexto do workspace ativo, resolvido pelo plugin de workspace. */
export interface WorkspaceContext {
  id: string;
  memberId: string;
  role: MemberRole;
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    /** preHandler: exige access token válido; popula request.userId. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** Preenchido por `authenticate`. */
    userId?: string;
    /** Preenchido pelo plugin de workspace (rotas /workspaces/:workspaceId/*). */
    workspace?: WorkspaceContext;
  }
}
