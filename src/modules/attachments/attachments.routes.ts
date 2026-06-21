import type { FastifyInstance } from 'fastify';
import { BadRequest } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import {
  createAttachment,
  deleteAttachment,
  getAttachmentUrl,
  listAttachments,
} from './attachments.service';

/**
 * Comprovantes/anexos de uma transação. Montado sob
 * `/workspaces/:workspaceId/transactions/:transactionId/attachments`.
 *
 * Upload passa pela API (multipart); download é via URL assinada do storage,
 * então o arquivo não trafega pela API na leitura.
 */
export default async function attachmentsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const { transactionId } = request.params as { transactionId: string };
    return listAttachments(app.prisma, request.workspace!.id, transactionId);
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { transactionId } = request.params as { transactionId: string };
    const file = await request.file();
    if (!file) throw BadRequest('Envie um arquivo (campo multipart "file").');

    const buffer = await file.toBuffer();
    const attachment = await createAttachment(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      transactionId,
      {
        filename: file.filename || 'comprovante',
        mimeType: file.mimetype || 'application/octet-stream',
        data: buffer,
      },
    );
    return reply.code(201).send({ attachment });
  });

  // URL assinada p/ baixar um anexo específico.
  app.get('/:id', async (request) => {
    const { transactionId, id } = request.params as { transactionId: string; id: string };
    return getAttachmentUrl(app.prisma, request.workspace!.id, transactionId, id);
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { transactionId, id } = request.params as { transactionId: string; id: string };
    await deleteAttachment(app.prisma, request.workspace!.id, transactionId, id);
    return reply.code(204).send();
  });
}
