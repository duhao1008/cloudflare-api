export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  AUTH_KEY: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ResourceRow = {
  id: number;
  resource_id: number;
  type: number;
  name: string;
  status: number | null;
  sort_order: number | null;
  json: string | null;
  create_time: string;
  update_time: string;
};

type ApiResource = {
  id: number;
  resourceId: number;
  type: number;
  name: string;
  status: number;
  sortOrder: number;
  json: JsonValue;
  createTime: string;
  updateTime: string;
};

type ResourceInput = {
  resource_id?: number;
  resourceId?: number;
  type?: number;
  name?: string;
  status?: number;
  sort_order?: number;
  sortOrder?: number;
  json?: JsonValue;
};

type AppListInput = {
  apps?: unknown[];
};

type SiteListInput = {
  subsites?: unknown[];
};

type ImportResource = {
  resourceId: number;
  type: number;
  name: string;
  status: number;
  sortOrder: number;
  json: JsonValue;
};

const RESOURCE_TYPE_APP = 1;
const RESOURCE_TYPE_SITE = 2;
const DEFAULT_PAGE_SIZE = 8;
const CACHE_PAGE_SIZES = [8];
const DEFAULT_CACHE_TYPES = [RESOURCE_TYPE_APP, RESOURCE_TYPE_SITE];
const MAX_PAGE_SIZE = 100;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      return await routeRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      return json({ error: message }, 500);
    }
  }
};

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = trimTrailingSlash(url.pathname);

  if (request.method === "GET" && pathname === "/health") {
    return json({ ok: true });
  }

  if (request.method === "POST" && pathname === "/cache/rebuild") {
    const authResponse = requireAuth(request, env);
    if (authResponse) {
      return authResponse;
    }

    await rebuildPaginationCache(env);
    return json({ ok: true });
  }

  if (request.method === "GET" && pathname === "/resources") {
    return listResources(url, env);
  }

  if (request.method === "POST" && pathname === "/resources") {
    const authResponse = requireAuth(request, env);
    if (authResponse) {
      return authResponse;
    }

    return createResource(request, env);
  }

  if (request.method === "POST" && pathname === "/resources/import") {
    const authResponse = requireAuth(request, env);
    if (authResponse) {
      return authResponse;
    }

    return importResources(request, env);
  }

  const resourceMatch = pathname.match(/^\/resources\/(\d+)$/);
  if (resourceMatch) {
    const id = Number(resourceMatch[1]);

    if (request.method === "GET") {
      return getResource(id, env);
    }

    if (request.method === "PUT" || request.method === "PATCH") {
      const authResponse = requireAuth(request, env);
      if (authResponse) {
        return authResponse;
      }

      return updateResource(id, request, env);
    }

    if (request.method === "DELETE") {
      const authResponse = requireAuth(request, env);
      if (authResponse) {
        return authResponse;
      }

      return deleteResource(id, env);
    }
  }

  return json({ error: "Not found" }, 404);
}

function requireAuth(request: Request, env: Env): Response | null {
  if (!env.AUTH_KEY) {
    return json({ error: "AUTH_KEY is not configured" }, 500);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = request.headers.get("x-api-key");

  if (bearerToken === env.AUTH_KEY || apiKey === env.AUTH_KEY) {
    return null;
  }

  return json({ error: "Unauthorized" }, 401);
}

async function listResources(url: URL, env: Env): Promise<Response> {
  const page = parsePositiveInt(url.searchParams.get("page"), 1);
  const requestedPageSize = parsePositiveInt(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  const type = parseOptionalInt(url.searchParams.get("type"));
  const meta = await env.CACHE.get<CacheMeta>(metaCacheKey(type, pageSize), "json");

  if (meta && page > meta.totalPages) {
    return json(emptyPage(page, pageSize, meta.total, meta.totalPages));
  }

  const cached = await env.CACHE.get(pageCacheKey(type, page, pageSize), "json");

  if (!cached) {
    return json(
      {
        error: "Page cache not found",
        hint: "Call POST /cache/rebuild once after binding an existing D1 table."
      },
      404
    );
  }

  return json(cached);
}

async function getResource(id: number, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM resources WHERE id = ?").bind(id).first<ResourceRow>();

  if (!row) {
    return json({ error: "Resource not found" }, 404);
  }

  return json({ item: toApiResource(row) });
}

async function createResource(request: Request, env: Env): Promise<Response> {
  const input = await readResourceInput(request);
  const resourceId = input.resource_id ?? input.resourceId;

  if (!Number.isInteger(resourceId)) {
    return json({ error: "resource_id/resourceId is required" }, 400);
  }

  if (!input.name) {
    return json({ error: "name is required" }, 400);
  }

  const type = input.type ?? RESOURCE_TYPE_SITE;
  const status = input.status ?? 0;
  const sortOrder = input.sort_order ?? input.sortOrder ?? 0;
  const result = await upsertResource(env, {
    resourceId: resourceId as number,
    type,
    name: input.name,
    status,
    sortOrder,
    json: input.json ?? null
  });

  await rebuildPaginationCache(env, [type]);

  return json({ item: toApiResource(result as ResourceRow) }, 201);
}

async function importResources(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  const body = (await request.json()) as AppListInput & SiteListInput;
  const resources = [
    ...(body.apps ?? []).map((item) => toImportResource(item, RESOURCE_TYPE_APP)),
    ...(body.subsites ?? []).map((item) => toImportResource(item, RESOURCE_TYPE_SITE))
  ];

  if (resources.length === 0) {
    return json({ error: "Request body must include apps or subsites" }, 400);
  }

  for (const resource of resources) {
    await upsertResource(env, resource);
  }

  await rebuildPaginationCache(env, [RESOURCE_TYPE_APP, RESOURCE_TYPE_SITE]);

  return json({
    ok: true,
    imported: resources.length,
    apps: resources.filter((resource) => resource.type === RESOURCE_TYPE_APP).length,
    sites: resources.filter((resource) => resource.type === RESOURCE_TYPE_SITE).length
  });
}

async function upsertResource(env: Env, resource: ImportResource): Promise<ResourceRow> {
  const existing = await env.DB.prepare(
    "SELECT id FROM resources WHERE resource_id = ? AND type = ? ORDER BY id ASC LIMIT 1"
  )
    .bind(resource.resourceId, resource.type)
    .first<{ id: number }>();

  if (existing) {
    return (await env.DB.prepare(
      `UPDATE resources
       SET name = ?, status = ?, sort_order = ?, json = ?, update_time = CURRENT_TIMESTAMP
       WHERE id = ?
       RETURNING *`
    )
      .bind(resource.name, resource.status, resource.sortOrder, stringifyJson(resource.json), existing.id)
      .first<ResourceRow>()) as ResourceRow;
  }

  return (await env.DB.prepare(
    `INSERT INTO resources (resource_id, type, name, status, sort_order, json, create_time, update_time)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING *`
  )
    .bind(
      resource.resourceId,
      resource.type,
      resource.name,
      resource.status,
      resource.sortOrder,
      stringifyJson(resource.json)
    )
    .first<ResourceRow>()) as ResourceRow;
}

async function updateResource(id: number, request: Request, env: Env): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM resources WHERE id = ?").bind(id).first<ResourceRow>();

  if (!existing) {
    return json({ error: "Resource not found" }, 404);
  }

  const input = await readResourceInput(request);
  const nextType = input.type ?? existing.type;
  const nextResourceId = input.resource_id ?? input.resourceId ?? existing.resource_id;
  const nextName = input.name ?? existing.name;
  const nextStatus = input.status ?? existing.status ?? 0;
  const nextSortOrder = input.sort_order ?? input.sortOrder ?? existing.sort_order ?? 0;
  const nextJson = Object.prototype.hasOwnProperty.call(input, "json") ? input.json ?? null : parseJson(existing.json);

  const result = await env.DB.prepare(
    `UPDATE resources
     SET resource_id = ?, type = ?, name = ?, status = ?, sort_order = ?, json = ?, update_time = CURRENT_TIMESTAMP
     WHERE id = ?
     RETURNING *`
  )
    .bind(nextResourceId, nextType, nextName, nextStatus, nextSortOrder, stringifyJson(nextJson), id)
    .first<ResourceRow>();

  await rebuildPaginationCache(env, [existing.type, nextType]);

  return json({ item: toApiResource(result as ResourceRow) });
}

async function deleteResource(id: number, env: Env): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM resources WHERE id = ?").bind(id).first<ResourceRow>();

  if (!existing) {
    return json({ error: "Resource not found" }, 404);
  }

  await env.DB.prepare("DELETE FROM resources WHERE id = ?").bind(id).run();
  await rebuildPaginationCache(env, [existing.type]);

  return json({ ok: true });
}

async function rebuildPaginationCache(env: Env, touchedTypes: number[] = []): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT * FROM resources ORDER BY sort_order ASC, update_time DESC, id DESC"
  ).all<ResourceRow>();
  const items = rows.results.map(toApiResource);
  const types = new Set([...DEFAULT_CACHE_TYPES, ...items.map((item) => item.type), ...touchedTypes]);

  await Promise.all([
    ...CACHE_PAGE_SIZES.map((pageSize) => writePagesForSize(env, items, pageSize, null)),
    ...Array.from(types).flatMap((type) => {
      const typedItems = items.filter((item) => item.type === type);
      return CACHE_PAGE_SIZES.map((pageSize) => writePagesForSize(env, typedItems, pageSize, type));
    })
  ]);
}

type CacheMeta = {
  pageSize: number;
  total: number;
  totalPages: number;
  refreshedAt: string;
};

async function writePagesForSize(
  env: Env,
  items: ApiResource[],
  pageSize: number,
  type: number | null
): Promise<void> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageWrites: Promise<void>[] = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * pageSize;
    const body = {
      items: items.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    };

    pageWrites.push(
      env.CACHE.put(pageCacheKey(type, page, pageSize), JSON.stringify(body), {
        expirationTtl: CACHE_TTL_SECONDS
      })
    );
  }

  await Promise.all([
    env.CACHE.put(
      metaCacheKey(type, pageSize),
      JSON.stringify({ pageSize, total, totalPages, refreshedAt: new Date().toISOString() }),
      { expirationTtl: CACHE_TTL_SECONDS }
    ),
    ...pageWrites
  ]);
}

async function readResourceInput(request: Request): Promise<ResourceInput> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  return (await request.json()) as ResourceInput;
}

function toApiResource(row: ResourceRow): ApiResource {
  return {
    id: row.id,
    resourceId: row.resource_id,
    type: row.type,
    name: row.name,
    status: row.status ?? 0,
    sortOrder: row.sort_order ?? 0,
    json: parseJson(row.json),
    createTime: row.create_time,
    updateTime: row.update_time
  };
}

function toImportResource(item: unknown, type: number): ImportResource {
  if (!isJsonObject(item)) {
    throw new Error("Import items must be objects");
  }

  const resourceIdValue = type === RESOURCE_TYPE_APP ? toNumber(item.appleId) : toNumber(item.mainId);
  const nameValue = type === RESOURCE_TYPE_APP ? item.displayName : item.siteName;
  const name = typeof nameValue === "string" && nameValue ? nameValue : String(resourceIdValue);
  const status = toNumber(item.status) ?? 0;
  const sortOrder = toNumber(item.sort_order) ?? toNumber(item.sortOrder) ?? 0;

  if (resourceIdValue === undefined || !Number.isInteger(resourceIdValue)) {
    throw new Error(type === RESOURCE_TYPE_APP ? "App item appleId is required" : "Site item mainId is required");
  }

  return {
    resourceId: resourceIdValue,
    type,
    name,
    status,
    sortOrder,
    json: item as JsonValue
  };
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function parseJson(value: string | null): JsonValue {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as JsonValue;
}

function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function pageCacheKey(type: number | null, page: number, pageSize: number): string {
  return `resources:${typeKey(type)}:page:${pageSize}:${page}`;
}

function metaCacheKey(type: number | null, pageSize: number): string {
  return `resources:${typeKey(type)}:meta:${pageSize}`;
}

function typeKey(type: number | null): string {
  return type === null ? "all" : `type:${type}`;
}

function emptyPage(page: number, pageSize: number, total: number, totalPages: number): unknown {
  return {
    items: [],
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: false,
      hasPrev: page > 1
    }
  };
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalInt(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
