import type { AppConfig } from "./config.ts";
import type { AdminClient } from "./db.ts";
import { ApiError, databaseError } from "./errors.ts";
import type {
  AccessContext,
  JsonObject,
  ProjectRecord,
  ResolvedAuthor,
} from "./types.ts";
import {
  enumValue,
  httpUrl,
  objectValue,
  optionalEmail,
  optionalString,
  stringValue,
  uuidValue,
} from "./validation.ts";

const DEVICES = ["Mobile", "Desktop", "Mob&Desk"] as const;
const STATUSES = [
  "Pendente",
  "Em andamento",
  "Validação",
  "Concluído",
  "Cancelado",
  "Info",
  "Layout",
  "Gestão",
  "Cadastro",
  "Plataforma",
] as const;
const PRIORITIES = ["Baixa", "Média", "Alta"] as const;

const PROJECT_RESPONSE_FIELDS = [
  "id",
  "name",
  "client",
  "status",
  "platform",
  "template_name",
  "designer",
  "dev_resp",
  "manager",
  "seo_resp",
  "figma_link",
  "docs_link",
  "admin_link",
  "kickoff_date",
  "go_live_date",
  "go_live_actual_date",
  "go_live_actual_date_change_count",
  "contract_hours",
  "project_holiday_calendar",
  "designer_id",
  "dev_resp_id",
  "manager_id",
  "seo_resp_id",
  "wiflow_client_id",
  "wiflow_project_id",
  "wiflow_projects",
] as const;

const ITEM_RESPONSE_FIELDS = [
  "id",
  "project_id",
  "device",
  "location",
  "page_url",
  "description",
  "image_url",
  "image_urls",
  "status",
  "priority",
  "responsible_id",
  "responsible_name",
  "created_by_name",
  "created_by_email",
  "status_changed_at",
  "created_at",
  "updated_at",
] as const;

const COMMENT_RESPONSE_FIELDS = [
  "id",
  "qa_item_id",
  "body",
  "author_name",
  "author_email",
  "created_at",
] as const;

function pick(record: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
}

function firstObject(value: unknown, envelope?: string): JsonObject | null {
  let candidate = Array.isArray(value) ? value[0] : value;
  if (
    envelope && candidate && typeof candidate === "object" && !Array.isArray(candidate)
  ) {
    candidate = (candidate as JsonObject)[envelope] ?? candidate;
  }
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as JsonObject
    : null;
}

function urlArray(value: unknown, field: string, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) {
      throw new ApiError(400, "IMAGE_REQUIRED", "Envie image_urls ou attachment_ids com uma imagem.");
    }
    return [];
  }
  if (!Array.isArray(value) || value.length > 10 || (required && value.length === 0)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} deve conter de 1 a 10 URLs.`);
  }
  return value.map((url, index) => httpUrl(url, `${field}[${index}]`));
}

function nullableHttpUrl(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return httpUrl(value, field);
}

export class QaAdapter {
  constructor(
    private readonly db: AdminClient,
    private readonly config: AppConfig,
  ) {}

  private coreTable(table: string) {
    return this.db.from(table);
  }

  async getProjectByToken(token: string): Promise<ProjectRecord> {
    const { data, error } = await this.coreTable(this.config.projectsTable)
      .select("*")
      .eq(this.config.projectTokenColumn, token)
      .maybeSingle();
    if (error) throw databaseError("find project", error);
    if (!data) throw new ApiError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
    const id = uuidValue((data as JsonObject).id, "project.id");
    return { ...(data as JsonObject), id } as ProjectRecord;
  }

  async getSnapshot(project: ProjectRecord, includeMembers: boolean): Promise<JsonObject> {
    if (this.config.snapshotRpc) {
      const { data, error } = await this.db.rpc(this.config.snapshotRpc, {
        p_project_id: project.id,
        p_include_members: includeMembers,
      });
      if (error) throw databaseError("snapshot RPC", error);
      const snapshot = firstObject(data);
      if (!snapshot) throw databaseError("invalid snapshot RPC response");
      return {
        project: pick(firstObject(snapshot.project) ?? project, PROJECT_RESPONSE_FIELDS),
        items: Array.isArray(snapshot.items)
          ? snapshot.items.map((item) => pick(objectValue(item, "items[]"), ITEM_RESPONSE_FIELDS))
          : [],
        comments: Array.isArray(snapshot.comments)
          ? snapshot.comments.map((comment) =>
            pick(objectValue(comment, "comments[]"), COMMENT_RESPONSE_FIELDS)
          )
          : [],
        clientChecklists: Array.isArray(snapshot.clientChecklists)
          ? snapshot.clientChecklists
          : [],
        memberDirectory: includeMembers
          ? (firstObject(snapshot.memberDirectory) ?? { dev: [], design: [], manager: [] })
          : { dev: [], design: [], manager: [] },
      };
    }

    const itemsResult = await this.coreTable(this.config.itemsTable)
      .select("*")
      .eq(this.config.itemProjectColumn, project.id)
      .order("created_at", { ascending: false });
    if (itemsResult.error) throw databaseError("list QA items", itemsResult.error);
    const rawItems = (itemsResult.data ?? []) as JsonObject[];
    const itemIds = rawItems.map((item) => String(item.id));

    const [comments, clientChecklists, memberDirectory] = await Promise.all([
      this.listComments(itemIds),
      this.listClientChecklists(project.id),
      includeMembers ? this.getMemberDirectory(project.id) : Promise.resolve({
        dev: [],
        design: [],
        manager: [],
      }),
    ]);

    return {
      project: pick(project, PROJECT_RESPONSE_FIELDS),
      items: rawItems.map((item) => pick(item, ITEM_RESPONSE_FIELDS)),
      comments,
      clientChecklists,
      memberDirectory,
    };
  }

  async createItem(
    projectId: string,
    itemValue: unknown,
    author: ResolvedAuthor,
    access: AccessContext,
    hasPrivateImage: boolean,
  ): Promise<JsonObject> {
    const item = normalizeNewItem(itemValue, author, access, hasPrivateImage);
    let created: JsonObject | null;

    if (this.config.createItemRpc) {
      const { data, error } = await this.db.rpc(this.config.createItemRpc, {
        p_project_id: projectId,
        p_item: item,
        p_author: author,
      });
      if (error) throw databaseError("create QA item RPC", error);
      created = firstObject(data, "item");
    } else {
      const { data, error } = await this.coreTable(this.config.itemsTable)
        .insert({ ...item, [this.config.itemProjectColumn]: projectId })
        .select("*")
        .single();
      if (error) throw databaseError("create QA item", error);
      created = data as JsonObject;
    }

    if (!created?.id) throw databaseError("invalid create item response");
    return pick(created, ITEM_RESPONSE_FIELDS);
  }

  async updateItem(
    projectId: string,
    itemIdValue: unknown,
    patchValue: unknown,
    access: AccessContext,
  ): Promise<JsonObject> {
    const itemId = uuidValue(itemIdValue, "id");
    await this.assertItemBelongsToProject(projectId, itemId);
    const patch = normalizeItemPatch(patchValue, access);
    let updated: JsonObject | null;

    if (this.config.updateItemRpc) {
      const { data, error } = await this.db.rpc(this.config.updateItemRpc, {
        p_project_id: projectId,
        p_item_id: itemId,
        p_patch: patch,
      });
      if (error) throw databaseError("update QA item RPC", error);
      updated = firstObject(data, "item");
    } else {
      const { data, error } = await this.coreTable(this.config.itemsTable)
        .update(patch)
        .eq("id", itemId)
        .eq(this.config.itemProjectColumn, projectId)
        .select("*")
        .maybeSingle();
      if (error) throw databaseError("update QA item", error);
      updated = data as JsonObject | null;
    }
    if (!updated) throw new ApiError(404, "ITEM_NOT_FOUND", "Item de QA não encontrado.");
    return pick(updated, ITEM_RESPONSE_FIELDS);
  }

  async createComment(
    projectId: string,
    itemIdValue: unknown,
    bodyValue: unknown,
    author: ResolvedAuthor,
  ): Promise<JsonObject> {
    const itemId = uuidValue(itemIdValue, "itemId");
    await this.assertItemBelongsToProject(projectId, itemId);
    const body = stringValue(bodyValue, "body", 1, 5_000);
    let created: JsonObject | null;

    if (this.config.createCommentRpc) {
      const { data, error } = await this.db.rpc(this.config.createCommentRpc, {
        p_project_id: projectId,
        p_item_id: itemId,
        p_body: body,
        p_author: author,
      });
      if (error) throw databaseError("create comment RPC", error);
      created = firstObject(data, "comment");
    } else {
      const { data, error } = await this.coreTable(this.config.commentsTable)
        .insert({
          [this.config.commentItemColumn]: itemId,
          body,
          author_name: author.name,
          author_email: author.email,
        })
        .select("*")
        .single();
      if (error) throw databaseError("create comment", error);
      created = data as JsonObject;
    }
    if (!created?.id) throw databaseError("invalid create comment response");
    return pick(created, COMMENT_RESPONSE_FIELDS);
  }

  async assertItemBelongsToProject(projectId: string, itemId: string): Promise<void> {
    const { data, error } = await this.coreTable(this.config.itemsTable)
      .select("id")
      .eq("id", itemId)
      .eq(this.config.itemProjectColumn, projectId)
      .maybeSingle();
    if (error) throw databaseError("find QA item", error);
    if (!data) throw new ApiError(404, "ITEM_NOT_FOUND", "Item de QA não encontrado.");
  }

  async deleteCreatedItem(projectId: string, itemId: string): Promise<void> {
    const { error } = await this.coreTable(this.config.itemsTable)
      .delete()
      .eq("id", itemId)
      .eq(this.config.itemProjectColumn, projectId);
    if (error) throw databaseError("rollback QA item", error);
  }

  private async listComments(itemIds: string[]): Promise<JsonObject[]> {
    if (itemIds.length === 0) return [];
    const { data, error } = await this.coreTable(this.config.commentsTable)
      .select("*")
      .in(this.config.commentItemColumn, itemIds)
      .order("created_at", { ascending: true });
    if (error) throw databaseError("list comments", error);
    return ((data ?? []) as JsonObject[]).map((comment) =>
      pick(comment, COMMENT_RESPONSE_FIELDS)
    );
  }

  private async listClientChecklists(projectId: string): Promise<JsonObject[]> {
    if (!this.config.checklistsTable || !this.config.checklistItemsTable) return [];
    const checklistsResult = await this.coreTable(this.config.checklistsTable)
      .select("*")
      .eq("project_id", projectId)
      .eq("checklist_type", "cliente");
    if (checklistsResult.error) {
      throw databaseError("list client checklists", checklistsResult.error);
    }
    const checklists = (checklistsResult.data ?? []) as JsonObject[];
    if (checklists.length === 0) return [];
    const ids = checklists.map((checklist) => String(checklist.id));
    const itemsResult = await this.coreTable(this.config.checklistItemsTable)
      .select("*")
      .in("checklist_id", ids)
      .order("sort_order", { ascending: true });
    if (itemsResult.error) {
      throw databaseError("list client checklist items", itemsResult.error);
    }
    const items = (itemsResult.data ?? []) as JsonObject[];
    return checklists.map((checklist) => ({
      id: checklist.id,
      title: checklist.title,
      checklist_type: checklist.checklist_type,
      items: items
        .filter((item) => item.checklist_id === checklist.id)
        .map((item) => ({
          id: item.id,
          content: item.content,
          is_checked: Boolean(item.is_checked),
          description: item.description ?? null,
        })),
    }));
  }

  private async getMemberDirectory(projectId: string): Promise<JsonObject> {
    if (!this.config.memberDirectoryRpc) {
      return { dev: [], design: [], manager: [] };
    }
    const { data, error } = await this.db.rpc(this.config.memberDirectoryRpc, {
      p_project_id: projectId,
    });
    if (error) throw databaseError("member directory RPC", error);
    return firstObject(data) ?? { dev: [], design: [], manager: [] };
  }
}

function normalizeNewItem(
  value: unknown,
  author: ResolvedAuthor,
  access: AccessContext,
  hasPrivateImage: boolean,
): JsonObject {
  const input = objectValue(value, "item");
  const imageUrls = urlArray(input.image_urls, "item.image_urls", !hasPrivateImage);
  const suppliedImageUrl = nullableHttpUrl(input.image_url, "item.image_url");
  const responsibleId = optionalString(input.responsible_id, "item.responsible_id", 160);
  const responsibleName = optionalString(input.responsible_name, "item.responsible_name", 160);
  if (access.mode === "client" && (responsibleId || responsibleName)) {
    throw new ApiError(
      403,
      "RESPONSIBLE_INTERNAL_ONLY",
      "Responsável só pode ser definido no acesso interno.",
    );
  }

  return {
    device: enumValue(input.device, "item.device", DEVICES),
    location: stringValue(input.location, "item.location", 1, 160),
    page_url: httpUrl(input.page_url, "item.page_url"),
    description: stringValue(input.description, "item.description", 1, 10_000),
    image_url: suppliedImageUrl ?? imageUrls[0] ?? null,
    image_urls: imageUrls,
    status: enumValue(input.status, "item.status", STATUSES),
    priority: enumValue(input.priority, "item.priority", PRIORITIES),
    responsible_id: responsibleId ?? null,
    responsible_name: responsibleName ?? null,
    created_by_name: author.name,
    created_by_email: author.email,
  };
}

function normalizeItemPatch(value: unknown, access: AccessContext): JsonObject {
  const input = objectValue(value, "item");
  const patch: JsonObject = {};
  if ("device" in input) patch.device = enumValue(input.device, "item.device", DEVICES);
  if ("location" in input) patch.location = stringValue(input.location, "item.location", 1, 160);
  if ("page_url" in input) patch.page_url = httpUrl(input.page_url, "item.page_url");
  if ("description" in input) {
    patch.description = stringValue(input.description, "item.description", 1, 10_000);
  }
  if ("image_urls" in input) {
    const imageUrls = urlArray(input.image_urls, "item.image_urls", false);
    patch.image_urls = imageUrls;
    if (!("image_url" in input)) patch.image_url = imageUrls[0] ?? null;
  }
  if ("image_url" in input) {
    patch.image_url = nullableHttpUrl(input.image_url, "item.image_url") ?? null;
  }
  if ("status" in input) patch.status = enumValue(input.status, "item.status", STATUSES);
  if ("priority" in input) {
    patch.priority = enumValue(input.priority, "item.priority", PRIORITIES);
  }
  if ("responsible_id" in input || "responsible_name" in input) {
    if (access.mode === "client") {
      throw new ApiError(
        403,
        "RESPONSIBLE_INTERNAL_ONLY",
        "Responsável só pode ser alterado no acesso interno.",
      );
    }
    if ("responsible_id" in input) {
      patch.responsible_id = optionalString(
        input.responsible_id,
        "item.responsible_id",
        160,
      ) ?? null;
    }
    if ("responsible_name" in input) {
      patch.responsible_name = optionalString(
        input.responsible_name,
        "item.responsible_name",
        160,
      ) ?? null;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "EMPTY_PATCH", "Nenhum campo atualizável foi enviado.");
  }
  return patch;
}
