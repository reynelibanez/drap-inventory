/** Error de la API con código estable (se traduce con `errors.<code>`). `status` 0 = no llegó al servidor. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly params: Record<string, any> = {}) {
    super(code);
  }
}
