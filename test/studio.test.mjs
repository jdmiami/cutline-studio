import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Studio } from '../studio.mjs';
import { buildDirector } from '../director.mjs';
import { createStudioServer } from '../pod-server.mjs';

function deferred() {
  let resolve;
  const result = new Promise(r => { resolve = r; });
  return { result, resolve };
}

test('a late director draft advances a held shot only once', async () => {
  const hold = deferred();
  const studio = new Studio({ director: () => hold.result, seconds: .03 });
  studio.start({ brief: 'A boat finds a lighthouse.' });
  while (studio.snapshot().status !== 'holding') await sleep(10);
  assert.equal(studio.snapshot().history.length, 1);
  hold.resolve({ title: 'Closer', prompt: 'The same amber boat approaches the lighthouse.', source: 'AI director' });
  await sleep(0);
  const state = studio.snapshot();
  assert.equal(state.current.number, 2);
  assert.equal(state.current.title, 'Closer');
  studio.stop();
});

test('a human override wins even if a stale AI response arrives', async () => {
  const hold = deferred();
  const studio = new Studio({ director: () => hold.result });
  studio.start({ brief: 'Amber boat on cobalt water.', automatic: false });
  const opening = studio.snapshot().current.id;
  studio.edit({ prompt: 'Cut to the light through fog.', currentId: opening });
  hold.resolve({ title: 'Old cue', prompt: 'A stale draft.', source: 'AI director' });
  await sleep(0);
  assert.equal(studio.snapshot().next.source, 'You');
  assert.equal(studio.snapshot().next.prompt, 'Cut to the light through fog.');
  studio.take();
  assert.equal(studio.snapshot().current.number, 2);
  assert.throws(() => studio.edit({ prompt: 'Wrong target.', currentId: opening }), /shot changed/);
  studio.stop();
});

test('video events only affect the latest active shot', () => {
  const worker = Object.assign(new EventEmitter(), {
    play(shot) { this.requested = shot.id; },
    pause() { this.paused = true; }
  });
  const studio = new Studio({ worker });
  studio.start({ brief: 'A ship crosses the ocean.', automatic: false });
  const first = worker.requested;
  assert.equal(studio.snapshot().status, 'loading');
  worker.emit('frame', { id: first, jpeg: 'sample', frame: 1 });
  assert.equal(studio.snapshot().status, 'playing');
  worker.emit('ended', { id: first });
  assert.equal(studio.snapshot().status, 'holding');
  studio.setAuto(true);
  assert.notEqual(worker.requested, first);
  worker.emit('frame', { id: first, jpeg: 'stale', frame: 81 });
  assert.equal(studio.snapshot().status, 'loading');
  studio.stop();
  assert.equal(worker.paused, true);
});

test('director uses the configured model, note and recent shot history', async t => {
  const stub = http.createServer(async (req, res) => {
    const input = [];
    for await (const b of req) input.push(b);
    const payload = JSON.parse(Buffer.concat(input));
    t.diagnostic('Director called the local test server.');
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(payload.model, 'test-director');
    assert.equal(payload.response_format.type, 'json_object');
    const context = JSON.parse(payload.messages[1].content);
    assert.equal(context.latestHumanNote, 'Closer fog');
    assert.equal(context.recentShots.length, 3);
    res.end(JSON.stringify({ choices: [{ message: { content: '{"title":"Close Shot","prompt":"Fog rolls over the same amber boat."}' } }] }));
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  const direct = buildDirector({ url: 'http://127.0.0.1:' + stub.address().port + '/v1', model: 'test-director' });
  assert.deepEqual(await direct({ brief: 'Boat', current: { title: 'Wide' }, history: [0,1,2,3], note: 'Closer fog', signal: new AbortController().signal }), {
    title: 'Close Shot', prompt: 'Fog rolls over the same amber boat.', source: 'AI director'
  });
});

test('HTTP app serves assets and begins a session with a streamed update', async t => {
  const studio = new Studio();
  const server = createStudioServer({ studio });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const stop = new AbortController();
  t.after(() => { stop.abort(); studio.stop(); server.closeAllConnections(); server.close(); });
  const page = await fetch(base);
  assert.match(await page.text(), /Direct the <em>next shot/);
  assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
  for (const asset of ['/app.js', '/studio.css']) assert.equal((await fetch(base+asset)).status, 200);
  const stream = await fetch(base + '/api/events', { signal: stop.signal });
  const reader = stream.body.getReader();
  const decode = result => Buffer.from(result.value).toString();
  assert.match(decode(await reader.read()), /"status":"idle"/);
  const denied = await fetch(base + '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' },
    body: JSON.stringify({ action: 'start', brief: 'Cross-origin test' })
  });
  assert.equal(denied.status, 403);
  const start = await fetch(base + '/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start', brief: 'A boat crosses a dark sea.', automatic: false })
  });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).next.source, 'Sample cues');
  assert.match(decode(await reader.read()), /"status":"playing"/);
});

test('public sessions isolate prompts and cap access to one visitor', async t => {
  const studio = new Studio({ seconds: 20 });
  const origin = 'https://example-8765.proxy.runpod.net';
  const server = createStudioServer({ studio, publicOrigin: origin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { studio.stop(); server.closeAllConnections(); server.close(); });
  const session = async () => (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const a = await session(), b = await session();
  const use = (cookie, action, data = {}, requestOrigin = origin) => fetch(base + '/api/action', {
    method:'POST', headers: {'Content-Type':'application/json', Origin:requestOrigin, Cookie:cookie},
    body:JSON.stringify({ action, ...data })
  });
  assert.equal((await use(a, 'start', {brief:'A private cue.'}, 'https://other.example')).status, 403);
  assert.equal((await use(a, 'start', {brief:'A private cue.'})).status, 200);
  assert.equal((await use(b, 'start', {brief:'Another film.'})).status, 409);
  const other = await (await fetch(base + '/api/state', { headers:{Cookie:b} })).json();
  assert.equal(other.brief, '');
  assert.equal(other.current, null);
  assert.equal(other.busy, true);
  assert.equal((await use(b, 'stop')).status, 403);
  assert.equal((await use(a, 'stop')).status, 200);
});

test('global shot budget and public draft cap stop additional work', async () => {
  let remaining = 2;
  const stub = () => Promise.resolve({title:'A cut', prompt:'A queued shot', source:'AI director'});
  const studio = new Studio({ director:stub, maxShots:2, maxDrafts:1,
    admission: action => {
      if (!remaining) return false;
      if (action === 'take') remaining--;
      return true;
    }});
  studio.start({brief:'A film.'});
  await sleep(0);
  await studio.draft();
  assert.equal(studio.snapshot().next.title, 'A cut');
  studio.take();
  assert.equal(studio.snapshot().current.number, 2);
  studio.ended(studio.snapshot().current.id);
  assert.equal(studio.snapshot().status, 'stopped');
  assert.throws(() => studio.start({brief:'Another film.'}), /budget/);
});
