import type { FastifyInstance } from 'fastify';
import type { Institution } from '@prisma/client';
import { z } from 'zod';
import { requireRole } from '../../plugins/workspace';
import { env } from '../../env';
import { institutionsCacheKey } from '../../lib/cache';
import { BadRequest, NotFound } from '../../lib/errors';
import { buildKey, getDownloadUrl, isStorageEnabled, putObject } from '../../lib/storage';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  shortName: z.string().max(40).optional(),
  brandColor: z.string().max(20).optional(),
  // chave do logo no storage (prefixo "logos/…") OU uma URL externa.
  logoUrl: z.string().max(512).optional(),
});

const updateSchema = createSchema.partial();

/** Logo guardado como chave do storage (não-URL) precisa virar URL assinada. */
async function resolveLogoUrl(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  if (/^https?:\/\//i.test(logoUrl)) return logoUrl; // URL externa: usa direto
  if (!isStorageEnabled) return null; // chave de storage, mas storage desligado
  try {
    return await getDownloadUrl(logoUrl);
  } catch {
    return null;
  }
}

async function withResolvedLogo(inst: Institution): Promise<Institution> {
  return { ...inst, logoUrl: await resolveLogoUrl(inst.logoUrl) };
}

/** Catálogo de instituições: globais (seed) + customizadas do workspace. */
export default async function institutionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const wsId = request.workspace!.id;
    // Catálogo (seed global + customizadas do ws) muda raramente e é lido a cada
    // formulário de conta — cacheado por workspace, invalidado ao criar uma nova.
    // O cache guarda a CHAVE crua do logo; a URL assinada (curta) é resolvida a
    // cada request, fora do cache.
    const institutions = await app.cache.getOrSet(
      institutionsCacheKey(wsId),
      env.CACHE_TTL_INSTITUTIONS_SECONDS,
      () =>
        app.prisma.institution.findMany({
          where: { OR: [{ workspaceId: null }, { workspaceId: wsId }] },
          orderBy: { name: 'asc' },
        }),
    );
    const resolved = await Promise.all(institutions.map(withResolvedLogo));
    return { institutions: resolved };
  });

  // Upload do logo de uma instituição custom. Devolve a CHAVE p/ salvar em
  // logoUrl no create/update. Multipart "file".
  app.post('/logo', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    if (!isStorageEnabled) throw BadRequest('Storage não está configurado.');
    const file = await request.file();
    if (!file) throw BadRequest('Envie um arquivo (campo multipart "file").');
    if (!file.mimetype?.startsWith('image/')) throw BadRequest('O logo deve ser uma imagem.');

    const buffer = await file.toBuffer();
    const key = buildKey({
      workspaceId: request.workspace!.id,
      prefix: 'logos',
      ownerId: request.userId!,
      filename: file.filename || 'logo',
    });
    await putObject({ key, body: buffer, contentType: file.mimetype });
    const url = await getDownloadUrl(key);
    return reply.code(201).send({ key, url });
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const institution = await app.prisma.institution.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });
    // Lista mudou — derruba o cache do catálogo deste workspace.
    await app.cache.del(institutionsCacheKey(request.workspace!.id));
    return reply.code(201).send({ institution: await withResolvedLogo(institution) });
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    // Só instituições do próprio workspace podem ser editadas (nunca as globais).
    const existing = await app.prisma.institution.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!existing) throw NotFound('Instituição não encontrada');
    const body = updateSchema.parse(request.body);
    const institution = await app.prisma.institution.update({ where: { id }, data: body });
    await app.cache.del(institutionsCacheKey(request.workspace!.id));
    return { institution: await withResolvedLogo(institution) };
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.institution.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!existing) throw NotFound('Instituição não encontrada');
    await app.prisma.institution.delete({ where: { id } });
    await app.cache.del(institutionsCacheKey(request.workspace!.id));
    return reply.code(204).send();
  });
}
