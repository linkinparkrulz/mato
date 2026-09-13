// How far behind is this instance? Compares the local data/version.json
// commit against the GitHub repository, over Tor (TLS through the same SOCKS
// tunnel the probes use), and reports commits behind plus releases published
// since this instance was built. Consumed by GET /api/admin/updates for the
// admin console's update line. Everything degrades gracefully: if GitHub is
// unreachable over Tor, the endpoint says so rather than failing the panel.
//
// "Releases behind" resolves release tags to commits and compares identity, so
// an instance running the exact commit of the newest release reports zero. The
// earlier version counted releases published after the local build timestamp,
// which always reported one behind: a tag is created after the commit it points
// at has been built and deployed. When the running commit is not itself a
// released tag, it falls back to that timestamp guess and flags it as such.
import tls from "node:tls";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { socks5Connect } from "../scripts/update.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_REPO = process.env.GITHUB_REPO || "Dojobay/dojobay";
const API_HOST = "api.github.com";

// The request line and headers, separated out so the Accept value is testable
// without a network or a TLS mock. It is not a detail: a download used to ask
// for `application/octet-stream`, and GitHub's archive route answers 415
// Unsupported Media Type to that, so self-update never got past its first
// request and no operator ever saw it work. Verified against the live endpoint:
// octet-stream returns 415, while both `application/vnd.github+json` and `*/*`
// return the 302 to codeload that this transport already follows.
//
// `*/*` rather than the JSON type, because a download genuinely will take
// whatever the route serves and saying so is true; asking for JSON to obtain a
// zip works only by convention and would be the next thing to break quietly.
// The metadata calls keep the JSON type, which is what those routes serve and
// what pins the API version.
export function githubRequestHead(apiPath, host, { binary = false } = {}) {
  return `GET ${apiPath} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: dojobay-update-check\r\n` +
    `Accept: ${binary ? "*/*" : "application/vnd.github+json"}\r\n` +
    `Accept-Encoding: identity\r\nConnection: close\r\n\r\n`;
}

// One HTTPS GET over the Tor SOCKS proxy. Handles chunked replies, returns
// both a text `body` and a raw `bodyBuf`, and follows GitHub's redirect from
// api.github.com to codeload for zipball downloads (binary: true) up to a few
// hops. Host is derived per hop so codeload.github.com is reached correctly.
/**
 * @param {string} apiPath
 * @param {{ proxyHost?: string, proxyPort?: number, timeoutMs?: number,
 *   binary?: boolean, _host?: string, _hops?: number }} [opts]
 */
export async function githubGet(apiPath, { proxyHost, proxyPort, timeoutMs = 30000, binary = false, _host = API_HOST, _hops = 0 } = {}) {
  const raw = await socks5Connect(proxyHost, proxyPort, _host, 443, timeoutMs);
  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, timeoutMs);
    const socket = tls.connect({ socket: raw, servername: _host }, () => {
      socket.write(githubRequestHead(apiPath, _host, { binary }));
    });
    const chunks = [];
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", (e) => { clearTimeout(timer); reject(e); });
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        const all = Buffer.concat(chunks);
        const headEnd = all.indexOf("\r\n\r\n");
        if (headEnd < 0) return reject(new Error("malformed reply"));
        const headText = all.subarray(0, headEnd).toString("latin1");
        const m = headText.match(/^HTTP\/1\.[01] (\d{3})/);
        if (!m) return reject(new Error("malformed reply"));
        const status = +m[1];
        const locM = headText.match(/\r\nlocation:\s*([^\r\n]+)/i);
        let bodyBuf = all.subarray(headEnd + 4);
        if (/transfer-encoding:\s*chunked/i.test(headText)) {
          const parts = []; let p = 0;
          for (;;) {
            const nl = bodyBuf.indexOf("\r\n", p);
            if (nl < 0) break;
            const size = parseInt(bodyBuf.subarray(p, nl).toString("latin1"), 16);
            if (!size) break;
            parts.push(bodyBuf.subarray(nl + 2, nl + 2 + size));
            p = nl + 2 + size + 2;
          }
          bodyBuf = Buffer.concat(parts);
        }
        resolve({ status, location: locM ? locM[1].trim() : null, bodyBuf });
      } catch (e) { reject(e); }
    });
  });
  if ([301, 302, 307, 308].includes(res.status) && res.location && _hops < 4) {
    const u = new URL(res.location);
    return githubGet(u.pathname + u.search, { proxyHost, proxyPort, timeoutMs, binary, _host: u.hostname, _hops: _hops + 1 });
  }
  return { status: res.status, body: res.bodyBuf.toString("utf8"), bodyBuf: res.bodyBuf };
}

/** What to tell an operator when GitHub refuses a request.
 *
 *  A bare "HTTP 403" reads as something broken here, and it is not: GitHub
 *  allows sixty unauthenticated requests an hour PER IP ADDRESS, and a Tor exit
 *  is one address shared with everyone else using it, so an instance can arrive
 *  at an exit whose hour was already spent by strangers. Observed on a live
 *  instance: limit 60, remaining 0, used 60, for an exit nobody here had made a
 *  single request through.
 *
 *  It clears by itself when the window rolls over, and often sooner on a new
 *  circuit, since the limit follows the exit rather than the client. Saying so
 *  is the difference between an operator waiting and an operator going looking
 *  for a fault that does not exist. 429 is included because GitHub uses it for
 *  secondary limits and means the same thing to a reader.
 */
export function githubRefusal(what, status) {
  if (status === 403 || status === 429) {
    // No call-site prefix. Which of the three requests hit the limit is of no
    // use to an operator, and "compare: GitHub is rate-limiting..." reads as
    // though "compare" were a thing that had gone wrong.
    return `GitHub is rate-limiting this Tor exit (HTTP ${status}). `
      + "The limit is per exit address and shared with every other user of it, so it clears on its "
      + "own within the hour, usually sooner on a new circuit. Updating from a peer .onion does not "
      + "touch GitHub and works meanwhile.";
  }
  return `${what}: HTTP ${status}`;
}

export async function checkUpdates({ repo = GITHUB_REPO, transport = githubGet, cfg = {} } = {}) {
  const verPath = path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "version.json");
  const version = JSON.parse(await readFile(verPath, "utf8"));
  if (!version.commit || version.commit === "dev") throw new Error("local version.json has no deployed commit");

  const cmp = await transport(`/repos/${repo}/compare/${encodeURIComponent(version.commit)}...main`, cfg);
  if (cmp.status !== 200) throw new Error(githubRefusal("compare", cmp.status));
  const compare = JSON.parse(cmp.body);

  const rel = await transport(`/repos/${repo}/releases?per_page=30`, cfg);
  if (rel.status !== 200) throw new Error(githubRefusal("releases", rel.status));
  const releases = JSON.parse(rel.body);

  // Which release are we actually running?
  //
  // This used to count releases published after the local build timestamp,
  // which is wrong in the ordinary case: a tag is created AFTER the commit it
  // points at has been built and deployed, so an instance running the exact
  // commit of the newest release always reported itself one release behind.
  //
  // Resolve each release's tag to a commit instead and compare identity. If our
  // commit IS a released tag, the number of releases published after it is the
  // honest answer (zero, when we are on the latest). Only when no tag matches do
  // we fall back to the timestamp approximation, and say so.
  let tagSha = new Map();
  let tagsError = null;
  try {
    const tg = await transport(`/repos/${repo}/tags?per_page=100`, cfg);
    if (tg.status === 200) {
      for (const t of JSON.parse(tg.body)) {
        if (t?.name && t?.commit?.sha) tagSha.set(t.name, String(t.commit.sha));
      }
    } else {
      tagsError = githubRefusal("tag lookup", tg.status);
    }
  } catch (e) {
    tagsError = "tag lookup: " + (e?.message || "failed");
  }

  // version.json carries a short commit, the API a full sha; match either way.
  const sameCommit = (a, b) => {
    if (!a || !b) return false;
    const x = String(a).toLowerCase(), y = String(b).toLowerCase();
    return x.startsWith(y) || y.startsWith(x);
  };

  const runningIndex = releases.findIndex((r) => sameCommit(tagSha.get(r.tag_name), version.commit));
  const approximate = runningIndex < 0;
  const builtAt = Date.parse(version.built || 0) || 0;

  // Three states, and the third used to be reported as the second.
  //
  //   matched      our commit IS a released tag: the count is exact.
  //   no match     we are on an untagged commit mid-cycle: the timestamp count
  //                is a fair approximation, because we are genuinely not on a
  //                release.
  //   no tag data  we could not look tags up at all, usually because a shared
  //                Tor exit hit GitHub's rate limit. The timestamp count is
  //                then WORSE than saying nothing: a tag is always created
  //                after its commit was built, so an instance running the very
  //                newest release scores one behind. Report null instead.
  const releasesBehind = !approximate ? runningIndex
    : tagsError ? null
    : releases.filter((r) => Date.parse(r.published_at || 0) > builtAt).length;

  return {
    commit: version.commit,
    built: version.built || null,
    commits_behind: compare.ahead_by ?? 0,        // main is ahead of us by this many
    status: compare.status || "unknown",           // identical | behind | ahead | diverged
    latest_release: releases[0] ? releases[0].tag_name : null,
    /** The release we are running, when our commit is exactly a released tag. */
    current_release: approximate ? null : releases[runningIndex].tag_name,
    releases_behind: releasesBehind,
    /** True when releases_behind is the timestamp guess rather than an identity
     *  match, which happens when the running commit is not itself a released
     *  tag (mid-cycle, or a local build). */
    releases_behind_approx: approximate,
    /** Why the release could not be identified, when it could not. */
    releases_note: tagsError,
    repo,
    checked_at: new Date().toISOString(),
  };
}

/** Whether an update check may be answered from the cache, and what to tell the
 *  operator if a forced check was refused.
 *
 *  Three rules, and the third is the only interesting one. An ordinary request
 *  takes the cache while it is fresh, because six hours is right for an
 *  unattended check over Tor where GitHub rate limits shared exit nodes. A
 *  forced request goes out. A forced request inside the floor is answered from
 *  the cache with the wait attached rather than refused, because the operator
 *  asked what the state is and the honest answer is the last one known plus how
 *  stale it is.
 *
 *  Pure, and separate from the route, so the floor can be tested without a
 *  reachable GitHub: the route only fills its cache on success, so an
 *  unreachable GitHub means the cached path is never taken and the floor never
 *  runs. A rule that cannot be exercised is a rule nobody has checked.
 */
export function updateCacheDecision({ cachedAt = null, now = Date.now(), forced = false,
  forcedAt = 0, ttlMs = 6 * 3600 * 1000, floorMs = 60 * 1000 } = {}) {
  const fresh = cachedAt !== null && now - cachedAt < ttlMs;
  if (!fresh) return { serveCached: false, waitS: 0 };
  if (!forced) return { serveCached: true, waitS: 0 };
  const since = now - forcedAt;
  if (forcedAt && since < floorMs) {
    return { serveCached: true, waitS: Math.ceil((floorMs - since) / 1000) };
  }
  return { serveCached: false, waitS: 0 };
}
