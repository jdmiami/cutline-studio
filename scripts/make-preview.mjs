import { mkdir, readFile, writeFile } from 'node:fs/promises';
const base = new URL('../', import.meta.url);
const get = file => readFile(new URL(file, base), 'utf8');
const [page, css, app, core, director] = await Promise.all(['public/index.html','public/studio.css','public/app.js','studio.mjs','director.mjs'].map(get));
const bus = `class EventEmitter {
  constructor(){this.listeners = {};}
  on(key, callback){(this.listeners[key] ??= []).push(callback);}
  emit(key, value){for(const callback of this.listeners[key] || []) callback(value);}
}
const preview = new Studio();
function LocalEvents() {
  this.addEventListener = (name, fn) => {
    if (name !== 'state') return;
    const send = () => fn({ data: JSON.stringify(preview.snapshot()) });
    preview.on('state', send);
    queueMicrotask(send);
  };
}
async function localFetch(path, request) {
  try {
    const input = JSON.parse(request.body);
    switch(input.action) {
      case 'start': preview.start(input); break;
      case 'stop': preview.stop(); break;
      case 'auto': preview.setAuto(input.value); break;
      case 'draft': void preview.draft(input.note); break;
      case 'edit': preview.edit(input); break;
      case 'take': preview.take(); break;
    }
    return {ok:true, json:async () => preview.snapshot()};
  } catch (error) { return {ok:false, json:async () => ({error:error.message})}; }
}`;
const [emitter, transport] = bus.split('const preview =');
const source = emitter + director.replace(/^export /gm,'') +
  core.replace(/^import .*\n/gm,'').replace(/^export /gm,'').replace(').unref();', ');') +
  'const preview =' + transport + '\n' + app.replace("new EventSource('/api/events')", 'new LocalEvents()').replace("fetch('/api/action'", "localFetch('/api/action'");
await writeFile(new URL('START-HERE.html', base), page
  .replace('<link rel="stylesheet" href="/studio.css">', () => '<style>'+css+'</style>')
  .replace('<script type="module" src="/app.js"></script>', () => '<script type="module">'+source+'</script>')
  .replace('href="/" aria-label=', 'href="#" aria-label='));

const rawURL = process.env.PUBLIC_GPU_URL || '';
if (rawURL && !/^https:\/\/[a-z0-9-]+\.proxy\.runpod\.net$/.test(rawURL)) {
  throw Error('PUBLIC_GPU_URL must be the HTTPS Runpod proxy origin.');
}
const launcher = rawURL
  ? '<a class="outline live-link" href="' + rawURL + '">Open live GPU</a>'
  : '<span class="pill quiet">PUBLIC GPU OFFLINE</span>';
await mkdir(new URL('vercel-public/', base), { recursive: true });
await Promise.all([
  writeFile(new URL('vercel-public/index.html', base), page.replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/preview.js"></script>')
    .replace('<span id="director" class="pill quiet">SAMPLE CUES</span>', '<span id="director" class="pill quiet">SAMPLE CUES</span>' + launcher)),
  writeFile(new URL('vercel-public/preview.js', base), source),
  writeFile(new URL('vercel-public/studio.css', base), css + '\n.live-link{font-size:11px;text-decoration:none;display:flex;align-items:center}.top-status{align-items:center}\n')
]);
