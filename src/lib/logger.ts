import type { FastifyServerOptions } from 'fastify';
import { env } from '../env';

/**
 * Configuração do logger HTTP da API.
 *
 * O Fastify já usa Pino internamente e registra automaticamente cada request
 * recebida e concluída (método, URL, status, tempo de resposta, reqId). Por
 * isso NÃO usamos `pino-http`: ele é a ponte do Pino para HTTP cru / Express e
 * entraria em conflito com o logger nativo. Aqui apenas refinamos esse logger
 * embutido — nível configurável, redaction de dados sensíveis e serializers
 * enxutos — mantendo o pretty-print em desenvolvimento.
 */

// Campos que nunca devem aparecer no log (tokens, cookies, segredos). `remove`
// garante que sejam apagados em vez de mascarados com [Redacted].
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function buildLoggerOptions(): FastifyServerOptions['logger'] {
  const base = {
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, remove: true },
    serializers: {
      // Tipamos só o subconjunto que lemos — os serializers do Fastify usam
      // tipos próprios (ResSerializerReply etc.) e a leitura estrutural basta.
      req(request: { method: string; url: string; ip: string }) {
        return {
          method: request.method,
          url: request.url,
          // ip já respeita o X-Forwarded-For por causa do trustProxy.
          remoteAddress: request.ip,
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };

  if (env.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }

  return base;
}
