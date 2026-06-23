import type { FastifyInstance } from 'fastify';
import { BadRequest } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { detectSource } from '../imports/source';
import {
  createDocument,
  deleteDocument,
  getDocumentFileUrl,
  importDocument,
  listDocuments,
} from './documents.service';
import { importSchema, listQuerySchema } from './documents.schemas';

/** Documentos persistidos no storage (upload direto + os vindos do Extrato). */
export default async function documentsRoutes(app: FastifyInstance): Promise<void> {
  // Upload direto de um documento (sem importar). Multipart "file".
  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const file = await request.file();
    if (!file) throw BadRequest('Envie um arquivo (campo multipart "file").');

    const buffer = await file.toBuffer();
    const filename = file.filename || 'documento';
    const mimeType = file.mimetype || 'application/octet-stream';
    const source = detectSource(filename, mimeType);

    const document = await createDocument(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      { filename, mimeType, source, data: buffer },
    );
    return reply.code(201).send({ document });
  });

  app.get('/', async (request) => {
    const q = listQuerySchema.parse(request.query);
    return listDocuments(app.prisma, request.workspace!.id, q);
  });

  // URL assinada p/ baixar o documento original.
  app.get('/:id/file', async (request) => {
    const { id } = request.params as { id: string };
    return getDocumentFileUrl(app.prisma, request.workspace!.id, id);
  });

  // (Re)importa o documento com IA: cria um ImportBatch e dispara a extração.
  app.post('/:id/import', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = importSchema.parse(request.body ?? {});
    const result = await importDocument(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      id,
      body,
    );
    return reply.code(result.queued ? 202 : 200).send(result);
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteDocument(app.prisma, request.workspace!.id, id);
    return reply.code(204).send();
  });
}
