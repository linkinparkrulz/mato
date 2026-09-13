// Launcher for the backend, which lives in index.ts.
//
// This file stays plain JavaScript on purpose, for three reasons:
//
//   1. It can be parsed by ANY Node version, so an operator on an older runtime
//      gets the message below instead of a syntax error from a .ts file they
//      cannot execute. The check must run before the import, hence the dynamic
//      import rather than a static one.
//   2. systemd, `npm start` and the README all name index.mjs, so nothing about
//      deployment changes.
//   3. self-update.mjs sanity-checks that an update archive contains
//      server/index.mjs before accepting it. Renaming this file outright would
//      make every legitimate update look malformed.
const major = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(major) || major < 24) {
  console.error(
    `The Dojo Bay backend needs Node 24 or newer (found ${process.versions.node}).\n` +
    "It runs TypeScript directly, which relies on type stripping added in Node 24,\n" +
    "and its BIP47 libraries require it too. Upgrade Node, then restart the service.");
  process.exit(1);
}

const mod = await import("./index.ts");
export const server = mod.server;
export const routes = mod.routes;
