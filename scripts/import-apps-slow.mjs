import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(projectDir, "..");
const apiBase = process.env.API_BASE ?? "https://cloudflare-api.hao-tools.com";
const authKey = process.env.AUTH_KEY;
const delayMs = Number(process.env.IMPORT_DELAY_MS ?? 1000);

if (!authKey) {
  throw new Error("AUTH_KEY env var is required");
}

const appList = JSON.parse(await readFile(resolve(rootDir, "app_list.json"), "utf8"));
const apps = appList.apps ?? [];

for (let index = 0; index < apps.length; index += 1) {
  const app = apps[index];
  const payload = {
    resource_id: app.appleId,
    type: 1,
    name: app.displayName ?? String(app.appleId),
    status: app.status ?? 0,
    sort_order: app.sort_order ?? app.sortOrder ?? 0,
    json: app
  };

  const response = await fetch(`${apiBase}/resources`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": authKey
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Import app ${index + 1}/${apps.length} failed: ${response.status} ${text}`);
  }

  console.log(`Imported app ${index + 1}/${apps.length}: ${payload.resource_id}`);

  if (index < apps.length - 1) {
    await sleep(delayMs);
  }
}

console.log(`Imported ${apps.length} apps.`);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
