#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — directory updater
//
// Probes every node's .onion pairing endpoint over Tor and rewrites the two
// JSON databases the website reads:
//
//   data/dojos.json    current snapshot  -> node.status + node.checked_at
//   data/history.json  rolling history   -> one {t, up} per node, per run
//
// dojos.json is also the source of truth for the node LIST. To add or remove a
// node, edit dojos.json (name, paynym, payload, etc.); this script only fills
// in status/checked_at and appends to the history. New nodes get a fresh
// history series automatically; removed nodes are retired under a grace stamp
// and only pruned HISTORY_GRACE_DAYS (default 14) after leaving the list.
//
// Health is checked through Tor's SOCKS5 proxy (no external npm deps). For a
// node whose pairing payload carries an apikey, the check logs in to the Dojo
// API and reads info.latest_block.height from GET /v2/wallet: the node is
// "active" only if it returns a chain tip, which proves the whole stack (Tor,
// nginx, Dojo API, bitcoind) is serving block data, and the height is recorded
// on the node. Nodes without an apikey fall back to a plain HTTP reachability
// probe (active if the onion returns an HTTP response line).
//
// Every Dojo response carries its running version in the X-Dojo-Version header;
// the probe reads it and records node.detected_version, so a card can show the
// live version rather than the one frozen into the pairing payload at signing
// time. build-public.mjs decides the effective version an operator override
// still wins over it.
//
// Run once (intended to be driven by cron/systemd every 10 minutes):
//   node scripts/update.mjs
//
// Config via environment variables (all optional):
//   TOR_SOCKS_HOST   default 127.0.0.1
//   TOR_SOCKS_PORT   default 9050
//   DATA_DIR         default <repo>/data
//   TIMEOUT_MS       default 45000   per-node Tor timeout
//   CONCURRENCY      default 3        simultaneous Tor circuits
//   WINDOW_CHECKS    default 144      history length kept per node (24h @ 10min)
//   RETENTION_DAYS   default 90       daily-rollup days kept per node (~3 months)
//   CONNECT_ONLY     default 0        "1" = treat a successful Tor connect as up
//                                     without waiting for an HTTP response line
//   DOJO_VERSION_HEADER default X-Dojo-Version  response header carrying the
//                                     node's running Dojo version
// =============================================================================

import net from "node:net";
import { retireUnlisted } from "../server/build-public.ts";
import { readFile, writeFile, rename, stat as fsStat, mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Chosen for a home connection as much as a VPS, because the unit that would
// override them lives in /etc and no update can reach it. A node answering at
// 23 seconds was being recorded as down against a 30 second ceiling, and six
// circuits at once through one Tor client on a domestic line makes every probe
// slow together, which reads as every node being down.
export const DEFAULT_TIMEOUT_MS = 45000;
export const DEFAULT_CONCURRENCY = 3;

const CFG = {
  proxyHost: process.env.TOR_SOCKS_HOST || "127.0.0.1",
  proxyPort: +(process.env.TOR_SOCKS_PORT || 9050),
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, "..", "data"),
  timeoutMs: +(process.env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  concurrency: +(process.env.CONCURRENCY || DEFAULT_CONCURRENCY),
  windowChecks: +(process.env.WINDOW_CHECKS || 144),
  retentionDays: +(process.env.RETENTION_DAYS || 90),
  connectOnly: process.env.CONNECT_ONLY === "1",
  // The Dojo API stamps its running version on every response via this header
  // (Dojo's http-server appends X-Dojo-Version: <DOJO_VERSION_TAG> as global
  // middleware). Read it during the probe so a node's displayed version tracks
  // what it is actually running, instead of the value frozen into its pairing
  // payload at submission time. Overridable in case a fork renames the header.
  dojoVersionHeader: (process.env.DOJO_VERSION_HEADER || "X-Dojo-Version").toLowerCase(),
};

// ---- SOCKS5 reply codes (RFC 1928 §6) ---------------------------------------
const SOCKS_ERR = {
  0x01: "general failure",
  0x02: "connection not allowed",
  0x03: "network unreachable",
  0x04: "host unreachable",   // Tor: onion descriptor not found / service down
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

class SocksError extends Error {
  constructor(code) {
    super("SOCKS " + (SOCKS_ERR[code] || "error 0x" + code.toString(16)));
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// Open a TCP stream to host:port THROUGH a SOCKS5 proxy (Tor), using a remote
// hostname so the .onion is resolved by Tor, not locally. Resolves with a
// connected socket on success; rejects on any handshake/connect failure.
// -----------------------------------------------------------------------------
export function socks5Connect(proxyHost, proxyPort, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyHost);
    let stage = "greet";
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);

    socket.once("connect", () => {
      // greeting: VER=5, NMETHODS=1, METHOD=0 (no auth)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("proxy closed")));

    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);

      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("proxy refused no-auth handshake"));
        buf = buf.subarray(2);
        stage = "reply";
        // CONNECT request with ATYP=3 (domain name), so Tor resolves the onion
        const hb = Buffer.from(host, "utf8");
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
          hb,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));
      }

      if (stage === "reply") {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return fail(new SocksError(buf[1]));
        const atyp = buf[3];
        const addrLen =
          atyp === 0x01 ? 4 :
          atyp === 0x04 ? 16 :
          atyp === 0x03 ? (buf.length >= 5 ? 1 + buf[4] : Infinity) : 0;
        if (buf.length < 4 + addrLen + 2) return; // wait for the full bound-addr
        // success: hand the live stream back to the caller
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        resolve(socket);
      }
    });
  });
}

// Well-formed dummy extended keys, used only to elicit info.latest_block from
// the Dojo /wallet endpoint. They are passed as `new` so the node performs no
// rescan or historical import; they derive from a throwaway seed and can never
// receive funds. One per network so the Dojo never rejects them on format.
const DUMMY_XPUB = "xpub661MyMwAqRbcFhv1kNXxwyGrJUVPrmiBNTVDYAtpzF5zu9ceuhn5yV6oaSdveis14LSeBLzpWb58pDNN6hC59TTDyiN7iJR7kUQgXNMfZCL";
const DUMMY_TPUB = "tpubD6NzVbkrYhZ4XW6sCZX49tcDdbb3rADEv65WtiwyL9qteSHMyvdB7vmdpUiiBDpErEyYnvWh3guBWPryVZ3K2tuX3K7RPq5MLS16HN9awey";

// The most bytes a response may accumulate before the read is abandoned.
//
// Every caller of httpOverTor is talking to a machine somebody else controls:
// that is the point of the probe. Without a ceiling the reader accumulates
// whatever arrives until the socket closes or the timeout fires, so a listed
// node that simply never stops sending can push thirty seconds of Tor
// throughput into the heap, times CONCURRENCY parallel probes, on a VPS whose
// documented minimum is 1 GB. Nothing about that requires malice: a Dojo
// misconfigured to return a file rather than JSON does it by accident.
//
// 2 MiB is chosen against the largest legitimate response any probe path sees,
// which is a Dojo /wallet reply for two dummy xpubs, single-digit kilobytes.
// A PayNym avatar is a small PNG and sits under the same ceiling comfortably;
// it does not get a tighter limit of its own, because a second constant would
// have to be kept in a sensible relationship with this one, and 2 MiB already
// bounds the disk that syncAvatars can consume to a few tens of megabytes
// across every listed code. The one caller that legitimately needs more is
// self-update fetching a peer's source zip, and it passes its own value.
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// The unauthenticated probe reads only until it recognises an HTTP status line,
// so it needs a far smaller ceiling than a full response: this bounds how long
// it will listen to something that is not speaking HTTP at all.
export const MAX_STATUS_LINE_BYTES = 64 * 1024;

// Send one HTTP/1.0 request over a fresh Tor stream and read the whole reply
// (Connection: close means the server ends the body by closing). Resolves with
// { status, body } or rejects on connect failure, read timeout, or a reply that
// runs past maxBytes.
export function httpOverTor(cfg, host, port, rawRequest, timeoutMs, maxBytes = MAX_RESPONSE_BYTES) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try {
      socket = await socks5Connect(cfg.proxyHost, cfg.proxyPort, host, port, timeoutMs);
    } catch (e) { return reject(e); }
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.destroy(); } catch {} fn(v); };
    const timer = setTimeout(() => done(reject, new Error("read-timeout")), timeoutMs);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      // Rejected the moment the ceiling is crossed rather than at close, so the
      // socket is destroyed and the memory released now. Waiting would mean a
      // node that never closes still occupies the full timeout while holding
      // everything it has sent. done() destroys the socket, so no further data
      // events arrive and the partial buffer goes out of scope with this call.
      if (buf.length > maxBytes) {
        done(reject, new Error(`response exceeded ${maxBytes} bytes`));
      }
    });
    socket.on("error", (e) => done(reject, e));
    socket.on("close", () => {
      const s = buf.toString("latin1");
      const m = s.match(/^HTTP\/1\.[01] (\d{3})/);
      const i = s.indexOf("\r\n\r\n");
      done(resolve, {
        status: m ? +m[1] : 0,
        body: i >= 0 ? s.slice(i + 4) : "",
        rawHead: i >= 0 ? s.slice(0, i + 2) : s,          // headers incl. trailing CRLF
        bodyBuf: i >= 0 ? buf.subarray(i + 4) : Buffer.alloc(0),   // exact bytes for binary payloads
      });
    });
    socket.write(rawRequest);
  });
}

// ---- Dojo version from response headers -------------------------------------
// The Dojo API sets its running version on every response (X-Dojo-Version). We
// read it opportunistically while probing so the card can show the live value.
// A node is only semi-trusted, so the value is validated and length-capped
// before it can reach a data file: a version looks like 1, 1.28, 1.28.0 or
// 1.28.0-rc1, with an optional leading v that we strip. Anything else -> null.
export function normaliseVersion(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^v/i, "").trim();
  if (!v || v.length > 32) return null;
  return /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.]+)?$/.test(v) ? v : null;
}

// Pull the version out of a raw header block (the CRLF-joined header lines from
// httpOverTor's rawHead, or the accumulated first bytes of a plain probe).
// Header names are case-insensitive; the first occurrence wins.
export function parseDojoVersion(rawHead, headerName = CFG.dojoVersionHeader) {
  if (typeof rawHead !== "string" || !rawHead) return null;
  const name = String(headerName).toLowerCase();
  for (const line of rawHead.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() !== name) continue;
    return normaliseVersion(line.slice(idx + 1));
  }
  return null;
}

// ---- Electrum (indexer) endpoint from /support/services ---------------------
// Dojo v1.27.0 added GET /support/services (ordinary apikey auth, not admin),
// which returns { services: [ { type, kind, url }, … ] }. The "indexer" entry
// is the node's Electrum server, published by the Dojo as
// "<tcp|ssl>://<onion>:<port>" and present only when the operator exposes a
// local indexer. Older Dojos have no such route, so absence is normal and is
// reported as "not found" rather than an error.
export function parseIndexerUrl(body) {
  let doc;
  try { doc = JSON.parse(body); } catch { return null; }
  const list = Array.isArray(doc?.services) ? doc.services : null;
  if (!list) return null;
  const hit = list.find((s) => s && s.type === "indexer" && typeof s.url === "string");
  return hit ? normaliseIndexerUrl(hit.url) : null;
}

// A listed node is only semi-trusted, so the URL is validated and length-capped
// before it can reach a data file or be rendered as a copyable string. Same
// shape the card already accepts: tcp/ssl, v3 onion, explicit port.
export function normaliseIndexerUrl(raw) {
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!u || u.length > 120) return null;
  return /^(tcp|ssl):\/\/[a-z2-7]{56}\.onion:\d{2,5}$/i.test(u) ? u : null;
}

// ---- PayNym avatars ---------------------------------------------------------
// Cards embed each node's PayNym avatar in the centre of its pairing QR. The
// front end never fetches from third parties, so the avatar is mirrored here:
// downloaded over Tor from the paynym.rs onion and served locally from
// data/avatars/<paymentCode>.png. Missing files are fetched every cycle (which
// also covers newly approved nodes within ten minutes) and existing ones are
// refreshed weekly. Only verified PNG bytes are written; anything else -- an
// error page, a redirect chain, an empty body -- is skipped without touching
// the file, and failures are logged, never fatal.
const PAYNYM_ONION = process.env.PAYNYM_ONION_HOST || "paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad.onion";
const AVATAR_MAX_AGE_MS = 7 * 86400000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * @param {string} paymentCode
 * @param {{ proxyHost?: string, proxyPort?: number, destDir?: string,
 *   timeoutMs?: number, host?: string, port?: number }} [opts]
 */
export async function fetchAvatar(paymentCode, { proxyHost, proxyPort, destDir, timeoutMs = 25000, host = PAYNYM_ONION, port = 80 } = {}) {
  const cfg = { proxyHost, proxyPort };
  let pathPart = `/${encodeURIComponent(paymentCode)}/avatar`;
  for (let hop = 0; hop < 2; hop++) {          // follow at most one same-host redirect
    const req = `GET ${pathPart} HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: dojobay-checker\r\nConnection: close\r\n\r\n`;
    const res = await httpOverTor(cfg, host, port, req, timeoutMs);
    if ([301, 302, 307, 308].includes(res.status)) {
      const m = res.rawHead && res.rawHead.match(/\r\nlocation:\s*([^\r\n]+)/i);
      if (!m) throw new Error("redirect without location");
      const loc = m[1].trim();
      if (/^https?:\/\//i.test(loc)) {
        const u = new URL(loc);
        if (u.hostname !== host) throw new Error("cross-host redirect");
        pathPart = u.pathname + u.search;
      } else pathPart = loc;
      continue;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status || "no-response"}`);
    const bytes = res.bodyBuf || Buffer.from(res.body, "latin1");
    if (bytes.length < 8 || !bytes.subarray(0, 4).equals(PNG_MAGIC)) throw new Error("not a PNG");
    await fsMkdir(destDir, { recursive: true });
    const dest = path.join(destDir, `${paymentCode}.png`);
    const atmp = tmpName(dest);
    await writeFile(atmp, bytes);
    await rename(atmp, dest);
    return dest;
  }
  throw new Error("too many redirects");
}

// Ensure a local avatar exists (and is reasonably fresh) for every listed
// payment code. Small concurrency; per-code failures are logged and skipped.
async function syncAvatars(nodes, destDir) {
  const codes = [...new Set(nodes.map((n) => n.paymentCode).filter(Boolean))];
  const wanted = [];
  for (const code of codes) {
    try {
      const st = await fsStat(path.join(destDir, `${code}.png`));
      if (Date.now() - st.mtimeMs < AVATAR_MAX_AGE_MS) continue;
    } catch { /* missing -> fetch */ }
    wanted.push(code);
  }
  let i = 0;
  const worker = async () => {
    for (;;) {
      const code = wanted[i++];
      if (!code) return;
      try {
        await fetchAvatar(code, { proxyHost: CFG.proxyHost, proxyPort: CFG.proxyPort, destDir });
        console.error(`[avatar] fetched ${code.slice(0, 12)}…`);
      } catch (e) {
        console.error(`[avatar] ${code.slice(0, 12)}…: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, wanted.length) }, worker));
}

// Authenticated health check: log in with the node's apikey, then read the
// chain tip from GET /v2/wallet. The Dojo stamps X-Dojo-Version on every
// response, so we harvest it from the first response that carries it (the login
// reply always does) even on an otherwise-down cycle. Returns
// { up, reason, ms, height?, blockTime?, detectedVersion? }.
async function probeHeight(url, cfg) {
  const t0 = Date.now();
  const u = new URL(url);
  const host = u.hostname;
  const port = u.port ? +u.port : 80;
  const base = (u.pathname || "/v2").replace(/\/+$/, "") || "/v2";   // e.g. /v2
  const dummy = cfg.network === "testnet" ? DUMMY_TPUB : DUMMY_XPUB;
  let detectedVersion = null;

  // 1) login -> access token
  let token;
  try {
    const body = `apikey=${encodeURIComponent(cfg.apikey)}`;
    const req =
      `POST ${base}/auth/login HTTP/1.0\r\nHost: ${host}\r\n` +
      `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `User-Agent: dojobay-checker\r\nConnection: close\r\n\r\n${body}`;
    const res = await httpOverTor(cfg, host, port, req, cfg.timeoutMs);
    detectedVersion = parseDojoVersion(res.rawHead, cfg.dojoVersionHeader) || detectedVersion;
    if (res.status !== 200) return { up: false, reason: `login HTTP ${res.status || "no-response"}`, ms: Date.now() - t0, detectedVersion };
    token = JSON.parse(res.body)?.authorizations?.access_token;
    if (!token) return { up: false, reason: "login: no token", ms: Date.now() - t0, detectedVersion };
  } catch (e) {
    return { up: false, reason: "login: " + e.message, ms: Date.now() - t0, detectedVersion };
  }

  // 2) wallet -> info.latest_block.height
  try {
    const q = `active=${dummy}&new=${dummy}`;
    const req =
      `GET ${base}/wallet?${q} HTTP/1.0\r\nHost: ${host}\r\n` +
      `Authorization: Bearer ${token}\r\nUser-Agent: dojobay-checker\r\nConnection: close\r\n\r\n`;
    const res = await httpOverTor(cfg, host, port, req, cfg.timeoutMs);
    detectedVersion = detectedVersion || parseDojoVersion(res.rawHead, cfg.dojoVersionHeader);
    if (res.status !== 200) return { up: false, reason: `wallet HTTP ${res.status || "no-response"}`, ms: Date.now() - t0, detectedVersion };
    const info = JSON.parse(res.body)?.info?.latest_block;
    const height = info?.height;
    if (typeof height !== "number") return { up: false, reason: "wallet: no block height", ms: Date.now() - t0, detectedVersion };

    // 3) services -> Electrum (indexer) endpoint. Best-effort and strictly
    // additive: the node is already known up, so a missing route (pre-1.27.0),
    // a node that exposes no indexer, or any error here must never downgrade
    // the result. Absence simply means the card shows N/A.
    let detectedIndexer = null;
    try {
      const sreq =
        `GET ${base}/support/services HTTP/1.0\r\nHost: ${host}\r\n` +
        `Authorization: Bearer ${token}\r\nUser-Agent: dojobay-checker\r\nConnection: close\r\n\r\n`;
      const sres = await httpOverTor(cfg, host, port, sreq, cfg.timeoutMs);
      detectedVersion = detectedVersion || parseDojoVersion(sres.rawHead, cfg.dojoVersionHeader);
      if (sres.status === 200) detectedIndexer = parseIndexerUrl(sres.body);
    } catch { /* leave null */ }

    return { up: true, reason: "height", height, blockTime: info.time ?? null, ms: Date.now() - t0, detectedVersion, detectedIndexer };
  } catch (e) {
    return { up: false, reason: "wallet: " + e.message, ms: Date.now() - t0, detectedVersion };
  }
}

// -----------------------------------------------------------------------------
// Probe a single onion URL. Returns { up, reason, ms }.
//   up = Tor connected AND (CONNECT_ONLY, or an HTTP status line came back)
// -----------------------------------------------------------------------------
// Fill in the transport settings a probe cannot work without. Callers pass a
// partial config (an apikey and a network, say) and it is easy to forget to
// spread PROBE_CFG or CFG alongside it; without these, net.connect is handed an
// undefined port and Node reports 'The "options" or "port" or "path" argument
// must be specified', which says nothing about the real mistake. The defaults
// are the same ones PROBE_CFG uses, so a partial config now behaves rather than
// failing obscurely. Explicitly supplied values always win.
/**
 * @param {Partial<import("../types.js").ProbeCfg>} [cfg]
 * @returns {import("../types.js").ProbeCfg}
 */
export function probeCfg(cfg = {}) {
  return {
    ...cfg,
    proxyHost: cfg.proxyHost ?? (process.env.TOR_SOCKS_HOST || "127.0.0.1"),
    proxyPort: cfg.proxyPort ?? +(process.env.TOR_SOCKS_PORT || 9050),
    // Same default as CFG below, from one place. These were separate literals
    // and had already diverged: the cron path waited 45 seconds while anything
    // going through this helper waited 30, so the same node could be up for one
    // caller and down for the other.
    timeoutMs: cfg.timeoutMs ?? +(process.env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    concurrency: cfg.concurrency ?? +(process.env.CONCURRENCY || DEFAULT_CONCURRENCY),
  };
}

/**
 * @param {string} url
 * @param {Partial<import("../types.js").ProbeCfg>} [cfgIn]
 * @returns {Promise<import("../types.js").ProbeResult>}
 */
export async function probe(url, cfgIn = CFG) {
  const cfg = probeCfg(cfgIn);
  // Preferred path: authenticated chain-tip check when an apikey is available.
  if (cfg.apikey) return probeHeight(url, cfg);
  const u = new URL(url);
  const host = u.hostname;
  const port = u.port ? +u.port : (u.protocol === "https:" ? 443 : 80);
  const reqPath = (u.pathname || "/") + (u.search || "");
  const t0 = Date.now();

  let socket;
  try {
    socket = await socks5Connect(cfg.proxyHost, cfg.proxyPort, host, port, cfg.timeoutMs);
  } catch (e) {
    return { up: false, reason: e.message, ms: Date.now() - t0 };
  }

  // TLS onions or connect-only mode: a successful Tor stream is the signal.
  if (cfg.connectOnly || u.protocol === "https:") {
    socket.destroy();
    return { up: true, reason: u.protocol === "https:" ? "tls-connect" : "connect", ms: Date.now() - t0 };
  }

  // Otherwise confirm the Dojo HTTP server actually answers.
  return await new Promise((resolve) => {
    let got = "";
    let settled = false;
    const finish = (up, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      // A code-less node has no apikey, so this is the only chance to read its
      // version; the header rides in the same first packet as the status line
      // often enough to be worth a look. Absent -> null, harmless.
      resolve({ up, reason, ms: Date.now() - t0, detectedVersion: parseDojoVersion(got, cfg.dojoVersionHeader) });
    };
    const timer = setTimeout(() => finish(got.length > 0, got ? "partial" : "read-timeout"), cfg.timeoutMs);

    socket.on("data", (d) => {
      got += d.toString("latin1");
      if (/^HTTP\//i.test(got)) finish(true, "http");
      // The same unbounded accumulation httpOverTor had, reached by a different
      // door. A well-behaved server puts its status line in the first packet
      // and the test above ends the read immediately, but a node that sends
      // anything NOT starting with "HTTP/" is never matched, so before this
      // guard `got` grew until the timeout with no ceiling at all. A status
      // line is a few dozen bytes; 64 KiB without one means this is not an HTTP
      // server, which is the answer the probe wanted anyway.
      else if (got.length > MAX_STATUS_LINE_BYTES) finish(false, "no-http-response");
    });
    socket.on("error", () => finish(got.length > 0, "socket-error"));
    socket.on("close", () => finish(got.length > 0, "closed"));

    socket.write(
      `HEAD ${reqPath} HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: dojobay-checker\r\nConnection: close\r\n\r\n`
    );
  });
}

// ---- date helpers (UTC, matching the formats already in the JSON) -----------
const p2 = (n) => String(n).padStart(2, "0");
function stamps(d = new Date()) {
  const Y = d.getUTCFullYear(), M = p2(d.getUTCMonth() + 1), D = p2(d.getUTCDate());
  const h = p2(d.getUTCHours()), m = p2(d.getUTCMinutes()), s = p2(d.getUTCSeconds());
  return {
    isoSec: `${Y}-${M}-${D}T${h}:${m}:${s}Z`,   // generated_at
    isoMin: `${Y}-${M}-${D}T${h}:${m}Z`,         // history check timestamp
    dateTime: `${Y}-${M}-${D} ${h}:${m}:${s}`,   // node.checked_at
  };
}

// ---- small concurrency pool -------------------------------------------------
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT" && fallback !== undefined) return fallback; throw e; }
}

// A temporary name no other writer can take.
//
// Every atomic write here was `<file>.tmp`, which is not atomic between
// processes: two writers produce the same path, the first rename consumes it,
// and the second fails with ENOENT on a file it had just written. That is not
// hypothetical. The installer enables the update timer and then runs its own
// first probe cycle, and once the timer gained a calendar schedule with
// Persistent=true, enabling it fired a catch-up run immediately rather than
// after two minutes. Two updaters wrote data/dojos.json.tmp at once and the
// install ended by announcing failures on a directory that was already
// updating.
//
// The pid and a counter are enough: the collision is between processes on one
// machine, and the rename is what makes the swap atomic for readers.
function tmpName(file) {
  return `${file}.${process.pid}.${(tmpSeq = (tmpSeq + 1) % 1e6)}.tmp`;
}
let tmpSeq = 0;

// Write atomically: a reader (the website) never sees a half-written file.
async function writeJSONAtomic(file, obj) {
  const tmp = tmpName(file);
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, file);
}

// Merge seed + approved submissions into the public list (delegates to
// server/build-public.mjs, which preserves live statuses and histories).
// Exported so the self-test can drive it against isolated data directories.
export async function reconcilePublicList() {
  if (!process.env.PUBLIC_DATA_DIR) process.env.PUBLIC_DATA_DIR = CFG.dataDir;
  const { rebuild } = await import("../server/build-public.ts");
  return rebuild();
}

// -----------------------------------------------------------------------------
async function main() {
  const dojosPath = path.join(CFG.dataDir, "dojos.json");
  // Reconcile FIRST: fold the curated seed and every APPROVED submission into
  // dojos.json before this cycle reads it. The admin approve does its own
  // rebuild, but that write is lost if it lands while a probe cycle (minutes
  // long over Tor) is in flight, because the cycle writes back the node list
  // it read at the start. Rebuilding here means an approved node can be absent
  // for at most one cycle, never indefinitely.
  try {
    const r = await reconcilePublicList();
    console.error(`[reconcile] ${r.msg}`);
  } catch (e) {
    console.error(`[reconcile] skipped: ${e.message}`);
  }
  const historyPath = path.join(CFG.dataDir, "history.json");

  const dojos = await readJSON(dojosPath);
  if (!dojos || !Array.isArray(dojos.nodes)) throw new Error(`bad or missing ${dojosPath}`);
  // Keep the self-hosted source download current: regenerate the zip when it
  // is missing or older than data/version.json (i.e. after any code deploy).
  try {
    const zipPath = path.join(CFG.dataDir, "dojobay-src.zip");
    const verPath = path.join(CFG.dataDir, "version.json");
    const zipSt = await fsStat(zipPath).catch(() => null);
    const verSt = await fsStat(verPath).catch(() => null);
    if (!zipSt || (verSt && verSt.mtimeMs > zipSt.mtimeMs)) {
      const { packSource } = await import("./pack-source.mjs");
      const r = await packSource({ outDir: CFG.dataDir });
      console.error(`[src-zip] repacked: ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KiB`);
    }
  } catch (e) { console.error(`[src-zip] skipped: ${e.message}`); }

  // Mirror PayNym avatars for every listed code (non-blocking for the probes).
  const operatorDoc = await readJSON(path.join(CFG.dataDir, "operator.json")).catch(() => null) ?? {};
  const avatarSubjects = dojos.nodes.concat(operatorDoc.paymentCode ? [{ paymentCode: operatorDoc.paymentCode }] : []);
  const avatarsDone = syncAvatars(avatarSubjects, path.join(CFG.dataDir, "avatars")).catch((e) => console.error("[avatar]", e.message));
  const history = await readJSON(historyPath, { interval_minutes: 10, window_checks: CFG.windowChecks, nodes: {} });
  const window = history.window_checks || CFG.windowChecks;

  const now = new Date();
  const ts = stamps(now);
  console.error(`[${ts.isoSec}] probing ${dojos.nodes.length} nodes via socks5h://${CFG.proxyHost}:${CFG.proxyPort} (timeout ${CFG.timeoutMs}ms, concurrency ${CFG.concurrency})`);

  const results = await pool(dojos.nodes, CFG.concurrency, async (n) => {
    const url = n?.payload?.pairing?.url;
    if (!url) return { up: false, reason: "no pairing url", ms: 0 };
    return probe(url, { ...CFG, apikey: n?.payload?.pairing?.apikey, network: n.network });
  });

  // ---- did this cycle learn anything? ----
  //
  // Fifteen independently operated nodes on different continents do not fail in
  // the same ten-minute window. When every one of them fails, the cause is here:
  // Tor rebuilding circuits after a suspend, a home connection renegotiating,
  // the daemon restarted underneath us. Recording that would write a DOWN check
  // against every operator in the directory and pull down reliability figures
  // this instance publishes about other people's machines, for a fault of its
  // own. So it is not recorded.
  //
  // The threshold is zero rather than a proportion. A cycle where some nodes
  // answer proves the local path works, and the ones that did not answer really
  // did not; only a clean sweep is evidence about this machine instead of about
  // them. A directory with one listing would trip this on a genuine outage, and
  // that is the right trade: withholding one node's bad cycle costs far less
  // than publishing a false one against everybody.
  const allFailed = dojos.nodes.length > 0 && results.every((r) => !r.up);

  // ---- update current snapshot ----
  let up = 0;
  dojos.nodes.forEach((n, i) => {
    const r = results[i];
    if (r.up) up++;
    n.status = r.up ? "active" : "inactive";
    n.checked_at = ts.dateTime;
    // Record the tip height when we read one; keep the last known height on a
    // down cycle so the card can still show where the node last was.
    if (typeof r.height === "number") n.block_height = r.height;
    else if (!("block_height" in n)) n.block_height = null;
    // Same sticky rule for the version read from X-Dojo-Version: update it when
    // this cycle saw one, otherwise leave the last known value in place. The
    // effective card version (operator override > detected > pairing default)
    // is computed by build-public.mjs, which carries this field across the
    // reconcile rebuild that opens every cycle.
    if (r.detectedVersion) n.detected_version = r.detectedVersion;
    else if (!("detected_version" in n)) n.detected_version = null;
    // Same sticky rule for the Electrum endpoint read from /support/services:
    // keep the last known value when a cycle didn't read one, so a node that is
    // merely down for a cycle doesn't flip its card to N/A. build-public.mjs
    // computes the published value and carries this field across the rebuild.
    if (r.detectedIndexer) n.detected_indexer = r.detectedIndexer;
    else if (!("detected_indexer" in n)) n.detected_indexer = null;
  });
  dojos.interval_minutes = dojos.interval_minutes || 10;

  if (allFailed) {
    // Publish the fault and nothing else. Statuses, heights and checked_at stay
    // as the last cycle that actually reached something left them, and
    // generated_at is deliberately not advanced, so the staleness banner keeps
    // measuring the age of real data rather than the age of a failure.
    const fresh = await readJSON(dojosPath, null);
    if (fresh) {
      fresh.probe_fault = { at: ts.isoSec, nodes: dojos.nodes.length };
      await writeJSONAtomic(dojosPath, fresh);
    }
    console.error(`[${ts.isoSec}] every one of ${dojos.nodes.length} nodes failed, which is`
      + " almost certainly a fault here rather than all of them at once.");
    console.error("  Nothing was recorded: no statuses changed and no history written.");
    console.error("  Check Tor on this machine (systemctl status tor@default), and the clock.");
    return;
  }
  dojos.generated_at = ts.isoSec;
  delete dojos.probe_fault;

  // ---- update rolling history (append + trim, retire stale ids) ----
  const listed = new Set(dojos.nodes.map((n) => n.id));
  const histNodes = {};
  dojos.nodes.forEach((n, i) => {
    const prev = (history.nodes?.[n.id]?.checks) || [];
    const checks = prev.concat([{ t: ts.isoMin, up: results[i].up }]);
    if (checks.length > window) checks.splice(0, checks.length - window);
    histNodes[n.id] = { checks };
  });
  // Unlisted ids are kept under a `retired` stamp for HISTORY_GRACE_DAYS (same
  // rule as build-public.mjs), so a bad or transient node list cannot destroy
  // accumulated history; a resurrected id resumes where it left off.
  for (const id of Object.keys(history.nodes || {})) if (!histNodes[id]) histNodes[id] = history.nodes[id];
  retireUnlisted(histNodes, (id) => listed.has(id), ts.isoSec);

  await writeJSONAtomic(dojosPath, dojos);
  await writeJSONAtomic(historyPath, {
    generated_at: ts.isoSec,
    interval_minutes: history.interval_minutes || 10,
    window_checks: window,
    nodes: histNodes,
  });

  // ---- update 90-day daily rollup (per-day uptime + closing block height) ----
  // One record per node per UTC day; `close` is the last height read that day,
  // so at day's end it holds the closing height. Retained RETENTION_DAYS days.
  const dailyPath = path.join(CFG.dataDir, "history-daily.json");
  const daily = await readJSON(dailyPath, { retention_days: CFG.retentionDays, nodes: {} });
  const today = ts.dateTime.slice(0, 10); // YYYY-MM-DD (UTC)
  const dailyNodes = {};
  dojos.nodes.forEach((n, i) => {
    const r = results[i];
    const days = ((daily.nodes?.[n.id]?.days) || []).map((d) => ({ ...d }));
    let rec = days.length && days[days.length - 1].d === today ? days[days.length - 1] : null;
    if (!rec) { rec = { d: today, up: 0, total: 0, pct: 0, close: null }; days.push(rec); }
    rec.total += 1;
    if (r.up) rec.up += 1;
    rec.pct = Math.round((rec.up / rec.total) * 1000) / 10;
    if (typeof r.height === "number") rec.close = r.height;
    if (days.length > CFG.retentionDays) days.splice(0, days.length - CFG.retentionDays);
    dailyNodes[n.id] = { days };
  });
  for (const id of Object.keys(daily.nodes || {})) if (!dailyNodes[id]) dailyNodes[id] = daily.nodes[id];
  retireUnlisted(dailyNodes, (id) => listed.has(id), ts.isoSec);
  await writeJSONAtomic(dailyPath, {
    generated_at: ts.isoSec,
    retention_days: CFG.retentionDays,
    nodes: dailyNodes,
  });

  // ---- probe PENDING submissions so the operator sees uptime before approving
  // Results are written server-side only (server/data/pending-probe.json), never
  // to the public data/, so an unapproved submission is not exposed over Tor.
  try {
    const { store } = await import("../server/store.ts");
    const serverDataDir = process.env.SERVER_DATA_DIR
      || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "data");
    const pendingPath = path.join(serverDataDir, "pending-probe.json");
    const subs = (await store.listSubmissions()).filter((s) => s.status === "pending");
    if (subs.length) {
      const prevDoc = await readJSON(pendingPath, { window_checks: window, nodes: {} });
      const presults = await pool(subs, CFG.concurrency, async (s) => {
        const url = s?.payload?.pairing?.url;
        if (!url) return { up: false, reason: "no pairing url", ms: 0 };
        return probe(url, { ...CFG, apikey: s?.payload?.pairing?.apikey, network: s.network });
      });
      const pnodes = {};
      subs.forEach((s, i) => {
        const r = presults[i];
        const prev = (prevDoc.nodes?.[s.id]?.checks) || [];
        const checks = prev.concat([{ t: ts.isoMin, up: r.up }]);
        if (checks.length > window) checks.splice(0, checks.length - window);
        pnodes[s.id] = {
          status: r.up ? "active" : "inactive",
          checked_at: ts.dateTime,
          block_height: typeof r.height === "number" ? r.height
            : (prevDoc.nodes?.[s.id]?.block_height ?? null),
          detected_version: r.detectedVersion || (prevDoc.nodes?.[s.id]?.detected_version ?? null),
          detected_indexer: r.detectedIndexer || (prevDoc.nodes?.[s.id]?.detected_indexer ?? null),
          checks,
        };
      });
      await writeJSONAtomic(pendingPath, { generated_at: ts.isoSec, window_checks: window, nodes: pnodes });
      console.error(`[${ts.isoSec}] probed ${subs.length} pending submission(s)`);
    }
  } catch (e) {
    console.error(`[${ts.isoSec}] pending probe skipped: ${e.message}`);
  }

  console.error(`[${ts.isoSec}] done: ${up}/${dojos.nodes.length} active`);
  for (const [i, n] of dojos.nodes.entries()) {
    const r = results[i];
    console.error(`  ${r.up ? "UP  " : "DOWN"} ${n.id.padEnd(28)} ${String(r.ms).padStart(6)}ms  ${r.reason || ""}`);
  }
  await avatarsDone;   // let in-flight avatar mirrors finish before the timer unit exits
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}
