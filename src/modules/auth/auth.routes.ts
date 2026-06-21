import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env, googleAuthEnabled } from '../../env';
import { BadRequest } from '../../lib/errors';
import { getMe, loginUser, registerUser, updateProfile } from './auth.service';
import { loginWithGoogle } from './auth.google';
import { issueTokens, revokeToken, rotateTokens, type DeviceInfo } from './auth.tokens';
import {
  forgotPasswordSchema,
  googleAuthSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from './auth.schemas';
import {
  onUserRegistered,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  sendUserVerification,
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

  // Login/cadastro com Google (Google Identity Services). O PWA envia o ID token
  // (`credential`); validamos contra o Client ID e emitimos nossos próprios tokens.
  app.post('/google', async (request, reply) => {
    if (!googleAuthEnabled) throw BadRequest('Login com Google não está disponível');
    const body = googleAuthSchema.parse(request.body);
    const { user, isNew } = await loginWithGoogle(app.prisma, body.credential, env.GOOGLE_OAUTH_CLIENT_ID!);
    const tokens = await issueTokens(app, app.prisma, user.id, deviceFrom(request, body.deviceId));
    return reply.code(isNew ? 201 : 200).send({ user, ...tokens });
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

  // Atualiza o perfil (nome, sobrenome, e-mail, telefone, avatar). Ao trocar o
  // e-mail, dispara uma nova verificação p/ o novo endereço (não bloqueia a
  // resposta; falha de envio é apenas logada).
  app.patch('/me', { preHandler: [app.authenticate] }, async (request) => {
    const body = updateProfileSchema.parse(request.body);
    const { user, emailChanged } = await updateProfile(app.prisma, request.userId!, body);
    if (emailChanged) {
      void sendUserVerification(app.prisma, { id: user.id, email: user.email, name: user.name }).catch(
        (err) => app.log.error({ err }, 'falha ao enviar verificação após troca de e-mail'),
      );
    }
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
