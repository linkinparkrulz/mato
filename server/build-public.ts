#!/usr/bin/env node
// Merge the curated seed list with APPROVED self-service submissions into the
// public data/dojos.json that the front-end and the 10-minute updater consume.
// The seed list (data/seed.json) stays under maintainer control; only approved
// submissions are added. A newly-approved node inherits the status, block
// height and reliability history the updater already recorded for it while it
// was pending (see scripts/update.mjs and server/data/pending-probe.json), so
// it appears active with its uptime intact the moment it is published.
//
// Exposes rebuild() for in-process use by the admin API; runs it when invoked
// directly from the CLI.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { store, hasSignedBlock } from "./store.ts";
import { urlOnDomain } from "./domains.ts";
import type { PublicNode, PairingPayload, StoreRecord } from "../types.js";

/** The generated data/dojos.json. */
interface PublicDoc {
  generated_at?: string;
  interval_minutes?: number;
  nodes: PublicNode[];
}
/** A history file: per-node check lists or daily rollups, keyed by record id. */
type HistoryMap = Record<string, any>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJSON<T>(p: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
// A temporary name no other writer can take. `<file>.tmp` is not atomic
// between processes: two writers produce the same path, the first rename
// consumes it, and the second fails with ENOENT on a file it had just written.
// See scripts/update.mjs for the install that did exactly that.
let tmpSeq = 0;
async function writeAtomic(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${(tmpSeq = (tmpSeq + 1) % 1e6)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, p);
}

// The payment code shown on a card. A PayNym commonly has two BIP47 variants
// and records store every variant; the canonical one people share (and the one
// shown on paynym.rs profiles) is the NON-segwit code, so prefer that when the
// paynym-codes mapping can identify it, falling back to the record's first.
// Exported for the self-test.
/** Only the two fields it actually reads, so callers need not build a whole
 *  record to ask which variant to display. */
type CodeBearing = { paymentCodes?: string[] | null; paynym?: string | null };

export function displayPaymentCode(sub: CodeBearing, mapping: any): string | null {
  const codes = Array.isArray(sub.paymentCodes) ? sub.paymentCodes : [];
  if (!codes.length) return null;
  const entry = sub.paynym && mapping && mapping[sub.paynym];
  const legacy = entry && (entry.codes || []).find((c) => !c.segwit && codes.includes(c.code));
  return (legacy && legacy.code) || codes[0];
}

// The version shown on a card is derived entirely from the node's API, never
// set by an operator. In priority order:
//   1. the version the updater last read live from the node's X-Dojo-Version
//      response header (detected_version, carried in dojos.json),
//   2. the version in the pairing payload, used only as a bootstrap fallback
//      until the first probe reads a live header (and for older nodes that do
//      not emit the header). It is itself an API value, captured from the
//      Dojo's pairing output at submission time.
// There is deliberately no operator override: the version always reflects what
// the node reports. To show nothing until a live header is read, drop the
// pairing fallback.
export function effectiveVersion(detected: string | null | undefined, pairing: string | null | undefined): string | null {
  return detected || pairing || null;
}

// The Electrum endpoint shown on a card. Only what the node reported about
// itself: the updater reads it from the Dojo's /support/services each cycle,
// over the API onion the operator's signature fixes.
//
// A URL declared in a submitted payload is NOT a fallback and must not become
// one: nothing signs it, and a node that is healthy but exposes no indexer
// never acquires a detected value, so a declared URL would be published for
// good. docs/decisions.md, entry 00d07ae, has the reasoning.
//
// Null means the card shows N/A, which is a real answer (no exposed indexer)
// rather than an omission, and is now reachable for every node.
export function effectiveIndexer(detected: string | null | undefined): string | null {
  return detected || null;
}

// Every key the published dojos.json may contain for a node. Exported so the
// suite can assert on it rather than restating it, and so that adding a field
// to toPublicNode without adding it here fails the gate: publishing a new field
// should be a decision somebody makes, not a consequence of editing a record
// shape somewhere else.
export const PUBLIC_NODE_KEYS = Object.freeze([
  "id", "network", "name", "status", "paynym", "paymentCode",
  "jurisdiction", "country", "hardware", "version", "detected_version",
  "detected_indexer", "operator_domain", "operator_domain_proof",
  "block_height", "indexer_url", "checked_at", "payload", "signed",
]);

// The allowlist itself, and the only producer of a published node.
//
// It names every field rather than deleting the ones it does not want, which is
// the distinction that matters: a redaction list is wrong by default and has to
// be updated whenever the store gains a field, whereas this is right by default
// and has to be updated whenever the PUBLIC shape should change. The store
// holds things that must never be published (moderation status, the owning
// payment codes, submission timestamps, the probe result recorded at
// submission, import provenance) and it will hold more in future.
//
// One field is copied wholesale rather than picked apart: `payload`. That is
// deliberate, since the pairing payload including its API key is the entire
// point of a listing and a visitor needs it byte for byte to pair. It does mean
// the allowlist has a nested edge: anything added inside payload is published.
// The store gate is what keeps that honest, since payload is what the operator
// signed and the signature covers its exact contents.
function toPublicNode(sub: StoreRecord, paymentCode: string | null): PublicNode {
  return {
    id: sub.id,
    network: sub.network,
    name: sub.name || sub.paynym || sub.id,
    status: "inactive",
    paynym: sub.paynym || null,
    paymentCode: paymentCode || null,
    jurisdiction: sub.jurisdiction || null,
    country: sub.country || null,
    hardware: sub.hardware || null,
    // Initial version is the pairing-payload fallback; rebuild() recomputes it
    // via effectiveVersion once the live-detected value is known.
    version: sub.payload?.pairing?.version || null,
    detected_version: null,
    detected_indexer: null,
    operator_domain: null,
    operator_domain_proof: null,
    block_height: null,
    indexer_url: null,
    checked_at: null,
    payload: sub.payload,
    signed: sub.signed || null,
  };
}

// Grace-period retirement for history entries. Deleting history the instant an
// id leaves the node list turned a transient list mistake into permanent data
// loss (the seed-migration deploy wiped every migrated node's history seconds
// after rsync, via the post-deploy rebuild, before the migration could run on
// the box). Instead: an unlisted id is STAMPED `retired` and kept; it is only
// deleted after HISTORY_GRACE_DAYS (default 14); if the id is listed again
// within the window, the stamp is cleared and its history resumes untouched.
// Exported because scripts/update.mjs rewrites the same two files every cycle
// and must apply identical rules.
export function retireUnlisted(nodesMap: HistoryMap, isListed: (id: string) => boolean,
    nowIso: string, graceDays: number = Number(process.env.HISTORY_GRACE_DAYS || 14)): boolean {
  let touched = false;
  const cutoffMs = Date.parse(nowIso) - graceDays * 86400000;
  for (const id of Object.keys(nodesMap)) {
    const entry = nodesMap[id];
    if (isListed(id)) {
      if (entry.retired) { delete entry.retired; touched = true; }
    } else if (!entry.retired) {
      entry.retired = nowIso; touched = true;
    } else if (Date.parse(entry.retired) < cutoffMs) {
      delete nodesMap[id]; touched = true;
    }
  }
  return touched;
}

export async function rebuild(): Promise<{ nodes: number; approved: number; msg: string }> {
  const DATA_DIR = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");
  const SERVER_DATA = process.env.SERVER_DATA_DIR || path.join(ROOT, "server", "data");
  const SEED = path.join(DATA_DIR, "seed.json");
  const OUT = path.join(DATA_DIR, "dojos.json");
  const HIST = path.join(DATA_DIR, "history.json");
  const DAILY = path.join(DATA_DIR, "history-daily.json");
  const PENDING_PROBE = path.join(SERVER_DATA, "pending-probe.json");

  const seed = await readJSON(SEED, { nodes: [] });
  // Optional: identifies each PayNym's non-segwit code variant for display.
  const codesDoc = await readJSON(path.join(DATA_DIR, "paynym-codes.json"), { mapping: {} });
  // The operator binding is REQUIRED: an instance must prove who runs it.
  // Warn (unmissably) rather than fail, so a malformed signature nags the
  // operator without taking the directory down for its visitors. The crypto
  // import is lazy so the dependency-free scripts/ chain can still import
  // this module on a box where server/node_modules is not installed yet.
  try {
    const opDoc = await readJSON(path.join(DATA_DIR, "operator.json"), null);
    if (!opDoc) {
      console.error("[rebuild] REQUIRED: data/operator.json is missing. Sign your onion URL with your wallet and install the binding (the installer does this); see README.");
    } else {
      try {
        const { verifyOperatorDoc } = await import("./crypto.ts");
        const v = verifyOperatorDoc(opDoc);
        if (!v.ok) console.error(`[rebuild] REQUIRED: data/operator.json does not verify: ${v.error}`);
      } catch { console.error("[rebuild] note: cannot verify operator.json (server dependencies not installed)."); }
    }
  } catch (e) { console.error(`[rebuild] operator.json check skipped: ${e.message}`); }

  // Anchor-model checks (warnings, never fatal: a fresh instance mid-setup or
  // mid-transition should build, just noisily). The seed should hold exactly
  // one node -- the instance operator's own, carrying their payment code --
  // and every listed node should carry a BIP47 code; code-less records are
  // grandfathered exceptions managed from /admin.
  if ((seed.nodes || []).length !== 1) {
    console.error(`[rebuild] note: seed carries ${(seed.nodes || []).length} node(s); the anchor model expects exactly one (the instance operator's own node).`);
  } else if (!seed.nodes[0].paymentCode) {
    console.error(`[rebuild] REFUSING to publish the anchor seed node ${seed.nodes[0].id}: it has no BIP47 payment code.`);
  }
  // A record with no payment code and no signed pairing block is not published.
  // The store refuses to write either, so this only fires for something that
  // predates those rules or was edited by hand — and in that case it is
  // withheld rather than shown, because a listing nobody can be held to, or
  // whose details nobody has attested to, is exactly what this directory must
  // not carry. Withheld, not deleted: the record stays for a maintainer to look
  // at. The two are reported separately because the remedies differ: a missing
  // code cannot be supplied by anyone but the operator, while a missing
  // signature usually means asking them to sign what they already gave us.
  const allApproved = (await store.listSubmissions()).filter((s) => s.status === "approved");
  const codeless = allApproved.filter((s) => !(s.paymentCodes || []).length);
  if (codeless.length) {
    console.error(`[rebuild] REFUSING to publish ${codeless.length} listing(s) with no BIP47 payment code: ${codeless.map((s) => s.id).join(", ")}. A listing must carry a payment code; remove it with server/remove-listing.ts, or give it one.`);
  }
  const unsigned = allApproved.filter((s) => (s.paymentCodes || []).length && !hasSignedBlock(s));
  if (unsigned.length) {
    console.error(`[rebuild] REFUSING to publish ${unsigned.length} listing(s) with no signed pairing block: ${unsigned.map((s) => s.id).join(", ")}. Ask the operator to sign their pairing payload and resubmit, or remove the listing with server/remove-listing.ts.`);
  }
  const approvedSubs = allApproved.filter((s) => (s.paymentCodes || []).length && hasSignedBlock(s));
  const approved = approvedSubs.map((s) => toPublicNode(s, displayPaymentCode(s, codesDoc.mapping)));
  const approvedIds = new Set(approved.map((n) => n.id));

  const byId = new Map();
  // The seed anchor is held to the same rules as any other listing.
  const seedNodes = (seed.nodes || []).filter((n) => {
    if (!n || !n.paymentCode) {
      console.error(`[rebuild] withholding seed node ${n?.id}: no BIP47 payment code.`);
      return false;
    }
    if (!hasSignedBlock(n)) {
      console.error(`[rebuild] withholding seed node ${n?.id}: no signed pairing block.`);
      return false;
    }
    return true;
  });
  // Seed nodes go through the SAME allowlist as store records. They used to be
  // published as they sit in data/seed.json, which meant the public file had two
  // producers and only one of them filtered anything. Nothing has ever leaked
  // that way, because seed.json is written by the installer and its fields
  // happen to be a subset of what toPublicNode emits, but "happens to be a
  // subset" is not a property anybody was maintaining: seed.json is
  // instance-owned and documented as hand-editable, so a field added there went
  // straight to the published file unread. One producer, one allowlist.
  //
  // The cast is safe because toPublicNode reads only fields a seed node has;
  // the owning code is passed as an argument rather than read from the record,
  // which is why a seed node's singular paymentCode needs no reshaping.
  for (const n of seedNodes) byId.set(n.id, toPublicNode(n as unknown as StoreRecord, n.paymentCode || null));
  for (const n of approved) byId.set(n.id, n);
  const nodes = [...byId.values()];

  // Per-id pairing version, the bootstrap fallback used until a live version is
  // detected. The card version is never operator-set (see effectiveVersion).
  const pairingById = new Map();
  for (const n of seedNodes) pairingById.set(n.id, n.payload?.pairing?.version || null);
  for (const s of approvedSubs) pairingById.set(s.id, s.payload?.pairing?.version || null);

  // Owner payment codes per node, for the verified-domain lookup below. The seed
  // anchor carries a single paymentCode; store records carry paymentCodes[].
  const ownerCodesById = new Map();
  for (const n of seedNodes) ownerCodesById.set(n.id, [n.paymentCode]);
  for (const sub of approvedSubs) ownerCodesById.set(sub.id, sub.paymentCodes || []);

  // Carry over the live status the updater last wrote, so a rebuild does not
  // blank a node for a probe cycle.
  const prior = await readJSON(OUT, { nodes: [] });
  const priorById = new Map((prior.nodes || []).map((n) => [n.id, n]));
  // Pending-probe results (updater-owned): seed a just-approved node's status
  // and height from what was observed while it was pending.
  const pending = await readJSON(PENDING_PROBE, { nodes: {} });
  // Verified operator domains: published per node so the card can show the badge
  // without another lookup, and used to filter the card-title link. A link that
  // is not on the operator's verified domain is withheld rather than deleted, so
  // an operator who verifies later gets their link back untouched.
  const domainByCode = await store.verifiedDomainMap();
  // The proof is published alongside the badge so a reader can check it with
  // their own tools instead of taking our tick on trust: the TXT record proves
  // the domain names the payment code, and the signed statement proves the code
  // names the domain. Everything here is already public (the payment code is on
  // the card, the domain is the claim), so publishing it discloses nothing new.
  const claimByCode = new Map<string, { signed: string; verified_at: string | null }>();
  for (const c of await store.listDomains()) {
    if (c?.verified && c.domain) claimByCode.set(c.paymentCode, { signed: c.signed, verified_at: c.verified_at ?? null });
  }
  for (const n of nodes) {
    const codes = ownerCodesById.get(n.id) || [];
    const code = codes.find((c) => domainByCode.get(c)) || null;
    const domain = code ? domainByCode.get(code) || null : null;
    n.operator_domain = domain;
    const claim = code ? claimByCode.get(code) : null;
    n.operator_domain_proof = domain && claim ? {
      domain,
      paymentCode: code,
      txt_name: `_dojobay.${domain}`,
      txt_value: `dojobay-domain-v1 pm=${code}`,
      signed: claim.signed,
      verified_at: claim.verified_at,
    } : null;
  }

  for (const n of nodes) {
    const p = priorById.get(n.id);
    const pr = (!p && approvedIds.has(n.id)) ? pending.nodes?.[n.id] : null;
    if (p) {
      n.status = p.status ?? n.status;
      n.checked_at = p.checked_at ?? n.checked_at;
      if (p.block_height != null) n.block_height = p.block_height;
    } else if (pr) {
      n.status = pr.status ?? n.status;
      n.checked_at = pr.checked_at ?? n.checked_at;
      if (pr.block_height != null) n.block_height = pr.block_height;
    }
    // Carry the live-detected version (prior snapshot, then a just-approved
    // node's pending probe) and fold it into the effective card version. The
    // updater writes detected_version each cycle; a rebuild must preserve it,
    // exactly as it preserves status and block height.
    const detected = (p && p.detected_version) || (pr && pr.detected_version) || null;
    n.detected_version = detected;
    n.version = effectiveVersion(detected, pairingById.get(n.id));
    // Same treatment for the Electrum endpoint: carry what the updater read and
    // publish it as indexer_url, which the card renders (N/A when null).
    const detectedIdx = (p && p.detected_indexer) || (pr && pr.detected_indexer) || null;
    n.detected_indexer = detectedIdx;
    n.indexer_url = effectiveIndexer(detectedIdx);
  }

  await writeAtomic(OUT, {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    interval_minutes: 10,
    nodes,
  });

  // Reliability history: ensure a bucket per node, seed a newly-approved node's
  // history from its pending history, and retire (grace period) unlisted ids.
  const hist = await readJSON(HIST, { interval_minutes: 10, window_checks: 144, nodes: {} });
  let touched = false;
  for (const n of nodes) {
    if (!hist.nodes[n.id]) {
      const seedChecks = (approvedIds.has(n.id) && pending.nodes?.[n.id]?.checks) || [];
      hist.nodes[n.id] = { checks: seedChecks.slice() };
      touched = true;
    }
  }
  const nowIso = new Date().toISOString();
  touched = retireUnlisted(hist.nodes, (id) => byId.has(id), nowIso) || touched;
  if (touched) { (hist as any).generated_at = (hist as any).generated_at || null; await writeAtomic(HIST, hist); }

  // 90-day daily rollup membership.
  const dailyDoc = await readJSON(DAILY, { retention_days: 90, nodes: {} });
  let dailyTouched = false;
  for (const n of nodes) if (!dailyDoc.nodes[n.id]) {
    dailyDoc.nodes[n.id] = { days: (approvedIds.has(n.id) && pending.nodes?.[n.id]?.days) ? pending.nodes[n.id].days.slice() : [] };
    dailyTouched = true;
  }
  dailyTouched = retireUnlisted(dailyDoc.nodes, (id) => byId.has(id), nowIso) || dailyTouched;
  if (dailyTouched) await writeAtomic(DAILY, dailyDoc);

  const msg = `public list rebuilt: ${nodes.length} nodes (${approved.length} approved submissions).`;
  return { nodes: nodes.length, approved: approved.length, msg };
}

// Run when invoked directly.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const r = await rebuild();
  console.log(r.msg);
}
