import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../env';
import { Unauthorized } from '../lib/errors';

/** Payload do access token. */
export interface AccessTokenPayload {
  sub: string; // userId
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload & { iat: number; exp: number };
  }
}

/**
 * Registra o @fastify/jwt (assinatura/verificação do ACCESS token) e expõe o
 * preHandler `authenticate`, que valida o Bearer token e popula `request.userId`.
 * O REFRESH token é opaco e vive na tabela Session (ver módulo auth) — não passa
 * por aqui.
 */
export default fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_TTL },
  });

  app.decorate('authenticate', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw Unauthorized('Token de acesso inválido ou expirado');
    }
    request.userId = request.user.sub;
  });
});
