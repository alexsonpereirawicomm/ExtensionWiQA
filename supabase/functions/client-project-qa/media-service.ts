import type { AppConfig } from "./config.ts";
import type { AdminClient } from "./db.ts";
import { ApiError, asApiError, databaseError } from "./errors.ts";
import type { IdempotencyService } from "./idempotency.ts";
import {
  assertTranscriptionConfigured,
  transcribeAudio,
} from "./openai-transcription.ts";
import type {
  AccessContext,
  JsonObject,
  MediaKind,
  MediaRecord,
} from "./types.ts";
import {
  booleanValue,
  integerValue,
  languageValue,
  mediaKind,
  objectValue,
  uuidValue,
} from "./validation.ts";

declare const EdgeRuntime:
  | { waitUntil(promise: Promise<unknown>): void }
  | undefined;

const SIGNED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1_000;

const MIME_EXTENSIONS: Record<MediaKind, Readonly<Record<string, string>>> = {
  audio: {
    "audio/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
  },
  image: {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  },
  video: {
    "video/webm": "webm",
    "video/mp4": "mp4",
  },
};

interface InitMediaInput {
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  clientRequestId: string;
}

interface StorageInfo {
  size: number;
  mimeType: string;
}

function baseMime(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_MIME", "mime_type deve ser texto.");
  }
  return value.split(";", 1)[0].trim().toLowerCase();
}

function expiration(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function isExpired(media: MediaRecord): boolean {
  return new Date(media.expires_at).getTime() <= Date.now();
}

function retryableTranscriptionCode(code: string | null): boolean {
  return Boolean(code && [
    "TRANSCRIPTION_TIMEOUT",
    "TRANSCRIPTION_NETWORK_ERROR",
    "TRANSCRIPTION_RATE_LIMITED",
    "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
    "INVALID_TRANSCRIPTION_RESPONSE",
  ].includes(code));
}

export class MediaService {
  constructor(
    private readonly db: AdminClient,
    private readonly config: AppConfig,
    private readonly idempotency: IdempotencyService,
  ) {}

  private mediaTable() {
    return this.db.schema(this.config.mediaSchema).from(this.config.mediaTable);
  }

  private attachmentTable() {
    return this.db.schema(this.config.mediaSchema).from(this.config.attachmentTable);
  }

  async init(
    projectId: string,
    access: AccessContext,
    body: JsonObject,
    requestKey: string,
  ): Promise<JsonObject> {
    const input = this.validateInit(body, requestKey);
    const payloadForHash = {
      kind: input.kind,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      duration_ms: input.durationMs,
      client_request_id: input.clientRequestId,
    };

    const result = await this.idempotency.execute(
      projectId,
      "media:init",
      requestKey,
      payloadForHash,
      async () => {
        let media = await this.findByClientRequestId(projectId, input.clientRequestId);
        if (media) {
          if (
            media.kind !== input.kind ||
            media.mime_type !== input.mimeType ||
            Number(media.size_bytes) !== input.sizeBytes ||
            Number(media.duration_ms ?? 0) !== Number(input.durationMs ?? 0)
          ) {
            throw new ApiError(
              409,
              "MEDIA_REQUEST_CONFLICT",
              "client_request_id já pertence a outra mídia.",
            );
          }
          if (isExpired(media)) {
            throw new ApiError(409, "MEDIA_EXPIRED", "A sessão de mídia expirou.");
          }
        } else {
          const mediaId = crypto.randomUUID();
          const extension = MIME_EXTENSIONS[input.kind][input.mimeType];
          const objectPath = `qa/${projectId}/drafts/${mediaId}.${extension}`;
          const insertResult = await this.mediaTable().insert({
            id: mediaId,
            project_id: projectId,
            client_request_id: input.clientRequestId,
            kind: input.kind,
            bucket: this.config.mediaBucket,
            object_path: objectPath,
            mime_type: input.mimeType,
            size_bytes: input.sizeBytes,
            duration_ms: input.durationMs,
            status: "created",
            created_by: {
              mode: access.mode,
              actor_id: access.actorId,
              name: access.name,
              email: access.email,
            },
            expires_at: expiration(this.config.mediaRetentionHours),
          }).select("*").single();
          if (insertResult.error) throw databaseError("create media", insertResult.error);
          media = insertResult.data as MediaRecord;
        }

        const signed = await this.db.storage
          .from(media.bucket)
          .createSignedUploadUrl(media.object_path, { upsert: false });
        if (signed.error || !signed.data) {
          await this.markFailed(media.id, "SIGNED_UPLOAD_FAILED", "Falha ao assinar upload.");
          throw new ApiError(
            503,
            "SIGNED_UPLOAD_FAILED",
            "Não foi possível preparar o upload.",
            true,
          );
        }

        const response = {
          media_id: media.id,
          bucket: media.bucket,
          path: media.object_path,
          upload_url: signed.data.signedUrl,
          upload_token: signed.data.token,
          expires_at: new Date(Date.now() + SIGNED_UPLOAD_TTL_MS).toISOString(),
          upload: {
            method: "PUT",
            headers: {
              "content-type": media.mime_type,
              "cache-control": "max-age=3600",
              "x-upsert": "false",
            },
            body: "binary",
          },
        };
        return { status: 200, body: response, resourceId: media.id };
      },
    );
    return result.body as JsonObject;
  }

  async complete(
    projectId: string,
    body: JsonObject,
    requestId: string,
  ): Promise<JsonObject> {
    const mediaId = uuidValue(body.media_id, "media_id");
    let media = await this.getOwnedMedia(projectId, mediaId);
    if (isExpired(media)) {
      await this.expireMedia(media);
      throw new ApiError(409, "MEDIA_EXPIRED", "A sessão de mídia expirou.");
    }
    if (media.storage_deleted_at) {
      throw new ApiError(409, "MEDIA_FILE_REMOVED", "O arquivo desta mídia já foi removido.");
    }

    if (media.status === "ready") return await this.statusPayload(media);
    if (media.status === "queued") {
      this.scheduleTranscription(media.id, requestId);
      return this.basicStatus(media);
    }
    if (media.status === "transcribing") {
      const startedAt = typeof media.processing_started_at === "string"
        ? new Date(media.processing_started_at).getTime()
        : Date.now();
      if (Date.now() - startedAt < this.config.transcriptionTimeoutMs + 30_000) {
        return this.basicStatus(media);
      }
      const staleResult = await this.mediaTable()
        .update({ status: "queued", error_code: null, error_detail: null })
        .eq("id", media.id)
        .eq("status", "transcribing")
        .select("*")
        .maybeSingle();
      if (staleResult.error) throw databaseError("recover stale transcription", staleResult.error);
      media = (staleResult.data ?? media) as MediaRecord;
      this.scheduleTranscription(media.id, requestId);
      return this.basicStatus(media);
    }
    if (media.status === "expired") {
      throw new ApiError(409, "MEDIA_EXPIRED", "A sessão de mídia expirou.");
    }

    const storageInfo = await this.verifyUpload(media);
    if (storageInfo.size !== Number(media.size_bytes)) {
      await this.markFailed(media.id, "UPLOAD_SIZE_MISMATCH", "Tamanho divergente.");
      throw new ApiError(422, "UPLOAD_SIZE_MISMATCH", "O tamanho enviado diverge do declarado.");
    }
    if (storageInfo.mimeType !== media.mime_type) {
      await this.markFailed(media.id, "UPLOAD_MIME_MISMATCH", "MIME divergente.");
      throw new ApiError(415, "UPLOAD_MIME_MISMATCH", "O tipo enviado diverge do declarado.");
    }

    const now = new Date().toISOString();
    if (media.kind !== "audio") {
      const readyResult = await this.mediaTable()
        .update({
          status: "ready",
          uploaded_at: now,
          completed_at: now,
          error_code: null,
          error_detail: null,
        })
        .eq("id", media.id)
        .in("status", ["created", "uploaded", "failed"])
        .select("*")
        .maybeSingle();
      if (readyResult.error) throw databaseError("complete media upload", readyResult.error);
      return await this.statusPayload((readyResult.data ?? media) as MediaRecord);
    }

    const shouldTranscribe = body.transcribe === undefined
      ? true
      : booleanValue(body.transcribe, "transcribe");
    if (!shouldTranscribe) {
      const uploadedResult = await this.mediaTable()
        .update({ status: "uploaded", uploaded_at: now, error_code: null, error_detail: null })
        .eq("id", media.id)
        .in("status", ["created", "failed"])
        .select("*")
        .maybeSingle();
      if (uploadedResult.error) throw databaseError("mark media uploaded", uploadedResult.error);
      return this.basicStatus((uploadedResult.data ?? media) as MediaRecord);
    }

    assertTranscriptionConfigured(this.config);
    const language = languageValue(body.language, "pt");
    if (Number(media.attempt_count) >= this.config.maxTranscriptionAttempts) {
      throw new ApiError(
        422,
        "TRANSCRIPTION_ATTEMPTS_EXHAUSTED",
        "O limite de tentativas de transcrição foi atingido.",
      );
    }
    const queuedResult = await this.mediaTable()
      .update({
        status: "queued",
        language,
        provider: "openai",
        model: this.config.openAiTranscribeModel,
        uploaded_at: media.uploaded_at ?? now,
        error_code: null,
        error_detail: null,
        attempt_count: Number(media.attempt_count) + 1,
      })
      .eq("id", media.id)
      .in("status", ["created", "uploaded", "failed"])
      .select("*")
      .maybeSingle();
    if (queuedResult.error) throw databaseError("queue transcription", queuedResult.error);
    if (queuedResult.data) {
      media = queuedResult.data as MediaRecord;
      this.scheduleTranscription(media.id, requestId);
    } else {
      media = await this.getOwnedMedia(projectId, media.id);
    }
    return this.basicStatus(media);
  }

  async getStatus(projectId: string, mediaIdValue: unknown): Promise<JsonObject> {
    const mediaId = uuidValue(mediaIdValue, "mediaId");
    let media = await this.getOwnedMedia(projectId, mediaId);
    if (isExpired(media) && media.status !== "expired") {
      await this.expireMedia(media);
      media = { ...media, status: "expired" };
    }
    return await this.statusPayload(media);
  }

  async validateAttachmentIds(projectId: string, ids: string[]): Promise<MediaRecord[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.mediaTable()
      .select("*")
      .eq("project_id", projectId)
      .in("id", ids);
    if (error) throw databaseError("validate attachments", error);
    const media = (data ?? []) as MediaRecord[];
    if (media.length !== ids.length) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Uma ou mais mídias não foram encontradas.");
    }
    const byId = new Map(media.map((entry) => [entry.id, entry]));
    return ids.map((id) => {
      const entry = byId.get(id)!;
      if (entry.status !== "ready" || entry.storage_deleted_at || isExpired(entry)) {
        throw new ApiError(
          409,
          "ATTACHMENT_NOT_READY",
          "Uma ou mais mídias ainda não estão prontas para anexar.",
          entry.status === "queued" || entry.status === "transcribing",
        );
      }
      return entry;
    });
  }

  async attachToItem(itemId: string, media: MediaRecord[]): Promise<void> {
    if (media.length === 0) return;
    const rows = media.map((entry, sortOrder) => ({
      qa_item_id: itemId,
      media_id: entry.id,
      sort_order: sortOrder,
    }));
    const { error } = await this.attachmentTable().insert(rows);
    if (error) throw databaseError("attach media to QA item", error);
  }

  async enrichItemsWithAttachments(
    projectId: string,
    items: JsonObject[],
  ): Promise<JsonObject[]> {
    const itemIds = items
      .map((item) => typeof item.id === "string" ? item.id : null)
      .filter((id): id is string => Boolean(id));
    if (itemIds.length === 0) {
      return items.map((item) => ({ ...item, attachments: [] }));
    }

    const attachmentResult = await this.attachmentTable()
      .select("*")
      .in("qa_item_id", itemIds)
      .order("sort_order", { ascending: true });
    if (attachmentResult.error) {
      throw databaseError("list QA attachments", attachmentResult.error);
    }
    const attachmentRows = (attachmentResult.data ?? []) as JsonObject[];
    if (attachmentRows.length === 0) {
      return items.map((item) => ({ ...item, attachments: [] }));
    }

    const mediaIds = [...new Set(attachmentRows.map((row) => String(row.media_id)))];
    const mediaResult = await this.mediaTable()
      .select("*")
      .eq("project_id", projectId)
      .in("id", mediaIds);
    if (mediaResult.error) throw databaseError("list attachment media", mediaResult.error);
    const mediaRows = (mediaResult.data ?? []) as MediaRecord[];
    const signedUrls = await this.createSignedReadUrls(mediaRows);
    const mediaById = new Map(mediaRows.map((entry) => [entry.id, entry]));
    const readExpiresAt = new Date(
      Date.now() + this.config.signedReadTtlSeconds * 1_000,
    ).toISOString();

    return items.map((item) => {
      const attachments = attachmentRows
        .filter((row) => row.qa_item_id === item.id)
        .map((row) => {
          const media = mediaById.get(String(row.media_id));
          if (!media) return null;
          return {
            id: row.id,
            media_id: media.id,
            kind: media.kind,
            mime_type: media.mime_type,
            size_bytes: Number(media.size_bytes),
            duration_ms: media.duration_ms,
            status: media.status,
            transcript: media.kind === "audio" ? media.transcript : null,
            url: signedUrls.get(media.id) ?? null,
            url_expires_at: signedUrls.has(media.id) ? readExpiresAt : null,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const legacyUrls = Array.isArray(item.image_urls)
        ? item.image_urls.filter((url): url is string => typeof url === "string")
        : [];
      const privateImageUrls = attachments
        .filter((attachment) => attachment.kind === "image" && attachment.url)
        .map((attachment) => attachment.url as string);
      const imageUrls = [...new Set([...legacyUrls, ...privateImageUrls])];
      return {
        ...item,
        image_url: typeof item.image_url === "string" && item.image_url
          ? item.image_url
          : imageUrls[0] ?? null,
        image_urls: imageUrls,
        attachments,
      };
    });
  }

  private validateInit(body: JsonObject, requestKey: string): InitMediaInput {
    const kind = mediaKind(body.kind);
    const mimeType = baseMime(body.mime_type);
    if (!MIME_EXTENSIONS[kind][mimeType]) {
      throw new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        `mime_type não permitido para ${kind}.`,
      );
    }
    const maxBytes = kind === "audio"
      ? this.config.audioMaxBytes
      : kind === "image"
      ? this.config.imageMaxBytes
      : this.config.videoMaxBytes;
    const sizeBytes = integerValue(body.size_bytes, "size_bytes", 1, maxBytes);
    let durationMs: number | null = null;
    if (kind === "audio") {
      durationMs = integerValue(
        body.duration_ms,
        "duration_ms",
        250,
        this.config.audioMaxDurationMs,
      );
    } else if (kind === "video") {
      durationMs = integerValue(
        body.duration_ms,
        "duration_ms",
        250,
        this.config.videoMaxDurationMs,
      );
    } else if (body.duration_ms !== undefined && body.duration_ms !== null) {
      throw new ApiError(400, "INVALID_FIELD", "duration_ms não se aplica a imagens.");
    }
    return {
      kind,
      mimeType,
      sizeBytes,
      durationMs,
      clientRequestId: uuidValue(body.client_request_id ?? requestKey, "client_request_id"),
    };
  }

  private async findByClientRequestId(
    projectId: string,
    clientRequestId: string,
  ): Promise<MediaRecord | null> {
    const { data, error } = await this.mediaTable()
      .select("*")
      .eq("project_id", projectId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    if (error) throw databaseError("find media request", error);
    return data as MediaRecord | null;
  }

  private async getOwnedMedia(projectId: string, mediaId: string): Promise<MediaRecord> {
    const { data, error } = await this.mediaTable()
      .select("*")
      .eq("project_id", projectId)
      .eq("id", mediaId)
      .maybeSingle();
    if (error) throw databaseError("find media", error);
    if (!data) throw new ApiError(404, "MEDIA_NOT_FOUND", "Mídia não encontrada.");
    return data as MediaRecord;
  }

  private async verifyUpload(media: MediaRecord): Promise<StorageInfo> {
    const { data, error } = await this.db.storage.from(media.bucket).info(media.object_path);
    if (error || !data) {
      throw new ApiError(
        409,
        "UPLOAD_NOT_FOUND",
        "O upload ainda não foi encontrado no Storage.",
        true,
      );
    }
    const raw = data as unknown as JsonObject;
    const metadata = raw.metadata && typeof raw.metadata === "object"
      ? raw.metadata as JsonObject
      : {};
    const size = Number(raw.size ?? metadata.size ?? 0);
    const mime = raw.contentType ?? raw.mimetype ?? metadata.mimetype ?? metadata.contentType;
    if (!Number.isSafeInteger(size) || size <= 0 || typeof mime !== "string") {
      throw new ApiError(
        422,
        "INVALID_UPLOAD_METADATA",
        "Metadados do upload inválidos.",
      );
    }
    return { size, mimeType: baseMime(mime) };
  }

  private scheduleTranscription(mediaId: string, requestId: string): void {
    const task = this.processTranscription(mediaId, requestId);
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(task);
      return;
    }
    void task;
  }

  private async processTranscription(mediaId: string, requestId: string): Promise<void> {
    const claim = await this.mediaTable()
      .update({
        status: "transcribing",
        processing_started_at: new Date().toISOString(),
      })
      .eq("id", mediaId)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();
    if (claim.error) {
      console.error(JSON.stringify({
        request_id: requestId,
        code: "TRANSCRIPTION_CLAIM_FAILED",
      }));
      return;
    }
    if (!claim.data) return;
    const media = claim.data as MediaRecord;

    try {
      const download = await this.db.storage.from(media.bucket).download(media.object_path);
      if (download.error || !download.data) {
        throw new ApiError(
          503,
          "MEDIA_DOWNLOAD_FAILED",
          "Não foi possível carregar o áudio para transcrição.",
          true,
        );
      }
      if (download.data.size !== Number(media.size_bytes)) {
        throw new ApiError(
          422,
          "UPLOAD_SIZE_MISMATCH",
          "O tamanho do áudio diverge do declarado.",
        );
      }
      const transcription = await transcribeAudio(
        download.data,
        media.mime_type,
        media.language ?? "pt",
        this.config,
      );
      const { error } = await this.mediaTable()
        .update({
          status: "ready",
          transcript: transcription.text,
          language: transcription.language,
          provider: "openai",
          model: this.config.openAiTranscribeModel,
          completed_at: new Date().toISOString(),
          error_code: null,
          error_detail: null,
        })
        .eq("id", media.id)
        .eq("status", "transcribing");
      if (error) throw databaseError("save transcription", error);

      if (this.config.deleteAudioAfterTranscription) {
        const removed = await this.db.storage.from(media.bucket).remove([media.object_path]);
        if (!removed.error) {
          await this.mediaTable()
            .update({ storage_deleted_at: new Date().toISOString() })
            .eq("id", media.id);
        } else {
          console.error(JSON.stringify({
            request_id: requestId,
            code: "TRANSCRIBED_AUDIO_CLEANUP_FAILED",
            media_id: media.id,
          }));
        }
      }
    } catch (error) {
      const apiError = asApiError(error);
      await this.markFailed(media.id, apiError.code, apiError.message);
      console.error(JSON.stringify({
        request_id: requestId,
        code: apiError.code,
        status: apiError.status,
        retryable: apiError.retryable,
        media_id: media.id,
      }));
    }
  }

  private async markFailed(mediaId: string, code: string, detail: string): Promise<void> {
    await this.mediaTable().update({
      status: "failed",
      error_code: code.slice(0, 120),
      error_detail: detail.slice(0, 500),
    }).eq("id", mediaId);
  }

  private async expireMedia(media: MediaRecord): Promise<void> {
    await this.mediaTable().update({ status: "expired" }).eq("id", media.id);
    if (!media.storage_deleted_at) {
      const cleanup = (async () => {
        const removed = await this.db.storage.from(media.bucket).remove([media.object_path]);
        if (!removed.error) {
          await this.mediaTable()
            .update({ storage_deleted_at: new Date().toISOString() })
            .eq("id", media.id);
        }
      })();
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(cleanup);
      } else {
        void cleanup;
      }
    }
  }

  private basicStatus(media: MediaRecord): JsonObject {
    return {
      media_id: media.id,
      kind: media.kind,
      status: media.status,
      transcript: media.status === "ready" ? media.transcript : null,
      language: media.language,
      error_code: media.error_code,
      retryable: media.status === "failed"
        ? retryableTranscriptionCode(media.error_code)
        : false,
    };
  }

  private async statusPayload(media: MediaRecord): Promise<JsonObject> {
    const payload = this.basicStatus(media);
    if (
      media.status === "ready" &&
      !media.storage_deleted_at &&
      !isExpired(media)
    ) {
      const signed = await this.db.storage
        .from(media.bucket)
        .createSignedUrl(media.object_path, this.config.signedReadTtlSeconds);
      if (!signed.error && signed.data?.signedUrl) {
        payload.download_url = signed.data.signedUrl;
        payload.download_url_expires_at = new Date(
          Date.now() + this.config.signedReadTtlSeconds * 1_000,
        ).toISOString();
      }
    }
    return payload;
  }

  private async createSignedReadUrls(mediaRows: MediaRecord[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    const eligible = mediaRows.filter((media) =>
      media.status === "ready" && !media.storage_deleted_at && !isExpired(media)
    );
    const byBucket = new Map<string, MediaRecord[]>();
    for (const media of eligible) {
      const entries = byBucket.get(media.bucket) ?? [];
      entries.push(media);
      byBucket.set(media.bucket, entries);
    }

    await Promise.all([...byBucket.entries()].map(async ([bucket, entries]) => {
      const signed = await this.db.storage.from(bucket).createSignedUrls(
        entries.map((entry) => entry.object_path),
        this.config.signedReadTtlSeconds,
      );
      if (signed.error || !signed.data) return;
      signed.data.forEach((result, index) => {
        const media = entries[index];
        if (media && result.signedUrl && !result.error) urls.set(media.id, result.signedUrl);
      });
    }));
    return urls;
  }
}
