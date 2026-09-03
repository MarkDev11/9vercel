const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DATA_DIR } = require("./paths");
const { LOG_BLACKLIST_URL_PARTS } = require("./config");

function time() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

const log = (msg) => console.log(`[${time()}] [MITM] ${msg}`);
const err = (msg) => console.error(`[${time()}] ❌ [MITM] ${msg}`);

let DUMP_DIR = null;
try {
  const dir = path.join(DATA_DIR, "logs", "mitm");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  DUMP_DIR = dir;
} catch (e) {
  if (process.env.VERCEL) {
    console.warn(`[mitm/logger] DUMP_DIR not writable on Vercel (${e?.code || e?.message}) -> dump disabled`);
  } else {
    console.warn(`[mitm/logger] DUMP_DIR create failed (${e?.code || e?.message})`);
  }
  DUMP_DIR = null;
}

// Clear all files inside DUMP_DIR (called on MITM server start to avoid unbounded growth)
function clearDumpDir() {
  try {
    if (!DUMP_DIR) return;
    if (!fs.existsSync(DUMP_DIR)) return;
    for (const f of fs.readdirSync(DUMP_DIR)) {
      try { fs.rmSync(path.join(DUMP_DIR, f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

const EMPTY_BODY_RE = /^\s*(\{\s*\}|\[\s*\]|null)?\s*$/;

function slugify(s, max = 80) {
  return String(s).replace(/[^a-zA-Z0-9]/g, "_").substring(0, max);
}

function isBlacklisted(url) {
  if (!url) return false;
  return LOG_BLACKLIST_URL_PARTS.some(part => url.includes(part));
}

// Decode body buffer based on content-encoding header
function decodeBody(buf, encoding) {
  if (!buf || buf.length === 0) return buf;
  try {
    const enc = (encoding || "").toLowerCase();
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch { /* return raw on failure */ }
  return buf;
}

// Save raw request: method + url + headers + body
function dumpRequest(req, bodyBuffer, tag = "raw") {
  if (!DUMP_DIR) return null;
  if (isBlacklisted(req.url)) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = slugify((req.headers.host || "") + req.url);
    const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.req.json`);
    let parsed = null;
    try { parsed = JSON.parse(bodyBuffer.toString()); } catch { /* not JSON */ }
    try {
      fs.writeFileSync(file, JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        headers: req.headers,
        body: parsed ?? bodyBuffer.toString("utf8")
      }, null, 2));
    } catch (e) {
      if (process.env.VERCEL) return null;
      return null;
    }
    return file;
  } catch (e) {
    if (process.env.VERCEL) return null;
    return null;
  }
}

// Buffer-based response dumper — collects chunks then decodes + writes once on end()
// Trade-off: holds response in RAM, but enables gzip/br decoding for readable output.
function createResponseDumper(req, tag = "raw") {
  if (!DUMP_DIR) return null;
  if (isBlacklisted(req.url)) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = slugify((req.headers.host || "") + req.url);
    const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.res.txt`);
    let status = 0;
    let headers = {};
    const chunks = [];
    return {
      writeHeader: (s, h) => { status = s; headers = h || {}; },
      writeChunk: (chunk) => {
        if (chunk == null) return;
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      },
      end: () => {
        if (!DUMP_DIR) return;
        try {
          const raw = Buffer.concat(chunks);
          const enc = headers["content-encoding"] || headers["Content-Encoding"];
          const decoded = decodeBody(raw, enc);
          const text = decoded.toString("utf8");
          // Skip empty / trivially-empty bodies
          if (EMPTY_BODY_RE.test(text)) return;
          // Strip content-encoding since body is now decoded
          const cleanHeaders = { ...headers };
          delete cleanHeaders["content-encoding"];
          delete cleanHeaders["Content-Encoding"];
          const out = `STATUS: ${status}\nHEADERS: ${JSON.stringify(cleanHeaders, null, 2)}\n---BODY---\n${text}`;
          try {
            fs.writeFileSync(file, out);
          } catch (e) {
            if (process.env.VERCEL) return;
            return;
          }
        } catch (e) {
          if (process.env.VERCEL) return;
          return;
        }
      },
      file
    };
  } catch (e) {
    if (process.env.VERCEL) return null;
    return null;
  }
}

module.exports = { log, err, dumpRequest, createResponseDumper, clearDumpDir };
