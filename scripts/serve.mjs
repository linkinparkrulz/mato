#!/usr/bin/env node
// Minimal static file server for local development — no dependencies.
// Serves the project root over HTTP so fetch() works (browsers block file://).
//   node scripts/serve.mjs            -> http://localhost:8080
//   PORT=3000 node scripts/serve.mjs
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = +(process.env.PORT || 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    // resolve and contain within ROOT (no path traversal)
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("Forbidden"); return; }

    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) { res.writeHead(404).end("Not found"); return; }

    const body = await readFile(file);
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const cache = rel.includes("/data/") ? "no-store" : "no-cache";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
    res.end(body);
  } catch (e) {
    console.error("500", req.url, e && e.message);
    res.writeHead(500).end("Server error");
  }
});

server.listen(PORT, () => console.log(`The Dojo Bay dev server: http://localhost:${PORT}`));
