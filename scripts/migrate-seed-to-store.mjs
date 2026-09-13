#!/usr/bin/env node
// Move seed nodes into the operator-managed store, idempotently.
//
//   node scripts/migrate-seed-to-store.mjs --dry-run   print the plan, write nothing
//   node scripts/migrate-seed-to-store.mjs             apply it
//
// The seed's role is the instance ANCHOR: exactly one node, the instance
// operator's own Dojo (mainnet or testnet), carrying their PayNym and BIP47
// payment code. Everything else belongs in the store, where operators manage
// their listings over Auth47. This script is the transition tool for an
// instance whose seed still carries an old-style curated list:
//
//   - a seed node with a PayNym present in data/paynym-codes.json becomes an
//     APPROVED store record owned by every BIP47 code variant of that PayNym
//   - a seed node WITHOUT a PayNym is REFUSED. Every listing must carry a BIP47
//     payment code: it is the identity a listing is owned, edited, verified and
//     recognised by. Code-less records were once adopted as admin-managed
//     exceptions; that door is closed, and the store refuses to write one.
//   - a seed node whose id already exists in the store is SKIPPED untouched,
//     which is what makes re-runs no-ops and lets the anchor node coexist as
//     both seed entry (bootstrap guarantee) and store record (Auth47-managed:
//     the store record shadows the seed copy in the public list)
//
// The script never rewrites data/seed.json: slimming the seed down to the
// anchor is a deliberate, separate commit made AFTER the store records exist,
// because a deploy that removes a node's seed entry before its store record
// exists delists it (the history survives under the fourteen-day grace stamp,
// but there is no reason to invite the gap).
//
// Record ids are the original seed ids, so reliability history (keyed by id)
// carries over untouched. Afterwards run `node server/build-public.mjs`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { store, hasSignedBlock } from "../server/store.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");
const SEED_PATH = path.join(DATA_DIR, "seed.json");
const CODES_PATH = path.join(DATA_DIR, "paynym-codes.json");
const DRY = process.argv.includes("--dry-run");

async function readJSON(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

const slugOf = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Name derivation for owned groups. Remainder = seed id minus `${network}-`.
// When one owner's several nodes share a first hyphen-token and stripping it
// leaves something for each, drop the shared token; and prefer the seed's
// display name whenever it slugs to the derived value, so capitalisation like
// "wanderinKing072" survives.
function deriveNames(nodes) {
  const rem = nodes.map((n) => n.id.replace(new RegExp(`^${n.network}-`), ""));
  let names = rem;
  if (nodes.length > 1) {
    const first = rem.map((r) => r.split("-")[0]);
    if (first.every((t) => t === first[0]) && rem.every((r) => r.includes("-"))) {
      names = rem.map((r) => r.split("-").slice(1).join("-"));
    }
  }
  return nodes.map((n, i) => (n.name && slugOf(n.name) === names[i]) ? n.name : names[i]);
}

function toRecord(n, name, codes, now) {
  return {
    id: n.id, network: n.network, name,
    paymentCodes: codes,
    paynym: n.paynym || null,
    jurisdiction: n.jurisdiction || null,
    country: n.country || null,
    hardware: n.hardware || null,
    payload: n.payload,
    signed: n.signed || null,
    status: "approved",
    source: "seed-migration",
    created_at: now, updated_at: now,
  };
}

async function main() {
  const seed = await readJSON(SEED_PATH);
  const mapping = (await readJSON(CODES_PATH, { mapping: {} })).mapping || {};
  const existing = await store.listSubmissions();
  const nodes = seed.nodes || [];

  const owned = nodes.filter((n) => n.paynym);
  const missing = owned.filter((n) => !mapping[n.paynym]);
  if (missing.length) {
    console.error("aborting: no payment codes in", path.relative(ROOT, CODES_PATH), "for:");
    for (const n of missing) console.error("  ", n.id, n.paynym);
    process.exit(1);
  }

  // Derive names per owner; code-less nodes keep their seed name (or the id
  // remainder). Then refuse any per-network name collision against the plan
  // itself or records already in the store under a DIFFERENT id.
  const byOwner = new Map();
  for (const n of owned) (byOwner.get(n.paynym) || byOwner.set(n.paynym, []).get(n.paynym)).push(n);
  const nameOf = new Map();
  for (const group of byOwner.values()) deriveNames(group).forEach((nm, i) => nameOf.set(group[i].id, nm));
  for (const n of nodes.filter((x) => !x.paynym)) {
    const rem = n.id.replace(new RegExp(`^${n.network}-`), "");
    nameOf.set(n.id, (n.name && slugOf(n.name) === rem) ? n.name : (n.name || rem));
  }
  const seen = new Set();
  for (const n of nodes) {
    const key = `${n.network}:${slugOf(nameOf.get(n.id))}`;
    if (seen.has(key)) { console.error("aborting: duplicate node name per network:", key); process.exit(1); }
    seen.add(key);
  }
  for (const r of existing) {
    for (const n of nodes) {
      if (r.id !== n.id && r.network === n.network && slugOf(r.name) === slugOf(nameOf.get(n.id))) {
        console.error(`aborting: seed node ${n.id} clashes with store record ${r.id} on name "${r.name}"`);
        process.exit(1);
      }
    }
  }

  const now = new Date().toISOString();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const plan = nodes.map((n) => {
    if (byId.has(n.id)) return { action: "skip", why: "already in store (left untouched)", node: byId.get(n.id) };
    const codes = n.paynym ? mapping[n.paynym].codes.map((c) => c.code) : [];
    // Two things make a node unmigratable, and both are the store's rules
    // rather than this script's: no payment code means no owner, and no signed
    // pairing block means nothing a visitor can check. Refusing here rather
    // than letting putSubmission throw is what turns a stack trace part-way
    // through a migration into a plan you can read before anything is written.
    const node = toRecord(n, nameOf.get(n.id), codes, now);
    if (!codes.length) return { action: "refuse", why: "no BIP47 payment code", node };
    if (!hasSignedBlock(node)) return { action: "refuse", why: "no signed pairing block", node };
    return { action: "create", node };
  });

  console.log(`${DRY ? "DRY RUN — " : ""}migration plan (${nodes.length} seed nodes):`);
  for (const { action, why, node } of plan) {
    const owner = node.paynym || "(no PayNym)";
    console.log(`  ${action.padEnd(6)} ${node.id.padEnd(26)} name=${String(node.name).padEnd(18)} ${owner} (${(node.paymentCodes || []).length} codes)${why ? " — " + why : ""}`);
    if (action === "refuse") {
      console.log(`         REFUSED: ${node.id} ${why}, so it cannot be migrated.`);
      console.log(`         Give it a PayNym in data/paynym-codes.json and a signed pairing block, or drop it from the seed.`);
    }
  }

  const changes = plan.filter((p) => p.action === "create");
  const refused = plan.filter((p) => p.action === "refuse");
  const tail = refused.length ? ` ${refused.length} refused: ${refused.map((p) => p.node.id).join(", ")}.` : "";
  if (DRY) { console.log(`\ndry run: ${changes.length} change(s) would be made, nothing written.${tail}`); return; }
  if (!changes.length) { console.log(`\nnothing to do: every seed node already has a store record.${tail}`); return; }
  for (const { node } of changes) await store.putSubmission(node);
  console.log(`\napplied ${changes.length} change(s).${tail} Now run: node server/build-public.mjs`);
  console.log("Once the store records exist, slim data/seed.json to the anchor (your own node) in a separate commit.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}
