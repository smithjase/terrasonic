import * as Tone from 'tone';
import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';
import type { Mode } from './engine.js';
import { buildSourceBuffer, SRC_DUR } from './source.js';

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

// WAV encoder — pure TypeScript port from prototype
export function encodeWAV(buffer: AudioBuffer): Blob {
  const nc = buffer.numberOfChannels;
  const len = buffer.length;
  const out = new Float32Array(len * nc);
  for (let ch = 0; ch < nc; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i * nc + ch] = d[i];
  }
  const ab = new ArrayBuffer(44 + out.length * 2);
  const v = new DataView(ab);
  const sr = buffer.sampleRate;
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nc, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, out.length * 2, true);
  let o = 44;
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    o += 2;
  }
  return new Blob([v], { type: 'audio/wav' });
}

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
interface PulseEvent { kind: 'pulse'; t: number; midi: number; gain: number; }
type ScheduleEvent = GrainEvent | PulseEvent;

function genEventsOffline(p: ImageProfile, feel: Feel, vc: Voicing, md: Mode, duration: number): ScheduleEvent[] {
  const rng = mulberry32(p.seed + (md === 'motion' ? 2000 : 7000));
  const evs: ScheduleEvent[] = [];
  // Chord layers louder than drone so they dominate the texture
  const tones: Array<{ iv: number; gainMul: number; air: boolean; idx: number }> = vc.tmpl.map((iv, i) => ({
    iv: iv + vc.reg,
    gainMul: [0.30, 0.26, 0.23, 0.19][i] ?? 0.19,
    air: false,
    idx: i,
  }));
  // Air layer: shimmer without harshness
  tones.push({ iv: vc.airTone, gainMul: 0.13, air: true, idx: tones.length });

  const nL = tones.length;
  const colorIdx = 2;
  const colorPeriod = (md === 'motion' ? 45 : 75) / (0.6 + feel.energy);

  tones.forEach((L, li) => {
    // Match engine.ts: more distinct swell rates per layer
    const swellRate = 0.018 + feel.energy * 0.05 + li * 0.007;
    const swellPh = rng() * 6.283;
    let t = rng() * 4 + li * 0.9;
    while (t < duration) {
      let iv = L.iv;
      if (li === colorIdx) {
        iv += (Math.floor(t / colorPeriod) % 2 === 1) ? (feel.valence > 0.5 ? 2 : -2) : 0;
      }
      const rate = Math.pow(2, iv / 12);
      // Longer grains + higher overlap = smoother, more flowing pad texture
      const baseDur = (md === 'motion' ? (3.5 + rng() * 2.0) : (5.0 + rng() * 3.0)) * (1 + feel.serene * 0.5);
      const dur = Math.min(baseDur, (SRC_DUR - 0.3) / rate);
      const overlap = (md === 'motion' ? 3.0 : 2.5) + feel.energy * 0.5 - feel.serene * 0.3;
      const swell = 0.45 + 0.55 * Math.sin(2 * Math.PI * swellRate * t + swellPh);
      const gain = L.gainMul * (0.35 + 0.75 * swell);
      // Match engine.ts: pos drifts through source buffer for timbre evolution
      const valid = Math.max(0.1, SRC_DUR - dur * rate - 0.2);
      const driftPhase = (t / duration) % 1;
      const pos = (driftPhase * valid * 0.6 + rng() * valid * 0.4) % valid;
      // Match engine.ts: wider stereo spread ±0.9, air layers hard pan ±0.85
      const spread = (li / (Math.max(1, nL - 1))) * 1.8 - 0.9;
      const pan = (L.air ? (rng() < 0.5 ? -0.85 : 0.85) : spread) + (rng() * 2 - 1) * 0.1;
      evs.push({
        kind: 'grain', t, rate, dur, pos,
        pan: Math.max(-0.95, Math.min(0.95, pan)), gain, air: L.air,
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

export async function exportWAV(
  profile: ImageProfile,
  feel: Feel,
  voicing: Voicing,
  mode: Mode,
  durationSecs: number,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  const SR = 44100;

  onProgress?.(5);

  const srcBuf = await buildSourceBuffer(profile);

  onProgress?.(20);

  const light = profile.light;
  const { space, serene, energy } = feel;

  const offlineBuf = await Tone.Offline(({ transport: _transport }) => {
    const ctx = Tone.getContext().rawContext as OfflineAudioContext;

    // Master gain → destination
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.72;
    masterGain.connect(ctx.destination);

    // Master HP at 40Hz — clears inaudible sub rumble
    const masterHP = ctx.createBiquadFilter();
    masterHP.type = 'highpass';
    masterHP.frequency.value = 40;
    masterHP.connect(masterGain);

    // Reverb (synthetic IR)
    const reverbDecay = 4.5 + space * 4 + serene * 3;
    const reverbWet = 0.26 + space * 0.38 + serene * 0.18;
    const irLen = Math.floor(SR * reverbDecay);
    const irBuf = ctx.createBuffer(2, irLen, SR);
    const rngIR = mulberry32(profile.seed ^ 0xabcd1234);
    for (let ch = 0; ch < 2; ch++) {
      const d = irBuf.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        d[i] = (rngIR() * 2 - 1) * Math.exp(-3 * i / irLen);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = irBuf;
    const convGain = ctx.createGain();
    // More reverb for flowing, spacious quality
    const reverbWetAdj = Math.min(0.85, reverbWet + 0.14);
    convGain.gain.value = reverbWetAdj;
    conv.connect(convGain);
    convGain.connect(masterHP);

    // Bus LP — capped at 7kHz, matches engine.ts
    const lpFreqBase = Math.min(7000, 1500 + light * 5000 + serene * 3000);
    const busLP = ctx.createBiquadFilter();
    busLP.type = 'lowpass';
    busLP.frequency.value = lpFreqBase;
    busLP.Q.value = 0.5;

    // High-shelf cut at 5kHz (−4dB) — softens electronic edge
    const hiShelf = ctx.createBiquadFilter();
    hiShelf.type = 'highshelf';
    hiShelf.frequency.value = 5000;
    hiShelf.gain.value = -4;
    busLP.connect(hiShelf);
    hiShelf.connect(masterHP);
    hiShelf.connect(conv);

    // Drone is a subtle bed — chord layers should dominate
    const droneGain = 0.012 + space * 0.008;
    const droneFreq = mtof(profile.root - 12);
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = droneFreq * (i === 0 ? 0.998 : 1.003);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(droneGain, 7);
      const droneHP = ctx.createBiquadFilter();
      droneHP.type = 'highpass';
      droneHP.frequency.value = 90;
      osc.connect(g);
      g.connect(droneHP);
      droneHP.connect(busLP);  // drone → HP → LP → hiShelf → master
      osc.start(0);
      osc.stop(durationSecs);
    }

    const events = genEventsOffline(profile, feel, voicing, mode, durationSecs);
    for (const ev of events) {
      if (ev.t >= durationSecs) continue;
      if (ev.kind === 'grain') {
        const src = ctx.createBufferSource();
        src.buffer = srcBuf;
        src.playbackRate.value = ev.rate;
        const g = ctx.createGain();
        // Softer crossfade matching engine.ts
        g.gain.setValueAtTime(0, ev.t);
        g.gain.linearRampToValueAtTime(ev.gain, ev.t + ev.dur * 0.45);
        g.gain.linearRampToValueAtTime(0, ev.t + ev.dur);
        const panner = ctx.createStereoPanner();
        panner.pan.value = ev.pan;
        src.connect(g);
        g.connect(panner);
        panner.connect(busLP);  // grains → LP → hiShelf → master
        const offset = Math.max(0, Math.min(ev.pos, srcBuf.duration - 0.01));
        src.start(ev.t, offset, ev.dur + 0.05);
      } else if (ev.kind === 'pulse') {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = mtof(ev.midi);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, ev.t);
        g.gain.linearRampToValueAtTime(ev.gain, ev.t + 0.08);
        g.gain.exponentialRampToValueAtTime(0.001, ev.t + 1.2);
        osc.connect(g);
        g.connect(busLP);  // pulse → LP → hiShelf → master
        osc.start(ev.t);
        osc.stop(ev.t + 1.3);
      }
    }
  }, durationSecs, 2, SR);

  onProgress?.(95);

  const blob = encodeWAV(offlineBuf as unknown as AudioBuffer);
  onProgress?.(100);
  return blob;
}
