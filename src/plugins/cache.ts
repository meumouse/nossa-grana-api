import fp from 'fastify-plugin';
import { createCache } from '../lib/cache';

/**
 * Disponibiliza o cache em `fastify.cache` e o fecha no shutdown.
 * Driver escolhido no boot conforme o ambiente (memória ou Redis — ver lib/cache).
 */
export default fp(async (app) => {
  const cache = await createCache(app.log);
  app.decorate('cache', cache);
  app.addHook('onClose', async () => {
    await cache.close();
  });
});
