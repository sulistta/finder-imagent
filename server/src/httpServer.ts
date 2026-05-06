import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import { loadServerEnv, type ServerEnv } from './env.js';
import { ImageFinderJobManager } from './jobManager.js';
import type { JobConfig } from './types.js';
import { previewWorkbook } from './workbook.js';

export interface LocalServer {
  server: http.Server;
  env: ServerEnv;
  jobManager: ImageFinderJobManager;
}

export function createLocalServer(env = loadServerEnv()): LocalServer {
  const rootDir = path.resolve(env.dataDir);
  fs.mkdirSync(rootDir, { recursive: true });
  const store = { rootDir };
  const jobManager = new ImageFinderJobManager({
    store,
    apiKeys: env.apiKeys,
    models: env.models,
    googleHeadless: env.googleHeadless,
    google: env.google,
  });

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, env, store, jobManager);
  });

  return { server, env, jobManager };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  env: ServerEnv,
  store: { rootDir: string },
  jobManager: ImageFinderJobManager,
): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        apiKeys: env.apiKeys.map(({ id, label }) => ({ id, label })),
        models: {
          query: Boolean(env.models.query),
          ranking: Boolean(env.models.ranking),
          visual: Boolean(env.models.visual),
          metadata: Boolean(env.models.metadata),
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/workbooks/preview') {
      const upload = await readUpload(req);
      const preview = await previewWorkbook(store, upload.buffer, upload.filename);
      sendJson(res, 200, preview);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const config = (await readJson(req)) as JobConfig;
      const started = await jobManager.startJob(config);
      sendJson(res, 200, started);
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (req.method === 'GET' && eventsMatch) {
      streamJobEvents(res, jobManager, eventsMatch[1]);
      return;
    }

    const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/download$/);
    if (req.method === 'GET' && downloadMatch) {
      const filePath = jobManager.getDownloadPath(downloadMatch[1]);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="image-finder-output.xlsx"',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(url.pathname, res)) return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function streamJobEvents(
  res: http.ServerResponse,
  jobManager: ImageFinderJobManager,
  jobId: string,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const unsubscribe = jobManager.subscribe(jobId, (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  });
  res.on('close', unsubscribe);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  return JSON.parse(body.toString('utf8'));
}

async function readUpload(req: http.IncomingMessage): Promise<{ filename: string; buffer: Buffer }> {
  const contentType = req.headers['content-type'] || '';
  const body = await readBody(req);
  if (!contentType.startsWith('multipart/form-data')) {
    return { filename: 'upload.xlsx', buffer: body };
  }
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new Error('Missing multipart boundary');

  const marker = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(marker);
  while (cursor >= 0) {
    const next = body.indexOf(marker, cursor + marker.length);
    if (next < 0) break;
    const part = body.subarray(cursor + marker.length + 2, next - 2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const filename = headers.match(/filename="([^"]+)"/)?.[1];
      if (filename) {
        return { filename, buffer: part.subarray(headerEnd + 4) };
      }
    }
    cursor = next;
  }
  throw new Error('No uploaded workbook found');
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 50 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function serveStatic(requestPath: string, res: http.ServerResponse): boolean {
  const webviewDir = path.resolve('dist/webview');
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(webviewDir, relativePath);
  if (!filePath.startsWith(webviewDir)) return false;
  const resolvedPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(webviewDir, 'index.html');
  if (!fs.existsSync(resolvedPath)) return false;
  res.writeHead(200, { 'Content-Type': contentType(resolvedPath) });
  fs.createReadStream(resolvedPath).pipe(res);
  return true;
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}
