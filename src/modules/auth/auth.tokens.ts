import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../env';
import { Unauthorized } from '../../lib/errors';
import { addDays } from '../../lib/dates';
import { randomToken, sha256 } from '../../lib/tokens';

export interface DeviceInfo {
  deviceId?: string;
  userAgent?: string;
  ip?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

function signAccess(app: FastifyInstance, userId: string): string {
  return app.jwt.sign({ sub: userId });
}

/** Cria uma sessão (refresh token) e devolve access + refresh. */
export async function issueTokens(
  app: FastifyInstance,
  prisma: PrismaClient,
  userId: string,
  device: DeviceInfo,
): Promise<AuthTokens> {
  const raw = randomToken();
  const expiresAt = addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS);

  await prisma.session.create({
    data: {
      userId,
      refreshToken: sha256(raw), // guardamos só o hash
      deviceId: device.deviceId ?? null,
      userAgent: device.userAgent ?? null,
      ip: device.ip ?? null,
      expiresAt,
    },
  });

  return { accessToken: signAccess(app, userId), refreshToken: raw, refreshExpiresAt: expiresAt };
}

/**
 * Rotação: valida o refresh atual, revoga-o e emite um novo par. Detecta reuso
 * (token já revogado) — útil p/ invalidar sessão comprometida.
 */
export async function rotateTokens(
  app: FastifyInstance,
  prisma: PrismaClient,
  rawRefresh: string,
  device: DeviceInfo,
): Promise<AuthTokens> {
  const hashed = sha256(rawRefresh);
  const session = await prisma.session.findUnique({ where: { refreshToken: hashed } });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw Unauthorized('Sessão inválida ou expirada');
  }

  // Revoga o atual e cria o próximo (rotação).
  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  return issueTokens(app, prisma, session.userId, {
    deviceId: device.deviceId ?? session.deviceId ?? undefined,
    userAgent: device.userAgent,
    ip: device.ip,
  });
}

/** Logout: revoga a sessão correspondente ao refresh token. */
export async function revokeToken(prisma: PrismaClient, rawRefresh: string): Promise<void> {
  const hashed = sha256(rawRefresh);
  await prisma.session.updateMany({
    where: { refreshToken: hashed, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
