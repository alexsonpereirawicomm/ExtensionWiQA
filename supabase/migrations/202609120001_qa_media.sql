-- WiControl QA media pipeline.
--
-- The existing QA/project tables are intentionally not referenced by foreign keys:
-- they are owned by the host application and are not part of this repository.
-- project_id and qa_item_id still use UUIDs, matching the public QA API contract.

create extension if not exists pgcrypto;

create table if not exists public.qa_media (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  client_request_id uuid not null,
  kind text not null check (kind in ('audio', 'image', 'video')),
  bucket text not null default 'qa-media' check (bucket = 'qa-media'),
  object_path text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  duration_ms integer,
  status text not null default 'created'
    check (status in ('created', 'uploaded', 'queued', 'transcribing', 'ready', 'failed', 'expired')),
  transcript text,
  language text,
  provider text,
  model text,
  created_by jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  uploaded_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  storage_deleted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qa_media_project_request_unique unique (project_id, client_request_id),
  constraint qa_media_object_path_unique unique (bucket, object_path),
  constraint qa_media_duration_valid check (
    (kind = 'image' and duration_ms is null)
    or (kind in ('audio', 'video') and duration_ms is not null and duration_ms > 0)
  ),
  constraint qa_media_transcript_state_valid check (
    status <> 'ready' or kind <> 'audio' or transcript is not null
  )
);

create index if not exists qa_media_project_created_idx
  on public.qa_media (project_id, created_at desc);

create index if not exists qa_media_pending_idx
  on public.qa_media (status, created_at)
  where status in ('created', 'uploaded', 'queued', 'transcribing', 'failed');

create index if not exists qa_media_expires_idx
  on public.qa_media (expires_at)
  where storage_deleted_at is null;

create table if not exists public.qa_item_attachments (
  id uuid primary key default gen_random_uuid(),
  qa_item_id uuid not null,
  media_id uuid not null references public.qa_media(id) on delete cascade,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  constraint qa_item_attachments_item_media_unique unique (qa_item_id, media_id)
);

create index if not exists qa_item_attachments_item_order_idx
  on public.qa_item_attachments (qa_item_id, sort_order, created_at);

-- Generic idempotency journal used by /media/init, /item and /comment. It is
-- independent from the host QA tables so retries never require adding columns
-- to those tables.
create table if not exists public.qa_request_idempotency (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  scope text not null,
  idempotency_key uuid not null,
  request_hash text not null,
  state text not null default 'processing'
    check (state in ('processing', 'completed', 'failed')),
  response_status smallint check (response_status between 100 and 599),
  response_body jsonb,
  resource_id uuid,
  error_code text,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qa_request_idempotency_unique unique (project_id, scope, idempotency_key)
);

create index if not exists qa_request_idempotency_expires_idx
  on public.qa_request_idempotency (expires_at);

create or replace function public.qa_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists qa_media_touch_updated_at on public.qa_media;
create trigger qa_media_touch_updated_at
before update on public.qa_media
for each row execute function public.qa_touch_updated_at();

drop trigger if exists qa_request_idempotency_touch_updated_at on public.qa_request_idempotency;
create trigger qa_request_idempotency_touch_updated_at
before update on public.qa_request_idempotency
for each row execute function public.qa_touch_updated_at();

-- The bucket is private. The 50 MB bucket ceiling covers video; the Edge
-- Function enforces stricter per-kind limits (audio defaults to 6 MB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'qa-media',
  'qa-media',
  false,
  52428800,
  array[
    'audio/webm',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/webm',
    'video/mp4'
  ]::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.qa_media enable row level security;
alter table public.qa_item_attachments enable row level security;
alter table public.qa_request_idempotency enable row level security;

-- There are deliberately no anon/authenticated policies for these tables or
-- for storage.objects in qa-media. All access is mediated by the Edge Function
-- using the server-only service role. Signed URLs provide narrowly scoped,
-- short-lived Storage access.
revoke all on table public.qa_media from anon, authenticated;
revoke all on table public.qa_item_attachments from anon, authenticated;
revoke all on table public.qa_request_idempotency from anon, authenticated;

grant all on table public.qa_media to service_role;
grant all on table public.qa_item_attachments to service_role;
grant all on table public.qa_request_idempotency to service_role;

comment on table public.qa_media is
  'Private media upload and transcription state for WiControl QA.';
comment on table public.qa_item_attachments is
  'Links host QA item UUIDs to private qa_media objects without coupling to the host QA schema.';
comment on table public.qa_request_idempotency is
  'Short-lived replay journal for mutation retries; request bodies and credentials are never stored.';

