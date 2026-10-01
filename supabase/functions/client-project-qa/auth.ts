import type { AppConfig } from "./config.ts";
import type { AdminClient } from "./db.ts";
import { ApiError, configurationError, databaseError } from "./errors.ts";
import type {
  AccessContext,
  AuthorInput,
  JsonObject,
  ProjectRecord,
  ResolvedAuthor,
} from "./types.ts";
import { optionalEmail, optionalString, stringValue } from "./validation.ts";

interface AuthRpcResult extends JsonObject {
  authenticated?: boolean;
  allowed?: boolean;
  actor_id?: string | null;
  user_id?: string | null;
  name?: string | null;
  email?: string | null;
  project_id?: string | null;
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim() ?? "";
  if (!value) return null;
  if (value.length > 4_096) {
    throw new ApiError(400, "INVALID_AUTH_HEADER", `Header ${name} inválido.`);
  }
  return value;
}

function rpcRow(value: unknown): AuthRpcResult | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return candidate as AuthRpcResult;
}

export async function authenticate(
  request: Request,
  db: AdminClient,
  config: AppConfig,
  project: ProjectRecord,
  projectToken: string,
): Promise<AccessContext> {
  const sessionToken = header(request, "x-wiflow-session-token");
  const userId = header(request, "x-wiflow-user-id");
  const clientAccessToken = header(request, "x-client-access-token");
  const hasWiflow = Boolean(sessionToken || userId);
  const hasClient = Boolean(clientAccessToken);

  if (hasWiflow && hasClient) {
    throw new ApiError(
      400,
      "AMBIGUOUS_AUTH",
      "Envie somente um modo de autenticação.",
    );
  }
  if (!hasWiflow && !hasClient) {
    throw new ApiError(401, "AUTH_REQUIRED", "Autenticação obrigatória.");
  }

  if (hasWiflow) {
    if (!sessionToken || !userId) {
      throw new ApiError(
        401,
        "INVALID_WIFLOW_SESSION",
        "Sessão Wiflow incompleta.",
      );
    }
    if (!config.wiflowSessionRpc) {
      throw configurationError("QA_WIFLOW_SESSION_RPC");
    }
    const { data, error } = await db.rpc(config.wiflowSessionRpc, {
      p_session_token: sessionToken,
      p_user_id: userId,
      p_project_id: project.id,
    });
    if (error) throw databaseError("validate Wiflow session", error);
    const result = rpcRow(data);
    if (!result || (result.authenticated !== true && result.allowed !== true)) {
      throw new ApiError(401, "INVALID_WIFLOW_SESSION", "Sessão Wiflow inválida.");
    }
    if (result.project_id && result.project_id !== project.id) {
      throw new ApiError(403, "PROJECT_ACCESS_DENIED", "Acesso negado ao projeto.");
    }
    return {
      mode: "wiflow",
      actorId: String(result.actor_id ?? result.user_id ?? userId),
      name: typeof result.name === "string" ? result.name : null,
      email: typeof result.email === "string" ? result.email : null,
    };
  }

  if (!config.clientAccessRpc) {
    throw configurationError("QA_CLIENT_ACCESS_RPC");
  }
  const { data, error } = await db.rpc(config.clientAccessRpc, {
    p_access_token: clientAccessToken!,
    p_project_id: project.id,
    p_project_token: projectToken,
  });
  if (error) throw databaseError("validate client access", error);
  const result = rpcRow(data);
  if (!result || (result.authenticated !== true && result.allowed !== true)) {
    throw new ApiError(401, "INVALID_CLIENT_ACCESS", "Token de acesso do cliente inválido.");
  }
  if (result.project_id && result.project_id !== project.id) {
    throw new ApiError(403, "PROJECT_ACCESS_DENIED", "Acesso negado ao projeto.");
  }
  return {
    mode: "client",
    actorId: result.actor_id ? String(result.actor_id) : null,
    name: typeof result.name === "string" ? result.name : "Cliente",
    email: typeof result.email === "string" ? result.email : null,
  };
}

export function resolveAuthor(
  value: unknown,
  access: AccessContext,
): ResolvedAuthor {
  let input: AuthorInput = {};
  if (value !== undefined && value !== null) {
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(400, "INVALID_AUTHOR", "author deve ser um objeto.");
    }
    input = value as AuthorInput;
  }

  const suppliedName = optionalString(input.name, "author.name", 160);
  const suppliedEmail = optionalEmail(input.email, "author.email");
  return {
    name: suppliedName ?? access.name ?? (access.mode === "client" ? "Cliente" : "Usuário Wiflow"),
    email: suppliedEmail === undefined ? access.email : suppliedEmail,
  };
}

export function createdBy(access: AccessContext, author: ResolvedAuthor): JsonObject {
  return {
    mode: access.mode,
    actor_id: access.actorId,
    name: stringValue(author.name, "author.name", 1, 160),
    email: author.email,
  };
}
