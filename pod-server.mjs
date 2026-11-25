import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { Studio } from './studio.mjs';
import { buildDirector } from './director.mjs';

export function gpuWorker({ root, python = root + '/.venv/bin/python', checkpoints = root + '/checkpoints', helios = false }) {
  if (!existsSync(python)) throw Error('GPU Python environment not found. Follow the model setup guide.');
  const label = helios ? 'Helios Distilled' : 'FastFrames-S';
  const bridge = new EventEmitter();
  Object.assign(bridge, { label, fps: 16, seconds: helios ? 5 : 5.0625, frames: helios ? 80 : 81 });
  let child, closing = false;
  function send(message) {
    child?.stdin.write(JSON.stringify(message) + '\n');
  }
  bridge.play = shot => {
    if (!child) {
      closing = false;
      const proc = spawn(python, ['-u', fileURLToPath(new URL(helios ? './helios_worker.py' : './fastframes_worker.py', import.meta.url)), root, checkpoints], {
        cwd: root, stdio: ['pipe', 'pipe', 'inherit']
      });
      child = proc;
      proc.stdin.on('error', () => {});
      proc.on('error', error => bridge.emit('fault', label + ' failed to launch: ' + error.code));
      proc.on('close', code => {
        if (child !== proc) return;
        child = null;
        if (!closing) bridge.emit('fault', label + ' stopped (' + code + '). See the server console.');
      });
      const lines = createInterface({ input: proc.stdout });
      lines.on('line', line => {
        try {
          const result = JSON.parse(line);
          if (result.type === 'frame' || result.type === 'ended') bridge.emit(result.type, result);
          if (result.type === 'ready') bridge.emit('ready');
          if (result.type === 'error') bridge.emit('fault', label + ' could not render this shot. See the server console.');
        } catch { /* Version mismatch or invalid worker output: ignore non-protocol lines. */ }
      });
    }
    send({ type: 'play', id: shot.id, prompt: shot.prompt, seed: 314159 });
  };
  bridge.pause = () => send({ type: 'pause' });
  bridge.close = () => { closing = true; child?.kill(); };
  return bridge;
}

export function createStudioServer({ studio = new Studio(), worker = null, publicOrigin = '', remaining = () => Infinity, leaseMs = 180000 } = {}) {
  const clients = new Map();
  let owner, lease, lastStart = 0;
  const getSession = req => /(?:^|;\s*)cutline_player=([a-f0-9]{64})(?=;|$)/.exec(req.headers.cookie || '')?.[1];
  function view(session) {
    const snapshot = studio.snapshot();
    if (!publicOrigin) return snapshot;
    if (session && session === owner) return { ...snapshot, publicMode: true, outOfBudget: remaining() <= 0 };
    return { ...snapshot, status: 'idle', brief: '', current: null, next: null, history: [], planning: false,
      notice: '', progress: 0, startedAt: null, automatic: true, busy: studio.active(), publicMode: true,
      outOfBudget: remaining() <= 0 };
  }
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/studio.css', ['studio.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
  ]);
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  function packet(event, data) { return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; }
  function multicast(event, data) {
    for (const [res, session] of clients) {
      if (publicOrigin && event === 'frame' && session !== owner) continue;
      const payload = packet(event, event === 'state' ? view(session) : data);
      if (res.writableEnded || res.destroyed) continue;
      if (res.writableLength > 196608 && event === 'frame') continue;
      if (res.writableLength > 524288) { res.destroy(); continue; }
      res.write(payload);
    }
  }
  studio.on('state', () => { if (!studio.active()) clearTimeout(lease); multicast('state'); });
  studio.on('frame', data => multicast('frame', data));

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!publicOrigin && !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(req.headers.host || '')) {
      return json(res, 403, { error: 'Use the localhost address or an SSH tunnel.' });
    }
    if (publicOrigin) res.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(req.url, 'http://localhost').pathname;
    const session = publicOrigin ? getSession(req) : undefined;
    if (req.method === 'GET' && staticFiles.has(path)) {
      const [name, mime] = staticFiles.get(path);
      if (publicOrigin && path === '/' && !session) {
        res.setHeader('Set-Cookie', 'cutline_player=' + randomBytes(32).toString('hex') + '; Path=/; HttpOnly; Secure; SameSite=Strict');
      }
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
      try {
        const file = await readFile(new URL('./public/' + name, import.meta.url));
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        return res.end(file);
      } catch { return json(res, 500, { error: 'Studio assets are missing.' }); }
    }
    if (req.method === 'GET' && path === '/health') return json(res, 200, { online: true, publicMode: !!publicOrigin, busy: studio.active(), available: remaining() > 0 });
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, view(session));
    if (req.method === 'GET' && path === '/api/events') {
      if (clients.size >= (publicOrigin ? 24 : 8)) return json(res, 429, { error: 'Too many open studio tabs.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.write(packet('state', view(session)));
      clients.set(res, session);
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 10000).unref();
      res.on('close', () => { clients.delete(res); clearInterval(keepalive); });
      return;
    }
    if (req.method !== 'POST' || path !== '/api/action') return json(res, 404, { error: 'Not found.' });
    if (!(req.headers['content-type'] || '').startsWith('application/json') ||
        (publicOrigin ? req.headers.origin !== publicOrigin || !session : req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      return json(res, 403, { error: 'Open the studio on its local address.' });
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { json(res, 413, { error: 'Shot input is too long.' }); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks));
      if (publicOrigin) {
        if (input.action === 'start') {
          if (studio.active()) return json(res, 409, { error: 'The live camera is busy. Try again after the current session.' });
          if (remaining() <= 0) return json(res, 429, { error: 'This pod reached its generation limit.' });
          if (Date.now() - lastStart < 10000) return json(res, 429, { error: 'The studio is cooling down. Try again in a few seconds.' });
          if (typeof input.brief !== 'string' || !input.brief.trim()) return json(res, 400, { error: 'Write a film brief first.' });
          owner = session;
          lastStart = Date.now();
          clearTimeout(lease);
          lease = setTimeout(() => studio.stop('The public session time limit was reached.'), leaseMs).unref();
        } else if (session !== owner) return json(res, 403, { error: 'Only the current director can change a session.' });
      }
      switch (input.action) {
        case 'start': studio.start(input); break;
        case 'edit': studio.edit(input); break;
        case 'draft':
          if (!studio.active()) throw Error('Start a session to draft a shot.');
          void studio.draft(input.note); break;
        case 'auto': studio.setAuto(input.value); break;
        case 'take': studio.take(); break;
        case 'stop': studio.stop(); break;
        default: return json(res, 400, { error: 'Unknown action.' });
      }
      return json(res, 200, view(session));
    } catch (error) {
      return json(res, 400, { error: error.message || 'Studio action failed.' });
    }
  });
  server.on('close', () => { clearTimeout(lease); worker?.close(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const publicOrigin = env.PUBLIC_STUDIO_ORIGIN || '';
  if (publicOrigin && !/^https:\/\/[a-z0-9-]+\.proxy\.runpod\.net$/.test(publicOrigin)) {
    throw Error('Use the exact HTTPS Runpod pod proxy origin for PUBLIC_STUDIO_ORIGIN.');
  }
  if (publicOrigin && (!env.HELIOS_ROOT || env.FASTFRAMES_ROOT)) throw Error('Public mode requires Helios and cannot use FastFrames.');
  const worker = env.HELIOS_ROOT ? gpuWorker({
    root: env.HELIOS_ROOT, python: env.HELIOS_PYTHON, checkpoints: env.HELIOS_MODEL_DIR || 'BestWishYsh/Helios-Distilled', helios: true
  }) : env.FASTFRAMES_ROOT && gpuWorker({
    root: env.FASTFRAMES_ROOT, python: env.FASTFRAMES_PYTHON, checkpoints: env.FASTFRAMES_CHECKPOINTS
  });
  const director = buildDirector({ url: env.DIRECTOR_URL, key: env.DIRECTOR_API_KEY, model: env.DIRECTOR_MODEL });
  if (publicOrigin && !director) throw Error('Configure DIRECTOR_URL and DIRECTOR_MODEL for public generation.');
  const cap = Number(env.PUBLIC_SHOT_BUDGET || 40);
  if (publicOrigin && (!Number.isInteger(cap) || cap < 1 || cap > 200)) throw Error('PUBLIC_SHOT_BUDGET must be 1–200.');
  let used = 0;
  const remaining = () => publicOrigin ? cap - used : Infinity;
  const admission = action => {
    if (remaining() <= 0) return false;
    if (action === 'take') used++;
    return true;
  };
  const studio = new Studio({ director, worker: worker || null, maxShots: publicOrigin ? 4 : 24, maxDrafts: publicOrigin ? 6 : 48, admission });
  const server = createStudioServer({ studio, worker, publicOrigin, remaining });
  const port = Number(env.PORT || 8765);
  server.listen(port, publicOrigin ? '0.0.0.0' : '127.0.0.1', () => console.log('Cutline Studio · ' + (publicOrigin || 'http://127.0.0.1:' + server.address().port)));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { worker?.close(); process.exit(); });
}
