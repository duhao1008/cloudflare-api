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

const siteList = JSON.parse(await readFile(resolve(rootDir, "site_list.json"), "utf8"));
const subsites = siteList.subsites ?? [];

for (let index = 0; index < subsites.length; index += 1) {
  const site = subsites[index];
  const payload = {
    resource_id: site.mainId,
    type: 2,
    name: site.siteName ?? String(site.mainId),
    status: site.status ?? 0,
    sort_order: site.sort_order ?? site.sortOrder ?? 0,
    json: site
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
    throw new Error(`Import site ${index + 1}/${subsites.length} failed: ${response.status} ${text}`);
  }

  console.log(`Imported site ${index + 1}/${subsites.length}: ${payload.resource_id}`);

  if (index < subsites.length - 1) {
    await sleep(delayMs);
  }
}

console.log(`Imported ${subsites.length} sites.`);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
