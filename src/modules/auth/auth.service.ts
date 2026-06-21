import type { Prisma, PrismaClient } from '@prisma/client';
import { BadRequest, Unauthorized } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/password';
import { createDefaultCategories } from '../../lib/defaults';

export interface PublicUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  surname: string | null;
  avatarUrl: string | null;
  phone: string | null;
  locale: string;
  timezone: string;
}

export function toPublic(u: {
  id: string;
  email: string;
  emailVerified: Date | null;
  name: string | null;
  surname: string | null;
  avatarUrl: string | null;
  phone: string | null;
  locale: string;
  timezone: string;
}): PublicUser {
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.emailVerified !== null,
    name: u.name,
    surname: u.surname,
    avatarUrl: u.avatarUrl,
    phone: u.phone,
    locale: u.locale,
    timezone: u.timezone,
  };
}

/**
 * Provisiona o workspace pessoal de um usuário recém-criado (settings padrão,
 * membership OWNER, categorias padrão e a preferência de workspace default) —
 * assim o app abre utilizável. Reutilizado pelo cadastro por senha e pelo
 * primeiro login via OAuth (Google). Roda dentro de uma transação.
 */
export async function provisionUserWorkspace(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string> {
  const workspace = await tx.workspace.create({
    data: {
      name: 'Pessoal',
      type: 'PERSONAL',
      members: { create: { userId, role: 'OWNER' } },
      settings: { create: {} },
    },
  });

  await createDefaultCategories(tx, workspace.id);

  await tx.userPreferences.create({
    data: { userId, defaultWorkspaceId: workspace.id },
  });

  return workspace.id;
}

/**
 * Cria o usuário e já provisiona um workspace pessoal — assim o app abre
 * utilizável.
 */
export async function registerUser(
  prisma: PrismaClient,
  input: { email: string; password: string; name?: string },
): Promise<{ user: PublicUser; workspaceId: string }> {
  const email = input.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw BadRequest('E-mail já cadastrado');

  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, name: input.name ?? null, passwordHash },
    });

    const workspaceId = await provisionUserWorkspace(tx, user.id);

    return { user: toPublic(user), workspaceId };
  });
}

export async function loginUser(
  prisma: PrismaClient,
  input: { email: string; password: string },
): Promise<PublicUser> {
  const email = input.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash || user.deletedAt) {
    throw Unauthorized('Credenciais inválidas');
  }

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) throw Unauthorized('Credenciais inválidas');

  return toPublic(user);
}

export async function getMe(prisma: PrismaClient, userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw Unauthorized();
  return toPublic(user);
}

export interface UpdateProfileInput {
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
}

/**
 * Atualiza os dados do perfil do usuário autenticado. Campos ausentes ficam
 * inalterados; strings vazias LIMPAM o campo (viram null). Trocar o e-mail
 * exige que ele esteja livre e zera a verificação — o chamador deve disparar
 * um novo e-mail de verificação (sinalizado por `emailChanged`).
 */
export async function updateProfile(
  prisma: PrismaClient,
  userId: string,
  input: UpdateProfileInput,
): Promise<{ user: PublicUser; emailChanged: boolean }> {
  const current = await prisma.user.findUnique({ where: { id: userId } });
  if (!current || current.deletedAt) throw Unauthorized();

  const data: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim() || null;
  if (input.surname !== undefined) data.surname = input.surname.trim() || null;
  if (input.phone !== undefined) data.phone = input.phone.trim() || null;
  if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl || null;

  let emailChanged = false;
  if (input.email !== undefined) {
    const email = input.email.toLowerCase().trim();
    if (email !== current.email) {
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) throw BadRequest('E-mail já cadastrado');
      data.email = email;
      data.emailVerified = null; // novo e-mail volta a precisar de verificação
      emailChanged = true;
    }
  }

  const user = await prisma.user.update({ where: { id: userId }, data });
  return { user: toPublic(user), emailChanged };
}
