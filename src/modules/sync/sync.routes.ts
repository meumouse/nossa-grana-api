import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../plugins/workspace';
import { pull, push } from './sync.service';
import { pullSchema, pushSchema } from './sync.schemas';

export default async function syncRoutes(app: FastifyInstance): Promise<void> {
  // Envia o lote de mutações pendentes do dispositivo (idempotente por clientId).
  app.post('/push', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const payload = pushSchema.parse(request.body);
    return push(app.prisma, request.workspace!.id, request.userId!, payload);
  });

  // Puxa o delta desde o último watermark.
  app.get('/pull', async (request) => {
    const { since } = pullSchema.parse(request.query);
    return pull(app.prisma, request.workspace!.id, since);
  });
}
