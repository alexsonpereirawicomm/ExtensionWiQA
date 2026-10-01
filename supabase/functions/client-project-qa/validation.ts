import { ApiError } from "./errors.ts";
import type { JsonObject, MediaKind } from "./types.ts";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROJECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export function objectValue(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} deve ser um objeto.`);
  }
  return value as JsonObject;
}

export function stringValue(
  value: unknown,
  field: string,
  min = 1,
  max = 10_000,
): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `${field} deve ser texto.`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `${field} deve ter entre ${min} e ${max} caracteres.`,
    );
  }
  return normalized;
}

export function optionalString(
  value: unknown,
  field: string,
  max = 10_000,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return stringValue(value, field, 1, max);
}

export function uuidValue(value: unknown, field: string): string {
  const normalized = stringValue(value, field, 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new ApiError(400, "INVALID_UUID", `${field} deve ser um UUID válido.`);
  }
  return normalized;
}

export function projectToken(value: unknown): string {
  const normalized = stringValue(value, "token", 16, 128);
  if (!PROJECT_TOKEN_PATTERN.test(normalized)) {
    throw new ApiError(400, "INVALID_PROJECT_TOKEN", "Token de projeto inválido.");
  }
  return normalized;
}

export function integerValue(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `${field} deve ser um inteiro entre ${min} e ${max}.`,
    );
  }
  return Number(value);
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", `${field} deve ser booleano.`);
  }
  return value;
}

export function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const normalized = stringValue(value, field, 1, 100);
  if (!allowed.includes(normalized as T)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `${field} contém um valor não permitido.`,
    );
  }
  return normalized as T;
}

export function httpUrl(value: unknown, field: string): string {
  const normalized = stringValue(value, field, 1, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ApiError(400, "INVALID_URL", `${field} deve ser uma URL válida.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(400, "INVALID_URL", `${field} deve usar http ou https.`);
  }
  return parsed.toString();
}

export function optionalEmail(value: unknown, field: string): string | null | undefined {
  const normalized = optionalString(value, field, 320);
  if (!normalized) return normalized;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ApiError(400, "INVALID_EMAIL", `${field} deve ser um e-mail válido.`);
  }
  return normalized.toLowerCase();
}

export function languageValue(value: unknown, fallback = "pt"): string {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = stringValue(value, "language", 2, 20).toLowerCase();
  if (!LANGUAGE_PATTERN.test(normalized)) {
    throw new ApiError(400, "INVALID_LANGUAGE", "language deve ser um código ISO válido.");
  }
  return normalized;
}

export function mediaKind(value: unknown): MediaKind {
  return enumValue(value, "kind", ["audio", "image", "video"] as const);
}

export function uuidArray(
  value: unknown,
  field: string,
  options: { required?: boolean; max?: number } = {},
): string[] {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new ApiError(400, "MISSING_FIELD", `${field} é obrigatório.`);
    }
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} deve ser uma lista de UUIDs.`);
  }
  const max = options.max ?? 20;
  if ((options.required && value.length === 0) || value.length > max) {
    throw new ApiError(400, "INVALID_FIELD", `${field} deve conter entre 1 e ${max} itens.`);
  }
  const normalized = value.map((entry, index) => uuidValue(entry, `${field}[${index}]`));
  return [...new Set(normalized)];
}

export function idempotencyKey(
  request: Request,
  body: JsonObject,
  required: boolean,
): string | null {
  const header = request.headers.get("idempotency-key")?.trim() || null;
  const bodyValue = typeof body.client_request_id === "string"
    ? body.client_request_id.trim()
    : null;
  if (header && bodyValue && header.toLowerCase() !== bodyValue.toLowerCase()) {
    throw new ApiError(
      400,
      "IDEMPOTENCY_KEY_MISMATCH",
      "Idempotency-Key e client_request_id devem ser iguais.",
    );
  }
  const candidate = header ?? bodyValue;
  if (!candidate) {
    if (required) {
      throw new ApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Envie Idempotency-Key ou client_request_id.",
      );
    }
    return null;
  }
  return uuidValue(candidate, "Idempotency-Key");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
