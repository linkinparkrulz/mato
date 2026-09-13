# Contributing to The Dojo Bay

Thanks for helping. This file covers development setup, the project's layout,
how to run the test suites, and the conventions the codebase follows. What
the project is and how to run a production instance are in the
[README](README.md). Node listings are not contributions to this repository:
operators submit them through the site's Auth47 flow.

## Development setup

The front end needs nothing but Node (any static server works too, but
opening `index.html` from disk is blocked by the browser because everything
loads over `fetch`):

```
npm run dev            # serves the repo at http://localhost:8080
```

The backend runs separately when you are working on submissions, Auth47 or
moderation:

```
cd server && npm ci
PORT=8787 BASE_URL=http://localhost:8080 ADMIN_PAYMENT_CODES=<your PM8...> node index.mjs
```

The front end shows **Manage my Dojo** only once `/api/me` answers, so the
button appearing is your sign the backend is up. `PUBLIC_DATA_DIR` and
`SERVER_DATA_DIR` override where the public JSON and the submission store
live; the test suites rely on those to isolate themselves from real data.

## Project structure

```
index.html                 # slim shell: loads the css + js below
manifest.json, sw.js       # PWA manifest and service worker
assets/
  css/styles.css           # all styling (CSS variables + @font-face at the top)
  js/app.js                # directory UI, Manage panel, admin console
  js/markdown.js           # tiny dependency-free Markdown renderer
  js/qrcode.js             # vendored QR encoder (qrcode-generator, MIT)
  fonts/, icons/           # self-hosted woff2 + PWA icons
content/
  about.md, faq.md, disclaimer.md   # modal copy: edit these, no JS required
data/
  seed.json                # instance ANCHOR: the operator's own node (exactly one)
  dojos.json               # GENERATED public list: committed EMPTY, see below
  history.json             # rolling 24h check series   (instance-owned)
  history-daily.json       # 90-day daily rollups       (instance-owned)
  operator.json            # signed onion<->payment-code binding for Verify
  paynym-codes.json        # PayNym -> BIP47 code variants (migration + display)
server/
  index.mjs                # Auth47 + submissions + moderation API (localhost)
  updates.mjs              # commits/releases-behind check against GitHub, over Tor
  self-update.mjs          # fetch (github/peer) + verify + stage a source update
  build-public.mjs         # merges seed + approved store into dojos.json
  store.ts, crypto.ts, paynym.mjs, admin.mjs
  selftest.mjs             # backend test suite (see below)
scripts/
  install.mjs              # guided installer; stages talk to installer-ui.mjs
  installer-ui.mjs         # the installer's one interface: a sequential flow
  tui.mjs                  # PARKED full-screen toolkit; nothing routes to it, see below
  installer-lib.mjs        # installer's pure logic: validators, config renderers
  bootstrap-import.mjs     # import nodes + history from a trusted instance (signature-gated)
  update.mjs               # ten-minute Tor prober; maintains statuses + history
  apply-update.mjs         # detached helper: swap staged code + restart service
  migrate-seed-to-store.mjs# idempotent seed -> store migration (--dry-run)
  selftest.mjs             # offline tests of the reachability logic
  pack-source.mjs          # packs the instance's own code into data/dojobay-src.zip
  serve.mjs                # zero-dependency dev server
  reconcile-system.mjs     # /etc units, nginx site and polkit rule vs what ships here
  dojobay-server.service, dojobay-update.{service,timer}
deploy/
  nginx-onion.conf.example # localhost bind, /api/ proxy, /server/ blocked
  polkit-restart.rules.example # lets the service account restart its own unit
.github/workflows/deploy.yml, tests.yml
```

`data/dojos.json`, both history files and `server/data/` are owned by the
running instance: never hand-edit them, and never let a deploy overwrite
them. The deploy workflow excludes them for that reason, and `server/data/`
is gitignored because the store holds Dojo API keys and live sessions.

The committed `data/dojos.json` is an **empty scaffold**, and should stay that
way. The file has to exist so a freshly installed instance serves something at
`/data/dojos.json` before its first rebuild rather than a 404, but its contents
are worthless in the repository and actively harmful: a real snapshot goes stale
within days, publishes every listed operator's API key at a frozen moment, and
invites someone to read the instance's state from a file that has not described
it for weeks. `generated_at: null` is deliberate, since it makes the front end
report the directory as never refreshed and show an empty state that says so.
Do not commit a populated one, and do not treat a diff to this file as a
routine refresh.

## Tests

Three suites and a type check, and all four must pass before a change ships.

From a fresh clone, install twice before running anything: the root install
brings in TypeScript and `@types/node` for the checker, and the `server` install
brings in the runtime dependencies the checker also needs to resolve. Skipping
the second leaves `tsc` reporting missing modules for `@dojo-tools/*` and
`@bitcoinerlab/secp256k1`, which looks like a broken tree and is not.

```
npm install                    # root: typescript + @types/node
cd server && npm ci && cd ..   # runtime dependencies
npm run typecheck              # must exit 0
node scripts/selftest.mjs
cd server && node selftest.mjs && cd ..
node scripts/e2e-harness.mjs
```

Take a `sha256sum` of `data/dojos.json` and `data/history*.json` before and
after. A suite that changes instance data is a bug in the suite.

**Backend** — `cd server && node selftest.mjs`. Spins up the real API against
temp data directories with a mock Tor proxy and a mock Dojo, and exercises
Auth47 end to end with a throwaway BIP39 wallet: challenge, signed callback,
sessions, the connection and signature gates, submissions, name uniqueness,
multi-code ownership, editing, moderation, publish failures, history
retirement and resurrection, the migration script (dry-run, apply,
idempotence) and the export endpoint.

**Updater** — `node scripts/selftest.mjs`. Offline checks of the
reachability-detection logic against mock sockets.

**Front end** — `scripts/e2e-harness.mjs`, a JSDom harness that boots
`assets/js/app.js` with stubbed fetch and asserts rendering behaviour:
card titles and ordering, the payment-code chip, build-hash persistence
across re-renders, the mobile menu, Manage-panel ordering and the inline
editor (name, hardware and link only — the Dojo version is read live from
the node by the updater and is not editable). The harness is committed;
its single dependency (jsdom) is side-installed once and never added to a
package.json, so the front end and `scripts/` stay dependency-free:

```
mkdir -p /tmp/e2e && cd /tmp/e2e && npm init -y && npm install jsdom
cd <repo> && node scripts/e2e-harness.mjs
```

One invariant applies to every test run: the instance-owned files must be
byte-identical before and after. Gate your runs with checksums —

```
sha256sum data/dojos.json data/history*.json > /tmp/before.sha
# ... run tests ...
sha256sum -c /tmp/before.sha
```

— and treat any difference as a bug in the test's isolation, not as noise.

### The same gate, in CI

`.github/workflows/tests.yml` runs everything above on Node 24 for every pull
request and every push to `main`: both installs, the type check, the three
suites, jsdom side-installed outside the workspace, and the checksum comparison.
Nothing here replaces running it locally. The deploy fires on the same push and
does not wait for this job, so on a direct push to `main` the result arrives
after the code is on the instance, which is better than never but is not a gate.
A pull request is the only path on which it runs before anything ships.

### CodeQL, before pushing rather than after

This repository uses GitHub's default code scanning setup, which runs the
`code-scanning` query suite against every push to `main`. The deploy workflow
fires on the same push, so by the time an alert appears the code is already on
the instance. Run the analysis locally first and the alert never happens.

The bundle is a large download and deliberately lives outside the repository,
like jsdom, so that `scripts/` and the front end stay dependency-free:

```
cd /tmp && curl -sL -o cq.tar.zst \
  "https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.26.2/codeql-bundle-linux64.tar.zst"
tar --zstd -xf cq.tar.zst          # gives /tmp/codeql

cd <repo> && /tmp/codeql/codeql database create /tmp/cqdb \
  --language=javascript-typescript --source-root=. --overwrite
/tmp/codeql/codeql database analyze /tmp/cqdb javascript-code-scanning.qls \
  --format=sarif-latest --output=/tmp/cq.sarif
```

`javascript-code-scanning.qls` is the suite that produces the alerts you will
actually see, and it is the one that must come back empty.
`javascript-security-and-quality.qls` is a superset worth running occasionally
for information: it currently reports around two dozen findings, mostly unused
bindings and test-only temporary-file patterns, none of which raise an alert.
Do not mistake one for the other, and do not change code to satisfy the superset
without deciding that the finding is worth acting on.

**The launchers are invisible to it.** CodeQL treats a `.js` or `.mjs` file
sitting beside a `.ts` file of the same name as compiled output and skips it, so
`server/index.mjs` and `server/build-public.mjs` are extracted by neither the
local run nor GitHub's. That is 39 of 41 files, and the two it drops are the two
this project hand-writes on purpose (see The launcher pattern). Scan them by
copying them somewhere their `.ts` siblings are not:

```
mkdir -p /tmp/launchers && cp server/index.mjs server/build-public.mjs /tmp/launchers/
/tmp/codeql/codeql database create /tmp/cqdb-launchers \
  --language=javascript-typescript --source-root=/tmp/launchers --overwrite
/tmp/codeql/codeql database analyze /tmp/cqdb-launchers javascript-code-scanning.qls \
  --format=sarif-latest --output=/tmp/cq-launchers.sarif
```

### The parked TUI

`tui.mjs` and `tuiUI()` in `installer-ui.mjs` are a full-screen installer that
used to be the default on any terminal that looked capable. Nothing reaches
them now. That is deliberate and it is not a temporary state to be tidied away
by deleting the files: a full-screen program takes over the screen, so a
failure erases the output that would explain it, and it was the path with the
least real use and the most reported trouble. The sequential flow scrolls,
which is what an operator wants on a server they are configuring once, and it
matches the uninstaller, which has only ever been sequential.

The pure core (key decoding, form reduction, frame rendering) is still covered
by `scripts/selftest.mjs`, so the code does not rot while it waits. If you pick
this up again, the thing to fix first is not the widgets: it is that a
full-screen installer needs to leave a readable transcript behind when it exits,
successfully or otherwise.

## Conventions

The front end is dependency-free and stays that way: no framework, no build
step, no CDN. Anything vendored (the QR encoder) is committed. Fonts are
self-hosted. Scripts under `scripts/` use Node builtins only, so the updater
and migration run on a bare box with nothing but Node installed; the
`server/` directory is the one place with npm dependencies, kept minimal.

Rendered state lives in variables read by templates at render time, never
poked into the DOM afterwards. `render()` rebuilds the page wholesale, so a
one-shot DOM injection silently vanishes on the next re-render; the build
hash, the Manage button and the mobile menu all exist as state for exactly
this reason. Follow the pattern for anything new.

The site is onion-only and the code must not assume clearnet: outbound
requests (probes, PayNym lookups) go through the Tor SOCKS proxy, nginx
binds to localhost, and nothing in the front end loads a remote resource.

Copy is British English. The modal text lives in `content/*.md` (the
renderer supports headings, bold, code, links, lists and `>` callouts);
editing copy needs no JavaScript. Records are keyed by
`network-slug(name)` with names unique per network; ids are stable once
created because the reliability history is keyed by them. Every node carries
a BIP47 payment code — ownership, Auth47 sign-in and the card chip key on it
— and the single seed entry is the instance operator's own node. A listing
without a payment code is impossible by construction, not by convention:
`store.putSubmission()` is the one chokepoint every write passes through and it
refuses such a record, the rebuild withholds any that predates the rule rather
than publishing it, and the seed migration refuses to create one. Use
`server/remove-listing.ts` to delete a listing and purge its history.

## TypeScript

**Everything here is type-checked; only some of it is written in TypeScript, and
that is deliberate.** If you are considering converting another file, read the
policy below first — the answer is often no, and the reasons are not obvious.

```
npm install          # once, at the repo root: typescript + @types/node
npm run typecheck    # must exit 0; run it with the three test suites
```

`tsconfig.json` includes `server/**/*.mjs`, `server/**/*.ts`, `scripts/**/*.mjs`
and `assets/js/app.js`. So a plain `.mjs` file is checked exactly as strictly as
a `.ts` one, using JSDoc annotations and the shared shapes in `types.d.ts`.
**Checking is what finds bugs; converting mainly improves ergonomics.** The
checking pass alone found a stale function call that would have thrown on first
use, an Auth47 proof read without checking its variant (which would have bound a
session to an undefined payment code), and two record shapes that did not match
how records are actually written.

### How conversion works here

Node 24 runs `.ts` directly, so there is **no build step**: the deploy is a plain
rsync, nothing is compiled or bundled, and a `.mjs` file may import a `.ts` one.
Three constraints follow:

- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties.
  `tsconfig.json` sets `erasableSyntaxOnly`, so the checker rejects these rather
  than the runtime doing so at 3am.
- **Import specifiers name the real file**: `./crypto.ts`, not `./crypto.js`.
- **Type-only imports must use `import type`**, so they are erased and never
  resolved at run time. `types.d.ts` is not a runtime module.

### Converted, and why

`store.ts`, `crypto.ts`, `dns.ts`, `domains.ts`, `index.ts`, `build-public.ts`,
`apply-signed-payload.ts`. These are the modules where a wrong shape is
expensive: signature verification, the store, the published node record, and the
request layer. Every one of these conversions corrected a type that did not match
reality — optional fields marked required, resolver counts that cannot exist on
an error path, contracts demanding a whole record when the function read two
fields. That correction is the return on the work.

### Not converted, and why not

Do not convert these without a reason beyond consistency:

- **`self-update.mjs`.** It has never run on real hardware. Changing it for
  syntax adds risk to the code least able to absorb it. Convert it *after* it has
  been exercised on a VM, not before.
- **The test suites** (`server/selftest.mjs`, `scripts/selftest.mjs`,
  `scripts/e2e-harness.mjs`). They are the safety net. Rewriting the net for
  syntax leaves the net itself unverified while you work, and they are already
  type-checked, which is how two of the shape corrections above were found.
- **`assets/js/app.js`.** Browsers do not run TypeScript, and Node's type
  stripping is a *runtime* feature that does nothing for a `<script src>` tag.
  Converting the front end therefore requires a build step or a committed
  compiled artefact, which breaks the principle that what is in the repository is
  what runs, and ripples into three places that assume raw JavaScript:
  `pack-source.mjs` ships the codebase as source, the self-update path swaps
  files and restarts with no build stage, and the JSDom harness reads `app.js` as
  text and evaluates it. It is already checked and its DOM narrowing is already
  annotated, so conversion would mostly swap JSDoc casts for TypeScript casts.
  **Leave it as checked JavaScript** unless a bundler becomes desirable for some
  other reason.
- **The maintenance scripts** (`audit-signed.mjs`, `diagnose-signed.mjs`,
  `fix-payload-version.mjs`). Run by hand, output read by a human. Low value.

Everything else (`paynym.mjs`, `updates.mjs`, `admin.mjs`, `probe.mjs`,
`scripts/*.mjs`) is worth converting **opportunistically**, when you are already
changing it for another reason. A dedicated migration commit for these is not a
good use of risk.

### The launcher pattern

`server/index.mjs` and `server/build-public.mjs` remain as small plain-JavaScript
launchers. Each checks the Node version and only then **dynamically** imports its
`.ts` counterpart — dynamically, because a static import is hoisted and would
fail before the check could run. This is not tidiness:

- An operator on Node 20 or 22 gets an explanation instead of a syntax error from
  a file their runtime cannot parse.
- `self-update.mjs` rejects an update archive that does not contain
  `server/index.mjs`, so renaming it would make every legitimate update look
  malformed.
- `scripts/apply-update.mjs` spawns `node build-public.mjs` during a self-update
  while still running the *old* copy of itself, so an instance updating across a
  rename would spawn a file that no longer exists.
- systemd, `npm start`, `npm run build-public`, `scripts/install.mjs`, the deploy
  workflow and the README all name these files.

So: **if a file is invoked by name from outside the repository's own source, keep
that name as a launcher and convert the implementation behind it.** In-process
callers should import the `.ts` module directly; the launcher exists for the
command line and for external callers. `server/selftest.mjs` asserts both
launchers still guard and still re-export, so this cannot be undone by accident.

## Maintenance scripts

Three read-mostly tools live in `server/` and are run on the instance, not in
CI. They are committed deliberately: the deploy pipeline prunes anything in the
web root that is not in the repo, so an uncommitted script pasted onto the box
disappears at the next deploy.

```
cd /var/www/dojobay/server
node audit-signed.mjs          # re-check every stored signed block (read-only)
node diagnose-signed.mjs       # explain why a block fails (read-only)
node fix-payload-version.mjs   # dry run; --apply restores a drifted pairing version
node apply-signed-payload.ts   # dry run; --apply applies operator-signed payloads
node remove-listing.ts <id>    # dry run; --apply removes a listing and its history
```

`audit-signed.mjs` exits non-zero if any record fails, so it can back a cron
check. `fix-payload-version.mjs` writes only `payload.pairing.version`, and only
where the signed block and the stored payload are otherwise identical; because
`store.mjs` holds the store in memory as a single writer, `--apply` refuses to
run while `dojobay-server.service` is active.

## Brand assets

The favicon, PWA icons and social image are committed so no build step is
needed. The vector master is `favicon.svg`: a torii gate over two waves on a
near-black rounded tile. Palette: torii and beams `#b5302a`, waves `#d6534a`
(lower wave at ~60% opacity), background `#0b0b0c`. The PWA icons
(`assets/icons/192x192.png`, `512x512.png`) put the logo at ~60% of a solid
near-black square for the maskable safe zone; `og-image.png` is the 1200x630
social card using the site's self-hosted families (Archivo, Hanken Grotesk,
JetBrains Mono). If the logo changes, regenerate all of them from the SVG by
whatever means you prefer.

## Pull requests

Keep commits scoped to one concern with a message describing behaviour, not
files. Extend the relevant self-test with any behavioural change — the suites
above are the spec — and run all three plus the checksum gate before pushing.
For anything touching `server/` or `scripts/`, run the CodeQL scan too: the
alert would otherwise arrive after the deploy that carried it.
For anything security-adjacent (the Auth47 flow, the signature gate, nginx
examples, the store), describe the threat you considered in the PR text.
