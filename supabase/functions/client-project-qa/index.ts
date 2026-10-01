import { authenticate, resolveAuthor } from "./auth.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { createAdminClient, type AdminClient } from "./db.ts";
import { ApiError, asApiError } from "./errors.ts";
import {
  assertCorsAllowed,
  errorResponse,
  jsonResponse,
  preflightResponse,
  readJsonObject,
  routePath,
} from "./http.ts";
import { IdempotencyService } from "./idempotency.ts";
import { MediaService } from "./media-service.ts";
import { QaAdapter } from "./qa-adapter.ts";
import type { AccessContext, JsonObject, ProjectRecord } from "./types.ts";
import {
  idempotencyKey,
  objectValue,
  projectToken,
  uuidArray,
} from "./validation.ts";

interface Services {
  db: AdminClient;
  qa: QaAdapter;
  media: MediaService;
}

interface RequestContext {
  project: ProjectRecord;
  access: AccessContext;
  token: string;
}

function services(config: AppConfig): Services {
  const db = createAdminClient(config);
  const idempotency = new IdempotencyService(db, config);
  return {
    db,
    qa: new QaAdapter(db, config),
    media: new MediaService(db, config, idempotency),
  };
}

function assertTransportHeaders(request: Request): void {
  const apiKey = request.headers.get("apikey")?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  if (!apiKey || !authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    throw new ApiError(
      401,
      "SUPABASE_HEADERS_REQUIRED",
      "Headers apikey e Authorization Bearer são obrigatórios.",
    );
  }
}

async function requestContext(
  request: Request,
  service: Services,
  config: AppConfig,
  tokenValue: unknown,
): Promise<RequestContext> {
  const token = projectToken(tokenValue);
  const project = await service.qa.getProjectByToken(token);
  const access = await authenticate(request, service.db, config, project, token);
  return { project, access, token };
}

function attachmentIds(body: JsonObject, item: JsonObject): string[] {
  const rootValue = body.attachment_ids;
  const nestedValue = item.attachment_ids;
  if (rootValue !== undefined && nestedValue !== undefined) {
    const root = uuidArray(rootValue, "attachment_ids", { max: 20 });
    const nested = uuidArray(nestedValue, "item.attachment_ids", { max: 20 });
    if (JSON.stringify(root) !== JSON.stringify(nested)) {
      throw new ApiError(
        400,
        "ATTACHMENT_IDS_MISMATCH",
        "attachment_ids deve ser enviado em apenas um local.",
      );
    }
    return root;
  }
  return uuidArray(rootValue ?? nestedValue, "attachment_ids", { max: 20 });
}

async function handleSnapshot(
  request: Request,
  url: URL,
  service: Services,
  config: AppConfig,
): Promise<JsonObject> {
  const context = await requestContext(
    request,
    service,
    config,
    url.searchParams.get("token"),
  );
  const includeMembersValue = url.searchParams.get("includeMembers");
  if (includeMembersValue && !["true", "false"].includes(includeMembersValue)) {
    throw new ApiError(
      400,
      "INVALID_INCLUDE_MEMBERS",
      "includeMembers deve ser true ou false.",
    );
  }
  const snapshot = await service.qa.getSnapshot(
    context.project,
    includeMembersValue !== "false",
  );
  const rawItems = Array.isArray(snapshot.items)
    ? snapshot.items.map((item) => objectValue(item, "items[]"))
    : [];
  snapshot.items = await service.media.enrichItemsWithAttachments(
    context.project.id,
    rawItems,
  );
  return snapshot;
}

async function handleCreateItem(
  request: Request,
  body: JsonObject,
  service: Services,
  config: AppConfig,
): Promise<JsonObject> {
  const context = await requestContext(request, service, config, body.token);
  const inputItem = objectValue(body.item, "item");
  const ids = attachmentIds(body, inputItem);
  const media = await service.media.validateAttachmentIds(context.project.id, ids);
  const hasPrivateImage = media.some((entry) => entry.kind === "image");
  const author = resolveAuthor(body.author, context.access);
  const key = idempotencyKey(request, body, false);
  const idempotency = new IdempotencyService(service.db, config);

  const result = await idempotency.execute(
    context.project.id,
    "item:create",
    key,
    { item: inputItem, author, attachment_ids: ids },
    async () => {
      const item = await service.qa.createItem(
        context.project.id,
        inputItem,
        author,
        context.access,
        hasPrivateImage,
      );
      const itemId = String(item.id);
      try {
        await service.media.attachToItem(itemId, media);
      } catch (error) {
        try {
          await service.qa.deleteCreatedItem(context.project.id, itemId);
        } catch {
          throw new ApiError(
            500,
            "ATTACHMENT_ROLLBACK_FAILED",
            "O item foi criado, mas não foi possível vincular a mídia. Verifique o item antes de tentar novamente.",
            false,
          );
        }
        throw error;
      }
      const [enriched] = await service.media.enrichItemsWithAttachments(
        context.project.id,
        [item],
      );
      return {
        status: 200,
        body: { item: enriched },
        resourceId: itemId,
      };
    },
  );
  return result.body as JsonObject;
}

async function handleUpdateItem(
  request: Request,
  body: JsonObject,
  service: Services,
  config: AppConfig,
): Promise<JsonObject> {
  const context = await requestContext(request, service, config, body.token);
  const key = idempotencyKey(request, body, false);
  const idempotency = new IdempotencyService(service.db, config);
  const result = await idempotency.execute(
    context.project.id,
    "item:update",
    key,
    { id: body.id, item: body.item },
    async () => {
      const item = await service.qa.updateItem(
        context.project.id,
        body.id,
        body.item,
        context.access,
      );
      const [enriched] = await service.media.enrichItemsWithAttachments(
        context.project.id,
        [item],
      );
      return { status: 200, body: { item: enriched }, resourceId: String(item.id) };
    },
  );
  return result.body as JsonObject;
}

async function handleComment(
  request: Request,
  body: JsonObject,
  service: Services,
  config: AppConfig,
): Promise<JsonObject> {
  const context = await requestContext(request, service, config, body.token);
  const author = resolveAuthor(body.author, context.access);
  const key = idempotencyKey(request, body, false);
  const idempotency = new IdempotencyService(service.db, config);
  const result = await idempotency.execute(
    context.project.id,
    "comment:create",
    key,
    { itemId: body.itemId, body: body.body, author },
    async () => {
      const comment = await service.qa.createComment(
        context.project.id,
        body.itemId,
        body.body,
        author,
      );
      return {
        status: 200,
        body: { comment },
        resourceId: String(comment.id),
      };
    },
  );
  return result.body as JsonObject;
}

async function dispatch(
  request: Request,
  config: AppConfig,
  requestId: string,
): Promise<{ status: number; body: JsonObject }> {
  assertTransportHeaders(request);
  const service = services(config);
  const url = new URL(request.url);
  const path = routePath(url.pathname);
  const key = `${request.method.toUpperCase()} ${path}`;

  switch (key) {
    case "GET /snapshot":
      return { status: 200, body: await handleSnapshot(request, url, service, config) };

    case "POST /item": {
      const body = await readJsonObject(request);
      return { status: 200, body: await handleCreateItem(request, body, service, config) };
    }

    case "PUT /item": {
      const body = await readJsonObject(request);
      return { status: 200, body: await handleUpdateItem(request, body, service, config) };
    }

    case "POST /comment": {
      const body = await readJsonObject(request);
      return { status: 200, body: await handleComment(request, body, service, config) };
    }

    case "POST /media/init": {
      const body = await readJsonObject(request);
      const context = await requestContext(request, service, config, body.token);
      const idempotency = idempotencyKey(request, body, true)!;
      return {
        status: 200,
        body: await service.media.init(
          context.project.id,
          context.access,
          body,
          idempotency,
        ),
      };
    }

    case "POST /media/complete": {
      const body = await readJsonObject(request);
      const context = await requestContext(request, service, config, body.token);
      return {
        status: 200,
        body: await service.media.complete(context.project.id, body, requestId),
      };
    }

    case "GET /media/status": {
      const context = await requestContext(
        request,
        service,
        config,
        url.searchParams.get("token"),
      );
      return {
        status: 200,
        body: await service.media.getStatus(
          context.project.id,
          url.searchParams.get("mediaId"),
        ),
      };
    }

    default:
      throw new ApiError(404, "OPERATION_NOT_FOUND", "Operação inválida.");
  }
}

export async function handler(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const apiError = asApiError(error);
    return new Response(JSON.stringify({
      error: apiError.message,
      code: apiError.code,
      retryable: apiError.retryable,
      request_id: requestId,
    }), {
      status: apiError.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  }

  try {
    assertCorsAllowed(request, config);
    if (request.method.toUpperCase() === "OPTIONS") {
      return preflightResponse(request, config);
    }
    const result = await dispatch(request, config, requestId);
    return jsonResponse(request, config, result.body, result.status, requestId);
  } catch (error) {
    return errorResponse(request, config, error, requestId);
  }
}

if (import.meta.main) Deno.serve(handler);
