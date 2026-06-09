import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';
import { buildAudioChain, type AudioChain } from './chain.js';
import { genEvents, scheduleBell, bellTimbre, type GrainEvent, type PulseEvent, type BellEvent, type ScheduleEvent } from './events.js';

export type Mode = 'stillness' | 'motion';

// Singleton raw AudioContext — same approach as export.ts, no Tone.js involvement
let sharedCtx: AudioContext | null = null;
export function getAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext();
  }
  return sharedCtx;
}

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export class TerraSonicEngine {
  private chain: AudioChain | null = null;
  private ctx: AudioContext | null = null;
  private droneNodes: Array<{ osc: OscillatorNode; gain: GainNode; hp: BiquadFilterNode }> = [];
  private activeSources: AudioBufferSourceNode[] = [];
  private running = false;
  private cycle = 0;
  private eventQueue: ScheduleEvent[] = [];
  private eventIdx = 0;
  private startTime = 0;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  private profile!: ImageProfile;
  private feel!: Feel;
  private voicing!: Voicing;
  private mode!: Mode;
  private sourceBuffer!: AudioBuffer;
  private durationSecs = 180;

  async init(
    profile: ImageProfile,
    feel: Feel,
    voicing: Voicing,
    mode: Mode,
    sourceBuffer: AudioBuffer,
    durationSecs = 180,
    startSilent = false,
  ) {
    if (this.running) await this.stop();

    this.ctx = getAudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.profile = profile;
    this.feel = feel;
    this.voicing = voicing;
    this.mode = mode;
    this.sourceBuffer = sourceBuffer;
    this.durationSecs = durationSecs;
    this.cycle = 0;

    // Build signal chain — identical raw Web Audio graph as used by export
    this.chain = buildAudioChain(this.ctx, profile, feel, durationSecs);
    if (startSilent) this.chain.setMasterGain(0, 0);

    // Drone bed
    this._startDrone();

    // Schedule events
    this.eventQueue = genEvents(profile, feel, voicing, mode, durationSecs);
    this.eventIdx = 0;
    this.startTime = this.ctx.currentTime + 0.1;
    this.running = true;
    this._startScheduler();
  }

  private _startDrone() {
    const ctx = this.ctx!;
    const chain = this.chain!;
    const { space } = this.feel;
    const droneGain = 0.012 + space * 0.008;
    const baseFreq = mtof(this.profile.root - 12);

    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = baseFreq * (i === 0 ? 0.998 : 1.003);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(droneGain, ctx.currentTime + 7);

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 40;

      osc.connect(gain);
      gain.connect(hp);
      hp.connect(chain.input);
      osc.start();
      this.droneNodes.push({ osc, gain, hp });
    }
  }

  private _startScheduler() {
    const LOOKAHEAD = 0.5;
    const CHECK_INTERVAL_MS = 100;

    this.checkInterval = setInterval(() => {
      if (!this.running || !this.ctx || !this.chain) return;
      const now = this.ctx.currentTime;
      const horizon = now + LOOKAHEAD;

      while (this.eventIdx < this.eventQueue.length) {
        const ev = this.eventQueue[this.eventIdx];
        const absTime = this.startTime + ev.t;
        if (absTime > horizon) break;
        this._scheduleEvent(ev, absTime);
        this.eventIdx++;
      }

      if (this.eventIdx >= this.eventQueue.length) {
        this.cycle++;
        this.eventQueue = genEvents(
          this.profile, this.feel, this.voicing, this.mode,
          this.durationSecs, this.cycle * 131,
        );
        this.eventIdx = 0;
        this.startTime += this.durationSecs;
      }
    }, CHECK_INTERVAL_MS);
  }

  private _scheduleEvent(ev: ScheduleEvent, absTime: number) {
    if (ev.kind === 'grain') this._playGrain(ev as GrainEvent, absTime);
    else if (ev.kind === 'pulse') this._playPulse(ev as PulseEvent, absTime);
    else if (ev.kind === 'bell') this._playBell(ev as BellEvent, absTime);
  }

  private _playGrain(ev: GrainEvent, absTime: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.sourceBuffer;
    src.playbackRate.value = ev.rate;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, absTime);
    gainNode.gain.linearRampToValueAtTime(ev.gain, absTime + ev.dur * 0.45);
    gainNode.gain.linearRampToValueAtTime(0, absTime + ev.dur);

    const panner = ctx.createStereoPanner();
    panner.pan.value = ev.pan;

    if (this.mode === 'motion') {
      const wowRate = 0.18 + this.feel.energy * 0.05;
      const wowAmt = 0.003 * this.feel.energy;
      src.detune.setValueAtTime(0, absTime);
      for (let step = 0; step < Math.ceil(ev.dur) + 2; step++) {
        src.detune.linearRampToValueAtTime(
          Math.sin(2 * Math.PI * wowRate * step) * wowAmt * 1200,
          absTime + step,
        );
      }
    }

    src.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(this.chain!.input);

    const offset = Math.max(0, Math.min(ev.pos, this.sourceBuffer.duration - 0.01));
    src.start(absTime, offset, ev.dur + 0.05);
    src.stop(absTime + ev.dur + 0.1);
    this.activeSources.push(src);

    src.onended = () => {
      const idx = this.activeSources.indexOf(src);
      if (idx >= 0) this.activeSources.splice(idx, 1);
      try { gainNode.disconnect(); panner.disconnect(); } catch { /* ignore */ }
    };
  }

  private _playPulse(ev: PulseEvent, absTime: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = mtof(ev.midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, absTime);
    g.gain.linearRampToValueAtTime(ev.gain, absTime + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, absTime + 1.2);
    osc.connect(g);
    g.connect(this.chain!.input);
    osc.start(absTime);
    osc.stop(absTime + 1.3);
  }

  private _playBell(ev: BellEvent, absTime: number) {
    scheduleBell(this.ctx!, ev, bellTimbre(this.feel), this.chain!.input, absTime);
  }

  async stop() {
    this.running = false;
    if (this.checkInterval) { clearInterval(this.checkInterval); this.checkInterval = null; }

    for (const src of this.activeSources) {
      try { src.stop(); src.disconnect(); } catch { /* ignore */ }
    }
    this.activeSources = [];

    for (const { osc, gain, hp } of this.droneNodes) {
      try { osc.stop(); osc.disconnect(); gain.disconnect(); hp.disconnect(); } catch { /* ignore */ }
    }
    this.droneNodes = [];

    this.chain?.dispose();
    this.chain = null;
  }

  fadeIn(secs: number) {
    this.chain?.setMasterGain(0.72, secs);
  }

  fadeOut(secs: number) {
    this.chain?.setMasterGain(0, secs);
  }

  isRunning() { return this.running; }
}
