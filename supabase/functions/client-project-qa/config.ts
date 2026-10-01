import { configurationError } from "./errors.ts";

export interface AppConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  allowedCorsOrigins: ReadonlySet<string>;
  mediaBucket: string;
  mediaSchema: string;
  mediaTable: string;
  attachmentTable: string;
  idempotencyTable: string;
  projectsTable: string;
  projectTokenColumn: string;
  itemsTable: string;
  itemProjectColumn: string;
  commentsTable: string;
  commentItemColumn: string;
  checklistsTable: string | null;
  checklistItemsTable: string | null;
  wiflowSessionRpc: string | null;
  clientAccessRpc: string | null;
  snapshotRpc: string | null;
  createItemRpc: string | null;
  updateItemRpc: string | null;
  createCommentRpc: string | null;
  memberDirectoryRpc: string | null;
  openAiApiKey: string | null;
  openAiTranscribeModel: string;
  openAiTranscribePrompt: string | null;
  transcriptionTimeoutMs: number;
  audioMaxBytes: number;
  audioMaxDurationMs: number;
  imageMaxBytes: number;
  videoMaxBytes: number;
  videoMaxDurationMs: number;
  mediaRetentionHours: number;
  signedReadTtlSeconds: number;
  deleteAudioAfterTranscription: boolean;
  idempotencyTtlHours: number;
  idempotencyLockSeconds: number;
  maxTranscriptionAttempts: number;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function env(name: string): string | null {
  const value = Deno.env.get(name)?.trim();
  return value ? value : null;
}

function required(name: string): string {
  const value = env(name);
  if (!value) throw configurationError(name);
  return value;
}

function identifier(name: string, fallback: string): string {
  const value = env(name) ?? fallback;
  if (!IDENTIFIER.test(value)) throw configurationError(name);
  return value;
}

function optionalIdentifier(name: string): string | null {
  const value = env(name);
  if (value && !IDENTIFIER.test(value)) throw configurationError(name);
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw configurationError(name);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw configurationError(name);
}

function corsOrigins(): ReadonlySet<string> {
  const raw = env("ALLOWED_CORS_ORIGINS") ?? "";
  const origins = raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set(origins);
}

export function loadConfig(): AppConfig {
  const supabaseUrl = required("SUPABASE_URL");
  try {
    new URL(supabaseUrl);
  } catch {
    throw configurationError("SUPABASE_URL");
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    allowedCorsOrigins: corsOrigins(),
    mediaBucket: env("QA_MEDIA_BUCKET") ?? "qa-media",
    mediaSchema: identifier("QA_MEDIA_SCHEMA", "public"),
    mediaTable: identifier("QA_MEDIA_TABLE", "qa_media"),
    attachmentTable: identifier("QA_ATTACHMENTS_TABLE", "qa_item_attachments"),
    idempotencyTable: identifier("QA_IDEMPOTENCY_TABLE", "qa_request_idempotency"),
    projectsTable: identifier("QA_PROJECTS_TABLE", "client_projects"),
    projectTokenColumn: identifier("QA_PROJECT_TOKEN_COLUMN", "client_share_token"),
    itemsTable: identifier("QA_ITEMS_TABLE", "qa_items"),
    itemProjectColumn: identifier("QA_ITEM_PROJECT_COLUMN", "project_id"),
    commentsTable: identifier("QA_COMMENTS_TABLE", "qa_comments"),
    commentItemColumn: identifier("QA_COMMENT_ITEM_COLUMN", "qa_item_id"),
    checklistsTable: optionalIdentifier("QA_CHECKLISTS_TABLE"),
    checklistItemsTable: optionalIdentifier("QA_CHECKLIST_ITEMS_TABLE"),
    wiflowSessionRpc: optionalIdentifier("QA_WIFLOW_SESSION_RPC"),
    clientAccessRpc: optionalIdentifier("QA_CLIENT_ACCESS_RPC"),
    snapshotRpc: optionalIdentifier("QA_SNAPSHOT_RPC"),
    createItemRpc: optionalIdentifier("QA_CREATE_ITEM_RPC"),
    updateItemRpc: optionalIdentifier("QA_UPDATE_ITEM_RPC"),
    createCommentRpc: optionalIdentifier("QA_CREATE_COMMENT_RPC"),
    memberDirectoryRpc: optionalIdentifier("QA_MEMBER_DIRECTORY_RPC"),
    openAiApiKey: env("OPENAI_API_KEY"),
    openAiTranscribeModel:
      env("OPENAI_TRANSCRIBE_MODEL") ?? "gpt-4o-mini-transcribe",
    openAiTranscribePrompt: env("OPENAI_TRANSCRIBE_PROMPT"),
    transcriptionTimeoutMs: integer(
      "OPENAI_TRANSCRIBE_TIMEOUT_MS",
      120_000,
      5_000,
      145_000,
    ),
    audioMaxBytes: integer("QA_AUDIO_MAX_BYTES", 6 * 1024 * 1024, 1, 25 * 1024 * 1024),
    audioMaxDurationMs: integer("QA_AUDIO_MAX_DURATION_MS", 300_000, 250, 3_600_000),
    imageMaxBytes: integer("QA_IMAGE_MAX_BYTES", 10 * 1024 * 1024, 1, 50 * 1024 * 1024),
    videoMaxBytes: integer("QA_VIDEO_MAX_BYTES", 50 * 1024 * 1024, 1, 50 * 1024 * 1024),
    videoMaxDurationMs: integer("QA_VIDEO_MAX_DURATION_MS", 300_000, 250, 3_600_000),
    mediaRetentionHours: integer("QA_MEDIA_RETENTION_HOURS", 24, 1, 720),
    signedReadTtlSeconds: integer("QA_SIGNED_READ_TTL_SECONDS", 600, 30, 86_400),
    deleteAudioAfterTranscription: boolean("QA_DELETE_AUDIO_AFTER_TRANSCRIPTION", true),
    idempotencyTtlHours: integer("QA_IDEMPOTENCY_TTL_HOURS", 24, 1, 168),
    idempotencyLockSeconds: integer("QA_IDEMPOTENCY_LOCK_SECONDS", 120, 10, 600),
    maxTranscriptionAttempts: integer("QA_MAX_TRANSCRIPTION_ATTEMPTS", 3, 1, 10),
  };
}
