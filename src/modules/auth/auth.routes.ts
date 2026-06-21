import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getMe, loginUser, registerUser } from './auth.service';
import { issueTokens, revokeToken, rotateTokens, type DeviceInfo } from './auth.tokens';
import {
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schemas';
import {
  onUserRegistered,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmail,
} from './auth.verification';

// Rate-limit apertado p/ rotas sensíveis a abuso (envio de e-mail / força bruta
// de token). Aplicado por rota via `config.rateLimit` do @fastify/rate-limit.
const emailRateLimit = { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } };

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
    // Boas-vindas + verificação de e-mail (não bloqueia a resposta do cadastro).
    void onUserRegistered(app.prisma, user);
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

  // --- Recuperação de senha ---
  // Resposta genérica de propósito: não revela se o e-mail existe.
  app.post('/forgot-password', emailRateLimit, async (request, reply) => {
    const body = forgotPasswordSchema.parse(request.body);
    await requestPasswordReset(app.prisma, body.email);
    return reply.send({ message: 'Se houver uma conta com esse e-mail, enviamos um link de redefinição.' });
  });

  app.post('/reset-password', emailRateLimit, async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);
    await resetPassword(app.prisma, body.token, body.password);
    return reply.send({ message: 'Senha redefinida com sucesso. Faça login com a nova senha.' });
  });

  // --- Verificação de e-mail ---
  app.post('/verify-email', emailRateLimit, async (request, reply) => {
    const body = verifyEmailSchema.parse(request.body);
    await verifyEmail(app.prisma, body.token);
    return reply.send({ message: 'E-mail verificado com sucesso.' });
  });

  app.post(
    '/resend-verification',
    { preHandler: [app.authenticate], ...emailRateLimit },
    async (request, reply) => {
      await resendVerification(app.prisma, request.userId!);
      return reply.send({ message: 'E-mail de verificação reenviado.' });
    },
  );
}
