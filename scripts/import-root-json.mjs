import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(projectDir, "..");
const apiBase = process.env.API_BASE ?? "https://cloudflare-api.hao-tools.com";
const authKey = process.env.AUTH_KEY;

if (!authKey) {
  throw new Error("AUTH_KEY env var is required");
}

const [appList, siteList] = await Promise.all([
  readJson(resolve(rootDir, "app_list.json")),
  readJson(resolve(rootDir, "site_list.json"))
]);

const response = await fetch(`${apiBase}/resources/import`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": authKey
  },
  body: JSON.stringify({
    apps: appList.apps ?? [],
    subsites: siteList.subsites ?? []
  })
});

const text = await response.text();

if (!response.ok) {
  throw new Error(`Import failed: ${response.status} ${text}`);
}

console.log(text);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
