import * as Tone from 'tone';
import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';
import { genEvents, type GrainEvent, type PulseEvent, type ScheduleEvent } from './events.js';

export type Mode = 'stillness' | 'motion';

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export class TerraSonicEngine {
  private context: Tone.BaseContext | null = null;
  private masterGain: Tone.Gain | null = null;
  private masterHP: Tone.Filter | null = null;
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
    const light = profile.light;

    // --- Master gain ---
    this.masterGain = new Tone.Gain(0.72).toDestination();

    // Master high-pass at 40Hz — clears inaudible sub rumble
    this.masterHP = new Tone.Filter({ type: 'highpass', frequency: 40, rolloff: -12 });
    this.masterHP.connect(this.masterGain);

    // --- Reverb ---
    const reverbDecay = 4.5 + space * 4 + serene * 3;
    this.reverb = new Tone.Reverb({ decay: reverbDecay, wet: 0 });
    await this.reverb.generate();
    this.reverb.wet.value = 0.40 + space * 0.30 + serene * 0.15;
    this.reverb.connect(this.masterHP);

    // --- Delay ---
    this.delay = new Tone.FeedbackDelay({
      delayTime: space > 0.5 ? 0.6 : 0.4,
      feedback: 0.3 + space * 0.15,
      wet: 0.16 + space * 0.12,
    });
    this.delay.connect(this.masterHP);

    // --- IR Convolver (optional hall/plate files) ---
    this.convolver = new Tone.Convolver();
    try {
      await (this.convolver as Tone.Convolver).load(space > 0.5 ? '/ir/hall.wav' : '/ir/plate.wav');
      const convMix = new Tone.Gain(space * 0.18);
      this.convolver.connect(convMix);
      convMix.connect(this.masterHP);
    } catch {
      this.convolver = null;
    }

    // --- Bus lowpass + high-shelf ---
    const lpFreqBase = Math.min(7000, 1500 + light * 5000 + serene * 3000);
    this.busLP = new Tone.Filter({ type: 'lowpass', frequency: lpFreqBase, Q: 0.5, rolloff: -12 });
    const hiShelf = new Tone.Filter({ type: 'highshelf', frequency: 5000, gain: -4 });
    this.busLP.connect(hiShelf);
    hiShelf.connect(this.masterHP);
    if (this.convolver) hiShelf.connect(this.convolver);
    hiShelf.connect(this.reverb);
    hiShelf.connect(this.delay);

    this.busLPLFO = new Tone.LFO({
      frequency: 0.03 + energy * 0.02,
      min: lpFreqBase,
      max: lpFreqBase * 1.4,
    }).start();
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
    const { space } = this.feel;
    const droneGain = 0.012 + space * 0.008;
    const baseFreq = mtof(root - 12);

    for (let i = 0; i < 2; i++) {
      const osc = new Tone.Oscillator({
        type: 'sine',
        frequency: baseFreq * (1 + (i === 0 ? -0.002 : 0.003)),
      });
      const g = new Tone.Gain(0);
      const droneHP = new Tone.Filter({ type: 'highpass', frequency: 90, rolloff: -12 });
      osc.connect(g);
      g.connect(droneHP);
      droneHP.connect(this.busLP!);
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
      this._playGrain(ev as GrainEvent, absTime, ctx);
    } else if (ev.kind === 'pulse') {
      this._playPulse(ev as PulseEvent, absTime, ctx);
    }
  }

  private _playGrain(ev: GrainEvent, absTime: number, ctx: AudioContext) {
    const src = ctx.createBufferSource();
    src.buffer = this.sourceBuffer;
    src.playbackRate.value = ev.rate;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, absTime);
    gainNode.gain.linearRampToValueAtTime(ev.gain, absTime + ev.dur * 0.45);
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
          Math.sin(2 * Math.PI * wowRate * step) * wowAmt * 1200, t,
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
    if (this.masterHP) { try { this.masterHP.dispose(); } catch { /* ignore */ } this.masterHP = null; }
    if (this.reverb) { try { this.reverb.dispose(); } catch { /* ignore */ } this.reverb = null; }
    if (this.delay) { try { this.delay.dispose(); } catch { /* ignore */ } this.delay = null; }
    if (this.convolver) { try { this.convolver.dispose(); } catch { /* ignore */ } this.convolver = null; }
    if (this.masterGain) { try { this.masterGain.dispose(); } catch { /* ignore */ } this.masterGain = null; }
  }

  isRunning() { return this.running; }
}
