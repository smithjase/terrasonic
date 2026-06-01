import * as Tone from 'tone';
import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';
import { SRC_DUR } from './source.js';

export type Mode = 'stillness' | 'motion';

// mulberry32 PRNG (identical to prototype)
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// HANN window (257-point)
const HANN = new Float32Array(257);
for (let i = 0; i < 257; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / 256));

interface GrainEvent {
  kind: 'grain';
  t: number;
  rate: number;
  dur: number;
  pos: number;
  pan: number;
  gain: number;
  air: boolean;
}

interface PulseEvent {
  kind: 'pulse';
  t: number;
  midi: number;
  gain: number;
}

type ScheduleEvent = GrainEvent | PulseEvent;

function genEvents(p: ImageProfile, feel: Feel, vc: Voicing, md: Mode, duration: number, seedOffset = 0): ScheduleEvent[] {
  const rng = mulberry32(p.seed + seedOffset + (md === 'motion' ? 2000 : 7000));
  const evs: ScheduleEvent[] = [];
  const tones: Array<{ iv: number; gainMul: number; air: boolean; idx: number }> = vc.tmpl.map((iv, i) => ({
    iv: iv + vc.reg,
    gainMul: [0.20, 0.17, 0.16, 0.12][i] ?? 0.12,
    air: false,
    idx: i,
  }));
  tones.push({ iv: vc.airTone, gainMul: 0.09, air: true, idx: tones.length });

  const nL = tones.length;
  const colorIdx = 2;
  const colorPeriod = (md === 'motion' ? 45 : 75) / (0.6 + feel.energy);

  tones.forEach((L, li) => {
    const swellRate = 0.018 + feel.energy * 0.05 + li * 0.004;
    const swellPh = rng() * 6.283;
    let t = rng() * 4 + li * 0.99;

    while (t < duration) {
      let iv = L.iv;
      if (li === colorIdx) {
        iv += (Math.floor(t / colorPeriod) % 2 === 1) ? (feel.valence > 0.5 ? 2 : -2) : 0;
      }
      const rate = Math.pow(2, iv / 12);
      const baseDur = (md === 'motion' ? (2.6 + rng() * 1.8) : (3.6 + rng() * 2.4)) * (1 + feel.serene * 0.6);
      const dur = Math.min(baseDur, (SRC_DUR - 0.3) / rate);
      const overlap = (md === 'motion' ? 2.2 : 1.7) + feel.energy * 0.7 - feel.serene * 0.5;
      const swell = 0.45 + 0.55 * Math.sin(2 * Math.PI * swellRate * t + swellPh);
      const gain = L.gainMul * (0.35 + 0.75 * swell);
      const valid = Math.max(0.1, SRC_DUR - dur * rate - 0.2);
      const pos = ((t / duration) * valid * 0.7 + rng() * valid * 0.3) % valid;
      const spread = (li / (Math.max(1, nL - 1))) * 1.4 - 0.7;
      const pan = (L.air ? (rng() < 0.5 ? -0.7 : 0.7) : spread) + (rng() * 2 - 1) * 0.15;
      evs.push({
        kind: 'grain',
        t,
        rate,
        dur,
        pos,
        pan: Math.max(-0.85, Math.min(0.85, pan)),
        gain,
        air: L.air,
      });
      t += (dur / Math.max(0.5, overlap)) * (0.85 + rng() * 0.3);
    }
  });

  if (md === 'motion' && feel.energy > 0.35) {
    let pt = 2 + rng() * 2;
    const per = 2.0 + (1 - feel.energy) * 1.6;
    while (pt < duration) {
      evs.push({ kind: 'pulse', t: pt, midi: p.root - 24, gain: 0.10 });
      pt += per * (0.92 + rng() * 0.16);
    }
  }

  return evs.sort((a, b) => a.t - b.t);
}

export class TerraSonicEngine {
  private context: Tone.BaseContext | null = null;
  private masterGain: Tone.Gain | null = null;
  private reverb: Tone.Reverb | null = null;
  private delay: Tone.FeedbackDelay | null = null;
  private busLP: Tone.Filter | null = null;
  private convolver: Tone.Convolver | null = null;
  private busLPLFO: Tone.LFO | null = null;
  private droneOscs: Tone.Oscillator[] = [];
  private activeSources: AudioBufferSourceNode[] = [];
  private scheduledIds: number[] = [];
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
  ) {
    if (this.running) await this.stop();

    await Tone.start();
    this.profile = profile;
    this.feel = feel;
    this.voicing = voicing;
    this.mode = mode;
    this.sourceBuffer = sourceBuffer;
    this.durationSecs = durationSecs;
    this.cycle = 0;

    const { space, serene, energy } = feel;

    // --- Master gain ---
    this.masterGain = new Tone.Gain(0.72).toDestination();

    // --- Reverb ---
    const reverbDecay = 4.5 + space * 4 + serene * 3;
    this.reverb = new Tone.Reverb({ decay: reverbDecay, wet: 0 });
    await this.reverb.generate();
    this.reverb.wet.value = 0.26 + space * 0.38 + serene * 0.18;
    this.reverb.connect(this.masterGain);

    // --- Delay ---
    this.delay = new Tone.FeedbackDelay({
      delayTime: space > 0.5 ? 0.6 : 0.4,
      feedback: 0.3 + space * 0.15,
      wet: 0.16 + space * 0.12,
    });
    this.delay.connect(this.masterGain);

    // --- IR Convolver (optional hall) ---
    this.convolver = new Tone.Convolver();
    try {
      await (this.convolver as Tone.Convolver).load(space > 0.5 ? '/ir/hall.wav' : '/ir/plate.wav');
      const convMix = new Tone.Gain(space * 0.25);
      this.convolver.connect(convMix);
      convMix.connect(this.masterGain);
    } catch {
      this.convolver = null;
    }

    // --- Bus lowpass with slow LFO ---
    const lpFreqBase = 3000 + (1 - energy) * 2000;
    this.busLP = new Tone.Filter({ type: 'lowpass', frequency: lpFreqBase, rolloff: -12 });
    this.busLP.connect(this.masterGain);
    if (this.convolver) this.busLP.connect(this.convolver);
    this.busLP.connect(this.reverb);
    this.busLP.connect(this.delay);

    this.busLPLFO = new Tone.LFO({ frequency: 0.04 + energy * 0.03, min: lpFreqBase * 0.7, max: lpFreqBase * 1.2 }).start();
    this.busLPLFO.connect(this.busLP.frequency);

    // --- Drone bed ---
    await this._startDrone();

    // --- Schedule events ---
    this.eventQueue = genEvents(profile, feel, voicing, mode, durationSecs);
    this.eventIdx = 0;
    this.startTime = Tone.now() + 0.1;
    this.running = true;

    this._startScheduler();
  }

  private async _startDrone() {
    const { root } = this.profile;
    const { energy, space } = this.feel;
    const droneGain = 0.06 + space * 0.04;
    const baseFreq = mtof(root - 12);

    for (let i = 0; i < 2; i++) {
      const osc = new Tone.Oscillator({
        type: 'sine',
        frequency: baseFreq * (1 + (i === 0 ? -0.002 : 0.003)),
      });
      const g = new Tone.Gain(0);
      osc.connect(g);
      g.connect(this.busLP!);
      osc.start();
      g.gain.rampTo(droneGain, 7, Tone.now());
      this.droneOscs.push(osc);
    }
  }

  private _startScheduler() {
    const LOOKAHEAD = 0.5;
    const CHECK_INTERVAL_MS = 100;

    this.checkInterval = setInterval(() => {
      if (!this.running) return;
      const now = Tone.now();
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
        const seedOffset = this.cycle * 131;
        this.eventQueue = genEvents(
          this.profile, this.feel, this.voicing, this.mode,
          this.durationSecs, seedOffset,
        );
        this.eventIdx = 0;
        this.startTime = this.startTime + this.durationSecs;
      }
    }, CHECK_INTERVAL_MS);
  }

  private _scheduleEvent(ev: ScheduleEvent, absTime: number) {
    if (!this.busLP) return;
    const ctx = Tone.getContext().rawContext as AudioContext;

    if (ev.kind === 'grain') {
      this._playGrain(ev, absTime, ctx);
    } else if (ev.kind === 'pulse') {
      this._playPulse(ev, absTime, ctx);
    }
  }

  private _playGrain(ev: GrainEvent, absTime: number, ctx: AudioContext) {
    const src = ctx.createBufferSource();
    src.buffer = this.sourceBuffer;
    src.playbackRate.value = ev.rate;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, absTime);
    gainNode.gain.linearRampToValueAtTime(ev.gain, absTime + ev.dur * 0.3);
    gainNode.gain.linearRampToValueAtTime(0, absTime + ev.dur);

    const tapeGain = ctx.createGain();
    tapeGain.gain.value = 1;

    const panner = ctx.createStereoPanner();
    panner.pan.value = ev.pan;

    if (this.mode === 'motion') {
      const wowRate = 0.18 + this.feel.energy * 0.05;
      const wowAmt = 0.003 * this.feel.energy;
      src.detune.setValueAtTime(0, absTime);
      for (let step = 0; step < Math.ceil(ev.dur) + 2; step++) {
        const t = absTime + step;
        src.detune.linearRampToValueAtTime(
          Math.sin(2 * Math.PI * wowRate * step) * wowAmt * 1200,
          t,
        );
      }
    }

    src.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(tapeGain);
    tapeGain.connect((this.busLP as Tone.Filter).input as unknown as AudioNode);

    const offset = Math.max(0, Math.min(ev.pos, this.sourceBuffer.duration - 0.01));
    src.start(absTime, offset, ev.dur + 0.05);
    src.stop(absTime + ev.dur + 0.1);
    this.activeSources.push(src);

    src.onended = () => {
      const idx = this.activeSources.indexOf(src);
      if (idx >= 0) this.activeSources.splice(idx, 1);
      try { gainNode.disconnect(); panner.disconnect(); tapeGain.disconnect(); } catch { /* ignore */ }
    };
  }

  private _playPulse(ev: PulseEvent, absTime: number, ctx: AudioContext) {
    const freq = mtof(ev.midi);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, absTime);
    g.gain.linearRampToValueAtTime(ev.gain, absTime + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, absTime + 1.2);
    osc.connect(g);
    g.connect((this.busLP as Tone.Filter).input as unknown as AudioNode);
    osc.start(absTime);
    osc.stop(absTime + 1.3);
  }

  async stop() {
    this.running = false;
    if (this.checkInterval) { clearInterval(this.checkInterval); this.checkInterval = null; }

    for (const src of this.activeSources) {
      try { src.stop(); } catch { /* ignore */ }
    }
    this.activeSources = [];

    for (const osc of this.droneOscs) {
      try { osc.stop(); osc.dispose(); } catch { /* ignore */ }
    }
    this.droneOscs = [];

    if (this.busLPLFO) { try { this.busLPLFO.stop(); this.busLPLFO.dispose(); } catch { /* ignore */ } this.busLPLFO = null; }
    if (this.busLP) { try { this.busLP.dispose(); } catch { /* ignore */ } this.busLP = null; }
    if (this.reverb) { try { this.reverb.dispose(); } catch { /* ignore */ } this.reverb = null; }
    if (this.delay) { try { this.delay.dispose(); } catch { /* ignore */ } this.delay = null; }
    if (this.convolver) { try { this.convolver.dispose(); } catch { /* ignore */ } this.convolver = null; }
    if (this.masterGain) { try { this.masterGain.dispose(); } catch { /* ignore */ } this.masterGain = null; }
  }

  isRunning() { return this.running; }
}
