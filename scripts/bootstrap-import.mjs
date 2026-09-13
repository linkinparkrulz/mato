#!/usr/bin/env node
// Bootstrap a new Dojo Bay from a TRUSTED existing instance, so a fresh
// directory is mature the moment it starts: its nodes become approved store
// records here and their reliability histories carry over.
//
//   node scripts/bootstrap-import.mjs --onion <56-char>.onion \
//        --code PM8T... [--dry-run]
//
// Trust is verified before anything is imported: the remote instance's
// data/operator.json must bind that onion to exactly the payment code YOU
// typed in, under a valid wallet signature (server/crypto.ts). If the
// signature does not verify, or binds a different onion or code, nothing is
// fetched further. After that: dojos.json supplies the nodes, both history
// files supply the record, and each PayNym is resolved against paynym.rs
// (over Tor) for its full BIP47 code-variant set so imported operators can
// sign in here with either variant. Existing ids are never touched; history
// is only written for ids that have none.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { httpOverTor } from "./update.mjs";
import { store, hasSignedBlock } from "../server/store.ts";
import { verifySignedPayload, canonicalPairing } from "../server/crypto.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");

const defaultCfg = () => ({
  proxyHost: process.env.TOR_SOCKS_HOST || "127.0.0.1",
  proxyPort: +(process.env.TOR_SOCKS_PORT || 9050),
});

// GET a JSON document from the remote instance over Tor.
async function torFetchJSON(onionHost, urlPath, cfg, timeoutMs = 30000) {
  const req = `GET ${urlPath} HTTP/1.0\r\nHost: ${onionHost}\r\nUser-Agent: dojobay-bootstrap\r\nConnection: close\r\n\r\n`;
  const res = await httpOverTor(cfg, onionHost, 80, req, timeoutMs);
  if (res.status !== 200) throw new Error(`${urlPath}: HTTP ${res.status || "no response"}`);
  return JSON.parse(res.body);
}

// A temporary name no other writer can take; see server/build-public.ts. The
// counter matters as well as the pid: one import writes the seed, both history
// files and the avatars in quick succession.
let tmpSeq = 0;
async function writeJSONAtomic(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${(tmpSeq = (tmpSeq + 1) % 1e6)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, p);
}

// fetchers are injectable for the self-test: fetchDoc(urlPath) -> object,
// fetchCodes(paynymOrCode) -> [{code, segwit}, ...]
/**
 * @param {{ onionHost?: string, trustedCode?: string, dryRun?: boolean, dataDir?: string,
 *   log?: (...a: any[]) => void, fetchDoc?: any, fetchCodes?: any,
 *   status?: "approved" | "pending" }} [opts]
 */
export async function bootstrapImport({
  onionHost, trustedCode, dryRun = false, dataDir = DATA_DIR, log = console.error,
  fetchDoc, fetchCodes, status = "approved",
} = {}) {
  const cfg = defaultCfg();
  fetchDoc = fetchDoc || ((p) => torFetchJSON(onionHost, p, cfg));
  if (!fetchCodes) {
    const { fetchNymCodes } = await import("../server/paynym.mjs");
    fetchCodes = (nym) => fetchNymCodes(nym);
  }

  // 1) trust gate: the remote operator binding must verify for THIS onion and
  //    exactly the payment code the operator typed in.
  const { verifyOperatorDoc } = await import("../server/crypto.ts");
  const opDoc = await fetchDoc("/data/operator.json");
  const v = verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
  if (!v.ok) throw new Error(`refusing to import: remote operator binding does not verify (${v.error})`);
  if (opDoc.paymentCode !== trustedCode) {
    throw new Error("refusing to import: the remote instance is operated by a DIFFERENT payment code than the one you trusted");
  }
  log(`trusted: ${onionHost} is signed by ${trustedCode.slice(0, 12)}… ✓`);

  // 2) data
  const dojos = await fetchDoc("/data/dojos.json");
  const hist = await fetchDoc("/data/history.json").catch(() => ({ nodes: {} }));
  const daily = await fetchDoc("/data/history-daily.json").catch(() => ({ nodes: {} }));
  const nodes = (dojos.nodes || []).filter((n) => n.payload?.pairing?.url);

  // The pairing URL identifies a physical Dojo; an id does not.
  //
  // An operator installing a new instance names their own node in the anchor,
  // then bootstraps from a directory that already lists it. The two ids differ,
  // because each instance derives one from the name it was given, so the same
  // machine arrived twice: once as the anchor and once as an import, with its
  // reliability history split between them. What is actually the same thing is
  // the onion address in the signed pairing payload, which is why matching on
  // it is not a heuristic. Two listings cannot share one, and an operator
  // cannot claim somebody else's without the signature failing.
  //
  // Compared as a whole URL rather than by host alone, because one machine may
  // legitimately serve mainnet at /v2 and testnet at /test/v2, and those are
  // two listings. Lower-cased and stripped of a trailing slash, since neither
  // changes which endpoint is meant.
  const pairingKey = (n) => {
    const u = n?.payload?.pairing?.url;
    if (typeof u !== "string" || !u) return null;
    return u.trim().toLowerCase().replace(/\/+$/, "");
  };

  // Everything this instance already lists, from the store AND from the seed
  // anchor. The anchor is not a store record, which is exactly why it was
  // invisible to this check and why the operator's own node was the one node
  // guaranteed to duplicate.
  const localByUrl = new Map();
  for (const r of await store.listSubmissions()) {
    const k = pairingKey(r);
    if (k) localByUrl.set(k, r.id);
  }
  try {
    const seed = JSON.parse(await readFile(path.join(dataDir, "seed.json"), "utf8"));
    for (const n of seed.nodes || []) {
      const k = pairingKey(n);
      if (k && !localByUrl.has(k)) localByUrl.set(k, n.id);
    }
  } catch { /* no anchor yet, which is normal on a bare install */ }

  // 3) plan records: skip existing ids; resolve full code sets per PayNym
  const existingIds = new Set((await store.listSubmissions()).map((r) => r.id));
  const plan = [];
  const codeCache = new Map();
  for (const n of nodes) {
    if (existingIds.has(n.id)) { plan.push({ action: "skip", n }); continue; }
    // Same machine under a different id. The record is not created, because a
    // second listing for one Dojo is worse than a missing one, but the history
    // is worth having: it is the same node's record of itself, and dropping it
    // would restart an operator's reliability figures from nothing on a machine
    // that has been up for months. Carried onto the id this instance uses.
    const dupOf = localByUrl.get(pairingKey(n));
    if (dupOf) { plan.push({ action: "merge", n, dupOf }); continue; }
    // A published node from another instance carries its signed block in
    // dojos.json, so an unsigned one either predates the rule there or was
    // published by an instance that does not enforce it. Either way it cannot
    // enter this store, and saying so in the plan is better than a throw from
    // putSubmission half way through the import.
    if (!hasSignedBlock(n)) { plan.push({ action: "refuse", n, why: "no signed pairing block" }); continue; }
    // And the block must actually verify, here, against the payload it claims
    // to cover.
    //
    // hasSignedBlock only looks for the two header lines, and putSubmission
    // enforces nothing more, so until this check an imported listing's
    // signature was taken on the source instance's word: a directory that was
    // careless or compromised could publish a well-formed block that verifies
    // against nothing, and every instance bootstrapping from it would list the
    // node. This is the same standard the domain badges above are already held
    // to, and for the same reason: one compromised directory must not be able
    // to place listings across a federation.
    //
    // Offline and self-contained. canonicalPairing derives the message from the
    // payload being imported, so a payload altered in transit no longer matches
    // what was signed, and the addresses come from the payment code named
    // inside the block itself rather than from anything the source asserts.
    const sig = verifySignedPayload({
      signedText: n.signed,
      expectedMessage: canonicalPairing(n.payload),
      network: n.network === "testnet" ? "testnet" : "bitcoin",
    });
    if (!sig.ok) { plan.push({ action: "refuse", n, why: `signature does not verify (${sig.error})` }); continue; }
    let codes = n.paymentCode ? [n.paymentCode] : [];
    if (n.paynym) {
      if (!codeCache.has(n.paynym)) codeCache.set(n.paynym, await fetchCodes(n.paynym).catch(() => []));
      const all = codeCache.get(n.paynym).map((c) => c.code);
      if (all.length) codes = [...new Set([...all, ...codes])];
    }
    if (!codes.length) { plan.push({ action: "refuse", n, why: "no BIP47 payment code" }); continue; }
    plan.push({ action: "import", n, codes });
  }

  const now = new Date().toISOString();
  for (const { action, n, codes, why } of plan) {
    log(`  ${action.padEnd(6)} ${n.id.padEnd(28)} ${n.paynym || "(no PayNym)"} (${(codes || []).length} codes)${why ? " — " + why : ""}`);
  }
  const imports = plan.filter((p) => p.action === "import");
  const merges = plan.filter((p) => p.action === "merge");
  const refused = plan.filter((p) => p.action === "refuse");
  for (const m of merges) {
    log(`  merge  ${m.n.id.padEnd(28)} same Dojo as ${m.dupOf}: history only, no second listing`);
  }
  if (refused.length) log(`refused ${refused.length} node(s) that cannot be listed here: ${refused.map((p) => p.n.id).join(", ")}`);
  // The plan as data, not as log lines. The command line reads the log; the
  // admin console has to render this and let an operator decide, and parsing
  // the log back out would be inventing a format nobody agreed on.
  const rows = plan.map(({ action, n, codes, dupOf, why }) => ({
    action, id: n.id, name: n.name || n.id, network: n.network || null,
    paynym: n.paynym || null, url: n?.payload?.pairing?.url || null,
    codes: (codes || []).length, dupOf: dupOf || null, why: why || null,
  }));
  if (dryRun) {
    log(`dry run: ${imports.length} node(s) would be imported`
      + (merges.length ? `, ${merges.length} recognised as already listed here` : "")
      + ", nothing written.");
    return { imported: 0, planned: imports.length, merged: merges.length,
      refused: refused.length, plan: rows, status };
  }

  for (const { n, codes } of imports) {
    await store.putSubmission({
      id: n.id, network: n.network, name: n.name || n.id,
      paymentCodes: codes, paynym: n.paynym || null,
      jurisdiction: n.jurisdiction || null, country: n.country || null,
      hardware: n.hardware || null, payload: n.payload,
      signed: n.signed || null,
      // approved at install, because choosing to bootstrap from a directory IS
      // the decision to trust its list. An import into a running instance
      // arrives pending instead, so it lands in the moderation queue the
      // operator already uses and nothing is published until they say so.
      status, source: `bootstrap-import:${onionHost}`,
      created_at: now, updated_at: now,
    });
  }

  // 3b) verified operator domains.
  //
  // dojos.json publishes each badge's proof, and the signed statement is
  // deliberately portable: it names the domain and the payment code, never the
  // instance that verified it. So a claim travels intact — but it is NOT taken
  // on the source's word. We re-verify the signature here, locally and offline,
  // and store the claim UNVERIFIED so this instance's own sweep must see the TXT
  // record with its own eyes before any badge appears. Importing a badge because
  // another instance said so would make one compromised directory able to mint
  // verified domains across a federation.
  const claims = new Map();
  for (const n of dojos.nodes || []) {
    const pf = n.operator_domain_proof;
    if (!pf || !pf.domain || !pf.paymentCode || !pf.signed) continue;
    if (claims.has(pf.paymentCode)) continue;
    claims.set(pf.paymentCode, pf);
  }
  let domainsImported = 0, domainsRefused = 0;
  if (claims.size) {
    const { verifySignedUrlClaim } = await import("../server/crypto.ts");
    for (const [code, pf] of claims) {
      if (await store.getDomain(code)) continue;                 // never overwrite a local claim
      const v = verifySignedUrlClaim({ signed: pf.signed, expectedUrl: `https://${pf.domain}`, paymentCode: code });
      if (!v.ok) {
        log(`  domain  ${pf.domain}: refused (${v.error})`);
        domainsRefused++;
        continue;
      }
      await store.putDomain({
        paymentCode: code, domain: pf.domain, signed: pf.signed,
        verified: false,                    // this instance has not seen the DNS yet
        verified_at: null,
        last_check: null,                   // so the sweep picks it up immediately
        last_result: `imported from ${onionHost}; awaiting our own DNS check`,
        fail_since: null, created_at: now,
      });
      log(`  domain  ${pf.domain}: signature verified, awaiting our own TXT lookup`);
      domainsImported++;
    }
  }

  // 4) histories: only for ids we have no history for
  for (const [file, remote] of [["history.json", hist], ["history-daily.json", daily]]) {
    const p = path.join(dataDir, file);
    let local; try { local = JSON.parse(await readFile(p, "utf8")); } catch { local = { nodes: {} } }
    local.nodes = local.nodes || {};
    let added = 0;
    for (const [id, entry] of Object.entries(remote.nodes || {})) {
      if (!local.nodes[id] && imports.some((x) => x.n.id === id)) { local.nodes[id] = entry; added++; continue; }
      // A duplicate contributes its history under the id this instance uses.
      //
      // The two series are combined rather than one replacing the other. An
      // anchor installed an hour ago has a handful of checks of its own and the
      // remote has months: overwriting throws away the local ones, skipping
      // throws away the months, and neither is what an operator means by
      // importing history. Combined, de-duplicated on the timestamp, sorted,
      // and trimmed to the same window the updater keeps.
      const merged = merges.find((x) => x.n.id === id);
      if (!merged) continue;
      const key = entry.checks ? "checks" : "days";
      const stamp = key === "checks" ? "t" : "d";
      const mine = (local.nodes[merged.dupOf] || {})[key] || [];
      const theirs = entry[key] || [];
      if (!theirs.length) continue;
      const byStamp = new Map();
      // Local last, so a period this instance measured itself wins over the
      // remote's account of the same period.
      for (const row of [...theirs, ...mine]) if (row && row[stamp]) byStamp.set(row[stamp], row);
      const all = [...byStamp.values()].sort((x, y) => String(x[stamp]).localeCompare(String(y[stamp])));
      const cap = key === "checks" ? (remote.window_checks || local.window_checks || 144) : 90;
      local.nodes[merged.dupOf] = { [key]: all.slice(-cap) };
      added++;
    }
    if (added) {
      if (remote.interval_minutes && !local.interval_minutes) local.interval_minutes = remote.interval_minutes;
      if (remote.window_checks && !local.window_checks) local.window_checks = remote.window_checks;
      await writeJSONAtomic(p, local);
      log(`  history: ${added} node(s) carried into ${file}`);
    }
  }
  log(`imported ${imports.length} node(s) from ${onionHost}`
    + (merges.length ? `, and recognised ${merges.length} as node(s) this instance already lists` : "")
    + ". Now run: node server/build-public.mjs");
  return { imported: imports.length, planned: imports.length, merged: merges.length,
    refused: refused.length, plan: rows, status,
    domains_imported: domainsImported, domains_refused: domainsRefused };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const onionHost = String(arg("--onion") || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const trustedCode = arg("--code");
  if (!/^[a-z2-7]{56}\.onion$/.test(onionHost) || !trustedCode) {
    console.error("usage: node scripts/bootstrap-import.mjs --onion <56-char>.onion --code PM8T... [--dry-run]");
    process.exit(1);
  }
  bootstrapImport({ onionHost, trustedCode, dryRun: process.argv.includes("--dry-run") })
    .catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}
