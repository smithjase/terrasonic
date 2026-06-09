import * as Tone from 'tone';
import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';
import type { Mode } from './engine.js';
import { buildSourceBuffer } from './source.js';
import { genEvents } from './events.js';

// WAV encoder
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

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
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

  const { space, serene, energy } = feel;
  const light = profile.light;

  // Build the identical signal chain as engine.ts, rendered offline via Tone.Offline.
  // Using Tone.js abstractions (Tone.Reverb, Tone.FeedbackDelay, Tone.Filter) guarantees
  // the export sounds the same as live playback.
  const offlineBuf = await Tone.Offline(async () => {
    // --- Master gain ---
    const masterGain = new Tone.Gain(0.72).toDestination();

    // Master HP at 40Hz
    const masterHP = new Tone.Filter({ type: 'highpass', frequency: 40, rolloff: -12 });
    masterHP.connect(masterGain);

    // --- Reverb (same params as engine) ---
    const reverbDecay = 4.5 + space * 4 + serene * 3;
    const reverb = new Tone.Reverb({ decay: reverbDecay, wet: 0 });
    await reverb.generate();
    reverb.wet.value = 0.40 + space * 0.30 + serene * 0.15;
    reverb.connect(masterHP);

    // --- Delay ---
    const delay = new Tone.FeedbackDelay({
      delayTime: space > 0.5 ? 0.6 : 0.4,
      feedback: 0.3 + space * 0.15,
      wet: 0.16 + space * 0.12,
    });
    delay.connect(masterHP);

    // --- Bus LP + high-shelf (same params as engine) ---
    const lpFreqBase = Math.min(7000, 1500 + light * 5000 + serene * 3000);
    const busLP = new Tone.Filter({ type: 'lowpass', frequency: lpFreqBase, Q: 0.5, rolloff: -12 });
    const hiShelf = new Tone.Filter({ type: 'highshelf', frequency: 5000, gain: -4 });
    busLP.connect(hiShelf);
    hiShelf.connect(masterHP);
    hiShelf.connect(reverb);
    hiShelf.connect(delay);

    // LFO sweeps LP cutoff upward
    const lfo = new Tone.LFO({
      frequency: 0.03 + energy * 0.02,
      min: lpFreqBase,
      max: lpFreqBase * 1.4,
    }).start();
    lfo.connect(busLP.frequency);

    // --- Drone bed ---
    const droneGain = 0.012 + space * 0.008;
    const droneFreq = mtof(profile.root - 12);
    for (let i = 0; i < 2; i++) {
      const osc = new Tone.Oscillator({
        type: 'sine',
        frequency: droneFreq * (i === 0 ? 0.998 : 1.003),
      });
      const g = new Tone.Gain(0);
      const droneHP = new Tone.Filter({ type: 'highpass', frequency: 90, rolloff: -12 });
      osc.connect(g);
      g.connect(droneHP);
      droneHP.connect(busLP);
      osc.start(0);
      osc.stop(durationSecs);
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(droneGain, 7);
    }

    // --- Schedule grain/pulse events (same genEvents as engine) ---
    const events = genEvents(profile, feel, voicing, mode, durationSecs);
    const ctx = Tone.getContext().rawContext as OfflineAudioContext;

    for (const ev of events) {
      if (ev.t >= durationSecs) continue;

      if (ev.kind === 'grain') {
        const src = ctx.createBufferSource();
        src.buffer = srcBuf;
        src.playbackRate.value = ev.rate;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0, ev.t);
        g.gain.linearRampToValueAtTime(ev.gain, ev.t + ev.dur * 0.45);
        g.gain.linearRampToValueAtTime(0, ev.t + ev.dur);

        const panner = ctx.createStereoPanner();
        panner.pan.value = ev.pan;

        src.connect(g);
        g.connect(panner);
        panner.connect((busLP as Tone.Filter).input as unknown as AudioNode);

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
        g.connect((busLP as Tone.Filter).input as unknown as AudioNode);
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
