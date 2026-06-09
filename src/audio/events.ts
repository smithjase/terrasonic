import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';
import type { Mode } from './engine.js';
import { SRC_DUR } from './source.js';

export interface GrainEvent {
  kind: 'grain';
  t: number;
  rate: number;
  dur: number;
  pos: number;
  pan: number;
  gain: number;
  air: boolean;
}

export interface PulseEvent {
  kind: 'pulse';
  t: number;
  midi: number;
  gain: number;
}

export type ScheduleEvent = GrainEvent | PulseEvent;

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

export function genEvents(
  p: ImageProfile,
  feel: Feel,
  vc: Voicing,
  md: Mode,
  duration: number,
  seedOffset = 0,
): ScheduleEvent[] {
  const rng = mulberry32(p.seed + seedOffset + (md === 'motion' ? 2000 : 7000));
  const evs: ScheduleEvent[] = [];

  const tones: Array<{ iv: number; gainMul: number; air: boolean; idx: number }> = vc.tmpl.map((iv, i) => ({
    iv: iv + vc.reg,
    gainMul: [0.30, 0.26, 0.23, 0.19][i] ?? 0.19,
    air: false,
    idx: i,
  }));
  tones.push({ iv: vc.airTone, gainMul: 0.13, air: true, idx: tones.length });

  const nL = tones.length;
  const colorIdx = 2;
  const colorPeriod = (md === 'motion' ? 45 : 75) / (0.6 + feel.energy);

  tones.forEach((L, li) => {
    const swellRate = 0.018 + feel.energy * 0.05 + li * 0.007;
    const swellPh = rng() * 6.283;
    let t = rng() * 4 + li * 0.99;

    while (t < duration) {
      let iv = L.iv;
      if (li === colorIdx) {
        iv += (Math.floor(t / colorPeriod) % 2 === 1) ? (feel.valence > 0.5 ? 2 : -2) : 0;
      }
      const rate = Math.pow(2, iv / 12);
      const baseDur = (md === 'motion' ? (3.5 + rng() * 2.0) : (5.0 + rng() * 3.0)) * (1 + feel.serene * 0.5);
      const dur = Math.min(baseDur, (SRC_DUR - 0.3) / rate);
      const overlap = (md === 'motion' ? 3.0 : 2.5) + feel.energy * 0.5 - feel.serene * 0.3;
      const swell = 0.45 + 0.55 * Math.sin(2 * Math.PI * swellRate * t + swellPh);
      const gain = L.gainMul * (0.35 + 0.75 * swell);
      const valid = Math.max(0.1, SRC_DUR - dur * rate - 0.2);
      const driftPhase = (t / duration + seedOffset * 0.001) % 1;
      const pos = (driftPhase * valid * 0.6 + rng() * valid * 0.4) % valid;
      const spread = (li / (Math.max(1, nL - 1))) * 1.8 - 0.9;
      const pan = (L.air ? (rng() < 0.5 ? -0.85 : 0.85) : spread) + (rng() * 2 - 1) * 0.1;
      evs.push({
        kind: 'grain',
        t, rate, dur, pos,
        pan: Math.max(-0.95, Math.min(0.95, pan)),
        gain, air: L.air,
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
