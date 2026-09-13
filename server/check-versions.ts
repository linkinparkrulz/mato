#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — report the Dojo version of every listing.
//
// READ-ONLY. Nothing is written and no network is touched: it reads what the
// updater has already recorded.
//
// Two versions per node, and the difference matters when choosing a minimum:
//
//   detected  from the node's own X-Dojo-Version header, read on every probe.
//             This is what it is actually running.
//   declared  the version inside the pairing payload. Frozen when that payload
//             was generated and signed, so it can be years out of date while
//             the node itself is current. At least one listing here declares
//             1.4.5 for exactly that reason.
//
// A minimum-version rule should therefore judge the DETECTED version. This
// report shows both, so a threshold can be chosen against the real spread.
//
// Usage, on the box:
//     cd /var/www/dojobay/server
//     node check-versions.ts             # against the configured minimum
//     node check-versions.ts 1.27.0      # against a threshold you are weighing
// =============================================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./store.ts";
import { MIN_DOJO_VERSION, judgeVersion, compareVersions } from "./dojo-version.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.PUBLIC_DATA_DIR || path.join(HERE, "..", "data");
const minimum = (process.argv.find((a) => /^\d/.test(a)) || MIN_DOJO_VERSION || "1.27.0").trim();

const dojos = await readFile(path.join(PUBLIC_DIR, "dojos.json"), "utf8")
  .then((t) => JSON.parse(t)).catch(() => ({ nodes: [] }));
const published = new Map((dojos.nodes || []).map((n: any) => [n.id, n]));
const records = (await store.listSubmissions())
  .filter((r) => r.status === "approved")
  .sort((a, b) => (a.network + a.name).localeCompare(b.network + b.name));

const rows = records.map((r) => {
  const pub: any = published.get(r.id) || {};
  const detected = pub.detected_version || null;
  const declared = r.payload?.pairing?.version || null;
  const verdict = judgeVersion(detected, declared, minimum);
  return { id: r.id, name: r.name || r.id, detected, declared, verdict, status: pub.status || "?" };
});

const pad = (s: string, n: number) => (s || "").padEnd(n);
console.log(`Minimum being applied: ${minimum}\n`);
console.log(pad("RECORD", 30) + pad("DETECTED", 12) + pad("DECLARED", 12) + pad("NODE", 10) + "VERDICT");
console.log("-".repeat(78));
for (const r of rows) {
  const v = r.verdict.ok ? "ok" : (r.verdict.version ? "BELOW MINIMUM" : "no version reported");
  console.log(pad(r.id, 30) + pad(r.detected || "—", 12) + pad(r.declared || "—", 12) + pad(r.status, 10) + v);
}

const below = rows.filter((r) => !r.verdict.ok && r.verdict.version);
const unknown = rows.filter((r) => !r.verdict.ok && !r.verdict.version);
const ok = rows.length - below.length - unknown.length;

console.log(`\n${ok} at or above ${minimum}, ${below.length} below, ${unknown.length} with no version reported.`);
if (below.length) {
  console.log("\nBelow the minimum:");
  for (const r of below) console.log(`  ${r.id}: ${r.verdict.version} (${r.verdict.source})`);
}
if (unknown.length) {
  console.log("\nNo version reported. A node that has never been probed successfully shows nothing here,");
  console.log("so check whether these are down rather than old before reading anything into it:");
  for (const r of unknown) console.log(`  ${r.id} (node currently ${r.status})`);
}

// The spread, which is what a threshold should actually be chosen against.
const seen = rows.map((r) => r.detected).filter(Boolean) as string[];
if (seen.length) {
  const uniq = [...new Set(seen)].sort(compareVersions);
  console.log(`\nDetected versions in use: ${uniq.join(", ")}`);
  console.log(`Oldest running: ${uniq[0]}. A minimum above that would refuse a node currently listed,`);
  console.log("though existing listings are never re-judged — the check applies to new submissions.");
}
process.exit(below.length || unknown.length ? 1 : 0);
