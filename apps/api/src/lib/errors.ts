export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'Faça login para continuar.') => new HttpError(401, message);
export const forbidden = (message = 'Você não tem permissão para esta ação.') => new HttpError(403, message);
export const notFound = (what = 'Registro') => new HttpError(404, `${what} não encontrado.`);
export const conflict = (message: string) => new HttpError(409, message);
