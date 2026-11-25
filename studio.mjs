import { EventEmitter } from 'node:events';
import { clean, suggested } from './director.mjs';

export class Studio extends EventEmitter {
  constructor({ director = null, worker = null, seconds = worker?.seconds || (worker ? 5.0625 : 8), maxShots = 24, maxDrafts = 48, admission = () => true } = {}) {
    super();
    Object.assign(this, { director, worker, seconds, maxShots, maxDrafts, admission, revision: 0, serial: 0, drafts: 0 });
    this.state = {
      renderer: worker?.label || (worker ? 'FastFrames-S' : 'Preview'), director: director ? 'AI director' : 'Sample cues',
      status: 'idle', automatic: true, brief: '', current: null, next: null, history: [],
      version: 0, planning: false, notice: '', fps: worker ? (worker.fps || 16) : null, progress: 0
    };
    worker?.on('frame', message => this.frame(message));
    worker?.on('ended', ({ id }) => this.ended(id));
    worker?.on('fault', error => this.fault(error));
    worker?.on('ready', () => this.emit('state'));
  }
  snapshot() { return { ...this.state, seconds: this.seconds }; }
  publish() { ++this.state.version; this.emit('state'); }
  cancelPlan() { ++this.revision; this.abort?.abort(); this.state.planning = false; }
  start({ brief, prompt, automatic = true }) {
    brief = clean(brief, 800);
    if (!brief) throw Error('Write a film brief first.');
    if (['playing', 'loading', 'holding'].includes(this.state.status)) throw Error('Stop the current session before starting a new one.');
    if (!this.admission('check')) throw Error('Today’s generation budget is exhausted.');
    this.drafts = 0;
    this.cancelPlan();
    Object.assign(this.state, { automatic: automatic !== false, brief, history: [], notice: '', next: null });
    const first = suggested(brief, 0);
    if (clean(prompt, 1250)) Object.assign(first, { prompt: clean(prompt, 1250), source: 'You' });
    this.play(first);
  }
  play(shot) {
    clearTimeout(this.timer);
    this.cancelPlan();
    if (!this.admission('take')) { this.stop('The generation budget is exhausted.'); return; }
    const current = { ...shot, id: ++this.serial, number: this.state.history.length + 1 };
    Object.assign(this.state, { current, next: null, status: this.worker ? 'loading' : 'playing', progress: 0, startedAt: this.worker ? null : Date.now(), notice: '' });
    this.state.history.push(current);
    this.publish();
    if (this.worker) this.worker.play(current);
    else this.timer = setTimeout(() => this.ended(current.id), this.seconds * 1000).unref();
    if (current.number < this.maxShots) void this.draft();
  }
  async draft(note = '') {
    if (!this.active()) throw Error('Start a session to draft the next shot.');
    if (this.state.history.length >= this.maxShots || this.drafts >= this.maxDrafts) {
      this.state.notice = 'No more director drafts for this session.'; this.publish(); return;
    }
    this.drafts++;
    this.cancelPlan();
    const revision = this.revision;
    this.abort = new AbortController();
    Object.assign(this.state, { planning: true, notice: '', next: null });
    this.publish();
    const { brief, current, history } = this.state;
    const direction = clean(note, 420);
    let next, notice = '';
    try {
      next = this.director
        ? await this.director({ brief, current, history, note: direction, signal: this.abort.signal })
        : suggested(brief, history.length, direction);
    } catch (error) {
      notice = error.name === 'TimeoutError' ? 'AI director timed out.' : 'AI director could not return a shot.';
    }
    if (revision !== this.revision || !this.active()) return;
    Object.assign(this.state, { planning: false, next: next || null, notice });
    this.publish();
    if (next && this.state.status === 'holding' && this.state.automatic) this.take();
  }
  active() { return ['loading', 'playing', 'holding'].includes(this.state.status); }
  edit({ title, prompt, currentId }) {
    if (!this.active()) throw Error('Start a session first.');
    if (currentId !== undefined && currentId !== this.state.current.id) throw Error('The shot changed before the edit arrived. Try editing the new queue.');
    prompt = clean(prompt, 1250);
    if (!prompt) throw Error('The next prompt is empty.');
    this.cancelPlan();
    Object.assign(this.state, {
      next: { title: clean(title, 64) || 'Your next shot', prompt, source: 'You' }, notice: ''
    });
    this.publish();
  }
  setAuto(value) { this.state.automatic = value === true; this.publish(); if (value === true && this.state.status === 'holding' && this.state.next) this.take(); }
  take() {
    if (!this.active() || !this.state.next) throw Error('There is no queued shot to take.');
    if (this.state.history.length >= this.maxShots) {
      this.stop('Session reached its shot limit. Your shot log is ready.');
      return;
    }
    this.play(this.state.next);
  }
  frame({ id, jpeg, frame }) {
    if (!this.active() || id !== this.state.current?.id || this.state.status === 'holding') return;
    if (this.state.status === 'loading') {
      this.state.status = 'playing';
      this.state.startedAt = Date.now();
      this.publish();
    }
    this.state.progress = Math.min(1, frame / (this.worker?.frames || 81));
    this.emit('frame', { id, jpeg, frame });
  }
  ended(id) {
    if (!this.active() || id !== this.state.current?.id) return;
    if (this.state.history.length >= this.maxShots) return this.stop('Session complete. Your shot log is ready.');
    if (this.state.automatic && this.state.next) return this.take();
    Object.assign(this.state, { status: 'holding', progress: 1 });
    this.publish();
  }
  stop(notice = '') {
    clearTimeout(this.timer);
    this.cancelPlan();
    this.worker?.pause();
    Object.assign(this.state, { status: 'stopped', startedAt: null, notice });
    this.publish();
  }
  fault(error) {
    clearTimeout(this.timer);
    this.cancelPlan();
    this.worker?.pause();
    Object.assign(this.state, { status: 'error', startedAt: null, notice: error });
    this.publish();
  }
}
