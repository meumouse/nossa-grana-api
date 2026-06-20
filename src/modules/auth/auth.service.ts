import type { PrismaClient } from '@prisma/client';
import { BadRequest, Unauthorized } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/password';
import { createDefaultCategories } from '../../lib/defaults';

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
}

function toPublic(u: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
}): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    locale: u.locale,
    timezone: u.timezone,
  };
}

/**
 * Cria o usuário e já provisiona um workspace pessoal (com settings padrão,
 * membership OWNER e categorias padrão) — assim o app abre utilizável.
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

    const workspace = await tx.workspace.create({
      data: {
        name: 'Pessoal',
        type: 'PERSONAL',
        members: { create: { userId: user.id, role: 'OWNER' } },
        settings: { create: {} },
      },
    });

    await createDefaultCategories(tx, workspace.id);

    await tx.userPreferences.create({
      data: { userId: user.id, defaultWorkspaceId: workspace.id },
    });

    return { user: toPublic(user), workspaceId: workspace.id };
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
