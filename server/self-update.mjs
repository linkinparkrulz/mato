// Self-update for a running Dojo Bay instance, driven from /admin. This is the
// most privileged path in the codebase -- it fetches code and restarts the
// service from a web request -- so every step is deliberate and auditable:
//
//   1. the SOURCE is verified before it is trusted:
//        - github: the archive is fetched over Tor; the commit it claims is
//          recorded, and the caller has already compared it via updates.mjs.
//        - peer:   the peer's data/operator.json signature must verify for the
//          onion it was fetched from (same trust gate as bootstrap-import),
//          and the operator must pass the peer's expected payment code.
//   2. instance data is NEVER in the archive (pack-source.mjs excludes the
//      store, seed, operator binding, histories, avatars), so an update only
//      ever replaces code.
//   3. the current code is BACKED UP to data/backups/<ts>/ before anything is
//      written, and the applier stages the new tree, then a DETACHED helper
//      swaps it in and restarts the service after this process has replied.
//
// The web layer (index.mjs) runs this as a background job and streams progress
// via a polled status object; this module just does the work and calls back
// with progress lines. Node builtins only here except the lazily-imported
// verifier (server/crypto.ts), which the server always has installed.
import { mkdir, writeFile, rm, cp, readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpOverTor } from "../scripts/update.mjs";

/** @see the call site in fetchFromPeer for why this is not the shared default. */
export const MAX_SOURCE_ZIP_BYTES = 8 * 1024 * 1024;
import { githubGet } from "./updates.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The most an archive may inflate to, in total, across every entry.
//
// MAX_SOURCE_ZIP_BYTES bounds what arrives over the wire; this bounds what it
// becomes. Deflate is not size-preserving and the gap is enormous: fifty
// megabytes of zeroes compresses to about fifty kilobytes, a ratio of roughly a
// thousand to one, so a peer could stay well inside the 8 MiB download ceiling
// and still hand back something that expands to gigabytes. The result would be
// an instance out of memory or out of disk part way through updating itself,
// which is the worst moment for it to happen: the operator's usual recourse is
// the box, and the box is the thing that has just stopped.
//
// 32 MiB against a real tree that inflates to 0.87 MiB across 70 entries, its
// largest single file 88 KiB. That is around thirty-five times the true figure,
// so the project can grow for a long time without anyone revisiting this, and
// the updater self-test asserts the real tree stays well under it so that
// growth is noticed as a decision rather than as a failed update.
//
// One budget rather than a per-entry limit and a total: each entry is inflated
// with whatever remains of the allowance, so a single enormous file and ten
// thousand merely large ones are refused by the same arithmetic.
export const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

// A zip's central directory declares its own entry count, so this bounds how
// many files a hostile archive can ask us to create. The byte budget above does
// not cover it: sixty thousand empty entries cost no memory and still write
// sixty thousand files into staging. 2000 against a real tree of 70.
export const MAX_ENTRIES = 2000;

// ---- unzip (matches scripts/pack-source.mjs's writer) ------------------------
// Reads the central directory and inflates stored/deflated entries. Guards
// against zip-slip: entries must stay under the single top-level folder, and
// against decompression bombs: see MAX_INFLATED_BYTES.
export function unzip(buf) {
  const files = [];
  let used = 0;
  // find End Of Central Directory
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error(`archive declares ${count} entries, more than the ${MAX_ENTRIES} allowed`);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    // local header -> data
    const lnameLen = buf.readUInt16LE(lho + 26);
    const lextraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    // Inflated against what is LEFT of the allowance, so the budget is spent
    // across the archive rather than per entry. zlib stops at the ceiling
    // instead of allocating and then being asked about it afterwards, which is
    // the whole point: checking data.length after inflateRawSync would mean the
    // memory had already been committed.
    const remaining = MAX_INFLATED_BYTES - used;
    let data;
    if (method === 8) {
      try {
        data = inflateRawSync(comp, { maxOutputLength: remaining });
      } catch (e) {
        // zlib reports this as a Buffer size error, which reads as an internal
        // fault rather than a rejected archive. Say what actually happened.
        if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || /larger than/.test(e.message || ""))) {
          throw new Error(`archive inflates past the ${MAX_INFLATED_BYTES} byte limit at entry ${name}`);
        }
        throw e;
      }
    } else {
      if (comp.length > remaining) {
        throw new Error(`archive inflates past the ${MAX_INFLATED_BYTES} byte limit at entry ${name}`);
      }
      data = Buffer.from(comp);
    }
    used += data.length;
    files.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function stripTopLevel(files) {
  // Everything sits under one top-level folder: "dojobay/" from pack-source,
  // "<owner>-<repo>-<sha>/" from a GitHub zipball. Strip exactly one segment.
  //
  // DIRECTORY ENTRIES ARE SKIPPED, and that is the whole reason this function
  // has a comment. A zip may carry an entry for each directory: zero bytes, a
  // name ending in a slash. GitHub's zipball has thirteen of them and the very
  // first entry in the archive is the bare top-level folder itself, which
  // strips to an empty relative path. The empty check below used to reject that
  // as an unsafe path, so a self-update from GitHub failed on entry one with a
  // message about a path traversal that was not happening.
  //
  // Every test passed throughout, because the fixtures are built by
  // pack-source, which writes no directory entries at all. The extractor was
  // only ever fed archives of its own shape. Nothing is lost by dropping them:
  // the writer calls mkdir with recursive:true for each file's parent, so the
  // directories are created as the files land, and git does not track empty
  // directories anyway.
  const out = [];
  for (const f of files) {
    const slash = f.name.indexOf("/");
    if (slash < 0) continue;                       // a bare top-level entry
    const rel = f.name.slice(slash + 1);
    // Traversal is refused for directory entries as well as files: a hostile
    // archive should not get a free pass by putting the slash on the end.
    if (rel.includes("..") || rel.startsWith("/")) throw new Error("unsafe path in archive: " + f.name);
    if (!rel || rel.endsWith("/")) continue;       // the folder itself, or one inside it
    // NOTHING under data/ is ever staged, whatever the archive contains.
    //
    // apply-update used to carry the comment "data/ is not in staging, so
    // instance state is untouched". That was true of an archive built by
    // pack-source, which excludes instance data by design, and false the moment
    // a GitHub zipball became a source: a zipball is the whole repository, and
    // seven files under data/ are committed to it. A self-update therefore
    // overwrote the instance's published list with the empty scaffold, its
    // reliability history with the repository's, its seed anchor, its operator
    // binding, and its version marker with "dev", which then made the update
    // check throw and report nothing useful. None of it was recoverable from
    // the backup either, because the backup excludes data/ for the same reason
    // this now does.
    //
    // Enforced here rather than in the caller, and by path rather than by a
    // list of filenames, because the assumption that broke was a caller's
    // assumption about what an archive contains. This holds for any archive
    // from any source, including ones nobody has thought of yet, and it is why
    // version.json is written afterwards from the commit that was fetched
    // instead of being taken from the tree.
    if (rel === "data" || rel.startsWith("data/")) continue;
    out.push({ rel, data: f.data });
  }
  return out;
}

// ---- source fetchers ---------------------------------------------------------
const cfgFrom = (o) => ({ proxyHost: o.proxyHost || "127.0.0.1", proxyPort: o.proxyPort || 9050 });

// A peer Dojo Bay serves its own code at /data/dojobay-src.zip. Verify who runs
// it before trusting a byte, exactly like bootstrap-import.
/**
 * @param {{ onionHost: string, trustedCode: string, cfg?: any,
 *   log?: (msg: string) => void, fetchDoc?: any, fetchZip?: any }} args
 */
export async function fetchFromPeer({ onionHost, trustedCode, cfg, log = (/** @type {string} */ _msg) => {}, fetchDoc, fetchZip }) {
  const c = cfgFrom(cfg || {});
  fetchDoc = fetchDoc || (async (p) => {
    const res = await httpOverTor(c, onionHost, 80, `GET ${p} HTTP/1.0\r\nHost: ${onionHost}\r\nConnection: close\r\n\r\n`, 30000);
    if (res.status !== 200) throw new Error(`${p}: HTTP ${res.status || "no response"}`);
    return res;
  });
  const { verifyOperatorDoc } = await import("./crypto.ts");
  log("fetching peer operator binding…");
  const opDoc = JSON.parse((await fetchDoc("/data/operator.json")).body);
  const v = verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
  if (!v.ok) throw new Error(`peer operator binding does not verify (${v.error})`);
  if (trustedCode && opDoc.paymentCode !== trustedCode) {
    throw new Error("peer is operated by a different payment code than the one you trusted");
  }
  log(`peer ${onionHost} verified ✓`);
  // The one response in the project that legitimately runs to megabytes, so it
  // opts out of httpOverTor's 2 MiB default and sets its own. 8 MiB against a
  // zip that is currently a little under 400 KiB: twenty times the real figure,
  // which leaves room for the tree to grow for years without anyone having to
  // think about this number, while still refusing a peer that tries to hand
  // back something the size of a disk image. Note that this bounds the DOWNLOAD
  // only: unzip() inflates each entry, so a peer could still send a small
  // archive that expands enormously, and bounding that is a separate job.
  const zres = fetchZip ? await fetchZip() : await httpOverTor(c, onionHost, 80,
    `GET /data/dojobay-src.zip HTTP/1.0\r\nHost: ${onionHost}\r\nConnection: close\r\n\r\n`, 120000,
    MAX_SOURCE_ZIP_BYTES);
  if (zres.status !== 200) throw new Error(`source zip: HTTP ${zres.status || "no response"}`);
  const bytes = zres.bodyBuf || Buffer.from(zres.body, "latin1");
  let version = null;
  try { const vf = JSON.parse((await fetchDoc("/data/version.json")).body); version = vf.commit || null; } catch {}
  return { bytes, sourceLabel: `peer ${onionHost}`, version };
}

// GitHub's zipball for a ref, over Tor. The archive nests under a generated
// "<owner>-<repo>-<sha>/" folder, which stripTopLevel handles the same way.
/**
 * @param {{ repo?: string, ref?: string, cfg?: any,
 *   log?: (msg: string) => void, transport?: any }} [args]
 */
// The repo path is read from the same GITHUB_REPO used by the update check, so
// moving the project to another organisation needs one environment variable
// rather than an edit in two files that could drift apart.
export async function fetchFromGitHub({ repo = process.env.GITHUB_REPO || "Dojobay/dojobay", ref = "main", cfg, log = (/** @type {string} */ _msg) => {}, transport } = {}) {
  const c = cfgFrom(cfg || {});
  transport = transport || githubGet;
  log("resolving latest commit…");
  const br = await transport(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, c);
  if ( br.status !== 200) throw new Error(`commit lookup: HTTP ${br.status}`);
  const sha = JSON.parse(br.body).sha;
  log(`downloading ${repo}@${sha.slice(0, 8)} over Tor…`);
  const zres = await transport(`/repos/${repo}/zipball/${sha}`, { ...c, binary: true, timeoutMs: 120000 });
  if (zres.status !== 200) throw new Error(`zipball: HTTP ${zres.status}`);
  const bytes = zres.bodyBuf || Buffer.from(zres.body, "latin1");
  return { bytes, sourceLabel: `github ${repo}`, version: sha };
}

// ---- apply -------------------------------------------------------------------
// Stages the new tree next to the web root, backs up the current one, then
// spawns a detached helper that swaps and restarts. Returns before the swap so
// the caller can reply "restarting" to the browser.
/**
 * @param {{ bytes?: Buffer, sourceLabel?: string, version?: any, webRoot?: string,
 *   log?: (msg: string) => void, spawnHelper?: boolean }} [args]
 */
export async function applyUpdate({ bytes, sourceLabel, version, webRoot = ROOT, log = (/** @type {string} */ _msg) => {}, spawnHelper = true } = {}) {
  log("verifying archive…");
  const entries = stripTopLevel(unzip(bytes));
  if (!entries.some((e) => e.rel === "server/index.mjs") || !entries.some((e) => e.rel === "assets/js/app.js")) {
    throw new Error("archive does not look like a Dojo Bay source tree");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = path.join(webRoot, "data", "updates", stamp, "new");
  const backupDir = path.join(webRoot, "data", "backups", stamp);
  await rm(path.join(webRoot, "data", "updates", stamp), { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  log(`writing ${entries.length} files to staging…`);
  for (const { rel, data } of entries) {
    const dest = path.join(staging, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }

  // Preserve executable bits the archive is known to carry.
  for (const rel of ["install.sh"]) {
    try { const { chmod } = await import("node:fs/promises"); await chmod(path.join(staging, rel), 0o755); } catch {}
  }

  log(`backing up current code to data/backups/${stamp}…`);
  await mkdir(backupDir, { recursive: true });
  // Back up code only, never instance data. The exclusion is decided on the
  // path RELATIVE to the web root, matched a segment at a time.
  //
  // It used to be a substring test against the absolute path, which was wrong
  // in a way that only showed up at certain install locations and then showed
  // up catastrophically. An instance deployed under, say, /srv/data/dojobay has
  // "/data/" in every absolute path it owns, so every entry was excluded, cp
  // copied nothing, and because this loop swallows its errors the update
  // carried on and replaced the running code with no backup at all. The backup
  // is the whole recovery story for a self-update; silently not taking one is
  // the worst available outcome. "node_modules" had the same shape of bug.
  //
  // Failures are still swallowed per entry, deliberately: a tree that lacks
  // install.sh should not fail an update. What is no longer possible is
  // swallowing ALL of them and calling it a backup, which the check below
  // catches.
  const excluded = new Set(["node_modules", "data"]);
  let backedUp = 0;
  for (const rel of ["assets", "content", "deploy", "scripts", "server", ".github",
    "index.html", "manifest.json", "sw.js", "package.json", "README.md", "CONTRIBUTING.md",
    "install.sh"]) {
    const src = path.join(webRoot, rel);
    try {
      await stat(src);
      await cp(src, path.join(backupDir, rel), {
        recursive: true,
        filter: (p) => {
          const relPath = path.relative(webRoot, p);
          // Outside the web root entirely: a symlink pointing away. Refuse it
          // rather than following it into somebody's home directory.
          if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return false;
          return !relPath.split(path.sep).some((seg) => excluded.has(seg));
        },
      });
      backedUp++;
    } catch { /* absent from this tree; not every install has every entry */ }
  }
  // server/ and assets/ exist in every Dojo Bay tree, so backing up fewer than
  // two entries means something is wrong with the copy rather than with the
  // tree. Refuse to go on: swapping in new code without a backup is the one
  // failure this whole path exists to make survivable.
  if (backedUp < 2) {
    throw new Error(`backup produced only ${backedUp} entr${backedUp === 1 ? "y" : "ies"} from ${webRoot}; refusing to update without one`);
  }

  const manifest = { source: sourceLabel, version, staged_at: stamp, files: entries.length };
  await writeFile(path.join(webRoot, "data", "updates", stamp, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (!spawnHelper) return { stamp, staging, backupDir, entries: entries.length, manifest };

  // Detached helper: runs after this process replies, swaps staged files into
  // the web root, reinstalls server deps, rebuilds, repacks, restarts service.
  log("handing off to the swap helper (the service will restart)…");
  const helper = path.join(webRoot, "scripts", "apply-update.mjs");
  const child = spawn(process.execPath, [helper, "--staging", staging, "--webroot", webRoot, "--version", String(version || "")], {
    detached: true, stdio: "ignore", cwd: webRoot,
  });
  child.unref();
  return { stamp, staging, backupDir, entries: entries.length, manifest, handedOff: true };
}
