import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'A senha precisa de ao menos 8 caracteres'),
  name: z.string().min(1).max(120).optional(),
  deviceId: z.string().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().max(200).optional(),
});

export const googleAuthSchema = z.object({
  // ID token (JWT) devolvido pelo Google Identity Services no PWA.
  credential: z.string().min(1),
  deviceId: z.string().max(200).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().max(200).optional(),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'A senha precisa de ao menos 8 caracteres'),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

// Atualização do perfil. Todos os campos são opcionais (PATCH parcial). Para
// nome/sobrenome/telefone, string vazia significa "limpar". avatarUrl aceita um
// preset (/avatars/xx.svg) ou um data URI da foto enviada — limitado p/ caber no
// bodyLimit (1MB) do Fastify; o cliente já redimensiona a imagem antes de enviar.
export const updateProfileSchema = z.object({
  name: z.string().max(120).optional(),
  surname: z.string().max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  avatarUrl: z.string().max(800_000).optional(),
});
