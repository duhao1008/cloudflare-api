# cloudflare-api

Cloudflare Worker API using D1 `resources` as source data and KV for paginated read cache.

## Endpoints

- `GET /health`
- `GET /resources?page=1&pageSize=20` reads paginated data from KV only
- `GET /resources?page=1&pageSize=20&type=0` reads one type from KV only
- `GET /resources/:id` reads one resource from D1
- `POST /resources` creates a resource in D1, then rebuilds KV page cache
- `PUT /resources/:id` or `PATCH /resources/:id` updates resource data in D1, then rebuilds KV page cache
- `DELETE /resources/:id` deletes from D1, then rebuilds KV page cache
- `POST /cache/rebuild` rebuilds KV page cache from existing D1 data

Request body for create/update:

```json
{
  "resource_id": 10001,
  "type": 0,
  "name": "example site",
  "status": 0,
  "sort_order": 10,
  "json": {
    "url": "https://example.com"
  }
}
```

`resource_id` is the Java backend data ID. `type` is used to distinguish app/site records.

## Setup

```bash
npm install
npx wrangler d1 create cloudflare_api_db
npx wrangler kv namespace create CACHE
```

Copy the generated `database_id` and KV `id` into `wrangler.toml`.

Apply D1 schema:

```bash
npm run db:migrate
```

If the `resources` table already exists, you can skip the migration and run `POST /cache/rebuild` once after deploy/dev starts.

Local development:

```bash
npm run db:migrate:local
npm run dev
```

Deploy:

```bash
npm run deploy
```

KV page cache is rebuilt after every create, update, and delete for page sizes `10`, `20`, `50`, and `100`.
