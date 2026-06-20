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

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().max(200).optional(),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});
