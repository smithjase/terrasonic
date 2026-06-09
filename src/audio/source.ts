import type { ImageProfile } from '../analysis/image.js';

export const SRC_DUR = 12;

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

const HANN = new Float32Array(257);
for (let i = 0; i < 257; i++) HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / 256));

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function buildSourceBuffer(profile: ImageProfile): Promise<AudioBuffer> {
  const sr = 44100;
  const frames = sr * SRC_DUR;
  const { light, warm, sat, density, root, seed } = profile;
  const bright = light;

  const N = 8 + Math.round(sat * 8);
  const slope = 1.3 - sat * 0.35;
  const rng = mulberry32(seed ^ 0xdeadbeef);

  const offCtx = new OfflineAudioContext(2, frames, sr);
  const bufL = offCtx.createBuffer(1, frames, sr);
  const bufR = offCtx.createBuffer(1, frames, sr);
  const dL = bufL.getChannelData(0);
  const dR = bufR.getChannelData(0);

  const baseFreq = mtof(root);

  for (let p = 1; p <= N; p++) {
    const inharm = 1 + density * 0.0035 * p * p;
    const freq = baseFreq * p * inharm;
    if (freq > sr / 2) continue;

    const isEven = p % 2 === 0;
    const partialGain = (isEven ? warm : (1 - warm * 0.5)) / Math.pow(p, slope);
    const highLift = p > N / 2 ? 1 + bright * 0.5 * ((p - N / 2) / (N / 2)) : 1;
    const baseGain = partialGain * highLift * 0.35;

    // Slow amplitude arc — different partials peak at different times so
    // reading different positions genuinely changes the timbre
    const arcPhase = rng() * Math.PI * 2;
    const arcRate = 0.5 + rng() * 1.5;
    const arcDepth = 0.35 + rng() * 0.45;

    const lfoRate = 0.02 + rng() * 0.10;
    const lfoAmt = 0.002 + rng() * 0.004;
    const lfoPhase = rng() * Math.PI * 2;

    // Unison stack: 3 oscillators per partial at -7, 0, +7 cents
    // Creates a lush chorus/pad quality instead of clinical pure sines
    const unisonCents = [-7, 0, 7];
    const unisonGains = [0.28, 0.44, 0.28];

    for (let u = 0; u < 3; u++) {
      const detune = Math.pow(2, unisonCents[u] / 1200);
      const angFreq = 2 * Math.PI * freq * detune;
      const uGain = baseGain * unisonGains[u];
      const phaseL = rng() * Math.PI * 2;
      const phaseR = phaseL + (0.5 + rng() * 0.4); // wider stereo per unison voice

      for (let i = 0; i < frames; i++) {
        const t = i / sr;
        const lfo = 1 + lfoAmt * Math.sin(2 * Math.PI * lfoRate * t + lfoPhase);
        const arc = 1 - arcDepth * (0.5 - 0.5 * Math.cos(2 * Math.PI * arcRate * t / SRC_DUR + arcPhase));
        dL[i] += uGain * lfo * arc * Math.sin(angFreq * t + phaseL);
        dR[i] += uGain * lfo * arc * Math.sin(angFreq * t + phaseR);
      }
    }
  }

  // Pink-tinted noise — breathy, not harsh
  const noiseFloor = 0.012 + bright * sat * 0.03;
  let runL = 0, runR = 0;
  const smoothing = 0.94;
  for (let i = 0; i < frames; i++) {
    runL = runL * smoothing + (rng() * 2 - 1) * (1 - smoothing);
    runR = runR * smoothing + (rng() * 2 - 1) * (1 - smoothing);
    dL[i] += runL * noiseFloor;
    dR[i] += runR * noiseFloor;
  }

  // HANN envelope — 2s fade in/out
  const envLen = Math.min(frames, sr * 2);
  for (let i = 0; i < envLen; i++) {
    const idx = Math.floor(i / envLen * 256);
    const w = HANN[idx];
    dL[i] *= w; dR[i] *= w;
    dL[frames - 1 - i] *= w; dR[frames - 1 - i] *= w;
  }

  // Normalize to 0.9 peak
  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(dL[i]), Math.abs(dR[i]));
  if (peak > 0) {
    const scale = 0.9 / peak;
    for (let i = 0; i < frames; i++) { dL[i] *= scale; dR[i] *= scale; }
  }

  const srcL = offCtx.createBufferSource(); srcL.buffer = bufL;
  const srcR = offCtx.createBufferSource(); srcR.buffer = bufR;
  const merger = offCtx.createChannelMerger(2);
  srcL.connect(merger, 0, 0); srcR.connect(merger, 0, 1);
  merger.connect(offCtx.destination);
  srcL.start(0); srcR.start(0);
  return offCtx.startRendering();
}
