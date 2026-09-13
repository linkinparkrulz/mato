#!/usr/bin/env node
// READ-ONLY discovery. Writes nothing, changes nothing.
//
// For every node in data/dojos.json: log in with its apikey over Tor, then call
// the endpoints below and report what comes back. /support/services was added in
// Dojo v1.27.0 and exposes the explorer, soroban and indexer (Electrum) entries;
// it supersedes the deprecated `explorer` field in the pairing payload. Older
// Dojos will not have it, so expect partial coverage.
//
//   node scripts/probe-services.mjs            summary table
//   node scripts/probe-services.mjs --raw      dump full JSON per node
//   node scripts/probe-services.mjs --raw --only mainnet-otto
//
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpOverTor } from "./update.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG = {
  proxyHost: process.env.TOR_SOCKS_HOST || "127.0.0.1",
  proxyPort: +(process.env.TOR_SOCKS_PORT || 9050),
  timeoutMs: +(process.env.TIMEOUT_MS || 30000),
  concurrency: +(process.env.CONCURRENCY || 4),
};
const RAW = process.argv.includes("--raw");
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > -1 ? process.argv[i + 1] : null; })();

// Candidate endpoints, tried in order. We dump whatever each returns.
// /fees/estimator is here to answer a capability question rather than to read a
// number: it is served by the $1 Fee Estimator, a separate component a Dojo may
// or may not run, and returns 503 when it is absent or bitcoind's mempool has
// not finished loading. Before putting a fee figure on every card it is worth
// knowing how many nodes can actually supply one, since a column that reads
// "—" for fifteen of sixteen listings is a different feature from the one that
// was asked for.
const ENDPOINTS = ["/support/services", "/support/info", "/status", "/fees/estimator"];

// A thin adapter over the shared reader in update.mjs rather than a second copy
// of it. This file used to carry its own, which is how it kept an unbounded
// accumulation for a while after the shared one was given a ceiling: a fix
// applied in one place simply did not reach the other, and nothing said so.
// Being a hand-run diagnostic makes that lower risk, not less true, and the
// only thing the private copy did differently was decode the body as UTF-8,
// which the shared one supports through bodyBuf.
//
// The default response ceiling applies. These endpoints return small JSON, so
// if one ever trips the limit that is itself the finding this script exists to
// surface, and it will say so rather than filling memory quietly.
async function torRequest(host, port, rawReq) {
  const res = await httpOverTor(CFG, host, port, rawReq, CFG.timeoutMs);
  return { status: res.status, body: res.bodyBuf.toString("utf8") };
}

async function login(host, port, base, apikey) {
  const body = `apikey=${encodeURIComponent(apikey)}`;
  const req = `POST ${base}/auth/login HTTP/1.0\r\nHost: ${host}\r\n` +
    `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n\r\n${body}`;
  const res = await torRequest(host, port, req);
  if (res.status !== 200) throw new Error(`login HTTP ${res.status || "no-response"}`);
  const tok = JSON.parse(res.body)?.authorizations?.access_token;
  if (!tok) throw new Error("login: no token");
  return tok;
}

async function get(host, port, base, endpoint, token) {
  const req = `GET ${base}${endpoint} HTTP/1.0\r\nHost: ${host}\r\n` +
    `Authorization: Bearer ${token}\r\nConnection: close\r\n\r\n`;
  const res = await torRequest(host, port, req);
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  return { status: res.status, json, body: res.body };
}

// Pull an indexer/Electrum endpoint out of whatever shape came back.
function findIndexer(obj) {
  if (!obj || typeof obj !== "object") return null;
  const arr = Array.isArray(obj) ? obj : (Array.isArray(obj.services) ? obj.services : null);
  if (arr) {
    const hit = arr.find((s) => s && (s.type === "indexer" || s.kind === "fulcrum" || s.kind === "electrum"));
    if (hit?.url) return hit.url;
  }
  if (obj.indexer) {
    if (typeof obj.indexer === "string") return obj.indexer;
    if (obj.indexer.url) return obj.indexer.url;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const r = findIndexer(v); if (r) return r; }
  }
  return null;
}
function findVersion(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of ["version", "dojo_version", "api_version"]) {
    if (typeof obj[k] === "string") return obj[k];
    if (obj[k]?.version) return obj[k].version;
  }
  if (obj.dojo?.version) return obj.dojo.version;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const r = findVersion(v); if (r) return r; }
  }
  return null;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const dojos = JSON.parse(await readFile(path.join(ROOT, "data", "dojos.json"), "utf8"));
let nodes = dojos.nodes.filter((n) => n?.payload?.pairing?.url && n?.payload?.pairing?.apikey);
if (ONLY) nodes = nodes.filter((n) => n.id === ONLY);

console.log(`probing ${nodes.length} node(s) via socks5h://${CFG.proxyHost}:${CFG.proxyPort}\n`);

const results = await pool(nodes, CFG.concurrency, async (n) => {
  const u = new URL(n.payload.pairing.url);
  const host = u.hostname, port = u.port ? +u.port : 80;
  const base = (u.pathname || "/v2").replace(/\/+$/, "") || "/v2";
  try {
    const token = await login(host, port, base, n.payload.pairing.apikey);
    const found = {};
    for (const ep of ENDPOINTS) {
      try {
        const r = await get(host, port, base, ep, token);
        found[ep] = r;
        if (RAW) {
          console.log(`--- ${n.id}  GET ${base}${ep}  -> HTTP ${r.status}`);
          console.log(r.json ? JSON.stringify(r.json, null, 2) : (r.body || "(empty)").slice(0, 600));
          console.log("");
        }
      } catch (e) { found[ep] = { status: 0, error: e.message }; }
    }
    const svc = found["/support/services"];
    const fee = found["/fees/estimator"];
    return {
      id: n.id,
      version: n.version || null,
      apiVersion: findVersion(svc?.json) || findVersion(found["/support/info"]?.json) || null,
      indexer: findIndexer(svc?.json),
      svcStatus: svc?.status ?? 0,
      feeStatus: fee?.status ?? 0,
      // The 99.9% figure: the rate the estimator says gives that chance of
      // being mined in the next block. Read as a string key because the reply
      // is a plain object keyed by probability.
      fee999: (fee?.json && typeof fee.json["0.999"] === "number") ? fee.json["0.999"] : null,
      note: null,
    };
  } catch (e) {
    return { id: n.id, version: n.version || null, apiVersion: null, indexer: null,
      svcStatus: 0, feeStatus: 0, fee999: null, note: e.message };
  }
});

console.log("id".padEnd(30) + "listed".padEnd(9) + "api ver".padEnd(10) + "svc".padEnd(6)
  + "fee".padEnd(6) + "sat/vB".padEnd(8) + "indexer / note");
console.log("-".repeat(124));
for (const r of results) {
  console.log(
    r.id.padEnd(30) +
    String(r.version || "-").padEnd(9) +
    String(r.apiVersion || "-").padEnd(10) +
    String(r.svcStatus || "-").padEnd(6) +
    String(r.feeStatus || "-").padEnd(6) +
    String(r.fee999 ?? "-").padEnd(8) +
    (r.indexer || (r.note ? "! " + r.note : "(none)"))
  );
}
const withIdx = results.filter((r) => r.indexer).length;
const withFee = results.filter((r) => r.fee999 != null).length;
console.log(`\n${withIdx}/${results.length} node(s) expose an indexer endpoint.`);
console.log(`${withFee}/${results.length} node(s) answer /fees/estimator with a 99.9% rate.`);
// The spread matters as much as the count. Every Dojo reads the same mempool,
// so if the answers agree the figure describes Bitcoin rather than the node,
// and putting it on a card is a capability flag with a number attached.
const rates = results.map((r) => r.fee999).filter((v) => v != null);
if (rates.length > 1) {
  console.log(`rates seen: ${[...new Set(rates)].sort((a, b) => a - b).join(", ")} sat/vB`
    + `  (min ${Math.min(...rates)}, max ${Math.max(...rates)})`);
}
