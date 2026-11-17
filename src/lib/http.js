import { ApiError } from './util.js';

const MAX_BODY = 8 * 1024 * 1024;

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const names = [];
    const regex = new RegExp(`^${pattern.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    }).replace(/\//g, '\\/')}$`);
    routes.push({ method, regex, names, handler });
  };
  const router = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      let path = url.pathname;
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.regex.exec(path);
        if (!m) continue;
        const params = {};
        route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        try {
          const raw = await readBody(req);
          const body = raw ? parseJson(raw) : {};
          const result = await route.handler({ req, res, params, query: url.searchParams, body });
          if (result !== undefined && !res.headersSent) {
            sendJson(res, 200, result);
          }
        } catch (err) {
          const status = err instanceof ApiError ? err.status : 500;
          if (status >= 500) console.error(`[${req.method} ${path}]`, err);
          if (!res.headersSent) {
            sendJson(res, status, {
              error: err.message || '内部错误',
              ...(err.details ? { details: err.details } : {}),
            });
          }
        }
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    },
  };
  return router;
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON');
  }
}
