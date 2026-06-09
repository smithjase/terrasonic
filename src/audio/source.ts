import type { ImageProfile } from '../analysis/image.js';

export const SRC_DUR = 12;

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// Build HANN window (257-point)
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
  // Gentler rolloff — still brighter than original but not glassy
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

    // Softer high-partial lift — 0.5 instead of 1.2 to avoid glassy harshness
    const highLift = p > N / 2 ? 1 + bright * 0.5 * ((p - N / 2) / (N / 2)) : 1;
    const gain = partialGain * highLift * 0.35;

    // Slow LFO per partial — smaller amount for smoother, more organic movement
    const lfoRate = 0.02 + rng() * 0.10;
    const lfoAmt = 0.002 + rng() * 0.004;
    const lfoPhase = rng() * Math.PI * 2;

    // Micro-detuning: each partial gets a tiny random pitch offset (±8 cents)
    // This breaks up the pure-sine stack and gives an organic, slightly imperfect quality
    const detuneCents = (rng() * 2 - 1) * 8;
    const detuneRatio = Math.pow(2, detuneCents / 1200);
    const phaseOff = 0.7;

    const phaseL = rng() * Math.PI * 2;
    const phaseR = phaseL + phaseOff;
    const angFreq = 2 * Math.PI * freq * detuneRatio;

    for (let i = 0; i < frames; i++) {
      const t = i / sr;
      const lfo = 1 + lfoAmt * Math.sin(2 * Math.PI * lfoRate * t + lfoPhase);
      dL[i] += gain * lfo * Math.sin(angFreq * t + phaseL);
      dR[i] += gain * lfo * Math.sin(angFreq * t + phaseR);
    }
  }

  // Pink-tinted noise: accumulate a running average to low-pass the white noise,
  // giving it a softer, breathy quality rather than harsh white hiss
  const noiseFloor = 0.015 + bright * sat * 0.04;
  let runL = 0, runR = 0;
  const smoothing = 0.92;
  for (let i = 0; i < frames; i++) {
    runL = runL * smoothing + (rng() * 2 - 1) * (1 - smoothing);
    runR = runR * smoothing + (rng() * 2 - 1) * (1 - smoothing);
    dL[i] += runL * noiseFloor;
    dR[i] += runR * noiseFloor;
  }

  // Apply HANN envelope (fade in/out over 2s)
  const envLen = Math.min(frames, sr * 2);
  for (let i = 0; i < envLen; i++) {
    const idx = Math.floor(i / envLen * 256);
    const w = HANN[idx];
    dL[i] *= w; dR[i] *= w;
    dL[frames - 1 - i] *= w; dR[frames - 1 - i] *= w;
  }

  // Normalize to 0.9 peak
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    peak = Math.max(peak, Math.abs(dL[i]), Math.abs(dR[i]));
  }
  if (peak > 0) {
    const scale = 0.9 / peak;
    for (let i = 0; i < frames; i++) { dL[i] *= scale; dR[i] *= scale; }
  }

  const srcL = offCtx.createBufferSource();
  srcL.buffer = bufL;
  const srcR = offCtx.createBufferSource();
  srcR.buffer = bufR;
  const merger = offCtx.createChannelMerger(2);
  srcL.connect(merger, 0, 0);
  srcR.connect(merger, 0, 1);
  merger.connect(offCtx.destination);
  srcL.start(0);
  srcR.start(0);

  return offCtx.startRendering();
}
