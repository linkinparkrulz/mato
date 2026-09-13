#!/usr/bin/env node
// Pack this instance's own codebase into data/dojobay-src.zip, so the running
// site is its own distribution point: visitors download exactly the code the
// instance runs (the footer's source icon), with no reliance on GitHub being
// reachable. Node builtins only -- the ZIP container is written by hand
// (deflate entries via zlib + a central directory), because a bare box has no
// `zip` binary and scripts/ must run everywhere.
//
//   node scripts/pack-source.mjs          write data/dojobay-src.zip
//
// What goes in is manifest-driven, and what stays out matters more than what
// goes in: NEVER the submission store (Dojo API keys, sessions), never the
// instance's generated data (dojos.json, history, avatars), and never its
// identity (seed.json anchor, operator.json binding, paynym-codes.json), so
// extracting the zip over an existing web root upgrades the CODE and touches
// nothing the instance owns. data/version.json IS included: it states which
// commit the code is, which is exactly what a downloader wants to know.
import { readFile, writeFile, rename, readdir, stat, mkdir } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "dojobay/";                       // extraction lands in one folder

const INCLUDE_FILES = [
  "index.html", "manifest.json", "sw.js", "favicon.svg", "og-image.png",
  // LICENSE travels with THIRD-PARTY-NOTICES.md: the archive is a distributed
  // copy of the source, and the README it contains links to the notices.
  // SECURITY.md travels for the same reason: a recipient who finds a
  // vulnerability in this copy needs to be told where to send it.
  "LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", "package.json",
  "tsconfig.json", "types.d.ts",
  "install.sh", "uninstall.sh",
  "data/version.json",
];
// docs/ holds the reasoning: why things are shaped as they are and what was
// tried and rejected. It is the most useful thing in the tree to anyone
// changing the code, and this archive is how a peer instance receives the code.
const INCLUDE_DIRS = ["assets", "content", "deploy", "docs", "scripts", "server", ".github"];
const DENY = [
  "server/data", "server/node_modules", "node_modules", ".git",
  "data/dojos.json", "data/history.json", "data/history-daily.json",
  "data/avatars", "data/seed.json", "data/operator.json", "data/paynym-codes.json",
  "data/updates", "data/backups",
];
const denied = (rel) => DENY.some((d) => rel === d || rel.startsWith(d + "/"))
  || rel.endsWith(".zip") || path.basename(rel) === ".DS_Store";

async function collect(root) {
  const out = [];
  for (const f of INCLUDE_FILES) {
    try { await stat(path.join(root, f)); out.push(f); } catch { /* absent on this instance */ }
  }
  async function walk(rel) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel + "/" + e.name;
      if (denied(r)) continue;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out.push(r);
    }
  }
  for (const d of INCLUDE_DIRS) {
    try { await stat(path.join(root, d)); await walk(d); } catch { /* absent */ }
  }
  return out.sort();
}

// ---- minimal ZIP writer (PKZIP appnote: local headers + central directory) --
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const dosTime = (d) => (((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff);
const dosDate = (d) => ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

function buildZip(entries) {                     // entries: [{name, data, mtime, mode}]
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, mtime, mode = 0o644 } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length < data.length;
    const body = stored ? deflated : data;
    const method = stored ? 8 : 0;
    const crc = crc32(data);
    const t = u16(dosTime(mtime)), dt = u16(dosDate(mtime));
    const common = Buffer.concat([
      u16(20), u16(0x0800 /* UTF-8 names */), u16(method), t, dt,
      u32(crc), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0),
    ]);
    locals.push(Buffer.concat([u32(0x04034b50), common, nameBuf, body]));
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16((3 << 8) | 20 /* unix */), common, u16(0), u16(0), u16(0),
      u32(((0o100000 | mode) >>> 0) * 0x10000) /* unix mode in high word */, u32(offset), nameBuf,
    ]));
    offset += locals[locals.length - 1].length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, end]);
}

export async function packSource({ root = ROOT, outDir = path.join(ROOT, "data") } = {}) {
  const files = await collect(root);
  const entries = [];
  for (const rel of files) {
    const p = path.join(root, rel);
    const [data, st] = [await readFile(p), await stat(p)];
    entries.push({ name: PREFIX + rel, data, mtime: st.mtime, mode: st.mode & 0o777 });
  }
  const zip = buildZip(entries);
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, "dojobay-src.zip");
  await writeFile(out + ".tmp", zip);
  await rename(out + ".tmp", out);
  return { out, files: files.length, bytes: zip.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  packSource().then((r) => console.log(`wrote ${r.out}: ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KiB`))
    .catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}
