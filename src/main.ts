import * as Tone from 'tone';
import { analyseImage } from './analysis/image.js';
import { deriveFeel } from './analysis/feel.js';
import { pickVoicing } from './music/voicing.js';
import { buildSourceBuffer } from './audio/source.js';
import { TerraSonicEngine, type Mode } from './audio/engine.js';
import { exportWAV } from './audio/export.js';
import { updateUI, showImagePreview, setAnalyser, type UIState } from './ui/ui.js';
import type { ImageProfile } from './analysis/image.js';
import type { Feel } from './analysis/feel.js';
import type { Voicing } from './music/voicing.js';

const engine = new TerraSonicEngine();

const state: UIState = {
  status: 'Drop a nature photograph to begin.',
  profile: null,
  feel: null,
  voicing: null,
  mode: 'stillness',
  playing: false,
  exporting: false,
  exportProgress: 0,
};

let currentProfile: ImageProfile | null = null;
let currentFeel: Feel | null = null;
let currentVoicing: Voicing | null = null;
let currentSourceBuffer: AudioBuffer | null = null;

function render() {
  updateUI(state);
}

render();

// --- Drop zone ---
const dropZone = document.getElementById('drop-zone')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file && file.type.startsWith('image/')) handleFile(file);
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

async function handleFile(file: File) {
  state.status = 'Analysing image…';
  state.profile = null;
  state.feel = null;
  state.voicing = null;
  render();

  if (state.playing) {
    await engine.stop();
    state.playing = false;
    setAnalyser(null);
  }

  showImagePreview(file);

  try {
    const { profile } = await analyseImage(file);
    currentProfile = profile;

    const feel = deriveFeel(profile);
    currentFeel = feel;
    currentVoicing = pickVoicing(feel, profile);

    state.profile = profile;
    state.feel = feel;
    state.voicing = currentVoicing;
    state.status = 'Image analysed. Ready to play.';
    render();

    // Pre-build source buffer in background
    state.status = 'Building source tones…';
    render();
    currentSourceBuffer = await buildSourceBuffer(profile);
    state.status = 'Ready. Press Generate & Play.';
    render();
  } catch (err) {
    state.status = `Error: ${(err as Error).message}`;
    render();
  }
}

// --- Play ---
document.getElementById('btn-play')?.addEventListener('click', async () => {
  if (!currentProfile || !currentFeel || !currentVoicing || !currentSourceBuffer) return;
  state.status = 'Starting engine…';
  state.playing = true;
  render();

  try {
    await Tone.start();
    const durationSecs = 180; // 3-minute cycle
    await engine.init(currentProfile, currentFeel, currentVoicing, state.mode, currentSourceBuffer, durationSecs);

    // Connect analyser for viz
    const ctx = Tone.getContext().rawContext as AudioContext;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    // Tap into destination
    ctx.destination.addEventListener('connect' as never, () => {});
    setAnalyser(analyser);

    state.status = currentProfile.desc
      ? `Playing: "${currentProfile.desc}"`
      : 'Playing…';
    render();
  } catch (err) {
    state.status = `Engine error: ${(err as Error).message}`;
    state.playing = false;
    render();
  }
});

// --- Stop ---
document.getElementById('btn-stop')?.addEventListener('click', async () => {
  await engine.stop();
  state.playing = false;
  setAnalyser(null);
  state.status = 'Stopped.';
  render();
});

// --- Export ---
document.getElementById('btn-export')?.addEventListener('click', async () => {
  if (!currentProfile || !currentFeel || !currentVoicing) return;
  const durSelect = document.getElementById('export-dur') as HTMLSelectElement;
  const durationSecs = parseInt(durSelect?.value ?? '60', 10);

  state.exporting = true;
  state.exportProgress = 0;
  state.status = 'Rendering offline…';
  render();

  try {
    const blob = await exportWAV(
      currentProfile, currentFeel, currentVoicing, state.mode, durationSecs,
      pct => {
        state.exportProgress = pct;
        state.status = `Rendering… ${pct}%`;
        render();
      },
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `terrasonic-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
   
    state.status = 'Export complete.';
  } catch (err) {
    state.status = `Export failed: ${(err as Error).message}`;
  } finally {
    state.exporting = false;
    state.exportProgress = 0;
    render();
  }
});
