import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const { SECRET = '', PORT = 3000, ALLOWED_ORIGIN, MAX_PEERS = 25, AI_RATE = 30 } = process.env;
if (SECRET.length < 32) { console.error('SECRET must be at least 32 characters'); process.exit(1); }
process.env.YPERSISTENCE = process.env.DATA_DIR || './data';
const { setupWSConnection } = createRequire(import.meta.url)('y-websocket/bin/utils');

// ---------- AI provider (OpenAI or Anthropic)
const OPENAI = process.env.AI_PROVIDER ? process.env.AI_PROVIDER === 'openai' : !!process.env.OPENAI_API_KEY;
const KEY = OPENAI ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || (OPENAI ? 'gpt-4o' : 'claude-sonnet-5-5');
const FAST = process.env.COMPLETE_MODEL || (OPENAI ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001');
if (!KEY) console.warn('No AI key set: AI features disabled');

async function* llm(prompt, { fast = false, max = 2000, system } = {}) {
  const model = fast ? FAST : MODEL;
  const r = await fetch(OPENAI ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: OPENAI ? { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } : { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(OPENAI
      ? { model, max_completion_tokens: max, stream: true, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] }
      : { model, max_tokens: max, stream: true, system, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || 'AI error');
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue;
      try { const j = JSON.parse(l.slice(6)); const t = OPENAI ? j.choices?.[0]?.delta?.content : j.type === 'content_block_delta' ? j.delta?.text : ''; if (t) yield t; } catch {}
    }
  }
}
const PROMPTS = {
  explain: 'Explain what this code does, concisely. Point out bugs or risks.',
  refactor: 'Refactor for clarity and performance. Return ONLY the replacement code, no prose, no fences.',
  fix: 'Find and fix bugs. Return ONLY the corrected code, no prose, no fences.',
  tests: 'Write unit tests for this code. Return ONLY code, no prose, no fences.',
  custom: 'Follow the instruction. If you change code, return ONLY the code.',
};

// ---------- capability tokens: <projectId>.<edit|view>.<hmac>  (unforgeable without SECRET)
const sig = (id, role) => crypto.createHmac('sha256', SECRET).update(`${id}.${role}`).digest('base64url').slice(0, 22);
const sign = (id, role) => `${id}.${role}.${sig(id, role)}`;
function verify(token = '') {
  const [id, role, s] = token.split('.');
  if (!id || !['edit', 'view'].includes(role) || !s || s.length !== 22) return null;
  return crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sig(id, role))) ? { id, role } : null;
}

// ---------- helpers
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const limited = (key, max) => { const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return n > max; };
const json = (res, s, o) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
const readBody = async req => { let b = ''; for await (const c of req) { b += c; if (b.length > 300_000) throw new Error('too large'); } return JSON.parse(b || '{}'); };
const ip = req => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress; // behind a proxy, ensure it sets this header

const routes = {
  'POST /api/projects'(req, res) {
    if (limited('new:' + ip(req), 10)) return json(res, 429, { error: 'Too many projects, slow down' });
    json(res, 200, { token: sign(crypto.randomBytes(12).toString('base64url'), 'edit') });
  },
  'GET /api/share'(req, res, auth) {
    if (auth?.role !== 'edit') return json(res, 403, { error: 'Edit access required' });
    json(res, 200, { edit: sign(auth.id, 'edit'), view: sign(auth.id, 'view') });
  },
  async 'POST /api/ai'(req, res, auth) {
    if (auth?.role !== 'edit') return json(res, 403, { error: 'Edit access required' });
    if (!KEY) return json(res, 503, { error: 'AI not configured' });
    if (limited('ai:' + auth.id, +AI_RATE) || limited('aiip:' + ip(req), +AI_RATE)) return json(res, 429, { error: 'AI rate limit, wait a minute' });
    const { mode, instruction = '', selection = '', file = '', language = '', context = '' } = await readBody(req);
    const prompt = `${PROMPTS[mode] ?? PROMPTS.custom}\n${instruction ? `Instruction: ${instruction}\n` : ''}Language: ${language}\n\n<other_files>\n${context.slice(0, 12000)}\n</other_files>\n\n<file>\n${file.slice(0, 20000)}\n</file>\n\n<selection>\n${selection}\n</selection>`;
    const it = llm(prompt)[Symbol.asyncIterator](), first = await it.next(); // surface provider errors before streaming starts
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (!first.done) res.write(`data: ${JSON.stringify(first.value)}\n\n`);
    for (let n = first.done ? { done: true } : await it.next(); !n.done; n = await it.next()) res.write(`data: ${JSON.stringify(n.value)}\n\n`);
    res.end('data: [DONE]\n\n');
  },
  async 'POST /api/complete'(req, res, auth) {
    if (auth?.role !== 'edit' || !KEY) return json(res, 200, { text: '' });
    if (limited('cmp:' + auth.id, +AI_RATE * 6)) return json(res, 429, { error: 'rate limited' });
    const { prefix = '', suffix = '', language = '' } = await readBody(req);
    let text = '';
    for await (const c of llm(`Language: ${language}\n${prefix.slice(-3000)}<cursor>${suffix.slice(0, 1000)}`, { fast: true, max: 120, system: 'You are a code completion engine. Output ONLY the text to insert at <cursor>: no fences, no explanation. Output nothing if no sensible completion exists.' })) text += c;
    json(res, 200, { text: text.replace(/^```\w*\n?|\n?```$/g, '') });
  },
  'GET /healthz'(req, res) { json(res, 200, { ok: true }); },
};

// ---------- static client (vite build output)
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
function serveStatic(req, res) {
  let f = path.normalize(path.join(DIST, new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); // SPA fallback for /p/<token>
  const asset = f.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': asset ? 'public, max-age=31536000, immutable' : 'no-store' });
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // links carry secrets in the path: never leak them via Referer, never frame the app
  res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('x-frame-options', 'DENY');
  const h = routes[`${req.method} ${req.url.split('?')[0]}`];
  if (!h) return req.method === 'GET' ? serveStatic(req, res) : res.writeHead(404).end();
  try { await h(req, res, verify(req.headers['x-token'])); } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); else res.end(); }
});

// ---------- realtime: verify token, enforce read-only, cap peers
const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });
const peers = new Map();
server.on('upgrade', (req, socket, head) => {
  const auth = req.url.startsWith('/yjs/') ? verify(decodeURIComponent(req.url.slice(5).split('?')[0])) : null;
  const badOrigin = ALLOWED_ORIGIN && req.headers.origin !== ALLOWED_ORIGIN;
  if (!auth || badOrigin || (peers.get(auth.id) ?? 0) >= +MAX_PEERS) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => {
    peers.set(auth.id, (peers.get(auth.id) ?? 0) + 1);
    ws.on('close', () => peers.set(auth.id, peers.get(auth.id) - 1));
    if (auth.role === 'view') { // drop Yjs sync step2 / update frames from view-only clients
      const on = ws.on.bind(ws);
      ws.on = (ev, fn) => on(ev, ev === 'message' ? m => { const b = new Uint8Array(m); if (b[0] === 0 && (b[1] === 1 || b[1] === 2)) return; fn(m); } : fn);
    }
    req.url = '/' + auth.id; // Yjs document name = project id (all roles share one doc)
    setupWSConnection(ws, req);
  });
});

server.listen(PORT, () => console.log(`listening on :${PORT}`));
const stop = () => { wss.clients.forEach(c => c.terminate()); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
