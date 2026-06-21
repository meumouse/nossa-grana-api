import type { PrismaClient, VerificationPurpose } from '@prisma/client';
import { env } from '../../env';
import { BadRequest } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { randomToken, sha256 } from '../../lib/tokens';
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
} from '../../lib/email';

/**
 * Fluxos por e-mail (recuperação de senha, verificação de conta). A mecânica é
 * sempre a mesma: emitir um token de uso único (guardamos só o hash), enviar o
 * link, e depois consumir o token validando expiração/uso. Mantido separado do
 * `auth.tokens` (sessões/refresh) por ser outro ciclo de vida.
 */

const PASSWORD_RESET_TTL_MS = env.PASSWORD_RESET_TTL_MINUTES * 60_000;
const EMAIL_VERIFICATION_TTL_MS = env.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000;

function resetUrl(raw: string): string {
  return `${env.APP_URL}/reset-password?token=${encodeURIComponent(raw)}`;
}

function verifyUrl(raw: string): string {
  return `${env.APP_URL}/verify-email?token=${encodeURIComponent(raw)}`;
}

/**
 * Emite um token p/ um propósito, invalidando os anteriores ainda pendentes do
 * mesmo propósito (só um link válido por vez). Devolve o valor CRU (vai no link).
 */
async function issueToken(
  prisma: PrismaClient,
  userId: string,
  purpose: VerificationPurpose,
  ttlMs: number,
): Promise<string> {
  await prisma.verificationToken.deleteMany({ where: { userId, purpose, usedAt: null } });
  const raw = randomToken(32);
  await prisma.verificationToken.create({
    data: {
      userId,
      purpose,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return raw;
}

/** Valida e marca o token como usado; devolve o userId. Lança se inválido. */
async function consumeToken(
  prisma: PrismaClient,
  rawToken: string,
  purpose: VerificationPurpose,
): Promise<string> {
  const token = await prisma.verificationToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
  });
  if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt < new Date()) {
    throw BadRequest('Link inválido ou expirado. Solicite um novo.');
  }
  await prisma.verificationToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
  return token.userId;
}

// ---------------------------------------------------------------------------
//  Recuperação de senha
// ---------------------------------------------------------------------------

/**
 * Dispara o e-mail de recuperação. Resolve SEMPRE com sucesso (mesmo p/ e-mail
 * inexistente) — não revelamos se a conta existe (anti-enumeração). Falhas de
 * envio são logadas, não propagadas, p/ não vazar nada por timing/erro.
 */
export async function requestPasswordReset(prisma: PrismaClient, rawEmail: string): Promise<void> {
  const email = rawEmail.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  // Só faz sentido p/ contas com senha (OAuth-only não redefine senha aqui).
  if (!user || !user.passwordHash || user.deletedAt) return;

  try {
    const raw = await issueToken(prisma, user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MS);
    await sendPasswordResetEmail(user.email, { name: user.name, url: resetUrl(raw) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[email] falha ao enviar recuperação de senha:', err);
  }
}

/**
 * Conclui a redefinição: valida o token, grava a nova senha e revoga TODAS as
 * sessões do usuário (qualquer dispositivo logado é deslogado por segurança).
 */
export async function resetPassword(
  prisma: PrismaClient,
  rawToken: string,
  newPassword: string,
): Promise<void> {
  const userId = await consumeToken(prisma, rawToken, 'PASSWORD_RESET');
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

// ---------------------------------------------------------------------------
//  Verificação de e-mail
// ---------------------------------------------------------------------------

/** Emite token e envia o e-mail de verificação para o usuário. */
export async function sendUserVerification(
  prisma: PrismaClient,
  user: { id: string; email: string; name: string | null },
): Promise<void> {
  const raw = await issueToken(prisma, user.id, 'EMAIL_VERIFICATION', EMAIL_VERIFICATION_TTL_MS);
  await sendVerificationEmail(user.email, { name: user.name, url: verifyUrl(raw) });
}

/** Reenvio solicitado pelo usuário autenticado. */
export async function resendVerification(prisma: PrismaClient, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw BadRequest('Usuário inválido');
  if (user.emailVerified) throw BadRequest('Seu e-mail já está verificado');
  await sendUserVerification(prisma, user);
}

/** Confirma o e-mail a partir do token do link. Idempotente. */
export async function verifyEmail(prisma: PrismaClient, rawToken: string): Promise<void> {
  const userId = await consumeToken(prisma, rawToken, 'EMAIL_VERIFICATION');
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: new Date() },
  });
}

// ---------------------------------------------------------------------------
//  Pós-registro (boas-vindas + verificação)
// ---------------------------------------------------------------------------

/**
 * Dispara boas-vindas + verificação logo após o cadastro. Não-fatal: se o envio
 * falhar, o registro não é desfeito — apenas logamos (o usuário pode reenviar).
 */
export async function onUserRegistered(
  prisma: PrismaClient,
  user: { id: string; email: string; name: string | null },
): Promise<void> {
  try {
    await sendWelcomeEmail(user.email, { name: user.name });
    await sendUserVerification(prisma, user);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[email] falha ao enviar boas-vindas/verificação no registro:', err);
  }
}
