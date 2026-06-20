import { PrismaClient } from '@prisma/client';

/**
 * Singleton do Prisma. Reaproveitado entre hot-reloads do tsx em dev para não
 * estourar conexões.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
