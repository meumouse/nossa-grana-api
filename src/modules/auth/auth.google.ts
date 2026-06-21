import type { PrismaClient, User } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import { Unauthorized } from '../../lib/errors';
import { provisionUserWorkspace, toPublic, type PublicUser } from './auth.service';

const PROVIDER = 'google';

// Um client por Client ID (reutiliza o cache de chaves públicas do Google entre
// requests). O `verifyIdToken` baixa e cacheia os certificados de assinatura.
const clients = new Map<string, OAuth2Client>();
function clientFor(clientId: string): OAuth2Client {
  let client = clients.get(clientId);
  if (!client) {
    client = new OAuth2Client(clientId);
    clients.set(clientId, client);
  }
  return client;
}

interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null; // primeiro nome (given_name; cai p/ o nome completo)
  surname: string | null; // sobrenome (family_name)
  picture: string | null;
}

/**
 * Valida o ID token (JWT) emitido pelo Google Identity Services: confere a
 * assinatura contra as chaves públicas do Google, o `audience` (nosso Client ID)
 * e a expiração. Devolve o perfil mínimo que precisamos.
 */
async function verifyGoogleToken(credential: string, clientId: string): Promise<GoogleProfile> {
  let payload;
  try {
    const ticket = await clientFor(clientId).verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    throw Unauthorized('Não foi possível validar o login com o Google');
  }

  if (!payload?.sub || !payload.email) {
    throw Unauthorized('Token do Google sem informações suficientes');
  }
  // O Google só deveria emitir e-mail verificado, mas conferimos: é o que nos
  // permite vincular/criar a conta com segurança.
  const emailVerified = payload.email_verified === true;
  if (!emailVerified) {
    throw Unauthorized('Seu e-mail do Google ainda não foi verificado');
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase().trim(),
    emailVerified,
    name: payload.given_name ?? payload.name ?? null,
    surname: payload.family_name ?? null,
    picture: payload.picture ?? null,
  };
}

/**
 * Login/cadastro via Google. Resolve a conta em três cenários:
 *  1. Já há um OAuthAccount Google com esse `sub` → entra direto.
 *  2. Existe um usuário com o mesmo e-mail (cadastro por senha) → vincula a
 *     conta Google a ele (o e-mail do Google é verificado) e entra.
 *  3. Ninguém ainda → cria o usuário (sem senha, e-mail já verificado) e
 *     provisiona o workspace pessoal.
 * Em todos os casos preenche nome/avatar quando o usuário ainda não os tem.
 */
export async function loginWithGoogle(
  prisma: PrismaClient,
  credential: string,
  clientId: string,
): Promise<{ user: PublicUser; isNew: boolean }> {
  const profile = await verifyGoogleToken(credential, clientId);

  // 1. Conta Google já vinculada.
  const linked = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider: PROVIDER, providerAccountId: profile.sub } },
    include: { user: true },
  });
  if (linked && !linked.user.deletedAt) {
    const user = await fillMissingProfile(prisma, linked.user, profile);
    return { user: toPublic(user), isNew: false };
  }

  // 2. Usuário existente pelo e-mail → vincula.
  const existing = await prisma.user.findUnique({ where: { email: profile.email } });
  if (existing && !existing.deletedAt) {
    await prisma.oAuthAccount.create({
      data: { userId: existing.id, provider: PROVIDER, providerAccountId: profile.sub },
    });
    const user = await fillMissingProfile(prisma, existing, profile, { verifyEmail: true });
    return { user: toPublic(user), isNew: false };
  }

  // 3. Conta nova.
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: profile.email,
        name: profile.name,
        surname: profile.surname,
        avatarUrl: profile.picture,
        emailVerified: profile.emailVerified ? new Date() : null,
        oauthAccounts: { create: { provider: PROVIDER, providerAccountId: profile.sub } },
      },
    });
    await provisionUserWorkspace(tx, created.id);
    return created;
  });

  return { user: toPublic(user), isNew: true };
}

/** Completa nome/avatar (e opcionalmente marca e-mail verificado) sem sobrescrever o que o usuário já definiu. */
async function fillMissingProfile(
  prisma: PrismaClient,
  user: User,
  profile: GoogleProfile,
  opts: { verifyEmail?: boolean } = {},
): Promise<User> {
  const data: { name?: string; surname?: string; avatarUrl?: string; emailVerified?: Date } = {};
  if (!user.name && profile.name) data.name = profile.name;
  if (!user.surname && profile.surname) data.surname = profile.surname;
  if (!user.avatarUrl && profile.picture) data.avatarUrl = profile.picture;
  if (opts.verifyEmail && !user.emailVerified && profile.emailVerified) data.emailVerified = new Date();

  if (Object.keys(data).length === 0) return user;
  return prisma.user.update({ where: { id: user.id }, data });
}
