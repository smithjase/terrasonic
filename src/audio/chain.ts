import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pink-noise convolution reverb IR — works identically in live and offline contexts
function buildReverbIR(ctx: BaseAudioContext, decay: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const predelay = Math.floor(sr * 0.012);
  const irLen = Math.floor(sr * decay) + predelay;
  const ir = ctx.createBuffer(2, irLen, sr);
  const rng = mulberry32(seed ^ 0xbeef1234);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0;
    for (let i = predelay; i < irLen; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      const pink = (b0 + b1 + b2 + b3 + b4 + w * 0.1848) / 5;
      const t = (i - predelay) / (irLen - predelay);
      d[i] = pink * Math.exp(-6 * t * (1 / decay + 0.5));
    }
  }
  return ir;
}

export interface AudioChain {
  // Connect all audio sources (grains, pulses, drone) to this node
  input: AudioNode;
  // Call on teardown to stop all internal nodes
  dispose: () => void;
}

// Builds the complete signal chain using raw Web Audio API.
// Works identically with a live AudioContext or an OfflineAudioContext.
export function buildAudioChain(
  ctx: BaseAudioContext,
  profile: ImageProfile,
  feel: Feel,
  scheduleDuration: number,
): AudioChain {
  const { space, serene, energy } = feel;
  const light = profile.light;

  // Master gain → destination
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.72;
  masterGain.connect(ctx.destination);

  // Master HP at 40Hz — clears sub rumble
  const masterHP = ctx.createBiquadFilter();
  masterHP.type = 'highpass';
  masterHP.frequency.value = 40;
  masterHP.connect(masterGain);

  // Reverb — pink-noise convolution, deterministic from seed
  const reverbDecay = 4.5 + space * 4 + serene * 3;
  const reverbWet = 0.40 + space * 0.30 + serene * 0.15;
  const ir = buildReverbIR(ctx, reverbDecay, profile.seed);
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  const convGain = ctx.createGain();
  convGain.gain.value = reverbWet;
  conv.connect(convGain);
  convGain.connect(masterHP);

  // Feedback delay
  const delayNode = ctx.createDelay(2.0);
  delayNode.delayTime.value = space > 0.5 ? 0.6 : 0.4;
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0.3 + space * 0.15;
  const delayWet = ctx.createGain();
  delayWet.gain.value = 0.16 + space * 0.12;
  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);
  delayNode.connect(delayWet);
  delayWet.connect(masterHP);

  // Bus lowpass
  const lpFreqBase = Math.min(7000, 1500 + light * 5000 + serene * 3000);
  const busLP = ctx.createBiquadFilter();
  busLP.type = 'lowpass';
  busLP.frequency.value = lpFreqBase;
  busLP.Q.value = 0.5;

  // High-shelf cut at 5kHz — softens electronic edge
  const hiShelf = ctx.createBiquadFilter();
  hiShelf.type = 'highshelf';
  hiShelf.frequency.value = 5000;
  hiShelf.gain.value = -4;

  busLP.connect(hiShelf);
  hiShelf.connect(masterHP);
  hiShelf.connect(conv);
  hiShelf.connect(delayNode);

  // Pre-scheduled LFO on busLP cutoff — works in both live and offline contexts
  const lfoRate = 0.03 + energy * 0.02;
  const lpMax = lpFreqBase * 1.4;
  const now = ctx.currentTime;
  const nPoints = Math.ceil(scheduleDuration * lfoRate * 24) + 2;
  for (let i = 0; i <= nPoints; i++) {
    const t = now + (i / nPoints) * scheduleDuration;
    const val = lpFreqBase + (lpMax - lpFreqBase) * 0.5 * (1 + Math.sin(2 * Math.PI * lfoRate * (t - now)));
    busLP.frequency.linearRampToValueAtTime(val, t);
  }

  return {
    input: busLP,
    dispose: () => {
      try { masterGain.disconnect(); masterHP.disconnect(); conv.disconnect();
        convGain.disconnect(); delayNode.disconnect(); delayFeedback.disconnect();
        delayWet.disconnect(); busLP.disconnect(); hiShelf.disconnect(); } catch { /* ignore */ }
    },
  };
}
