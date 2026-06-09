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

// Bell/piano note: additive-synth tone with exponential decay.
// Creates the melodic foreground — the thing that makes it feel like music.
export interface BellEvent {
  kind: 'bell';
  t: number;
  midi: number;   // MIDI note number
  gain: number;
  dur: number;    // decay length in seconds
  pan: number;
}

export type ScheduleEvent = GrainEvent | PulseEvent | BellEvent;

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Dynamic arc: quiet intro → full build → gentle fade.
// Gives the music a sense of journey rather than static texture.
function buildArc(t: number, duration: number): number {
  const p = t / duration;
  if (p < 0.18) return 0.55 + (p / 0.18) * 0.45;  // rises 0.55 → 1.0
  if (p < 0.65) return 1.0;                          // full
  return 1.0 - ((p - 0.65) / 0.35) * 0.4;           // fades 1.0 → 0.6
}

// Melodic note sequence from chord tones — the foreground melody.
// Plays bell/piano notes in phrases with space between them.
function genMelody(
  p: ImageProfile,
  feel: Feel,
  vc: Voicing,
  md: Mode,
  duration: number,
  rng: () => number,
): BellEvent[] {
  const evs: BellEvent[] = [];

  // Notes available: chord tones one octave above the pad layer
  const baseNote = p.root + vc.reg + 12;
  const notePool: number[] = [
    ...vc.tmpl.map(iv => baseNote + iv),
    ...vc.tmpl.map(iv => baseNote + iv + 12),  // higher octave for sparkle
  ];

  // How often to play notes — scales with energy, more in middle section
  const noteDensity = 0.4 + feel.energy * 0.5 + (md === 'motion' ? 0.3 : 0);
  const phraseMinGap = 5 - feel.energy * 2;
  const phraseMaxGap = 12 - feel.energy * 4;
  const noteSpacing = 1.2 + (1 - feel.energy) * 2.0;

  let t = 6 + rng() * 6; // Start a few seconds in — let the pad establish first

  while (t < duration - 8) {
    const arc = buildArc(t, duration);
    if (arc < 0.3) { t += 2; continue; } // skip melody in very quiet sections

    // Phrase length: 3–7 notes
    const phraseLen = 3 + Math.floor(rng() * 4);

    // Pick a starting note and direction (ascending, descending, or mixed)
    let noteIdx = Math.floor(rng() * notePool.length);
    const ascending = rng() > 0.45;

    for (let n = 0; n < phraseLen && t < duration - 4; n++) {
      const midi = notePool[noteIdx];
      const dur = 1.8 + rng() * 2.5 + (1 - feel.energy) * 2;  // softer images = longer decay
      const gain = (0.18 + rng() * 0.12) * arc * noteDensity;
      const pan = (rng() * 2 - 1) * 0.6;  // spread notes across stereo field

      evs.push({ kind: 'bell', t, midi, gain, dur, pan });

      // Step through the scale — ascending with occasional leaps for interest
      const step = ascending ? 1 : -1;
      const leap = rng() < 0.25 ? step * 2 : step;
      noteIdx = Math.max(0, Math.min(notePool.length - 1, noteIdx + leap));

      t += noteSpacing * (0.7 + rng() * 0.6);
    }

    // Gap between phrases — shorter in build section, longer in sparse sections
    const gap = phraseMinGap + rng() * (phraseMaxGap - phraseMinGap);
    t += gap * (1.5 - arc * 0.6);
  }

  return evs;
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

  // Pad layer: sustained grains forming the harmonic background
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

      // Scale grain gain by build arc — quiet at start/end, full in middle
      const arc = buildArc(t, duration);
      const gain = L.gainMul * (0.35 + 0.75 * swell) * arc;

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

  // Sub-bass pulse in motion mode
  if (md === 'motion' && feel.energy > 0.35) {
    let pt = 6 + rng() * 4; // start later — let pad and melody establish first
    const per = 2.0 + (1 - feel.energy) * 1.6;
    while (pt < duration) {
      const arc = buildArc(pt, duration);
      evs.push({ kind: 'pulse', t: pt, midi: p.root - 24, gain: 0.08 * arc });
      pt += per * (0.92 + rng() * 0.16);
    }
  }

  // Melodic bell layer — the foreground voice that makes it feel like music
  const melodyEvs = genMelody(p, feel, vc, md, duration, rng);
  evs.push(...melodyEvs);

  return evs.sort((a, b) => a.t - b.t);
}
