// Launcher for the public-list rebuild, which lives in build-public.ts.
//
// Kept as plain JavaScript, and kept under this name, for the same reasons as
// index.mjs:
//
//   1. It parses on any Node, so an operator on an older runtime gets the
//      message below rather than a syntax error from a file their Node cannot
//      execute. The check must precede the import, hence the dynamic import.
//   2. A lot of things outside this file invoke it by name: the deploy workflow,
//      `npm run build-public`, scripts/install.mjs, and — importantly —
//      scripts/apply-update.mjs, which spawns it during a self-update. That
//      helper is the OLD copy still running while new files are swapped in, so
//      an instance updating ACROSS a rename would spawn a file that no longer
//      exists and its rebuild would fail.
//
// New in-process callers should import ./build-public.ts directly.
const major = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(major) || major < 24) {
  console.error(
    `The Dojo Bay rebuild needs Node 24 or newer (found ${process.versions.node}).\n` +
    "It runs TypeScript directly, which relies on type stripping added in Node 24.\n" +
    "Upgrade Node, then re-run the rebuild.");
  process.exit(1);
}

const mod = await import("./build-public.ts");
export const rebuild = mod.rebuild;
export const displayPaymentCode = mod.displayPaymentCode;
export const effectiveVersion = mod.effectiveVersion;
export const effectiveIndexer = mod.effectiveIndexer;
export const retireUnlisted = mod.retireUnlisted;

// Run the rebuild when invoked directly (the .ts module's own check does not
// fire in that case, because argv[1] is this launcher).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const r = await mod.rebuild();
  console.log(r.msg);
}
