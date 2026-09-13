// PayNym.rs lookup. paynym.rs runs the same API the historical Samourai server
// exposed, and offers both a clearnet host and a Tor onion. We prefer the onion
// (the box already has a SOCKS proxy for the connection gate, and it keeps the
// lookup inside Tor), falling back to clearnet.
//
// The call is POST {base}/api/v1/nym  body {"nym": "<payment code>"} and the
// response carries the registered nym label. This resolution is ALWAYS
// best-effort: any failure returns null and callers must carry on, because a
// paynym.rs outage must never block a submission or an approval.
import { socks5Connect, PROBE_CFG } from "./probe.mjs";

// Override via env if the onion address changes.
const PAYNYM_ONION = process.env.PAYNYM_ONION
  || "http://paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad.onion";
const PAYNYM_CLEARNET = process.env.PAYNYM_CLEARNET || "https://paynym.rs";

// Pull the human label out of whatever shape the API returns. The legacy API
// nests it under codes[].claimed / nymName; we probe a few known keys so a
// minor schema change degrades to "not found" rather than a wrong value.
function extractNym(obj) {
  if (!obj || typeof obj !== "object") return null;
  const direct = obj.nymName || obj.nym_name || obj.nym;
  if (typeof direct === "string" && direct.length) return direct;
  if (Array.isArray(obj.codes) && obj.codes[0] && typeof obj.codes[0].claimed === "string") return obj.codes[0].claimed;
  return null;
}

// Minimal HTTP POST over a SOCKS5 stream (onion), reading the JSON body.
function postOverTor(onionUrl, path, jsonBody, timeoutMs) {
  return new Promise(async (resolve) => {
    let socket;
    try {
      const u = new URL(onionUrl);
      socket = await socks5Connect(PROBE_CFG.proxyHost, PROBE_CFG.proxyPort, u.hostname, +(u.port || 80), timeoutMs);
    } catch { return resolve(null); }
    const body = Buffer.from(JSON.stringify(jsonBody), "utf8");
    const host = new URL(onionUrl).hostname;
    const req =
      `POST ${path} HTTP/1.0\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    let buf = "";
    const done = (v) => { try { socket.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on("data", (d) => { buf += d.toString("utf8"); });
    socket.on("close", () => {
      clearTimeout(timer);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return resolve(null);
      try { resolve(JSON.parse(buf.slice(i + 4))); } catch { resolve(null); }
    });
    socket.on("error", () => done(null));
    socket.write(req + body.toString("utf8"));
  });
}

async function postClearnet(base, paymentCode, timeoutMs) {
  if (typeof fetch !== "function") return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(base + "/api/v1/nym", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nym: paymentCode }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Fetch the raw nym document (codes[], nymName, ...) for a handle or payment
// code, Tor first. Returns the parsed object or null. Never throws.
export async function fetchNymInfo(nymOrCode, { timeoutMs = 20000, preferTor = true } = {}) {
  if (!nymOrCode) return null;
  let obj = null;
  if (preferTor) obj = await postOverTor(PAYNYM_ONION, "/api/v1/nym", { nym: nymOrCode }, timeoutMs);
  if (!obj) obj = await postClearnet(PAYNYM_CLEARNET, nymOrCode, timeoutMs);
  return obj && typeof obj === "object" ? obj : null;
}

// Every BIP47 code variant registered for a PayNym (segwit + legacy), because
// the wallet may sign Auth47 with either. [] when unresolvable.
export async function fetchNymCodes(nymOrCode, opts) {
  const info = await fetchNymInfo(nymOrCode, opts);
  return Array.isArray(info?.codes) ? info.codes.filter((c) => c && typeof c.code === "string") : [];
}

// Resolve a payment code to its registered PayNym label, or null. Never throws.
export async function resolvePayNym(paymentCode, opts) {
  const name = extractNym(await fetchNymInfo(paymentCode, opts));
  if (!name) return null;
  return name.startsWith("+") ? name : "+" + name;
}
