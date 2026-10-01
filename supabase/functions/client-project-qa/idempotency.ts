import type { AppConfig } from "./config.ts";
import type { AdminClient } from "./db.ts";
import { ApiError, databaseError } from "./errors.ts";
import type { IdempotentResult } from "./types.ts";
import { sha256 } from "./validation.ts";

interface IdempotencyRow {
  id: string;
  request_hash: string;
  state: "processing" | "completed" | "failed";
  response_status: number | null;
  response_body: unknown;
  locked_at: string;
}

interface Reservation<T> {
  replay: IdempotentResult<T> | null;
  rowId: string | null;
  requestHash: string;
}

export class IdempotencyService {
  constructor(
    private readonly db: AdminClient,
    private readonly config: AppConfig,
  ) {}

  async execute<T>(
    projectId: string,
    scope: string,
    key: string | null,
    payload: unknown,
    operation: () => Promise<IdempotentResult<T>>,
  ): Promise<IdempotentResult<T>> {
    if (!key) return await operation();

    const reservation = await this.reserve<T>(projectId, scope, key, payload);
    if (reservation.replay) return reservation.replay;

    try {
      const result = await operation();
      const { error } = await this.table()
        .update({
          state: "completed",
          response_status: result.status,
          response_body: result.body,
          resource_id: result.resourceId ?? null,
          error_code: null,
        })
        .eq("id", reservation.rowId!);
      if (error) throw databaseError("complete idempotency", error);
      return result;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
      await this.table()
        .update({ state: "failed", error_code: code })
        .eq("id", reservation.rowId!);
      throw error;
    }
  }

  private table() {
    return this.db.schema(this.config.mediaSchema).from(this.config.idempotencyTable);
  }

  private async reserve<T>(
    projectId: string,
    scope: string,
    key: string,
    payload: unknown,
  ): Promise<Reservation<T>> {
    const requestHash = await sha256(payload);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.idempotencyTtlHours * 3_600_000,
    ).toISOString();
    const row = {
      project_id: projectId,
      scope,
      idempotency_key: key,
      request_hash: requestHash,
      state: "processing",
      locked_at: now.toISOString(),
      expires_at: expiresAt,
    };

    const inserted = await this.table().insert(row).select("*").single();
    if (!inserted.error) {
      return { replay: null, rowId: (inserted.data as IdempotencyRow).id, requestHash };
    }
    if (inserted.error.code !== "23505") {
      throw databaseError("reserve idempotency", inserted.error);
    }

    const existingResult = await this.table()
      .select("*")
      .eq("project_id", projectId)
      .eq("scope", scope)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (existingResult.error || !existingResult.data) {
      throw databaseError("read idempotency", existingResult.error);
    }
    const existing = existingResult.data as IdempotencyRow;

    if (existing.request_hash !== requestHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "A chave de idempotência já foi usada com outro conteúdo.",
      );
    }
    if (
      existing.state === "completed" &&
      existing.response_status &&
      existing.response_body !== null
    ) {
      return {
        replay: {
          status: existing.response_status,
          body: existing.response_body as T,
        },
        rowId: null,
        requestHash,
      };
    }

    const lockAgeMs = now.getTime() - new Date(existing.locked_at).getTime();
    if (
      existing.state === "processing" &&
      lockAgeMs < this.config.idempotencyLockSeconds * 1_000
    ) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        "Uma requisição com esta chave ainda está em processamento.",
        true,
      );
    }

    const reclaimed = await this.table()
      .update({
        state: "processing",
        response_status: null,
        response_body: null,
        resource_id: null,
        error_code: null,
        locked_at: now.toISOString(),
        expires_at: expiresAt,
      })
      .eq("id", existing.id)
      .eq("request_hash", requestHash)
      .select("id")
      .maybeSingle();
    if (reclaimed.error || !reclaimed.data) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        "Não foi possível assumir a requisição idempotente.",
        true,
      );
    }
    return { replay: null, rowId: existing.id, requestHash };
  }
}
