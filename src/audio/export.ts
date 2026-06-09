import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';
import type { Mode } from './engine.js';
import { buildSourceBuffer } from './source.js';
import { buildAudioChain } from './chain.js';
import { genEvents } from './events.js';

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

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

  // Use a plain OfflineAudioContext — no Tone.js wrappers, no nested offline issues.
  // buildAudioChain uses raw Web Audio API so it works identically here as in the live engine.
  const offCtx = new OfflineAudioContext(2, SR * durationSecs, SR);
  const chain = buildAudioChain(offCtx, profile, feel, durationSecs);

  // Drone bed — identical to engine.ts
  const { space } = feel;
  const droneGain = 0.012 + space * 0.008;
  const droneFreq = mtof(profile.root - 12);
  for (let i = 0; i < 2; i++) {
    const osc = offCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = droneFreq * (i === 0 ? 0.998 : 1.003);
    const g = offCtx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(droneGain, 7);
    const hp = offCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    osc.connect(g);
    g.connect(hp);
    hp.connect(chain.input);
    osc.start(0);
    osc.stop(durationSecs);
  }

  // Schedule grain/pulse events — same genEvents as engine.ts
  const events = genEvents(profile, feel, voicing, mode, durationSecs);
  for (const ev of events) {
    if (ev.t >= durationSecs) continue;

    if (ev.kind === 'grain') {
      const src = offCtx.createBufferSource();
      src.buffer = srcBuf;
      src.playbackRate.value = ev.rate;

      const g = offCtx.createGain();
      g.gain.setValueAtTime(0, ev.t);
      g.gain.linearRampToValueAtTime(ev.gain, ev.t + ev.dur * 0.45);
      g.gain.linearRampToValueAtTime(0, ev.t + ev.dur);

      const panner = offCtx.createStereoPanner();
      panner.pan.value = ev.pan;

      src.connect(g);
      g.connect(panner);
      panner.connect(chain.input);

      const offset = Math.max(0, Math.min(ev.pos, srcBuf.duration - 0.01));
      src.start(ev.t, offset, ev.dur + 0.05);

    } else if (ev.kind === 'pulse') {
      const osc = offCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = mtof(ev.midi);
      const g = offCtx.createGain();
      g.gain.setValueAtTime(0, ev.t);
      g.gain.linearRampToValueAtTime(ev.gain, ev.t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, ev.t + 1.2);
      osc.connect(g);
      g.connect(chain.input);
      osc.start(ev.t);
      osc.stop(ev.t + 1.3);
    }
  }

  onProgress?.(25);
  const rendered = await offCtx.startRendering();
  onProgress?.(95);

  const blob = encodeWAV(rendered);
  onProgress?.(100);
  return blob;
}
