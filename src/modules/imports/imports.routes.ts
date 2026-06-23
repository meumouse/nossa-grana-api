import type { FastifyInstance } from 'fastify';
import { BadRequest } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { detectSource } from './source';
import {
  cancelBatch,
  confirmBatch,
  createBatch,
  getBatch,
  getBatchFileUrl,
  listBatches,
  patchItem,
  startExtraction,
} from './imports.service';
import { confirmSchema, listQuerySchema, patchItemSchema } from './imports.schemas';

export default async function importsRoutes(app: FastifyInstance): Promise<void> {
  // Upload + extração. Conta padrão opcional via query (?accountId=).
  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const file = await request.file();
    if (!file) throw BadRequest('Envie um arquivo (campo multipart "file").');

    const buffer = await file.toBuffer();
    const filename = file.filename || 'documento';
    const mimeType = file.mimetype || 'application/octet-stream';
    const source = detectSource(filename, mimeType);
    const { accountId, creditCardId } = request.query as {
      accountId?: string;
      creditCardId?: string;
    };

    const batch = await createBatch(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      {
        source,
        filename,
        mimeType,
        data: buffer,
        defaultAccountId: accountId,
        defaultCreditCardId: creditCardId,
      },
    );
    return reply.code(201).send({ batch });
  });

  // Confirma o upload e dispara a extração com IA (segunda etapa do fluxo).
  // Enfileirado (Redis + storage): segue em background e o front acompanha por
  // polling; senão processa inline.
  app.post('/:id/extract', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await startExtraction(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      id,
    );
    return reply.code(result.queued ? 202 : 200).send(result);
  });

  app.get('/', async (request) => {
    const q = listQuerySchema.parse(request.query);
    return listBatches(app.prisma, request.workspace!.id, q);
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const batch = await getBatch(app.prisma, request.workspace!.id, id);
    return { batch };
  });

  // URL assinada p/ baixar o documento original enviado à importação.
  app.get('/:id/file', async (request) => {
    const { id } = request.params as { id: string };
    return getBatchFileUrl(app.prisma, request.workspace!.id, id);
  });

  app.patch('/:id/items/:itemId', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = patchItemSchema.parse(request.body);
    const item = await patchItem(app.prisma, request.workspace!.id, id, itemId, body);
    return { item };
  });

  app.post('/:id/confirm', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = confirmSchema.parse(request.body ?? {});
    const result = await confirmBatch(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      id,
      body,
    );
    // Enfileirado: trabalho segue em background, o front acompanha por polling.
    return reply.code(result.queued ? 202 : 200).send(result);
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await cancelBatch(app.prisma, request.workspace!.id, id);
    return reply.code(204).send();
  });
}
