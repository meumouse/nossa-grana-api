import fp from 'fastify-plugin';
import { prisma } from '../prisma';

/** Disponibiliza o Prisma client em `fastify.prisma` e fecha no shutdown. */
export default fp(async (app) => {
  app.decorate('prisma', prisma);
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});
