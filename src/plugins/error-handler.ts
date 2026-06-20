import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors';

/** Converte erros conhecidos em respostas JSON estáveis. */
export default fp(async (app) => {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Rota ${request.method} ${request.url} não existe` },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dados inválidos',
          details: error.flatten(),
        },
      });
    }

    // Erros de validação do próprio Fastify (schema de rota).
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error instanceof Error ? error.message : 'Dados inválidos',
        },
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.code(409).send({
          error: { code: 'CONFLICT', message: 'Registro duplicado', details: error.meta },
        });
      }
      if (error.code === 'P2025') {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Registro não encontrado' },
        });
      }
    }

    request.log.error({ err: error }, 'Erro não tratado');
    return reply.code(500).send({
      error: { code: 'INTERNAL', message: 'Erro interno do servidor' },
    });
  });
});
