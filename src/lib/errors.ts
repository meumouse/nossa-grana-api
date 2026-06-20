/**
 * Erros de aplicação com status HTTP. O error-handler global converte estes em
 * respostas JSON consistentes ({ error: { code, message } }).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const BadRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const Unauthorized = (message = 'Não autenticado') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const Forbidden = (message = 'Sem permissão') =>
  new AppError(403, 'FORBIDDEN', message);

export const NotFound = (message = 'Recurso não encontrado') =>
  new AppError(404, 'NOT_FOUND', message);

export const Conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);
