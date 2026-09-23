/**
 * Error de negocio con un código estable. El cliente traduce `code` (clave i18n
 * `errors.<code>`) y usa `params` para rellenar variables; `message` es solo un
 * texto de respaldo en español para logs y herramientas.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Record<string, unknown> = {},
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, params?: Record<string, unknown>, msg?: string) => new AppError(400, code, params, msg);
export const unauthorized = (code = 'unauthorized') => new AppError(401, code);
export const forbidden = (code = 'forbidden', params?: Record<string, unknown>) => new AppError(403, code, params);
export const notFound = (code = 'not_found', params?: Record<string, unknown>) => new AppError(404, code, params);
export const conflict = (code: string, params?: Record<string, unknown>) => new AppError(409, code, params);
/** Suscripción vencida/plan agotado: el cliente redirige a la pantalla de facturación. */
export const paymentRequired = (code: string, params?: Record<string, unknown>) => new AppError(402, code, params);

/** Traduce violaciones típicas de PostgreSQL a errores de negocio entendibles. */
export function mapDbError(err: any): AppError | null {
  if (!err || typeof err.code !== 'string') return null;
  switch (err.code) {
    case '23505': // unique_violation
      return conflict('duplicate', { constraint: err.constraint, detail: err.detail });
    case '23503': // foreign_key_violation
      return conflict('in_use', { constraint: err.constraint });
    case '23514': // check_violation
      return badRequest('invalid_value', { constraint: err.constraint });
    case '22P02': // invalid_text_representation
      return badRequest('invalid_value');
    case '40P01': // deadlock_detected
    case '40001': // serialization_failure
      return new AppError(503, 'retry');
    default:
      return null;
  }
}
