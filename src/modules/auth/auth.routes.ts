import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getMe, loginUser, registerUser } from './auth.service';
import { issueTokens, revokeToken, rotateTokens, type DeviceInfo } from './auth.tokens';
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from './auth.schemas';

function deviceFrom(request: FastifyRequest, deviceId?: string): DeviceInfo {
  return {
    deviceId,
    userAgent: request.headers['user-agent'],
    ip: request.ip,
  };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const { user } = await registerUser(app.prisma, body);
    const tokens = await issueTokens(app, app.prisma, user.id, deviceFrom(request, body.deviceId));
    return reply.code(201).send({ user, ...tokens });
  });

  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await loginUser(app.prisma, body);
    const tokens = await issueTokens(app, app.prisma, user.id, deviceFrom(request, body.deviceId));
    return reply.send({ user, ...tokens });
  });

  app.post('/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const tokens = await rotateTokens(app, app.prisma, body.refreshToken, deviceFrom(request, body.deviceId));
    return reply.send(tokens);
  });

  app.post('/logout', async (request, reply) => {
    const body = logoutSchema.parse(request.body);
    await revokeToken(app.prisma, body.refreshToken);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const user = await getMe(app.prisma, request.userId!);
    return { user };
  });
}
