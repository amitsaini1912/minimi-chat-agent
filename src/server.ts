import 'dotenv/config';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './memory/store.js';
import { runTurn, type AgentEvent } from './agent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store(process.env.DATA_FILE || path.join(root, 'data', 'memory.json'));
const PORT = Number(process.env.PORT || 3000);

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('\n  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n');
}

const STATIC: Record<string, [string, string]> = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.umd.js', 'text/javascript'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.min.js', 'text/javascript'],
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

function validTimeZone(tz: unknown): string {
  try { if (typeof tz === 'string') { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } } catch { /* fall through */ }
  return 'UTC';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    const file = STATIC[url.pathname];
    if (req.method === 'GET' && file) {
      res.writeHead(200, { 'content-type': file[1] + '; charset=utf-8' });
      return res.end(await fs.readFile(path.join(root, file[0])));
    }

    if (url.pathname === '/api/conversations' && req.method === 'GET') {
      return json(res, 200, store.list().filter((c) => store.get(c.id)!.turns.length));
    }
    const m = url.pathname.match(/^\/api\/conversations\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const c = store.get(m[1]);
      return c ? json(res, 200, c) : json(res, 404, { error: 'not found' });
    }
    if (m && req.method === 'DELETE') { await store.remove(m[1]); return json(res, 200, { ok: true }); }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const message = String(body.message ?? '').trim();
      if (!message) return json(res, 400, { error: 'empty message' });

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const ctrl = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
      const emit = (e: AgentEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
      try {
        await runTurn({ store, conversationId: body.conversationId, message, timeZone: validTimeZone(body.timeZone), emit, signal: ctrl.signal });
      } catch (err: any) {
        if (!ctrl.signal.aborted) {
          console.error(err);
          emit({ type: 'error', message: err?.error?.error?.message || err?.message || 'Something went wrong' });
        }
      }
      return res.end();
    }

    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`Chat agent running at http://localhost:${PORT}`));
