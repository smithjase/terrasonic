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
  const { light, warm, sat, density, contrast, root, seed } = profile;
  const bright = light;

  const N = 4 + Math.round(sat * 8);
  const slope = 1.8 - sat * 0.95;
  const rng = mulberry32(seed ^ 0xdeadbeef);

  const offCtx = new OfflineAudioContext(2, frames, sr);
  const bufL = offCtx.createBuffer(1, frames, sr);
  const bufR = offCtx.createBuffer(1, frames, sr);
  const dL = bufL.getChannelData(0);
  const dR = bufR.getChannelData(0);

  const baseFreq = mtof(root);

  for (let p = 1; p <= N; p++) {
    // Inharmonicity stretch from density (bell-like)
    const inharm = 1 + density * 0.0035 * p * p;
    const freq = baseFreq * p * inharm;
    if (freq > sr / 2) continue;

    // Even/odd balance from warmth
    const isEven = p % 2 === 0;
    const partialGain = (isEven ? warm : (1 - warm * 0.5)) / Math.pow(p, slope);

    // High partial lift from brightness
    const highLift = p > N / 2 ? 1 + bright * 0.4 * ((p - N / 2) / (N / 2)) : 1;
    const gain = partialGain * highLift * 0.35;

    // Slow LFO per partial
    const lfoRate = 0.03 + rng() * 0.16; // 0.03..0.19 Hz
    const lfoAmt = 0.004 + rng() * 0.006;
    const lfoPhase = rng() * Math.PI * 2;
    const phaseOff = 0.7; // stereo phase offset in radians

    const phaseL = rng() * Math.PI * 2;
    const phaseR = phaseL + phaseOff;
    const angFreq = 2 * Math.PI * freq;

    for (let i = 0; i < frames; i++) {
      const t = i / sr;
      const lfo = 1 + lfoAmt * Math.sin(2 * Math.PI * lfoRate * t + lfoPhase);
      dL[i] += gain * lfo * Math.sin(angFreq * t + phaseL);
      dR[i] += gain * lfo * Math.sin(angFreq * t + phaseR);
    }
  }

  // Noise floor
  const noiseFloor = 0.03 + bright * sat * 0.08;
  for (let i = 0; i < frames; i++) {
    const n = (rng() * 2 - 1) * noiseFloor;
    dL[i] += n * 0.7;
    dR[i] += (rng() * 2 - 1) * noiseFloor * 0.7;
  }

  // Apply HANN envelope to the whole buffer (fade in/out)
  const envLen = Math.min(frames, sr * 2); // 2s fade
  for (let i = 0; i < envLen; i++) {
    const idx = Math.floor(i / envLen * 256);
    const w = HANN[idx];
    dL[i] *= w;
    dR[i] *= w;
    dL[frames - 1 - i] *= w;
    dR[frames - 1 - i] *= w;
  }

  // Normalize to 0.9 peak
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    peak = Math.max(peak, Math.abs(dL[i]), Math.abs(dR[i]));
  }
  if (peak > 0) {
    const scale = 0.9 / peak;
    for (let i = 0; i < frames; i++) {
      dL[i] *= scale;
      dR[i] *= scale;
    }
  }

  // Render through offline context
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
