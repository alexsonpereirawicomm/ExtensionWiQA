export type JsonObject = Record<string, unknown>;

export type AccessMode = "wiflow" | "client";

export interface ProjectRecord extends JsonObject {
  id: string;
}

export interface AccessContext {
  mode: AccessMode;
  actorId: string | null;
  name: string | null;
  email: string | null;
}

export type MediaKind = "audio" | "image" | "video";
export type MediaStatus =
  | "created"
  | "uploaded"
  | "queued"
  | "transcribing"
  | "ready"
  | "failed"
  | "expired";

export interface MediaRecord extends JsonObject {
  id: string;
  project_id: string;
  client_request_id: string;
  kind: MediaKind;
  bucket: string;
  object_path: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  status: MediaStatus;
  transcript: string | null;
  language: string | null;
  provider: string | null;
  model: string | null;
  error_code: string | null;
  error_detail: string | null;
  attempt_count: number;
  uploaded_at: string | null;
  processing_started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  storage_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthorInput {
  name?: string;
  email?: string | null;
}

export interface ResolvedAuthor {
  name: string;
  email: string | null;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  resourceId?: string;
}
