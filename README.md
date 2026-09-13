> **This repository is `mato`, a work in progress.**
>
> It is a fork of [The Dojo Bay](https://github.com/Dojobay/dojobay), an
> onion-only directory of public Bitcoin Dojo nodes, and is being rebuilt into a
> BIP47 storefront: a shop that derives a fresh payment address for every order
> on the operator's own personal wallet chain, so the server never holds a key
> that can spend and never publishes an xpub.
>
> The Dojo Bay's code is MIT-licensed and its licence is retained in
> [LICENSE](LICENSE); this fork keeps that notice and its thanks. The
> documentation below still describes the directory and is being replaced
> section by section. Nothing here is finished, audited, or safe to point at
> real money yet.

# The Dojo Bay

An onion-only directory of public Bitcoin **Dojo** nodes for
[Samourai](https://web.archive.org/web/20240424023506/https://samouraiwallet.com/),
[Ashigaru](https://ashigaru.rs/) and
[Sentinel](https://github.com/wanderingking072/sentinel-android) wallets.
The reference instance runs at:

```
http://dojobayeryasshgghz537de5ckgd5hhi4z5sdeil3roeh65fwhdnu2yd.onion/
```

Each listed node shows its PayNym and payment code, jurisdiction, hardware,
Dojo version, current block height, a 24-hour reliability strip, a 90-day
daily history, and the pairing payload as a scannable QR with copyable
endpoints (Dojo API, explorer, and Electrum server where one is exposed).
Cards are ordered by measured uptime. Node operators list and manage their
own Dojos by signing in with their PayNym over **Auth47**: no accounts, no
email, no passwords: signing a challenge in the wallet proves control of the
payment code, and submissions pass a live Tor connection check, a signature
check over the pairing payload, and a moderation review before publication.

Everything is served from a Tor hidden service. There is no clearnet aspect:
the web server binds to localhost, only the Tor daemon reaches it, and the
site's outbound probes and PayNym lookups travel over Tor.

This repository is the complete, self-hostable software: anyone with a Debian
or Ubuntu box, including the one already running their node, can operate
their own Dojo Bay.

## How it works

The front end is a static single-page app (plain HTML, CSS and JavaScript, no
build step, no framework) served by nginx behind a Tor hidden service. It
renders entirely from JSON files fetched at load, so the data pipeline and
the presentation never touch.

The node list is generated, not hand-edited. `data/seed.json` is the
instance **anchor**: exactly one node, the instance operator's own Dojo,
which is what guarantees a Dojo Bay is never empty and that whoever runs a
directory also runs a node. Every other listing lives in a server-side store,
created and managed by its operator over Auth47, and `server/build-public.mjs`
merges the anchor with every approved submission into the public
`data/dojos.json`, preserving live statuses. Every listed node carries a
BIP47 payment code and a signed pairing block. The code is what ownership,
sign-in and the card's payment-code chip all key on, and a listing without one
cannot be owned, edited, verified or recognised; the signature is the only part
of a listing a visitor can check without trusting this site at all. Both are
enforced structurally rather than by convention: the store refuses to write a
record missing either, and the build withholds any that predates the rules
instead of publishing it. A systemd timer runs `scripts/update.mjs` every ten minutes, which
logs into each listed Dojo's API over Tor, reads the chain tip, and maintains
`data/dojos.json` (statuses and block heights), `data/history.json` (the
24-hour check series) and `data/history-daily.json` (90-day daily rollups).
Reliability history is retained under a grace stamp for fourteen days after a
node leaves the list, so a transient mistake never destroys accumulated data.

The backend (`server/index.ts`, launched by `server/index.mjs`, a
dependency-light Node service on
localhost, proxied by nginx as `/api/`) handles Auth47 challenges and
sessions, operator submissions and edits, and the moderation console at
`/admin`. Admin rights belong to whichever payment codes the instance
operator sets in the service environment, using the same Auth47 sign-in, no
separate credentials.

## Run your own Dojo Bay

Requirements: Debian 12 or Ubuntu 24.04 (or similar), **Node.js 24 or
newer**, plus your own Dojo and PayNym.

**Hardware.** A small VPS is enough: **1 vCPU, 2 GB RAM and 20 GB of disk**,
with swap configured. The work is almost entirely waiting on Tor circuits, so
extra cores buy very little; what matters is enough memory for the transient
peaks and enough disk that nothing fills up quietly. The backend itself sits at
well under 100 MB, and the two spikes are `npm ci` during a deploy and the
unpack during a self-update, neither of which lasts. 1 GB can work, but leaves
nothing spare for those spikes.

Do not guess from that: `server/check-resources.ts` measures what an instance
actually uses: service memory current and peak, the disk each part occupies,
the probe workload, and whether there is any evidence of strain such as swap in
use or an out-of-memory kill. Run it on your own box, ideally just after a
deploy, and size from that rather than from this paragraph.

```
cd /var/www/dojobay/server && sudo -u deploy node check-resources.ts
```

One thing it will warn about as an instance ages: every self-update keeps a full
copy of the previous code under `data/backups/`, and nothing removes them. On a
20 GB disk that is years away from mattering, but it grows without limit and is
worth pruning by hand occasionally.

A word on Node, because this is where installs go wrong: `apt install nodejs`
gives you **Node 18** on both Debian 12 and Ubuntu 24.04, which is too old. The
backend runs TypeScript directly, which needs Node 24's type stripping, and the
BIP47 libraries require it too. Install from NodeSource instead, which replaces
the apt package in place:

```
sudo apt-get install -y ca-certificates curl gnupg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
sudo apt-get update && sudo apt-get install -y nodejs
node --version    # expect v24 or newer
```

The installer checks this before doing anything and prints these commands if
your Node is missing or too old, so there is no need to memorise them.

The easiest path is the guided installer. Download the source (any instance's
footer serves it, or GitHub), extract, and run:

```
./install.sh
```

Run it from a terminal, locally or over SSH. It is a guided sequential flow:
it asks one thing at a time, explains what it is about to do, and everything
it prints stays on the screen and in your scrollback, which is what you want
when something goes wrong on a server you are configuring once. There is no
double-click launcher and no full-screen mode; the same is true of the
uninstaller. The wizard checks prerequisites (offering to
install `tor` and `nginx`), takes your BIP47 payment code, creates the hidden
service, or **imports your existing .onion key** if you have a vanity
address (point it at your `hs_ed25519_secret_key`; generating vanity keys is
outside its scope), walks you through the **required** operator signature,
live-probes your Dojo's pairing payload over Tor before accepting it, can
**bootstrap your directory from a trusted existing instance** (nodes and
their reliability histories import after that instance's operator signature
is verified against the payment code you type in), then writes nginx, systemd
and the first build. It shows a review screen before writing anything and is
safe to re-run.

The manual steps below do the same by hand, and assume the site lives at
`/var/www/dojobay`.

1. **Clone and install the backend's dependencies.**

   ```
   sudo git clone https://github.com/Dojobay/dojobay /var/www/dojobay
   cd /var/www/dojobay/server && sudo npm ci --omit=dev
   ```

2. **Create the hidden service.** In `/etc/tor/torrc`:

   ```
   HiddenServiceDir /var/lib/tor/dojobay/
   HiddenServicePort 80 127.0.0.1:8080
   ```

   Restart Tor and read your onion address from
   `/var/lib/tor/dojobay/hostname`.

3. **Configure nginx** from `deploy/nginx-onion.conf.example`. It binds to
   `127.0.0.1:8080` (never a public interface), proxies `/api/` to the
   backend, and returns 404 for everything under `/server/`. That block is
   security-critical, because the submission store (which contains Dojo API
   keys) lives inside the web root.

4. **Install the systemd units** from `scripts/`:
   `dojobay-server.service` (the Auth47 backend: set `BASE_URL` to your
   onion address, since Auth47 challenges embed it and wallets sign exactly
   that string, and set `ADMIN_PAYMENT_CODES` to your own payment code to
   make yourself the moderator), and `dojobay-update.service` plus
   `dojobay-update.timer` (the ten-minute prober). Enable the timer and the
   service.

5. **Seed your anchor and build the list.** Running a Dojo Bay requires
   running a Dojo: put your own node, mainnet or testnet, into
   `data/seed.json` as its single entry, with your PayNym and BIP47 payment
   code (the same code you set in `ADMIN_PAYMENT_CODES`). Then generate the
   public list:

   ```
   node server/build-public.mjs
   ```

   From here the timer keeps statuses and history current, other operators
   list themselves through **Manage my Dojo**, and you approve at `/admin`.
   If you are transitioning an instance that still has an old-style curated
   list in its seed, `scripts/migrate-seed-to-store.mjs --dry-run` shows how
   each entry would move into the operator-managed store.

6. **Prove you operate the site** (required). Sign this exact text with your
   wallet under **PayNym → Sign message**, which signs with your PayNym's
   notification address (Tools → Sign message will not verify). Your onion
   URL, a blank line, then
   `BIP47: <your payment code>`, and place the result in
   `data/operator.json` as `{ "onion", "paymentCode", "verifySigned" }`. The
   footer's **Verify** popup lets visitors check the signature against your
   PayNym's notification address, other instances refuse to bootstrap from
   you without it, and every rebuild verifies it and warns loudly when it is
   missing or invalid.

The deploy pipeline in `.github/workflows/deploy.yml` shows how the reference
instance ships updates (rsync over SSH, excluding the VPS-owned data files
and the store, then a rebuild and backend restart); adapt or ignore it. A
`git pull` followed by `node server/build-public.mjs` and a service restart
does the same by hand.

## Uninstalling

`./uninstall.sh` reverses the guided install. Run it with no arguments first: it
only reports what it finds and what it would remove.

```
sudo ./uninstall.sh                                   # dry run
sudo ./uninstall.sh --apply                           # stop serving
sudo ./uninstall.sh --apply --purge-data              # …and delete the store
sudo ./uninstall.sh --apply --purge-data --purge-onion  # …and the onion key
```

By default it stops and disables the backend and the updater timer, removes the
three systemd units and the nginx site, and takes its own block out of
`/etc/tor/torrc`, surgically, so any other hidden service in that file survives,
with the original kept alongside as `torrc.dojobay-bak`. It leaves the tor and
nginx **packages** installed, since they were probably there first and are
probably serving something else.

Two things it will not touch unless you ask, because neither can be undone:

- **`--purge-data`** deletes the web root, and with it the store: every
  operator's submission, their signed pairing blocks and the reliability
  history. Those are other people's records, not only yours.
- **`--purge-onion`** deletes the hidden service directory, which holds the
  private key that *is* your onion address. That address is then permanently
  unreachable for anyone holding the bookmark, and no copy exists anywhere else.
  It asks you to type the address back before doing it.

Either purge takes a `tar.gz` of what it is about to delete into `/root/` first,
and aborts rather than proceeding if that archive cannot be written. Pass
`--no-backup` if you genuinely want it gone with no copy.

Leaving both out is the usual case: the instance stops serving, and reinstalling
later reuses the same onion address and the same listings.

## Data access

All directory data is plain JSON, fetchable from any instance:

- `data/dojos.json`: the current list (also the **JSON ↓** pill in the header)
- `data/history.json`: the rolling 24-hour check series per node
- `data/history-daily.json`: 90 days of daily uptime and closing heights
- `/api/history/export`: both windows merged per node; `?id=<node-id>`
  filters to one node

For example, over Tor:

```
curl -s --socks5-hostname 127.0.0.1:9050 http://<onion>/data/dojos.json \
  | jq '.nodes[] | select(.status=="active") | .name'
```

## Getting listed on the reference instance

Open **Manage my Dojo** in the header, scan the Auth47 challenge with
Samourai or Ashigaru (Tools → Authenticate using PayNym), and submit your
node's name, details and pairing payload. The server checks the Dojo answers
over Tor before the submission is accepted, and the signed pairing message is
required and must verify against your payment code's notification address.
Changing your pairing details later needs a fresh signature over the new ones:
the old signature covers what you are replacing. Approved listings appear with your PayNym; you can edit the display
fields or remove the listing at any time with the same sign-in.

## Minimum Dojo version

A new listing must be running **Dojo 1.27.0 or newer**. Earlier versions do not
serve the endpoints a listing is checked against, so a directory that accepted
them would be publishing claims it could not verify.

The check reads the version from the node's own `X-Dojo-Version` response header
during the connection probe, not from the `version` field inside the pairing
payload. That field is frozen when the payload is generated and can be years out
of date while the node itself is current, so judging on it would refuse working
nodes and admit old ones.

It applies to **registration only**. An operator updating a listing they already
hold, whether a moved onion or a rotated API key, is not re-judged, because a rule
introduced after they joined should not punish them for maintaining their node.
An instance operator can change the threshold with `MIN_DOJO_VERSION`, or
disable the check by setting it empty.

To see where every current listing stands before changing it:

```
cd /var/www/dojobay/server
sudo -u deploy node check-versions.ts          # against the configured minimum
sudo -u deploy node check-versions.ts 1.29.0   # against one you are weighing
```

## Changing your pairing details

An operator can update the pairing payload of a listing they already own, from
**Manage my Dojo → Pairing**. Use it when your Dojo's onion address changes, when
you rotate an API key, or when you start exposing an Electrum indexer.

The listing keeps its place, its approval and its uptime history. Approval here
binds to the **payment code** that owns the record, not to a particular address:
approving a listing means accepting that this operator is who they say they are,
and the judgement about whether to trust their node belongs to the visitor, who
has the signed pairing details and the tools to check them. The same gates as a
first submission still apply, because those protect the reader rather than
gatekeep the operator: the payload must be well formed, the new address must be
answering over Tor at that moment, and a signed block, if you supply one, must
verify against your payment code. If the new address does not answer, the update
is refused and your existing listing is left exactly as it was.

The Electrum endpoint is normally read from your Dojo automatically. If yours
predates v1.27.0, or does not expose `/support/services`, you can declare it in
the payload as an `indexer` entry and it will be published as a fallback.

**A payment code cannot be changed.** Rotating the BIP47 code on an existing
listing is not supported and is not planned. The payment code is not an
attribute of a listing, it is the identity the whole directory rests on: it
authenticates you, it decides who may edit a record, it keys your verified
domain, and it is what a visitor recognises you by. Allowing it to be swapped
would mean a listing, and the reputation and history attached to it, could
change hands on the strength of a single signature. If you need to move to a new
PayNym, submit a new listing under it; the history starts afresh, which is the
honest outcome when the identity behind a node has genuinely changed.

## Verifying a domain you own

Optional, and the only way to put a link on your card. An operator may prove
control of one clearnet domain, which then appears as a `✓ example.com` badge on
every card they run, and lets the card title link anywhere on that domain.
Nothing else is linkable: this deliberately replaces a freeform URL field, so a
card cannot carry an identity claim the directory has not tested. Identity
material also does not belong in the signed pairing payload, which attests to
pairing data only.

Proof runs in both directions, so neither half is enough on its own. In
**Manage my Dojo → Verified domain**, enter your domain and the panel shows you:

1. A **TXT record** to publish, at `_dojobay.<your-domain>`, whose value is
   `dojobay-domain-v1 pm=<your payment code>`. Publishing it requires control of
   the domain.
2. The **exact text to sign**, which is `https://<your-domain>/`, a blank line,
   then `BIP47: <your payment code>`. Sign it under **PayNym → Sign message**,
   the same procedure as everything else here, and paste the whole signed block
   back. Producing it requires your PayNym's notification key.

The instance reads the TXT record over Tor, through several independent
DNS-over-HTTPS resolvers, and requires more than one to agree before the badge
appears. If it cannot reach enough resolvers it says so rather than failing you.

The signature never expires; the TXT record is the revocable half. Remove the
record and the badge disappears after a grace period, while your claim is kept,
so restoring the record restores the badge without signing anything again. A
domain that changes hands therefore stops being claimable by its previous owner.

The proof travels. `data/dojos.json` publishes the TXT record and the signed
statement alongside the badge, and the signed statement names only the domain and
the payment code, never the instance that checked it. So another Dojo Bay
bootstrapping from this one carries the claim across, but re-verifies the
signature itself and re-checks the DNS with its own resolvers before showing a
badge. A directory never inherits another's tick, which is what stops one
compromised instance minting verified domains across a federation.

A badge attests that the operator **controls that domain**, and nothing more. It
is not a statement that they are trustworthy, a lookalike domain can be verified
just as easily as a well-known one, and a maintainer can revoke any badge.

## Verifying a directory

Any Dojo Bay instance can be verified against its operator: the **Verify**
link in the footer shows a Bitcoin-signed message binding the onion address
to the operator's payment code. Check it with the
[BIP47 Message Verifier](https://paymentcode.io/lab)
or with **Tools → Verify message** in the wallet.

## Upgrading an instance

Every Dojo Bay serves its own source code: the branch icon in the footer
downloads `data/dojobay-src.zip`, an archive of exactly the code that
instance is running (regenerated automatically after each deploy, and never
containing instance data: no submission store, no API keys, no seed, no
histories). That makes any instance an upgrade source for any other, with no
reliance on GitHub being reachable.

To upgrade a hand-managed instance, fetch the archive from the reference
instance over Tor (or from any instance you trust, or from GitHub), then
extract it over the web root. The archive contains only code, so your seed,
operator binding, submission store and histories are untouched:

```
cd /tmp
curl -s --socks5-hostname 127.0.0.1:9050   -o dojobay-src.zip http://<reference-onion>/data/dojobay-src.zip
unzip -o dojobay-src.zip
sudo systemctl stop dojobay-server
sudo cp -a dojobay/. /var/www/dojobay/
cd /var/www/dojobay/server && sudo npm ci --omit=dev
node ../server/build-public.mjs
sudo systemctl start dojobay-server
```

The footer's build hash and `data/version.json` tell you what you are
running. The admin console shows how far the instance is behind (commits
behind `main` and releases since your build, checked over Tor), and can
**apply an update in place**: choose *Update from GitHub* or *Update from a
peer .onion* and the console fetches the verified source over Tor, backs up
the current code to `data/backups/`, swaps in the new tree, and restarts the
service, showing a progress bar and hard-reloading when the instance returns.

**Self-update is experimental**, and the admin console labels it so. The
failure that matters is a service that does not come back, which needs shell
access to the box to recover, so do not run it where you cannot reach a
terminal. The last step restarts the service, and an instance whose service
account has not been granted permission to do that will install the new code
and go on running the old: the console checks for that before it offers the
button, and says so. Deploying by push, or the manual upgrade above, remains
the supported path.

That permission is a polkit rule, not a sudoers line, because the updater runs
`systemctl restart` directly and systemd asks polkit whether the account may.
The installer offers to write it, shows you the rule first, and verifies it
afterwards. A running instance cannot verify it: polkit refuses an
authorisation query carrying details from any caller that is not root, and the
rule matches on the unit and the verb, so the console makes no claim either way
and instead reports an update that installed without restarting, which is what a
missing permission looks like. If you declined at install, or set the instance up
by hand, copy the rule yourself and check the account named inside matches the
one your service runs as:

```
sudo cp /var/www/dojobay/deploy/polkit-restart.rules.example \
  /etc/polkit-1/rules.d/49-dojobay-restart.rules
systemctl show dojobay-server.service -p User --value
sudo grep subject.user /etc/polkit-1/rules.d/49-dojobay-restart.rules
```

Substitute your web root in the first path if it is not `/var/www/dojobay`. The
`.example` ending is part of the filename the template ships under, not a
placeholder; the destination name is what polkit reads. The last two commands
must agree: the account systemd runs the service as, and the account named
inside the rule.

It grants restart of that one unit to that one account, and nothing else: not
stop, not start, not mask, and no other service. polkit has to be installed and
running for a rule file to mean anything (`apt install polkitd`), and where it
is absent the console reports the permission as unknown rather than promising a
restart it has not been able to test.

A peer update reuses the same trust gate as bootstrapping: you supply the
peer's payment code, and nothing is applied unless that peer's operator
signature verifies for the onion you named. Either way the archive contains
code only, so your seed, operator binding, submission store and histories are
never touched, and a backup under `data/backups/<timestamp>/` lets you roll
back by hand if a build misbehaves. The manual `unzip` upgrade below remains
available and does the same thing.

### Importing listings from another Dojo Bay

The same operation the installer offers at setup is available afterwards, from
the admin console: **Import Dojos from another Dojo Bay**. Give it that
instance's `.onion` and the payment code of its operator, and it fetches their
published list over Tor.

Nothing is trusted about the other directory beyond the fact that you named it.
Its operator signature is verified against the payment code you supplied, so a
list from an onion whose operator did not sign for it is refused. Then every
listing in it is verified here, individually: its signed block must cover the
pairing payload it arrived with, checked offline against the notification
addresses of the payment code named inside the block. A well-formed signature
over somebody else's payload does not import, and a directory that publishes
one cannot place a listing here on its say-so.

It works in two steps. The first produces a plan and writes nothing: what would
be imported, what this instance already lists under a different id, and what is
refused and why. A node you already have is recognised by its pairing URL and
contributes only its reliability history, so bootstrapping from an instance that
already lists your own Dojo does not create a second copy of it. Only then does
an apply button appear.

Applying then runs one probe cycle before it reports done, which takes about a
minute, so the imported nodes show their own status rather than reading inactive
until the ten-minute timer comes round. A moderator deciding whether to approve
them is exactly the person who needs that answer. It is skipped if a cycle is
already running.

Imported listings arrive as **Pending review**, unpublished until you approve
them, which is the difference from the installer's version: at setup, choosing
to bootstrap is the decision to trust that list wholesale, whereas on a running
directory anything appearing on the site without passing your moderation queue
would be another operator publishing here. Verified domain badges are never
imported as verified; the claim comes across and your own DNS sweep has to see
the TXT record before a badge appears.

## Maintaining an instance

Six scripts live in `server/` and are run on the instance itself, not in CI.
Each of the three that writes anything defaults to a **dry run**, backs up what
it touches, and refuses to run while `dojobay-server.service` is up, because
`store.ts` holds the store in memory as a single writer and would overwrite the
edit. Run them as the service user, not as root: files left owned by root are
files the deploy cannot manage.

```
cd /var/www/dojobay/server
```

**`audit-signed.mjs`**, read-only. Re-checks every stored signed block with the
same gate the submission endpoint uses, and sorts each record into VERIFIED,
FAILED, UNSIGNED or ERROR. Exits non-zero if anything failed, so it can back a
cron check. UNSIGNED is not a failure: it is a record that never carried a
signature, for a per-record decision.

```
sudo -u deploy node audit-signed.mjs
```

**`diagnose-signed.mjs`**, read-only. Explains *why* a block fails: whether the
signature is genuine and its payment code binds to the signing address, and if
so exactly where the stored payload diverges from the signed text. Use it when
`audit-signed.mjs` reports FAILED and the reason is not obvious.

```
sudo -u deploy node diagnose-signed.mjs
```

**`apply-signed-payload.ts`** applies pairing payloads an operator has signed
and sent out of band. It performs the same checks as the submission gate, finds
the listing by the payment code inside the signed text, and writes only the
payload and the signature, so ids and reliability history survive. A block whose
whitespace was mangled in transit is repaired, but only when the repaired form
verifies cryptographically. One block per file.

```
sudo -u deploy node apply-signed-payload.ts /tmp/blocks/*.txt        # dry run
sudo -u deploy node apply-signed-payload.ts --apply /tmp/blocks/*.txt
```

Add `--id <record-id>` when one payment code owns more than one listing.

**`fix-payload-version.mjs`** restores a `pairing.version` that drifted after
signing, and only where the signed block and the stored payload are otherwise
identical. Rarely needed now that operators can update their own pairing
details.

```
sudo -u deploy node fix-payload-version.mjs      # dry run
```

**`remove-listing.ts`** deletes one or more listings **and purges their
reliability history**. Deleting through the API leaves history stamped `retired`
for the grace period so a node that returns resurrects its uptime; that is right
for a node coming back and wrong for one being removed deliberately. Takes
several ids at once.

```
sudo -u deploy node remove-listing.ts mainnet-example testnet-example   # dry run
sudo -u deploy node remove-listing.ts --apply mainnet-example testnet-example
```

**`reconcile-system.mjs`** compares the systemd units, the nginx site and the
polkit rule installed under `/etc` against the copies shipped in this
repository. Nothing there is touched by a deploy or a self-update: those files
are written once, at install time, and then drift, so a change to a unit
template reaches your checkout and stops. Run it from the repository root,
not from `scripts/`.

```
sudo node scripts/reconcile-system.mjs            # dry run, the default
sudo node scripts/reconcile-system.mjs --diff     # the full diff for each file
sudo node scripts/reconcile-system.mjs --apply    # writes, after asking again
```

Your own settings are not reported as drift. It reads the account, web root,
onion and admin code back out of the installed unit and renders the current
template with them, so what you see is what this repository changed. Anything
else you edited by hand shows as a difference, because it is one and only you
can say whether it should survive: read the diff before applying. Applying keeps
the previous copies under `/var/backups/dojobay/`, reloads systemd, restarts any
timer whose file changed, since a timer keeps its old schedule until it is
restarted and nothing about the machine would look wrong meanwhile, and
validates the nginx site with `nginx -t` before reloading nginx. It names any
service still running an old unit and leaves restarting those to you.

Answer its prompt by hand rather than pasting it as part of a block of
commands. It discards queued input before asking, but a confirmation that
guards the files under `/etc` deserves a deliberate keystroke.

`/etc/tor/torrc` is deliberately outside its scope. The installer merges a
marked block into your torrc rather than rendering it, because that file carries
your other hidden services.

**`check-resources.ts`**, read-only. Measures memory, disk and workload on this
instance, and reports any sign that the machine is short of something. Use it to
size a VPS from evidence rather than from a recommendation.

```
sudo -u deploy node check-resources.ts
```

**`check-versions.ts`**, read-only. Reports the Dojo version of every listing,
both detected and declared, against a minimum, and prints the spread of versions
actually in use so a threshold can be chosen against real numbers.

```
sudo -u deploy node check-versions.ts 1.27.0
```

**`build-public.mjs`** republishes `data/dojos.json` immediately rather than
waiting for the next ten-minute cycle. Run it after any of the writing scripts.

```
sudo -u deploy node build-public.mjs
```

A normal sequence for a change to stored data is therefore: dry run, stop the
service, apply, start the service, `build-public.mjs`, then `audit-signed.mjs`
to confirm the result.

## TypeScript, and what is deliberately not converted

The whole codebase is type-checked (`npm run typecheck`), and the parts where a
wrong shape is expensive are written in TypeScript: the store, the crypto, the
DNS and domain layers, the request layer and the public-list rebuild. Node 24
runs `.ts` directly, so there is **no build step**: the deploy is a plain rsync
and nothing is compiled or bundled.

Some things are deliberately left as checked JavaScript, and a contributor
should not "finish the migration" without reading the reasoning first:

- **`assets/js/app.js`** stays JavaScript because browsers do not run TypeScript
  and Node's type stripping is a runtime feature that does nothing for a
  `<script src>` tag. Converting it would require a build step, which breaks the
  principle that what is in the repository is what runs.
- **`self-update.mjs`** stays until it has been exercised on real hardware.
  Changing it for syntax adds risk to the code least able to absorb it.
- **The test suites** stay, because rewriting the safety net for syntax leaves
  the net itself unverified while you work.

`server/index.mjs` and `server/build-public.mjs` remain as small launchers that
check the Node version before importing their `.ts` counterparts, so an operator
on an older runtime gets an explanation rather than a syntax error. Those names
are also depended on from outside the repository, so they must not be renamed.
The full policy, including when converting *is* worthwhile, is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing and licence

Development setup, project structure, the test suites and coding conventions
are in [CONTRIBUTING.md](CONTRIBUTING.md). The code is MIT-licensed
([LICENSE](LICENSE)); the dependencies it installs are not all MIT, and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) names the two LGPL-3.0
components and the rule that they are never bundled into anything this
repository distributes. Listings are not added through pull requests. They go
through the Auth47 flow above. Security problems go through
[SECURITY.md](SECURITY.md) rather than a public issue.
