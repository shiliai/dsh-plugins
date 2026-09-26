#!/usr/bin/env node
/**
 * gbrain-mcp-proxy — local auth-injecting reverse proxy for a GBrain MCP server.
 *
 * Why this exists: the GBrain OAuth access token (client_credentials grant)
 * expires every 3600s, but `@deepseek-ai/dsh-mcp-client` sends statically
 * configured headers for the life of the web server. This proxy bridges the
 * gap: dsh-mcp-client connects here with no auth; the proxy fetches and caches
 * the access token, injects it on every request, and transparently
 * re-authenticates and retries once on a 401.
 *
 * Credentials come from the environment — nothing is embedded:
 *   GBRAIN_UPSTREAM        required, e.g. http://<gbrain-lan-host>:3131
 *   GBRAIN_CLIENT_ID       required
 *   GBRAIN_CLIENT_SECRET   required
 *   GBRAIN_PROXY_PORT      default 3137
 *   GBRAIN_TOKEN_FILE      default ~/.local/state/gbrain-mcp-proxy/token.json
 *
 * Run standalone for testing, or install as a launchd agent via
 * install-proxy.sh in this directory.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.GBRAIN_PROXY_PORT || 3137);
const UPSTREAM_RAW = process.env.GBRAIN_UPSTREAM;
const CLIENT_ID = process.env.GBRAIN_CLIENT_ID;
const CLIENT_SECRET = process.env.GBRAIN_CLIENT_SECRET;
const TOKEN_FILE = process.env.GBRAIN_TOKEN_FILE
  || path.join(os.homedir(), '.local/state/gbrain-mcp-proxy/token.json');

if (!UPSTREAM_RAW || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('gbrain-mcp-proxy: GBRAIN_UPSTREAM, GBRAIN_CLIENT_ID and GBRAIN_CLIENT_SECRET are required');
  process.exit(1);
}
const UPSTREAM = new URL(UPSTREAM_RAW);

const REFRESH_MARGIN_MS = 120_000; // refetch this long before expiry
const MAX_TOKEN_BYTES = 64 * 1024;

/** @type {{ token: string, expiresAt: number } | null} */
let cached = null;
let inflight = null;

function log(...args) {
  process.stdout.write(`[gbrain-proxy ${new Date().toISOString()}] ${args.join(' ')}\n`);
}

function readCachedToken() {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (typeof parsed.token === 'string' && typeof parsed.expiresAt === 'number') {
      cached = parsed;
      return cached;
    }
  } catch { /* no cache yet */ }
  return null;
}

function fetchToken() {
  if (inflight) return inflight;
  inflight = new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString();
    const req = http.request({
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port,
      path: '/token',
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 15_000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= MAX_TOKEN_BYTES) chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`token endpoint ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          const ttl = Number(parsed.expires_in || 3600);
          const record = {
            token: String(parsed.access_token),
            expiresAt: Date.now() + ttl * 1000,
          };
          cached = record;
          try {
            fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(record), { mode: 0o600 });
          } catch (e) { log('warn: token cache write failed:', e.message); }
          log(`fetched token, expires ${new Date(record.expiresAt).toISOString()}`);
          resolve(record);
        } catch (e) {
          reject(new Error(`token endpoint returned invalid JSON: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('token endpoint timeout')));
    req.on('error', reject);
    req.end(body);
  }).finally(() => { inflight = null; });
  return inflight;
}

async function ensureToken() {
  const rec = readCachedToken();
  if (rec && rec.expiresAt - Date.now() > REFRESH_MARGIN_MS) return rec.token;
  return (await fetchToken()).token;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'content-length', // recomputed from the actual forwarded body
]);

function forward(req, res, authToken) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
      }
      headers['content-length'] = body.length;
      headers.authorization = `Bearer ${authToken}`;
      const upReq = http.request({
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        path: req.url,
        method: req.method,
        headers,
        timeout: 0,
      }, (upRes) => {
        if (upRes.statusCode === 401) { // signal the caller to re-auth + retry once
          upRes.resume();
          resolve({ unauthorized: true });
          return;
        }
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => resolve({}));
      });
      upReq.on('timeout', () => upReq.destroy(new Error('upstream timeout')));
      upReq.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`gbrain-proxy upstream error: ${e.message}`);
        resolve({});
      });
      upReq.end(body);
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/proxy-health') {
    const rec = readCachedToken();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      upstream: UPSTREAM.href,
      tokenExpiresAt: rec ? new Date(rec.expiresAt).toISOString() : null,
    }));
    return;
  }
  try {
    let token = await ensureToken();
    let outcome = await forward(req, res, token);
    if (outcome.unauthorized) {
      log(`401 from upstream on ${req.method} ${req.url} — refreshing token and retrying once`);
      cached = null;
      token = (await fetchToken()).token;
      await forward(req, res, token);
    }
  } catch (e) {
    log(`error on ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`gbrain-proxy error: ${e.message}`);
  }
});

// Long-lived SSE responses must not be cut by Node defaults.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 120_000;

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM.href}`);
});
