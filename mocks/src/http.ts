import http from 'node:http';

export type Req = http.IncomingMessage & { body?: any; params: Record<string, string>; query: URLSearchParams };
export type Handler = (req: Req, res: http.ServerResponse) => unknown | Promise<unknown>;

/** Tiny router shared by the two mock services (no framework needed). */
export function createRouter() {
  const routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
  const add = (method: string, path: string, h: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, h });
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return send(res, 404, { code: 'NOT_FOUND', message: url.pathname });
    const m = url.pathname.match(route.re)!;
    const r = req as Req;
    r.params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    r.query = url.searchParams;
    if (req.method !== 'GET') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { r.body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { code: 'BAD_REQUEST', message: 'invalid json' }); }
    }
    try { await route.h(r, res); } catch (e) {
      if (!res.headersSent) send(res, 500, { code: 'INTERNAL', message: String(e) });
    }
  });
  return { server, get: (p: string, h: Handler) => add('GET', p, h), post: (p: string, h: Handler) => add('POST', p, h) };
}

export function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
