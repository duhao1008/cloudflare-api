# cloudflare-api

Cloudflare Worker API using D1 `resources` as source data.

## Endpoints

- `GET /health`
- `GET /resources?page=1` reads paginated data from D1, page size is fixed to 8
- `GET /resources?page=1&type=1` reads app data from D1
- `GET /resources?page=1&type=2` reads site data from D1
- `GET /resources/search?keyword=xxx&page=1` searches `name` and `json` from D1, page size is fixed to 8
- `GET /resources/search?keyword=xxx&page=1&type=1` searches app data
- `GET /resources/search?keyword=xxx&page=1&type=2` searches site data
- `GET /resources/:id` reads one resource from D1
- `POST /resources` creates or updates a resource in D1
- `PUT /resources/:id` or `PATCH /resources/:id` updates resource data in D1
- `DELETE /resources/:id` deletes from D1
- `POST /resources/import` imports `app_list.json`/`site_list.json` style data into D1
- `POST /cache/rebuild` is kept for compatibility, but pagination cache is disabled

Write endpoints require authentication. Public pagination and search endpoints do not.

Use either header:

```bash
Authorization: Bearer <AUTH_KEY>
```

or:

```bash
X-API-Key: <AUTH_KEY>
```

Request body for create/update:

```json
{
  "resource_id": 10001,
  "type": 2,
  "name": "example site",
  "status": 0,
  "sort_order": 10,
  "json": {
    "url": "https://example.com"
  }
}
```

`resource_id` is the Java backend data ID. `type` is used to distinguish app/site records:

- `1`: app
- `2`: site

`sort_order` is reserved for manual sorting and defaults to `0`. The `json` field stores the original app/site object used by the website display layer.

Recommended D1 table:

```sql
CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  status INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  json TEXT,
  create_time TEXT DEFAULT CURRENT_TIMESTAMP,
  update_time TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_resources_resource_type ON resources (resource_id, type);
CREATE INDEX idx_resources_type_sort ON resources (type, sort_order, update_time DESC, id DESC);
CREATE INDEX idx_resources_resource_id ON resources (resource_id);
```

Import mapping:

- `app_list.json.apps[]`: `resource_id = appleId`, `type = 1`, `name = displayName`, full item saved to `json`
- `site_list.json.subsites[]`: `resource_id = mainId`, `type = 2`, `name = siteName`, full item saved to `json`

## Setup

```bash
npm install
npx wrangler d1 create cloudflare_api_db
npx wrangler kv namespace create CACHE
```

Copy the generated `database_id` into `wrangler.toml`. The KV binding may stay in `wrangler.toml` for compatibility, but it is not used by pagination/search.

Set the production auth secret:

```bash
npx wrangler secret put AUTH_KEY
```

Apply D1 schema:

```bash
npm run db:migrate
```

If the `resources` table already exists, you can skip the migration.

Local development:

```bash
npm run db:migrate:local
npm run dev
```

Import the two JSON files from the parent directory:

```bash
$env:AUTH_KEY="your-auth-key"
npm run import:json
```

Use another API host if needed:

```bash
$env:API_BASE="http://127.0.0.1:8787"
$env:AUTH_KEY="your-auth-key"
npm run import:json
```

Deploy:

```bash
npm run deploy
```
