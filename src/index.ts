export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
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

const DEFAULT_PAGE_SIZE = 20;
const CACHE_PAGE_SIZES = [10, 20, 50, 100];
const DEFAULT_CACHE_TYPES = [0, 1];
const MAX_PAGE_SIZE = 100;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
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
    await rebuildPaginationCache(env);
    return json({ ok: true });
  }

  if (request.method === "GET" && pathname === "/resources") {
    return listResources(url, env);
  }

  if (request.method === "POST" && pathname === "/resources") {
    return createResource(request, env);
  }

  const resourceMatch = pathname.match(/^\/resources\/(\d+)$/);
  if (resourceMatch) {
    const id = Number(resourceMatch[1]);

    if (request.method === "GET") {
      return getResource(id, env);
    }

    if (request.method === "PUT" || request.method === "PATCH") {
      return updateResource(id, request, env);
    }

    if (request.method === "DELETE") {
      return deleteResource(id, env);
    }
  }

  return json({ error: "Not found" }, 404);
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

  const type = input.type ?? 0;
  const status = input.status ?? 0;
  const sortOrder = input.sort_order ?? input.sortOrder ?? 0;
  const result = await env.DB.prepare(
    `INSERT INTO resources (resource_id, type, name, status, sort_order, json, create_time, update_time)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING *`
  )
    .bind(resourceId, type, input.name, status, sortOrder, stringifyJson(input.json ?? null))
    .first<ResourceRow>();

  await rebuildPaginationCache(env, [type]);

  return json({ item: toApiResource(result as ResourceRow) }, 201);
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
