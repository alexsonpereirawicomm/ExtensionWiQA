export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function databaseError(operation: string, cause?: unknown): ApiError {
  return new ApiError(
    500,
    "DATABASE_ERROR",
    `Falha ao acessar os dados de QA (${operation}).`,
    true,
    { cause },
  );
}

export function configurationError(name: string): ApiError {
  return new ApiError(
    500,
    "SERVER_CONFIGURATION_ERROR",
    `Configuração obrigatória ausente ou inválida: ${name}.`,
    false,
  );
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(
    500,
    "INTERNAL_ERROR",
    "Erro interno do servidor.",
    true,
    { cause: error },
  );
}
