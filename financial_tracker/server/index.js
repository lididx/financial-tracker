import express from 'express';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = process.env.DATA_DIR || '/data';
const DATA_PATH = join(DATA_DIR, 'fin.json');
const BAK_PATH  = join(DATA_DIR, 'fin.json.bak');
const DIST_DIR  = process.env.DIST_DIR || join(__dirname, '..', 'dist');
const PORT      = parseInt(process.env.PORT || '8099', 10);

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

let state = { data: null, theme: 'light', revision: 0 };

if (existsSync(DATA_PATH)) {
  try {
    const raw = readFileSync(DATA_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    state.data = parsed.data ?? null;
    state.theme = parsed.theme ?? 'light';
    state.revision = parsed.revision ?? 0;
    console.log(`Loaded data from ${DATA_PATH} (revision ${state.revision})`);
  } catch (err) {
    console.error('Failed to load data file, starting empty:', err.message);
  }
}

const sseClients = new Map();

function broadcast(excludeClientId, payload) {
  const msg = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [clientId, res] of sseClients) {
    if (clientId === excludeClientId) continue;
    res.write(msg);
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', revision: state.revision, uptime: process.uptime() });
});

app.get('/api/data', (_req, res) => {
  res.json({ data: state.data, theme: state.theme, revision: state.revision });
});

app.put('/api/data', (req, res) => {
  const { data, theme, revision } = req.body;
  if (data === undefined || revision === undefined) {
    return res.status(400).json({ error: 'missing data or revision' });
  }

  if (revision !== state.revision) {
    return res.status(409).json({
      error: 'conflict',
      serverRevision: state.revision,
      serverData: state.data,
      serverTheme: state.theme,
    });
  }

  state.revision++;
  state.data = data;
  if (theme !== undefined) state.theme = theme;

  try {
    if (existsSync(DATA_PATH)) {
      copyFileSync(DATA_PATH, BAK_PATH);
    }
    writeFileSync(DATA_PATH, JSON.stringify({
      data: state.data,
      theme: state.theme,
      revision: state.revision,
    }, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write data file:', err.message);
  }

  const clientId = req.headers['x-client-id'] || '';
  broadcast(clientId, {
    data: state.data,
    theme: state.theme,
    revision: state.revision,
  });

  res.json({ ok: true, revision: state.revision });
});

app.get('/api/events', (req, res) => {
  const clientId = req.query.clientId || `anon-${Date.now()}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ revision: state.revision })}\n\n`);

  sseClients.set(clientId, res);

  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  });
});

const indexHtml = existsSync(join(DIST_DIR, 'index.html'))
  ? readFileSync(join(DIST_DIR, 'index.html'), 'utf-8')
  : null;

function serveIndex(req, res) {
  if (!indexHtml) return res.status(404).send('Not found');
  const ingressPath = req.headers['x-ingress-path'];
  if (ingressPath) {
    const html = indexHtml.replace('<head>', `<head><base href="${ingressPath}/">`);
    return res.type('html').send(html);
  }
  res.type('html').send(indexHtml);
}

if (existsSync(DIST_DIR)) {
  app.get('/', serveIndex);
  app.use(express.static(DIST_DIR));
  app.get('*', serveIndex);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Financial Tracker server running on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Dist dir: ${DIST_DIR}`);
});
