import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API_BASE = "https://api.avito.ru";
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const port = Number(process.env.PORT ?? 8080);
const feedToken = process.env.FEED_TOKEN ?? randomBytes(24).toString("hex");
const adminToken = process.env.ADMIN_TOKEN ?? randomBytes(24).toString("hex");
const dataFile = resolve(process.env.DATA_FILE ?? "./data/ads.json");
let accessToken;
let accessTokenExpiresAt = 0;
let detectedUserId = process.env.AVITO_USER_ID || "";
let writeQueue = Promise.resolve();

const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function buildFeed(ads) {
  const rows = ['<?xml version="1.0" encoding="UTF-8"?>', '<Ads formatVersion="3" target="Avito.ru">'];
  for (const ad of ads.filter((item) => item.enabled !== false)) {
    rows.push("  <Ad>");
    for (const [name, value] of Object.entries(ad.fields ?? {})) {
      if (!XML_NAME.test(name)) throw new Error(`Invalid XML field name: ${name}`);
      if (value === undefined || value === null || value === "" || Array.isArray(value)) continue;
      rows.push(`    <${name}>${escapeXml(value)}</${name}>`);
    }
    if (Array.isArray(ad.images) && ad.images.length) {
      rows.push("    <Images>");
      for (const image of ad.images) rows.push(`      <Image url="${escapeXml(image)}"/>`);
      rows.push("    </Images>");
    }
    rows.push("  </Ad>");
  }
  rows.push("</Ads>", "");
  return rows.join("\n");
}

function validateAd(ad) {
  const fields = ad?.fields ?? {};
  const missing = ["Id", "Address", "Title", "Description", "Category", "BusinessType", "BusinessSubType", "DealGoal"]
    .filter((name) => fields[name] === undefined || fields[name] === null || fields[name] === "");
  if (!ad?.id) missing.unshift("id");
  if (ad?.id && fields.Id && ad.id !== fields.Id) throw new Error("id and fields.Id must be identical");
  if (!Array.isArray(ad?.images) || !ad.images.length) missing.push("images");
  if (missing.length) throw new Error(`Missing required fields: ${[...new Set(missing)].join(", ")}`);
  for (const image of ad.images) if (new URL(image).protocol !== "https:") throw new Error("Every image URL must use HTTPS");
}

async function readData() {
  try {
    const parsed = JSON.parse(await readFile(dataFile, "utf8"));
    return Array.isArray(parsed.ads) ? parsed : { ads: [] };
  } catch (error) {
    if (error.code === "ENOENT") return { ads: [] };
    throw error;
  }
}

async function writeData(data) {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    const temporary = `${dataFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, dataFile);
  });
  return writeQueue;
}

async function avitoToken() {
  if (accessToken && accessTokenExpiresAt > Date.now() + 60_000) return accessToken;
  const response = await fetch(`${API_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.AVITO_CLIENT_ID ?? "", client_secret: process.env.AVITO_CLIENT_SECRET ?? "" })
  });
  if (!response.ok) throw new Error(`Avito token request failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  accessToken = result.access_token;
  accessTokenExpiresAt = Date.now() + Number(result.expires_in ?? 86400) * 1000;
  return accessToken;
}

async function avitoRequest(path) {
  if (!process.env.AVITO_CLIENT_ID || !process.env.AVITO_CLIENT_SECRET) throw new Error("Avito API environment variables are incomplete");
  const response = await fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${await avitoToken()}`, accept: "application/json" } });
  if (!response.ok) throw new Error(`Avito API request failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function userId() {
  if (detectedUserId) return detectedUserId;
  const account = await avitoRequest("/core/v1/accounts/self");
  if (!account?.id) throw new Error("Avito did not return an account id");
  detectedUserId = String(account.id);
  return detectedUserId;
}

const sendJson = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
};

const authorized = (request) => {
  const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(adminToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

async function requestBody(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error("Request body is too large");
  }
  return text ? JSON.parse(text) : {};
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true, avitoApiConfigured: Boolean(process.env.AVITO_CLIENT_ID && process.env.AVITO_CLIENT_SECRET) });
    if (request.method === "GET" && url.pathname === `/feed/${feedToken}.xml`) {
      response.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" });
      return response.end(buildFeed((await readData()).ads));
    }
    if (!authorized(request)) return sendJson(response, 401, { error: "Unauthorized" });
    if (request.method === "GET" && url.pathname === "/api/ads") return sendJson(response, 200, await readData());
    if (request.method === "POST" && url.pathname === "/api/ads") {
      const ad = await requestBody(request); validateAd(ad);
      const data = await readData(); const index = data.ads.findIndex((item) => item.id === ad.id);
      if (index === -1) data.ads.push(ad); else data.ads[index] = ad;
      await writeData(data); return sendJson(response, 200, ad);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/ads/")) {
      const id = decodeURIComponent(url.pathname.slice(9)); const data = await readData(); const before = data.ads.length;
      data.ads = data.ads.filter((item) => item.id !== id); await writeData(data);
      return sendJson(response, data.ads.length === before ? 404 : 200, { id });
    }
    if (request.method === "GET" && url.pathname === "/api/avito/account") return sendJson(response, 200, await avitoRequest("/core/v1/accounts/self"));
    if (request.method === "GET" && url.pathname === "/api/avito/reports/last") return sendJson(response, 200, await avitoRequest(`/autoload/v1/accounts/${encodeURIComponent(await userId())}/reports/last_report/`));
    if (request.method === "GET" && url.pathname.startsWith("/api/avito/items/")) return sendJson(response, 200, await avitoRequest(`/autoload/v1/accounts/${encodeURIComponent(await userId())}/items/${encodeURIComponent(url.pathname.slice(17))}/`));
    return sendJson(response, 404, { error: "Not found" });
  } catch (error) { return sendJson(response, 400, { error: error.message }); }
}).listen(port, () => console.log(`Avito feed service listening on port ${port}`));
