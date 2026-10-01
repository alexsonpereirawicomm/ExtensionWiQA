import type { AppConfig } from "./config.ts";
import { ApiError, asApiError } from "./errors.ts";

const ALLOWED_HEADERS = [
  "authorization",
  "apikey",
  "content-type",
  "idempotency-key",
  "x-client-access-token",
  "x-request-id",
  "x-wiflow-session-token",
  "x-wiflow-user-id",
].join(", ");

export function assertCorsAllowed(request: Request, config: AppConfig): void {
  const origin = request.headers.get("origin")?.replace(/\/$/, "");
  if (!origin) return;
  if (config.allowedCorsOrigins.has("*") || config.allowedCorsOrigins.has(origin)) return;
  throw new ApiError(403, "CORS_ORIGIN_DENIED", "Origem não autorizada.");
}

function corsHeaders(request: Request, config: AppConfig): HeadersInit {
  const origin = request.headers.get("origin")?.replace(/\/$/, "");
  const allowed = origin &&
    (config.allowedCorsOrigins.has("*") || config.allowedCorsOrigins.has(origin));

  return {
    ...(allowed ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

export function preflightResponse(request: Request, config: AppConfig): Response {
  assertCorsAllowed(request, config);
  return new Response(null, { status: 204, headers: corsHeaders(request, config) });
}

export function jsonResponse(
  request: Request,
  config: AppConfig,
  body: unknown,
  status: number,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, config),
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-Id": requestId,
    },
  });
}

export function errorResponse(
  request: Request,
  config: AppConfig,
  error: unknown,
  requestId: string,
): Response {
  const apiError = asApiError(error);
  console.error(JSON.stringify({
    request_id: requestId,
    code: apiError.code,
    status: apiError.status,
    retryable: apiError.retryable,
  }));
  return jsonResponse(request, config, {
    error: apiError.message,
    code: apiError.code,
    retryable: apiError.retryable,
    request_id: requestId,
  }, apiError.status, requestId);
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiError(415, "JSON_REQUIRED", "Content-Type deve ser application/json.");
  }

  const rawLength = request.headers.get("content-length");
  if (rawLength && Number(rawLength) > 131_072) {
    throw new ApiError(413, "JSON_TOO_LARGE", "Corpo JSON acima do limite permitido.");
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "JSON inválido.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_JSON", "O corpo deve ser um objeto JSON.");
  }
  return value as Record<string, unknown>;
}

export function routePath(pathname: string): string {
  const marker = "/client-project-qa";
  const markerIndex = pathname.indexOf(marker);
  let path = markerIndex >= 0
    ? pathname.slice(markerIndex + marker.length)
    : pathname;
  path = `/${path}`.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  return path;
}
