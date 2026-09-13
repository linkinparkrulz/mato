#!/usr/bin/env node
// The Dojo Bay — self-service submission backend (step 2 feature).
//
// Auth47 login, then a gated "manage my Dojo" API. Two hard gates on any create
// or pairing-changing edit:
//   1. connection gate: the pairing code's .onion must currently answer over Tor
//   2. signature gate:  a signed pairing payload is required, and must verify
//      against the notification address of the authenticated payment code (lab
//      logic). The store refuses an unsigned record too, so this gate is where
//      an operator is told what to do, not the only thing standing in the way.
// Passing both puts the record in a moderation queue; a maintainer approves it
// (see admin.mjs) before build-public.mjs merges it into the public dojos.json.
//
// Runs behind nginx on 127.0.0.1. No passwords, no external database.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StoreRecord } from "../types.js";

/** A route handler. Registered against a method and a path pattern. */
type Handler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;
import { randomBytes } from "node:crypto";
import { store } from "./store.ts";
import { makeAuth47, notificationAddresses, verifySignedPayload, repairSignedBlock, canonicalPairing } from "./crypto.ts";
import osMod from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import { probe, PROBE_CFG } from "./probe.mjs";
import { checkUpdates, updateCacheDecision } from "./updates.mjs";
import { judgeVersion, MIN_DOJO_VERSION, pairingNetwork, countryFor } from "./dojo-version.ts";
import {
  normaliseDomain, txtName, txtHost, txtValue, signingText, verifyClaim,
  recheckClaim, applyRecheck, isDue, urlOnDomain, GRACE_DAYS,
} from "./domains.ts";
import { resolvePayNym } from "./paynym.mjs";
import { rebuild } from "./build-public.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = +(process.env.PORT || 8787);
// The public origin of the site (its .onion), needed for the Auth47 callback + resource.
const BASE_URL = process.env.BASE_URL || "http://localhost";
const NONCE_TTL = 5 * 60 * 1000;      // Auth47 nonces valid 5 minutes
const SESSION_TTL = 12 * 60 * 60 * 1000;

// BIP47 payment codes permitted to moderate at /admin. Per-operator config, set
// in the systemd unit (Environment=ADMIN_PAYMENT_CODES=...); never hard-coded,
// so a fork's operator sets their own.
const ADMIN_CODES = (process.env.ADMIN_PAYMENT_CODES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const isAdmin = (pc) => !!pc && ADMIN_CODES.includes(pc);

const SERVER_DATA = process.env.SERVER_DATA_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
// The published view of a node, for the admin panel. A pending submission is
// probed separately into pending-probe.json, but once it is APPROVED the
// updater stops writing there and its live status, chain tip and 24-hour checks
// live in the published files instead. Reading only the pending file therefore
// left every approved listing saying "not yet probed" with a reliability strip
// frozen at whatever it had when it was approved.
async function publishedView() {
  const dir = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");
  const read = async (name, fallback) => {
    try { return JSON.parse(await readFile(path.join(dir, name), "utf8")); }
    catch { return fallback; }
  };
  const [dojos, hist] = await Promise.all([
    read("dojos.json", { nodes: [] }),
    read("history.json", { nodes: {} }),
  ]);
  const byId = new Map();
  for (const n of dojos.nodes || []) {
    byId.set(n.id, {
      status: n.status || null,
      checked_at: n.checked_at || null,
      block_height: n.block_height ?? null,
      detected_version: n.detected_version || null,
      checks: (hist.nodes?.[n.id]?.checks) || [],
    });
  }
  return byId;
}

async function pendingProbe() {
  try { return JSON.parse(await readFile(path.join(SERVER_DATA, "pending-probe.json"), "utf8")); }
  catch { return { nodes: {} }; }
}

const auth47 = makeAuth47(BASE_URL);

// ---- helpers ---------------------------------------------------------------
const json = (res: ServerResponse, code: number, obj: unknown) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};
const readBody = (req: IncomingMessage, limit = 64 * 1024) => new Promise<string>((resolve, reject) => {
  let data = ""; let size = 0;
  req.on("data", (c: Buffer | string) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else data += c; });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});
function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}; const h = req.headers.cookie || "";
  h.split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
async function sessionFrom(req) {
  const sid = parseCookies(req).dojobay_sid;
  return sid ? await store.getSession(sid) : null;
}
function networkOf(rec) { return rec === "testnet" ? "testnet" : "bitcoin"; }

// Ownership: a record is owned by whoever holds ANY of its payment codes,
// because a PayNym commonly has two BIP47 codes (segwit + legacy) and the
// wallet may sign Auth47 with either variant.
const owns = (rec, pc) => !!rec && Array.isArray(rec.paymentCodes) && rec.paymentCodes.includes(pc);

// Node names: operator-chosen, unique per network. The slug both keys the
// record (`${network}-${slug}`) and enforces case/punctuation-insensitive
// uniqueness of the display name.
// Signed pairing blocks arrive by clipboard, which is where stray bytes creep
// in: CRLF line endings, zero-width characters, non-breaking spaces. Wallets
// emit LF-only ASCII, so stripping these BEFORE signature verification keeps a
// mangled paste verifiable while never altering what the wallet actually
// signed. Applied at intake only; stored and emitted bytes are then clean.
const cleanSigned = (v) => {
  const t = String(v || "").replace(/\r/g, "").replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\u00a0/g, " ").trim();
  return t || null;
};

const slugify = (name) => String(name || "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// Curated seed nodes are not in the store but still occupy the same public
// namespace, so a submission may not take a seed node's name or id.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function seedNodes() {
  const p = path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "seed.json");
  try { return JSON.parse(await readFile(p, "utf8")).nodes || []; } catch { return []; }
}

// Is `slug` free on `network` for the holder of `pc`? Returns null when free
// or when it names a record the caller already owns (an update), otherwise a
// human-readable reason. Checks every store record regardless of status plus
// the curated seed, so a rejected or pending record cannot be hijacked either.
async function nameConflict(network, slug, pc) {
  for (const r of await store.listSubmissions()) {
    if (r.network !== network) continue;
    if (slugify(r.name) !== slug && r.id !== `${network}-${slug}`) continue;
    if (!owns(r, pc)) return `the name is already used by another operator's ${r.status} record`;
  }
  for (const n of await seedNodes()) {
    if (n.network !== network) continue;
    if (slugify(n.name) === slug || n.id === `${network}-${slug}`) return "the name is reserved by a curated seed node";
  }
  return null;
}

// The record an owner's (network, slug) submission should update, if any.
async function ownedRecordFor(network, slug, pc) {
  for (const r of await store.listSubmissions()) {
    if (r.network === network && owns(r, pc)
        && (slugify(r.name) === slug || r.id === `${network}-${slug}`)) return r;
  }
  return null;
}

// Manage-panel ordering: mainnet before testnet, then alphabetical by name.
const submissionOrder = (a, b) =>
  a.network !== b.network
    ? (a.network === "mainnet" ? -1 : 1)
    : String(a.name || a.id).localeCompare(String(b.name || b.id), "en", { sensitivity: "base" });
const isPlainOnionUrl = (u) => { try { const x = new URL(u); return x.protocol === "http:" && /\.onion$/.test(x.hostname); } catch { return false; } };

function validatePayload(payload, network = null) {
  if (!payload || typeof payload !== "object") return "missing pairing payload";
  const p = payload.pairing;
  if (!p || p.type !== "dojo.api" || !p.url) return "pairing.type must be dojo.api with a url";
  if (!isPlainOnionUrl(p.url)) return "pairing.url must be an http .onion address";
  if (payload.explorer && !isPlainOnionUrl(payload.explorer.url)) return "explorer.url must be an http .onion address";
  // The endpoint must be for the network the listing claims. See pairingNetwork
  // for why a crossed pair is worth refusing: it probes green forever and the
  // only symptom is a block height nobody reads as an error. Network omitted,
  // the URL is not judged, which keeps this usable where the network is not yet
  // known.
  if (network) {
    const looks = pairingNetwork(p.url);
    if (looks && looks !== network) {
      return network === "testnet"
        ? "this is a mainnet endpoint: a testnet Dojo serves http://<onion>/test/v2. "
          + "Either paste your testnet pairing payload or list it as mainnet."
        : "this is a testnet endpoint: a mainnet Dojo serves http://<onion>/v2. "
          + "Either paste your mainnet pairing payload or list it as testnet.";
    }
  }
  return null;
}

// ---- routes ----------------------------------------------------------------
const routes: { method: string; re: RegExp; fn: Handler }[] = [];
const route = (method: string, re: RegExp, fn: Handler) => routes.push({ method, re, fn });

// 1) begin login: mint nonce + challenge URI (QR-encoded client-side)
route("POST", /^\/api\/auth47\/challenge$/, async (req, res) => {
  await store.gcNonces();
  const nonce = randomBytes(16).toString("hex");            // 32 alphanumeric chars
  const expires = Date.now() + NONCE_TTL;
  const uri = auth47.challengeURI(nonce, Math.floor(expires / 1000), BASE_URL);
  await store.putNonce(nonce, { expires, used: false, sid: null });
  json(res, 200, { nonce, uri, expires });
});

// 2) wallet callback: verify proof, bind nonce -> payment code
// The update check's answer, cached in the process. Declared here rather than
// beside the route that fills it, because the login below clears it and a const
// used before its declaration is a trap waiting for someone to reorder a file.
let UPDATES_CACHE = null;
// When a forced check last actually went out, and the shortest gap between two
// of them. Declared beside the cache they qualify, and above their first use:
// a const read by code that runs before its declaration has failed outright
// here before.
let FORCED_UPDATE_AT = 0;
const FORCED_UPDATE_FLOOR = 60 * 1000;

route("POST", /^\/api\/auth47\/callback$/, async (req, res) => {
  let proof;
  try { proof = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  // BASE_URL is what challengeURI put in the r parameter, so it is what the
  // proof must name. See makeAuth47.verify for what this stops.
  const v = auth47.verify(proof, { expectedResource: BASE_URL });
  if (!v.ok) return json(res, 401, { error: v.error });
  // tie proof back to a live nonce (prevents replay to a different session)
  let nonce = null;
  try { nonce = new URL(proof.challenge).hostname; } catch {}
  const rec = nonce ? await store.takeNonce(nonce) : null;
  if (!rec) return json(res, 401, { error: "unknown or expired nonce" });
  if (rec.expires < Date.now()) return json(res, 401, { error: "challenge expired" });
  const sid = await store.putSession({ paymentCode: v.paymentCode, expires: Date.now() + SESSION_TTL });
  // Signing in is the moment somebody is about to look at the console, so it is
  // the moment to stop answering from a six-hour-old cache. Without this an
  // operator who pushed a commit twenty minutes ago is told they are up to date
  // and has no way to say otherwise: signing out and back in did not help,
  // because the cache lives in the process rather than the session, and only a
  // service restart cleared it. Discarding it here costs one request over Tor
  // per login and removes the whole confusion.
  UPDATES_CACHE = null;
  // stash the sid against the nonce value so the browser poll can pick it up
  await store.putNonce("claimed:" + nonce, { expires: Date.now() + NONCE_TTL, sid });
  json(res, 200, { ok: true });
});

// 3) browser poll: has my nonce been claimed? if so, set the session cookie
route("GET", /^\/api\/auth47\/poll$/, async (req, res) => {
  const u = new URL(req.url, "http://x");
  const nonce = u.searchParams.get("nonce") || "";
  const claim = await store.takeNonce("claimed:" + nonce);
  if (!claim) return json(res, 200, { authenticated: false });
  res.setHeader("Set-Cookie",
    `dojobay_sid=${claim.sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
  json(res, 200, { authenticated: true });
});

// 4) who am I
route("GET", /^\/api\/me$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 200, { authenticated: false });
  const mine = (await store.submissionsFor(s.paymentCode)).sort(submissionOrder);
  json(res, 200, { authenticated: true, paymentCode: s.paymentCode, admin: isAdmin(s.paymentCode), submissions: mine });
});

// ---- admin (moderation) ----------------------------------------------------
// All require an authenticated session whose payment code is in ADMIN_CODES.
async function adminFrom(req, res) {
  const s = await sessionFrom(req);
  if (!s) { json(res, 401, { error: "not authenticated" }); return null; }
  if (!isAdmin(s.paymentCode)) { json(res, 403, { error: "not authorised" }); return null; }
  return s;
}

// list submissions with their pending-probe status + reliability history
route("GET", /^\/api\/admin\/submissions$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  const probes = (await pendingProbe()).nodes || {};
  const live = await publishedView();
  const subs = (await store.listSubmissions()).map((s) => ({
    id: s.id, network: s.network, status: s.status, name: s.name || null,
    paynym: s.paynym || null, paymentCodes: s.paymentCodes,
    jurisdiction: s.jurisdiction || null, country: s.country || null,
    hardware: s.hardware || null, signed: !!s.signed,
    version: (live.get(s.id)?.detected_version) || (probes[s.id] && probes[s.id].detected_version)
      || s.payload?.pairing?.version || null,
    pairingUrl: s.payload?.pairing?.url || null,
    created_at: s.created_at || null, updated_at: s.updated_at || null,
    // Prefer the published view: it is what the card shows and it keeps being
    // updated. Fall back to the pending probe for a record not yet approved.
    probe: live.get(s.id) || probes[s.id] || null,   // { status, checked_at, block_height, checks[] }
    probe_source: live.has(s.id) ? "published" : (probes[s.id] ? "pending" : null),
  }));
  json(res, 200, { admin: true, submissions: subs });
});

// The store change (approve/reject/remove) is committed before the public list
// is rebuilt, so a rebuild failure must be REPORTED, not thrown as a 500 that
// hides which half happened: the moderation applied but publication did not.
// The updater re-runs the rebuild at the start of every 10-minute cycle, so a
// failed publish heals itself; the error here tells the admin why it deferred.
async function tryRebuild() {
  try { return await rebuild(); }
  catch (e) { return { error: e.message, msg: "rebuild failed: " + e.message + " (the updater retries every 10 minutes)" }; }
}

route("POST", /^\/api\/admin\/approve$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec) return json(res, 404, { error: "not found" });
  rec.status = "approved";
  rec.updated_at = new Date().toISOString();
  if (body.paynym) rec.paynym = body.paynym.startsWith("+") ? body.paynym : "+" + body.paynym;
  else if (!rec.paynym) { const r = await resolvePayNym(rec.paymentCodes[0]).catch(() => null); if (r) rec.paynym = r; }
  // Mirror the operator's PayNym avatar now rather than waiting a cycle; the
  // updater retries missing ones every ten minutes, so failure here is fine.
  import("../scripts/update.mjs").then(({ fetchAvatar }) => Promise.all(
    rec.paymentCodes.map((c) => fetchAvatar(c, {
      proxyHost: PROBE_CFG.proxyHost, proxyPort: PROBE_CFG.proxyPort,
      destDir: path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "avatars"),
    }).catch(() => {}))
  )).catch(() => {});
  await store.putSubmission(rec);
  const out = await tryRebuild();
  json(res, 200, { ok: true, submission: rec, rebuild: out });
});

route("POST", /^\/api\/admin\/reject$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec) return json(res, 404, { error: "not found" });
  rec.status = "rejected";
  rec.updated_at = new Date().toISOString();
  await store.putSubmission(rec);
  const out = await tryRebuild();   // drops it from the public list if it was approved
  json(res, 200, { ok: true, rebuild: out });
});

route("POST", /^\/api\/admin\/remove$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  await store.deleteSubmission(body.id);
  const out = await tryRebuild();
  json(res, 200, { ok: true, rebuild: out });
});

// 5) logout
route("POST", /^\/api\/logout$/, async (req, res) => {
  const sid = parseCookies(req).dojobay_sid;
  if (sid) await store.dropSession(sid);
  res.setHeader("Set-Cookie", "dojobay_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  json(res, 200, { ok: true });
});

// 6) is a node name free on a network? (pre-flight for the submission form;
//    the POST below re-checks and is the authority)
route("GET", /^\/api\/dojo\/name-check$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  const u = new URL(req.url, "http://x");
  const network = u.searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
  const slug = slugify(u.searchParams.get("name"));
  if (!slug) return json(res, 400, { error: "name must contain at least one letter or digit" });
  const conflict = await nameConflict(network, slug, s.paymentCode);
  const mine = conflict ? null : await ownedRecordFor(network, slug, s.paymentCode);
  json(res, 200, { available: !conflict, reason: conflict, slug, update: !!mine, id: mine ? mine.id : `${network}-${slug}` });
});

// 7) create or replace one of my Dojo records (keyed by network + node name)
route("POST", /^\/api\/dojo$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }

  const network: "mainnet" | "testnet" | null = body.network === "testnet" ? "testnet" : (body.network === "mainnet" ? "mainnet" : null);
  if (!network) return json(res, 400, { error: "network must be mainnet or testnet" });

  const name = String(body.name || "").trim().slice(0, 40);
  const slug = slugify(name);
  if (!slug) return json(res, 400, { error: "name is required (letters, digits and hyphens)" });
  const conflict = await nameConflict(network, slug, s.paymentCode);
  if (conflict) return json(res, 409, { error: `name "${name}" is taken on ${network}: ${conflict}` });

  const payloadErr = validatePayload(body.payload, network);
  if (payloadErr) return json(res, 400, { error: payloadErr });

  body.signed = cleanSigned(body.signed);
  // signature gate. The signed block is REQUIRED: it is the only part of a
  // listing a visitor can check without trusting this site, so a listing
  // without one asks for trust we have no way to earn. Refused here rather than
  // at the store so the operator is told what to do about it while they still
  // have the form open, and before the connection gate spends thirty seconds
  // probing a node whose submission cannot be accepted anyway.
  if (!body.signed) {
    return json(res, 400, { error: "signature gate: paste the signed pairing block. " +
      "Sign the exact pairing text shown above in your wallet under PayNym → Sign message, " +
      "then paste the whole block, headers included." });
  }
  {
    // Operators paste this into a web form, which eats whitespace as readily as
    // a chat window does — and the signature covers the blank line before the
    // BIP47 line. Repair that before judging, so a correct signature is not
    // reported as invalid. A reconstruction is only accepted when it verifies
    // against an address the declared code derives, and the repaired block is
    // what gets stored, so a later audit verifies too.
    const repaired = repairSignedBlock(body.signed);
    if (repaired) body.signed = repaired.block;

    const sig = verifySignedPayload({
      signedText: body.signed,
      expectedMessage: canonicalPairing(body.payload),
      // A PayNym signs from its mainnet notification address even when the
      // node being listed is testnet, so accept either derivation.
      expectedAddress: notificationAddresses(s.paymentCode),
      network: networkOf(network),
    });
    if (!sig.ok) return json(res, 400, { error: "signature gate: " + sig.error });
  }

  // connection gate: the node must answer right now over Tor. When the pairing
  // payload carries an apikey (it should), this performs the same authenticated
  // chain-tip read the health checker uses, so a submission must prove its
  // apikey works and the Dojo is serving block data, not merely that the onion
  // is reachable. Without an apikey it falls back to a plain reachability probe.
  const check = await probe(body.payload.pairing.url, { ...PROBE_CFG, apikey: body.payload.pairing.apikey, network });
  if (!check.up) return json(res, 422, { error: "connection gate: node unreachable or not serving block data over Tor (" + (check.reason || "no response") + ")", probe: check });

  // An owned record with this name (or this id, for records that predate
  // operator naming) is updated in place, keeping its id and therefore its
  // reliability history; otherwise a new record is created at network-slug.
  const existing = await ownedRecordFor(network, slug, s.paymentCode);

  // Minimum Dojo version, on REGISTRATION only.
  //
  // Judged on what the node just told us in its X-Dojo-Version header rather
  // than on the version inside the payload: that field is frozen when the
  // payload is generated and can be years stale, so a current node can declare
  // an ancient version quite honestly.
  //
  // Existing operators are not re-judged. An operator updating a listing they
  // already hold — a moved onion, a rotated key — is not registering, and
  // trapping them behind a rule introduced after they joined would punish them
  // for maintaining their node. New listings only.
  if (!existing) {
    const v = judgeVersion(check.detectedVersion, body.payload?.pairing?.version, MIN_DOJO_VERSION);
    if (!v.ok) {
      return json(res, 422, {
        error: "version gate: " + v.reason,
        minimum: MIN_DOJO_VERSION,
        detected: check.detectedVersion || null,
      });
    }
  }

  const id = existing ? existing.id : `${network}-${slug}`;
  const now = new Date().toISOString();
  // Resolve the registered PayNym from paynym.rs (best-effort, over Tor). Keep a
  // previously resolved value if the lookup is momentarily unavailable.
  const resolvedNym = await resolvePayNym(s.paymentCode).catch(() => null);
  const rec: StoreRecord = {
    id, network, name,
    // Union with any codes already on the record, so a record migrated with
    // both PayNym variants keeps them when the operator edits via either.
    paymentCodes: [...new Set([...(existing?.paymentCodes || []), s.paymentCode])],
    paynym: resolvedNym || (existing && existing.paynym) || null,
    jurisdiction: (body.jurisdiction || "").toString().slice(0, 64) || null,
    // Inferred from what the operator wrote about where they are, never asked
    // for separately. It used to be its own field, sliced to two characters and
    // upper-cased, which rejected nothing: "FIN" silently became "FI" and was
    // published as whichever country those letters name, while a single letter
    // or half a pasted flag emoji were stored as given and rendered on a card
    // as letterboxes. Now there is one question, no validation, and a flag when
    // the answer happens to name somewhere.
    //
    // An existing code survives an edit that no longer implies one, so nobody
    // loses a flag they already had by rewording their location.
    country: countryFor(body.jurisdiction) || (existing && existing.country) || null,
    hardware: (body.hardware || "").toString().slice(0, 120) || null,
    // Exactly the two keys the signature covers. A Dojo export may carry more
    // (an indexer block, a services[] array); none of it is signed, and the
    // published payload is what a visitor pairs with, so it stores nothing it
    // cannot attest to. The Electrum endpoint on a card comes from probing
    // /support/services instead.
    payload: { pairing: body.payload.pairing, explorer: body.payload.explorer },
    signed: body.signed || null,
    // A link supplied here is set; left blank, any existing link is kept (the
    // Edit panel, where the field is prefilled, is the place to clear it).
    status: "pending",                         // moderation state: pending | approved | rejected
    last_probe: check,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
  };
  await store.putSubmission(rec);
  json(res, 200, { ok: true, submission: rec, note: "Submitted for review. It will appear once a maintainer approves it." });
});

// Editable metadata: name and hardware. The Dojo version is NOT editable it is
// read live from the node's X-Dojo-Version response header by the updater (see
// scripts/update.mjs), so it always reflects what the node is actually running.
// These are display fields, so an edit keeps the record's moderation status and
// its id (and therefore its history); only a full resubmission re-enters
// moderation. A rename must not collide with ANY other record's name on that
// network, including the editor's own other records, hence the excludeId scan.
async function slugTakenByOther(network, slug, excludeId) {
  for (const r of await store.listSubmissions()) {
    if (r.id === excludeId || r.network !== network) continue;
    if (slugify(r.name) === slug || r.id === `${network}-${slug}`) {
      return `the name is already used by ${r.paynym || "another"}'s ${r.status} record`;
    }
  }
  for (const n of await seedNodes()) {
    if (n.network !== network || n.id === excludeId) continue;
    if (slugify(n.name) === slug || n.id === `${network}-${slug}`) return "the name is reserved by a curated seed node";
  }
  return null;
}

async function applyEdit(rec, body, res) {
  const name = String(body.name || "").trim().slice(0, 40);
  const slug = slugify(name);
  if (!slug) return json(res, 400, { error: "name is required (letters, digits and hyphens)" });
  const taken = await slugTakenByOther(rec.network, slug, rec.id);
  if (taken) return json(res, 409, { error: `name "${name}" is taken on ${rec.network}: ${taken}` });
  rec.name = name;
  rec.hardware = String(body.hardware || "").trim().slice(0, 120) || null;
  rec.updated_at = new Date().toISOString();
  await store.putSubmission(rec);
  const out = rec.status === "approved" ? await tryRebuild() : null;   // approved edits publish immediately
  json(res, 200, { ok: true, submission: rec, rebuild: out });
}

// 9) edit display fields on one of my records
route("POST", /^\/api\/dojo\/edit$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec || !owns(rec, s.paymentCode)) return json(res, 404, { error: "not found" });
  await applyEdit(rec, body, res);
});

// 9b) update the pairing details of a record you already own.
//
// The onion of a Dojo can change, an apikey can be rotated, an operator can
// start exposing an Electrum indexer. None of that changes WHO runs the node,
// and approval here binds to the payment code rather than to a particular
// address: a maintainer approving a listing is approving the operator, and
// leaves visitors to judge the node. So a pairing update keeps the record's
// moderation status, its id and therefore its reliability history, and only
// ever writes the payload and its signature.
//
// The same gates as a submission still apply, because they protect the reader
// rather than gatekeep the operator: the payload must be well-formed, the new
// onion must answer over Tor right now (which catches a mistyped address before
// it replaces a working one), and a signature, if supplied, must verify against
// the payment code signed in.
route("POST", /^\/api\/dojo\/pairing$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }

  const rec = await store.getSubmission(body.id);
  if (!rec || !owns(rec, s.paymentCode)) return json(res, 404, { error: "not found" });

  // Taken from the RECORD, not from the request: an edit cannot change which
  // network a listing is on, so the new endpoint is judged against the network
  // the listing already has.
  const network = rec.network === "testnet" ? "testnet" : "mainnet";
  const payloadErr = validatePayload(body.payload, network);
  if (payloadErr) return json(res, 400, { error: payloadErr });

  body.signed = cleanSigned(body.signed);
  // Required here for the same reason as at submission, and for one more: this
  // endpoint assigns rec.signed unconditionally, so an edit that omitted the
  // block used to replace a verified signature with null and quietly turn a
  // checkable listing into an unattested one. New pairing details need a new
  // signature over them; the old one covers the old details and would be a lie
  // about the new.
  if (!body.signed) {
    return json(res, 400, { error: "signature gate: paste a signed block covering the NEW pairing details. " +
      "Your existing signature covers the details you are replacing, so it cannot carry over. " +
      "Your listing is unchanged." });
  }
  {
    const repaired = repairSignedBlock(body.signed);
    if (repaired) body.signed = repaired.block;
    const sig = verifySignedPayload({
      signedText: body.signed,
      expectedMessage: canonicalPairing(body.payload),
      expectedAddress: notificationAddresses(s.paymentCode),
    });
    if (!sig.ok) return json(res, 400, { error: "signature gate: " + sig.error });
  }

  const check = await probe(body.payload.pairing.url, {
    ...PROBE_CFG, apikey: body.payload.pairing.apikey, network,
  });
  if (!check.up) {
    return json(res, 422, {
      error: "connection gate: that node is unreachable or not serving block data over Tor ("
        + (check.reason || "no response") + "). Your listing is unchanged.",
      probe: check,
    });
  }

  // Exactly the two keys the signature covers, and nothing the operator posted
  // alongside them. canonicalPairing is what was verified above, so anything
  // else in body.payload is unattested and must not be stored, let alone
  // published: dojos.json publishes payload wholesale for visitors to pair
  // with.
  rec.payload = { pairing: body.payload.pairing, explorer: body.payload.explorer };
  rec.signed = body.signed || null;
  rec.last_probe = check;
  rec.updated_at = new Date().toISOString();
  await store.putSubmission(rec);

  // Republish straight away when the record is live, so a moved onion is
  // corrected on the cards without waiting for the next probe cycle.
  const rebuilt = rec.status === "approved" ? await tryRebuild() : null;
  json(res, 200, { ok: true, submission: rec, rebuild: rebuilt,
    note: "Pairing details updated. Your listing keeps its place and its history." });
});

// 10) admin: edit display fields on any record
route("POST", /^\/api\/admin\/edit$/, async (req, res) => {
  const s = await adminFrom(req, res);
  if (!s) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec) return json(res, 404, { error: "not found" });
  await applyEdit(rec, body, res);
});

// 12) admin: how far behind is this instance? Cached for six hours; failure
//     (GitHub unreachable over Tor, or an undeployed dev build) is reported
//     in-band so the admin panel can show "unavailable" without erroring.
// A self-update runs as a single background job with polled progress. Only one
// at a time; the job object is the source of truth the poll route returns.
let UPDATE_JOB = null;   // { id, phase, log[], done, ok, error, source, version, needsRefresh }
route("POST", /^\/api\/admin\/update$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  if (UPDATE_JOB && !UPDATE_JOB.done) return json(res, 409, { error: "an update is already in progress" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { body = {}; }

  const id = Date.now().toString(36);
  const job = UPDATE_JOB = { id, phase: "starting", log: [], done: false, ok: false, error: null,
    source: body.source === "peer" ? "peer" : "github", version: null, needsRefresh: false };
  const log = (line) => { job.log.push(line); if (job.log.length > 200) job.log.shift(); };

  // Run detached from the request: reply immediately with the job id.
  (async () => {
    try {
      const cfg = { proxyHost: PROBE_CFG.proxyHost, proxyPort: PROBE_CFG.proxyPort };
      const { fetchFromGitHub, fetchFromPeer, applyUpdate } = await import("./self-update.mjs");
      let fetched;
      job.phase = "fetching";
      if (job.source === "peer") {
        const onionHost = String(body.onion || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (!/^[a-z2-7]{56}\.onion$/.test(onionHost)) throw new Error("a valid peer .onion is required");
        fetched = await fetchFromPeer({ onionHost, trustedCode: body.code || null, cfg, log });
      } else {
        fetched = await fetchFromGitHub({ cfg, log });
      }
      job.version = fetched.version;
      job.phase = "applying";
      const r = await applyUpdate({ ...fetched, webRoot: ROOT, log });
      job.needsRefresh = true;                 // front end should hard-reload once the service is back
      job.phase = "restarting";
      job.ok = true; job.done = true;
      log("update staged from " + fetched.sourceLabel + "; service is restarting.");
    } catch (e) {
      job.error = e.message; job.ok = false; job.done = true; job.phase = "failed";
      log("✗ " + e.message);
    }
  })();

  json(res, 202, { started: true, id });
});

// 12b) admin: import listings from another Dojo Bay.
//
// The same operation the installer performs at setup, offered to a running
// instance. It is a background job for the same reason the self-update is: the
// three documents come from another onion over Tor, which is seconds at best,
// and holding a request open for that is worse than polling.
//
// It runs IN this process rather than by spawning the script, because the
// backend holds the store in memory as its single writer. A second process
// writing store.json while this one has it loaded is the bug the maintenance
// tools all refuse to risk.
//
// Two phases on purpose. The premise of importing from another directory is
// that you do not trust it, so an operator sees the plan (what would be
// imported, what is already listed here under another id, what is refused and
// why) before anything is written. That is the same dry run the command line
// defaults to.
//
// Imported records arrive PENDING. At install, approved is right, because
// choosing to bootstrap is the decision to trust that list wholesale. In a
// running instance with a moderation queue, a listing that appeared on the site
// without passing through it would be the other directory publishing here.
let IMPORT_JOB = null;   // { id, phase, log[], done, ok, error, apply, onion, result }
route("POST", /^\/api\/admin\/import$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  if (IMPORT_JOB && !IMPORT_JOB.done) return json(res, 409, { error: "an import is already in progress" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { body = {}; }

  const onionHost = String(body.onion || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z2-7]{56}\.onion$/.test(onionHost)) {
    return json(res, 400, { error: "a valid .onion address is required" });
  }
  // The peer's payment code is what the operator binding is checked against,
  // and it is the operator's own statement of who they are choosing to trust.
  // Without it there is nothing to compare the remote signature to, so the
  // import would verify only that the remote signed something.
  const trustedCode = String(body.code || "").trim();
  if (!/^(PM8T|PM8[A-Za-z0-9])/.test(trustedCode) || trustedCode.length < 100) {
    return json(res, 400, { error: "the payment code of the instance you are importing from is required" });
  }

  const id = Date.now().toString(36);
  const job = IMPORT_JOB = { id, phase: "starting", log: [], done: false, ok: false, error: null,
    apply: body.apply === true, onion: onionHost, result: null };
  const log = (line: string) => { job.log.push(String(line)); if (job.log.length > 400) job.log.shift(); };

  (async () => {
    try {
      job.phase = job.apply ? "importing" : "planning";
      const { bootstrapImport } = await import("../scripts/bootstrap-import.mjs");
      job.result = await bootstrapImport({
        onionHost, trustedCode, dryRun: !job.apply, log,
        dataDir: process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"),
        status: "pending",
      });
      // Rebuild after an apply. The new records are pending and publish
      // nothing, but an import also carries history onto listings this instance
      // already has and adds domain claims, and both of those do reach the
      // published file. A planning run writes nothing and needs none.
      if (job.apply) { job.phase = "rebuilding"; await tryRebuild(); }

      // Then probe, for the same reason the installer runs a cycle before it
      // declares success. A pending record's live status comes from
      // pending-probe.json, which only the update cycle writes, so until one
      // runs an imported listing has no status at all and the moderation queue
      // shows a wall of nodes reading inactive. They are not inactive; nothing
      // has asked them yet, and a moderator deciding whether to approve is
      // exactly the person who needs the answer.
      //
      // Skipped when a cycle is already running, since there is no lock and two
      // at once would race to write the same files. systemd knows, and reading
      // that needs no privilege.
      if (job.apply && (job.result?.imported ?? 0) > 0) {
        job.phase = "probing";
        const running = await execFileP("systemctl", ["is-active", "--quiet", "dojobay-update.service"])
          .then(() => true, () => false);
        if (running) {
          log("a probe cycle is already running; the imported nodes will get their status from it");
        } else {
          log("probing the imported nodes over Tor (this takes a minute)");
          try {
            await execFileP(process.execPath, [path.join(ROOT, "scripts", "update.mjs")],
              { cwd: ROOT, timeout: 5 * 60 * 1000 });
            log("probe cycle complete: the imported nodes show their own status");
          } catch (e: any) {
            // Non-fatal. The records are imported and the timer comes round
            // within ten minutes; what is lost is the status being right
            // immediately, not the import.
            log("! probe cycle failed: " + (e.message || String(e)));
            log("  the import is complete; the update timer will fill in statuses within ten minutes");
          }
        }
      }
      job.ok = true; job.done = true; job.phase = "done";
    } catch (e: any) {
      job.error = e.message; job.ok = false; job.done = true; job.phase = "failed";
      log("✗ " + e.message);
    }
  })();

  json(res, 202, { started: true, id, apply: job.apply });
});

route("GET", /^\/api\/admin\/import\/status$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  json(res, 200, { job: IMPORT_JOB });
});

route("GET", /^\/api\/admin\/update\/status$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  // After a successful apply the service restarts; on the way back up the
  // helper leaves data/updates/last-result.json, which we surface so the panel
  // can confirm completion across the restart.
  let lastResult = null;
  try { lastResult = JSON.parse(await readFile(path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "updates", "last-result.json"), "utf8")); } catch {}
  json(res, 200, { job: UPDATE_JOB, lastResult });
});

// The restart permission self-update needs cannot be checked from here.
//
// Two attempts, both wrong, and the second wrong in a way that took a live
// instance to find. systemctl restart --dry-run returns before any bus call, so
// it reported success whatever the account could do. pkcheck asks polkit the
// right question, but polkit refuses CheckAuthorization() WITH DETAILS from any
// caller that is not uid 0 or the action's owner, and the rule keys on the unit
// and the verb, so without details it cannot match and the answer would be a
// false no. The rules directory is 750 root:polkitd, so reading the file is
// closed off too.
//
// So this instance says nothing about whether the permission is present. What
// it can do is report the one thing it has evidence for: an update that
// installed and did not restart, which lastResult already records, and which is
// exactly the symptom a missing permission produces.
route("GET", /^\/api\/admin\/updates$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  // Six hours is right for an unattended check over Tor, where GitHub rate
  // limits shared exit nodes. It is wrong for somebody who has just signed in
  // to look, which is why the login discards it, and wrong for somebody who has
  // just pushed while already signed in, which is what ?refresh=1 is for.
  //
  // The floor is what stops that button being a way to hammer GitHub from an
  // exit node shared with every other Tor user. A forced check inside the floor
  // is answered from the cache with the wait attached, rather than refused:
  // the operator asked what the state is, and the honest answer is the last one
  // known plus how stale it is.
  const forced = /[?&]refresh=1(&|$)/.test(req.url || "");
  const decision = updateCacheDecision({
    cachedAt: UPDATES_CACHE ? UPDATES_CACHE.at : null,
    forced, forcedAt: FORCED_UPDATE_AT, floorMs: FORCED_UPDATE_FLOOR });
  if (decision.serveCached) {
    return json(res, 200, decision.waitS
      ? { ...UPDATES_CACHE.result, refresh_wait_s: decision.waitS }
      : UPDATES_CACHE.result);
  }
  if (forced) FORCED_UPDATE_AT = Date.now();
  try {
    // The account this process runs as, so the panel can print a command that
    // works rather than a placeholder. The two machines differ: one built by the
    // installer runs as dojobay, one set up by hand may not.
    const result = { available: true,
      serviceUser: (() => { try { return osMod.userInfo().username; } catch { return null; } })(),
      // Absolute, because the remedy the panel prints used to be a relative
      // path with nowhere stated to run it. An operator reading "cp
      // deploy/polkit-restart.rules.example" has to work out both the directory
      // and that .example is the literal filename rather than a placeholder.
      ruleSource: path.join(ROOT, "deploy/polkit-restart.rules.example"),
      rulePath: "/etc/polkit-1/rules.d/49-dojobay-restart.rules",
      ...(await checkUpdates({ cfg: { proxyHost: PROBE_CFG.proxyHost, proxyPort: PROBE_CFG.proxyPort } })) };
    UPDATES_CACHE = { at: Date.now(), result };
    json(res, 200, result);
  } catch (e) {
    json(res, 200, { available: false, error: e.message });
  }
});

// 11) reliability export: the full 24h check series and 90-day rollups in one
//     document, optionally filtered to a single node. Not linked anywhere on
//     the front end; the raw files also remain at /data/history.json and
//     /data/history-daily.json.
route("GET", /^\/api\/history\/export$/, async (req, res) => {
  const u = new URL(req.url, "http://x");
  const id = u.searchParams.get("id");
  const dataDir = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");
  const read = async (f, fb) => { try { return JSON.parse(await readFile(path.join(dataDir, f), "utf8")); } catch { return fb; } };
  const hist = await read("history.json", { nodes: {} });
  const daily = await read("history-daily.json", { nodes: {} });
  const ids = id ? [id] : [...new Set([...Object.keys(hist.nodes || {}), ...Object.keys(daily.nodes || {})])].sort();
  const nodes = {};
  for (const k of ids) {
    const h = (hist.nodes || {})[k], d = (daily.nodes || {})[k];
    if (!h && !d) continue;
    nodes[k] = { checks: (h && h.checks) || [], days: (d && d.days) || [] };
    const retired = (h && h.retired) || (d && d.retired);
    if (retired) nodes[k].retired = retired;
  }
  if (id && !nodes[id]) return json(res, 404, { error: "no history for that id" });
  json(res, 200, {
    generated_at: new Date().toISOString(),
    interval_minutes: hist.interval_minutes || 10,
    window_checks: hist.window_checks || 144,
    nodes,
  });
});

// 8) delete one of my records
route("POST", /^\/api\/dojo\/delete$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec || !owns(rec, s.paymentCode)) return json(res, 404, { error: "not found" });
  await store.deleteSubmission(body.id);
  json(res, 200, { ok: true });
});

// A card link is only publishable on the operator's verified domain. This is the
// constraint that replaces a freeform URL field: "link to my own site" survives,
// an unverifiable social profile does not.

// ---- verified operator domains ---------------------------------------------
// An operator proves control of one clearnet domain: the domain names their
// payment code in a TXT record, and they sign a statement naming the domain.
// The badge on their cards, and the card-title link, both depend on it.

const domainCfg = () => ({ proxyHost: PROBE_CFG.proxyHost, proxyPort: PROBE_CFG.proxyPort });

// What the operator has, plus exactly what to publish and sign. Returning the
// instructions from the server keeps them identical to what verification checks.
route("GET", /^\/api\/domain$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  const claim = await store.getDomain(s.paymentCode);
  json(res, 200, {
    claim: claim ? {
      domain: claim.domain, verified: !!claim.verified, verified_at: claim.verified_at || null,
      last_check: claim.last_check || null, last_result: claim.last_result || null,
      failing_since: claim.fail_since || null, grace_days: GRACE_DAYS,
    } : null,
    txt_host: txtHost(),
    txt_prefix: txtName("<your-domain>"),
    txt_value: txtValue(s.paymentCode),
    signing_hint: "Sign under PayNym → Sign message, which uses your PayNym's notification address.",
  });
});

// Instructions for a specific domain, so the console can show the exact record
// and text before the operator has signed anything.
route("POST", /^\/api\/domain\/prepare$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const norm = normaliseDomain(body?.domain);
  if (!norm.ok) return json(res, 400, { error: norm.error });
  json(res, 200, {
    domain: norm.domain,
    punycode: !!norm.punycode,
    // Two forms on purpose: most panels (Namecheap, Cloudflare, Route 53) want
    // the label relative to the zone, a few want the fully-qualified name.
    // Handing over only the latter produces _dojobay.example.com.example.com.
    txt_host: txtHost(),
    txt_name: txtName(norm.domain),
    txt_value: txtValue(s.paymentCode),
    sign_text: signingText(norm.domain, s.paymentCode),
  });
});

route("POST", /^\/api\/domain$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const norm = normaliseDomain(body?.domain);
  if (!norm.ok) return json(res, 400, { error: norm.error });
  let signed = String(body?.signed || "").trim();
  if (!signed) return json(res, 400, { error: "paste the signed block" });
  // Same paste hazard as the submission gate: restore the blank line the
  // signature covers, when a reconstruction verifies cryptographically.
  const repairedClaim = repairSignedBlock(signed);
  if (repairedClaim) signed = repairedClaim.block;

  // A domain already verified by a different operator is not fatal (a host may
  // run several operators' nodes) but it is worth surfacing to an admin.
  const clash = (await store.listDomains())
    .find((c) => c && c.verified && c.domain === norm.domain && c.paymentCode !== s.paymentCode);

  const r = await verifyClaim({ domain: norm.domain, paymentCode: s.paymentCode, signed }, domainCfg());
  const now = new Date().toISOString();
  const prev = await store.getDomain(s.paymentCode);

  // A bad signature is the operator's to fix and nothing is stored. A missing
  // TXT record is usually propagation, so the claim is SAVED unverified and the
  // sweep keeps looking: the operator does not have to sign again, and an
  // unverified claim confers nothing (no badge, and no card link, because
  // checkNameUrl requires a verified domain).
  if (!r.ok && r.stage === "signature") {
    return json(res, 400, { error: r.error, stage: r.stage });
  }
  await store.putDomain({
    paymentCode: s.paymentCode, domain: norm.domain, signed,
    verified: !!r.ok,
    verified_at: r.ok ? now : null,
    last_check: r.ok ? now : null,       // null so the sweep retries immediately
    last_result: r.ok ? "ok" : (r.error || "awaiting the TXT record"),
    fail_since: null,
    created_at: (prev && prev.created_at) || now,
    also_claimed_by: clash ? clash.paymentCode : null,
  });
  if (!r.ok) {
    const rebuiltPending = await tryRebuild();
    return json(res, 202, {
      ok: false, pending: true, domain: norm.domain,
      error: r.error, hint: r.hint || null, inconclusive: !!r.inconclusive,
      note: "Your signature is verified and saved. We could not see the TXT record yet, "
        + "which usually means DNS has not propagated. This is retried automatically; "
        + "you do not need to sign again.",
      rebuild: rebuiltPending,
    });
  }
  // A changed domain can invalidate an existing card link, so republish.
  const rebuilt = await tryRebuild();
  json(res, 200, { ok: true, domain: norm.domain, resolvers_agreed: r.agreed, rebuild: rebuilt });
});

// Re-check on demand, using the signature already stored. The operator has just
// published a TXT record and wants an answer now rather than at the next sweep;
// they should not have to sign again, and the GET deliberately does not hand
// their signed block back to the browser.
route("POST", /^\/api\/domain\/recheck$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  const claim = await store.getDomain(s.paymentCode);
  if (!claim) return json(res, 404, { error: "no domain claim to re-check" });
  const r = await verifyClaim({ domain: claim.domain, paymentCode: claim.paymentCode, signed: claim.signed }, domainCfg());
  const now = new Date().toISOString();
  const next = { ...claim, last_check: now,
    verified: !!r.ok,
    verified_at: r.ok ? (claim.verified_at || now) : claim.verified_at,
    last_result: r.ok ? "ok" : (r.error || "no matching TXT record"),
    fail_since: r.ok ? null : claim.fail_since };
  await store.putDomain(next);
  const rebuilt = await tryRebuild();
  json(res, r.ok ? 200 : 202, {
    ok: !!r.ok, pending: !r.ok, domain: claim.domain,
    error: r.ok ? undefined : r.error, hint: r.ok ? undefined : (r.hint || null),
    inconclusive: !!r.inconclusive, rebuild: rebuilt,
  });
});

route("DELETE", /^\/api\/domain$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  await store.deleteDomain(s.paymentCode);
  const rebuilt = await tryRebuild();
  json(res, 200, { ok: true, rebuild: rebuilt });
});

// Admin revocation. A badge attests to control, not to trustworthiness, so
// there must be a way to remove one from a lookalike or abusive domain.
route("POST", /^\/api\/admin\/domain\/revoke$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const code = String(body?.paymentCode || "");
  const claim = await store.getDomain(code);
  if (!claim) return json(res, 404, { error: "no domain claim for that payment code" });
  await store.putDomain({ ...claim, verified: false, revoked: true,
    last_result: "revoked by admin", last_check: new Date().toISOString() });
  const rebuilt = await tryRebuild();
  json(res, 200, { ok: true, rebuild: rebuilt });
});

route("GET", /^\/api\/admin\/domains$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  const list = (await store.listDomains()).map((c) => ({
    paymentCode: c.paymentCode, domain: c.domain, verified: !!c.verified, revoked: !!c.revoked,
    verified_at: c.verified_at || null, last_check: c.last_check || null,
    last_result: c.last_result || null, failing_since: c.fail_since || null,
    also_claimed_by: c.also_claimed_by || null,
  }));
  json(res, 200, { domains: list, grace_days: GRACE_DAYS });
});

// Periodic re-check. This lives in the backend rather than the ten-minute
// updater because the store is owned by the backend's user; the updater runs as
// a different user and must not write it. DNS changes slowly, so the sweep is
// daily per claim, and it never lets an unreachable resolver strip a badge.
// Rejected submissions are not kept indefinitely. The window exists so a
// maintainer can undo a mistaken rejection; after it, the operator's payment
// code, pairing payload, apikey and signature are removed. Defaults to the same
// grace period the retired history uses.
const REJECTED_RETENTION_DAYS = +(process.env.REJECTED_RETENTION_DAYS || process.env.HISTORY_GRACE_DAYS || 14);

async function sweepRejected() {
  try {
    const gone = await store.pruneRejected(REJECTED_RETENTION_DAYS);
    if (gone.length) {
      console.log(`[retention] removed ${gone.length} rejected submission(s) older than ` +
        `${REJECTED_RETENTION_DAYS} days: ${gone.join(", ")}`);
    }
    return gone;
  } catch (e) {
    console.error("[retention] sweep failed:", (e as Error).message);
    return [];
  }
}

async function sweepDomains() {
  let changed = false;
  for (const claim of await store.listDomains()) {
    if (claim.revoked || !isDue(claim)) continue;
    let result;
    try { result = await recheckClaim(claim, domainCfg()); }
    catch (e) { result = { ok: false, inconclusive: true, error: e.message }; }
    const next = applyRecheck(claim, result);
    if (JSON.stringify(next) !== JSON.stringify(claim)) {
      await store.putDomain(next);
      if (next.verified !== claim.verified) changed = true;
    }
  }
  if (changed) await tryRebuild();
  return changed;
}

if (process.env.DOMAIN_SWEEP !== "0") {
  const every = +(process.env.DOMAIN_SWEEP_MINUTES || 30) * 60 * 1000;
  const t = setInterval(() => {
    sweepDomains().catch(() => {});
    sweepRejected().catch(() => {});
  }, every);
  t.unref?.();
  // Also once at startup, so a long-dead instance does not wait for the first tick.
  sweepRejected().catch(() => {});
}

// ---- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;
    for (const r of routes) {
      if (r.method === req.method && r.re.test(path)) return await r.fn(req, res);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: "server error", detail: e.message });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`dojobay backend on 127.0.0.1:${PORT} (base ${BASE_URL})`));

export { server, routes };
