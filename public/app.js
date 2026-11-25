const $ = id => document.getElementById(id);
const ctx = $('video').getContext('2d');
let state, editing = false, frame = 0, latestRendered = 0, started = 0, image, imageId, running = false, localNotice = '';
let lockAuto = Promise.resolve();

function label(id, value) { $(id).textContent = value; }
function active() { return !!state && ['playing', 'loading', 'holding'].includes(state.status); }
function controls() {
  if (!state) return;
  $('take').disabled = !active() || (!state.next && !editing) || !$('next').value.trim();
  $('save').disabled = !active() || !editing || !$('next').value.trim();
  $('next').disabled = !active();
  $('draft').disabled = !active() || state.planning || editing;
  $('note').disabled = !active();
}
function render(next) {
  if (state && next.version < state.version) return;
  if (next.current?.id !== state?.current?.id) {
    editing = false; frame = latestRendered = 0;
    started = performance.now();
  }
  if (!['playing', 'loading', 'holding'].includes(next.status)) editing = false;
  state = next;
  label('engine', state.renderer.toUpperCase());
  label('director', state.director.toUpperCase());
  label('visualMode', state.renderer === 'Preview' ? 'ILLUSTRATED PREVIEW' : state.renderer.toUpperCase());
  label('footer', state.renderer === 'Preview' ? 'Illustrated preview. No GPU is running.' : state.publicMode ? 'Public GPU · one active viewer · four silent shots per session. Your text is sent to the director service configured by the studio operator.' : state.renderer + ' · silent video · separate shots joined by cuts');
  const set = active();
  $('brief').disabled = $('opening').disabled = set;
  $('start').hidden = set;
  $('start').disabled = !!(state.busy || state.outOfBudget);
  $('stop').hidden = !set;
  $('auto').checked = editing ? false : state.automatic;
  $('tally').classList.toggle('live', state.status === 'playing');
  $('export').disabled = !state.history.length;
  label('shotNumber', state.current ? 'SHOT ' + String(state.current.number).padStart(2, '0') : 'SHOT —');
  label('shotTitle', state.current?.title || 'The stage is yours.');
  label('source', editing ? 'YOUR EDIT' : state.next?.source?.toUpperCase() || 'STANDBY');
  label('suggestion', editing ? 'Editing next shot' : state.planning ? 'Writing the next shot…' : state.next?.title || 'Nothing queued');
  if (!editing) $('next').value = state.next?.prompt || '';
  label('stateLabel', localNotice || state.notice || (state.busy ? 'Another visitor is using the GPU' : '') || (state.outOfBudget ? 'Public generation is paused' : '') || ({
    idle: 'Ready to go live', loading: 'Waiting for the first frame…', playing: 'On air',
    holding: state.planning ? 'Holding while the next shot is written' : 'Holding on the last frame',
    stopped: 'Session stopped', error: 'Renderer stopped'
  })[state.status]);
  timeline();
  controls();
}
function timeline() {
  const root = $('timeline');
  const key = state.history.map(s => s.id).join(',');
  if (root.dataset.key === key) return;
  root.dataset.key = key;
  label('shotCount', state.history.length + (state.history.length === 1 ? ' SHOT' : ' SHOTS'));
  root.replaceChildren();
  if (!state.history.length) {
    const li = document.createElement('li'); li.className = 'empty';
    li.textContent = 'Your shots will appear here once you go live.'; root.append(li); return;
  }
  for (const s of state.history) {
    const li = document.createElement('li'), number = document.createElement('small');
    number.textContent = String(s.number).padStart(2, '0') + ' / ' + s.source;
    li.classList.toggle('current', s.id === state.current.id);
    li.title = s.prompt; li.append(number, document.createTextNode(s.title)); root.append(li);
  }
  root.scrollLeft = root.scrollWidth;
}
async function action(action, body = {}) {
  localNotice = '';
  try {
    const res = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || 'Action failed.');
    return data;
  } catch (error) {
    localNotice = error.message;
    label('stateLabel', localNotice);
    return false;
  }
}
$('start').onclick = () => action('start', { brief: $('brief').value, prompt: $('opening').value, automatic: $('auto').checked });
$('stop').onclick = () => action('stop');
$('auto').onchange = () => action('auto', { value: $('auto').checked });
$('draft').onclick = () => action('draft', { note: $('note').value });
$('next').oninput = () => {
  if (!editing) {
    editing = true; $('auto').checked = false;
    lockAuto = action('auto', { value: false });
  }
  label('source', 'YOUR EDIT'); label('suggestion', 'Editing next shot');
  controls();
};
async function saveEdit() {
  if (!editing) return true;
  const prompt = $('next').value;
  const currentId = state.current?.id;
  await lockAuto;
  const success = await action('edit', { prompt, currentId });
  if (success) {
    editing = false;
    render(success);
  }
  return !!success;
}
$('save').onclick = saveEdit;
$('take').onclick = async () => { if (await saveEdit()) await action('take'); };
$('export').onclick = () => {
  const data = new Blob([JSON.stringify({ brief: state.brief, shots: state.history }, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(data), link = document.createElement('a');
  link.href = href; link.download = 'cutline-shot-log.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};
const events = new EventSource('/api/events');
events.addEventListener('state', event => { running = true; render(JSON.parse(event.data)); });
events.addEventListener('frame', event => {
  const next = JSON.parse(event.data);
  if (next.id !== state?.current?.id) return;
  // Decode the newest frame. Older, slower decodes cannot replace it.
  const incoming = new Image();
  incoming.onload = () => {
    if (next.id !== state?.current?.id || next.frame <= latestRendered) return;
    latestRendered = frame = next.frame;
    image = incoming; imageId = next.id;
  };
  incoming.src = 'data:image/jpeg;base64,' + next.jpeg;
});
events.onerror = () => { running = false; label('stateLabel', 'Disconnected · reconnecting…'); };

const w = 832, h = 480;
const palettes = [
  ['#0a182e','#233b63','#b26c63','#050d20','#111e3d'],
  ['#0a1a38','#493663','#dc8564','#07101f','#142345'],
  ['#09192b','#223f58','#a37462','#050d17','#101c35'],
  ['#170c29','#49304a','#d19469','#080d23','#211937']
];
const stars = Array.from({length:98}, (_, i) => [((i * 9137) % 1237) / 1237, ((i*i * 733) % 919) / 919, i % 3]);
function painted(t, shot) {
  const p = palettes[shot % palettes.length], horizon = 268 + 5 * Math.sin(shot * 2);
  const sky = ctx.createLinearGradient(0,0,0,horizon+16);
  p.slice(0,3).forEach((c,i) => sky.addColorStop(i/2,c));
  ctx.fillStyle = sky; ctx.fillRect(0,0,w,horizon+20);
  for (const [x,y,r] of stars) {
    ctx.fillStyle = 'rgba(255,235,191,' + (.22 + r*.12) + ')';
    ctx.fillRect(x*w, y*147, r===2?2:1, r===2?2:1);
  }
  const moonX = 497 + Math.cos(shot*1.85)*108;
  const moon = ctx.createRadialGradient(moonX,183,0,moonX,183,93);
  moon.addColorStop(0,'#ffd8a8'); moon.addColorStop(.37,'#efad7f');
  moon.addColorStop(.39,'#f3b18936'); moon.addColorStop(1,'#f3b18900');
  ctx.fillStyle = moon; ctx.fillRect(moonX-94,89,188,188);
  for (let layer=0; layer<2; ++layer) {
    ctx.beginPath(); ctx.moveTo(0,horizon+15);
    for (let x=0;x<=w+12;x+=12) {
      const valley = 13*Math.sin(x*.014+layer*2)+10*Math.sin(x*.029+layer)+7*Math.sin(x*.061+4);
      ctx.lineTo(x,horizon-7+valley*(1+layer*.25));
    }
    ctx.lineTo(w,horizon+15); ctx.fillStyle=layer?'#12243a':'#3a4559'; ctx.fill();
  }
  const sea = ctx.createLinearGradient(0,horizon,0,h);
  sea.addColorStop(0,p[4]); sea.addColorStop(1,p[3]);
  ctx.fillStyle=sea; ctx.fillRect(0,horizon,w,h);
  for (let j=0;j<45;j++) {
    const y = horizon + 2 + ((j*173)%205), x = ((j*197 + 832 + t*(j%7+1)*4) % w);
    ctx.fillStyle=j%6===0?'#e9bb9c42':'#809fbe43';
    ctx.fillRect(x,y,10+(j%9)*6,1+(j%19===0?1:0));
    if(j%4===0){ ctx.fillStyle='#ffb68d52'; ctx.fillRect(moonX+Math.sin(j*4.2+t)* (y-horizon)*.4,y,j%13+4,1); }
  }
  const lx = 682 + 13 * Math.sin(shot*3);
  ctx.beginPath();ctx.moveTo(lx-55,horizon+16);ctx.lineTo(lx-24,horizon-5);
  ctx.lineTo(lx+31,horizon-9);ctx.lineTo(lx+64,horizon+12);ctx.fillStyle='#101726';ctx.fill();
  ctx.fillStyle='#c29c88';ctx.fillRect(lx-5,horizon-49,10,43);
  ctx.fillStyle='#e5ac78';ctx.fillRect(lx-8,horizon-55,16,7);
  ctx.fillStyle='#b67156';ctx.fillRect(lx-5,horizon-32,10,7);
  const beam=ctx.createLinearGradient(lx,horizon-52,lx-231,horizon-44);
  beam.addColorStop(0,'#ffdba29a');beam.addColorStop(1,'#ffe3ac00');
  ctx.fillStyle=beam;ctx.beginPath();ctx.moveTo(lx,horizon-54);ctx.lineTo(lx-260,horizon-82+13*Math.sin(t));
  ctx.lineTo(lx-260,horizon-43+23*Math.sin(t));ctx.lineTo(lx,horizon-50);ctx.fill();
  const x = 271 + (shot%4)*38 + t*8, y = 385 + 4*Math.sin(t*2.5);
  ctx.save();ctx.translate(x,y);ctx.rotate(.045*Math.sin(t*2));
  ctx.fillStyle='#bb6a43';ctx.beginPath();ctx.moveTo(-51,0);ctx.lineTo(53,-4);ctx.lineTo(37,13);ctx.lineTo(-31,14);ctx.fill();
  ctx.strokeStyle='#f8c789';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-4,0);ctx.lineTo(-4,-81);ctx.stroke();
  ctx.beginPath();ctx.moveTo(-7,-78);ctx.lineTo(-49,-10);ctx.lineTo(-7,-9);ctx.fillStyle='#f8b979';ctx.fill();
  ctx.beginPath();ctx.moveTo(1,-60);ctx.lineTo(48,-10);ctx.lineTo(1,-8);ctx.fillStyle='#db8a56';ctx.fill();
  ctx.restore();
}
function animate() {
  requestAnimationFrame(animate);
  const secs = state?.seconds || 8;
  const elapsed = state?.status === 'holding' ? secs : state?.status === 'playing'
    ? Math.min(secs,(performance.now()-started)/1000) : 0;
  if (state && state.renderer !== 'Preview') {
    if (image && (imageId === state.current?.id || state.status === 'loading')) ctx.drawImage(image,0,0,w,h);
    else { ctx.fillStyle='#0b151c'; ctx.fillRect(0,0,w,h); }
  } else painted(elapsed, (state?.current?.number || 1) - 1);
  const time = state && state.renderer !== 'Preview' ? frame / (state.fps || 16) : elapsed;
  $('progress').value = Math.min(1,time / secs);
  label('clock', '00:' + String(Math.floor(time)).padStart(2,'0') + ':' + String(Math.floor(time*16)%16).padStart(2,'0'));
  if (!running && !state) label('tally','');
}
requestAnimationFrame(animate);
