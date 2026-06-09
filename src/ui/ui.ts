import type { ImageProfile } from '../analysis/image.js';
import type { Feel } from '../analysis/feel.js';
import type { Voicing } from '../music/voicing.js';

export interface UIState {
  status: string;
  profile: ImageProfile | null;
  feel: Feel | null;
  voicing: Voicing | null;
  playing: boolean;
  exporting: boolean;
  exportProgress: number;
  queueItems: Array<{ url: string; ready: boolean }>;
  activeQueueIdx: number;
}

let analyserNode: AnalyserNode | null = null;
let vizRaf: number | null = null;
const BAR_COUNT = 40;

export function setAnalyser(node: AnalyserNode | null) {
  analyserNode = node;
  if (!node && vizRaf !== null) {
    cancelAnimationFrame(vizRaf);
    vizRaf = null;
    clearViz();
  } else if (node) {
    startViz();
  }
}

function clearViz() {
  const canvas = document.getElementById('viz') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function startViz() {
  const canvas = document.getElementById('viz') as HTMLCanvasElement | null;
  if (!canvas || !analyserNode) return;
  const ctx = canvas.getContext('2d')!;
  const bufLen = analyserNode.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);

  function draw() {
    vizRaf = requestAnimationFrame(draw);
    if (!analyserNode) return;
    analyserNode.getByteFrequencyData(dataArr);
    ctx.clearRect(0, 0, canvas!.width, canvas!.height);

    const barW = canvas!.width / BAR_COUNT;
    for (let i = 0; i < BAR_COUNT; i++) {
      const idx = Math.floor(i * bufLen / BAR_COUNT);
      const val = dataArr[idx] / 255;
      const h = val * canvas!.height;
      const alpha = 0.4 + val * 0.6;
      ctx.fillStyle = `rgba(200, 217, 160, ${alpha})`;
      ctx.fillRect(i * barW + 1, canvas!.height - h, barW - 2, h);
    }
  }
  draw();
}

function meter(id: string, val: number, label?: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const fill = el.querySelector('.meter-fill') as HTMLElement | null;
  const lbl = el.querySelector('.meter-label') as HTMLElement | null;
  if (fill) fill.style.width = `${Math.round(val * 100)}%`;
  if (lbl && label) lbl.textContent = label;
}

export function updateUI(state: UIState) {
  // Status
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = state.status;

  // Mood / desc
  const descEl = document.getElementById('desc');
  if (descEl) {
    if (state.profile?.desc) {
      descEl.textContent = state.profile.desc;
      descEl.style.display = '';
    } else {
      descEl.style.display = 'none';
    }
  }

  const moodEl = document.getElementById('mood-tags');
  if (moodEl) {
    if (state.profile?.mood) {
      moodEl.innerHTML = state.profile.mood.map(m => `<span class="tag">${m}</span>`).join('');
    } else {
      moodEl.innerHTML = '';
    }
  }

  // Meters
  if (state.profile) {
    meter('meter-light', state.profile.light, 'Light');
    meter('meter-warm', state.profile.warm, 'Warmth');
    meter('meter-sat', state.profile.sat, 'Saturation');
    meter('meter-density', state.profile.density, 'Density');
    meter('meter-contrast', state.profile.contrast, 'Contrast');
  }
  if (state.feel) {
    meter('meter-energy', state.feel.energy, 'Energy');
    meter('meter-space', state.feel.space, 'Space');
    meter('meter-valence', state.feel.valence, 'Valence');
    meter('meter-serene', state.feel.serene, 'Serenity');
  }

  // Voicing
  const voicingEl = document.getElementById('voicing-name');
  if (voicingEl && state.voicing) {
    voicingEl.textContent = `${state.voicing.name} (${state.voicing.key}) · root ${state.profile?.root ?? 'န'}`;
  }

  // Root note display
  const rootEl = document.getElementById('root-note');
  if (rootEl && state.profile) {
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const noteName = noteNames[state.profile.root % 12];
    const octave = Math.floor(state.profile.root / 12) - 1;
    rootEl.textContent = `${noteName}${octave}`;
  }

  // Buttons
  const playBtn = document.getElementById('btn-play') as HTMLButtonElement | null;
  const stopBtn = document.getElementById('btn-stop') as HTMLButtonElement | null;
  const exportBtn = document.getElementById('btn-export') as HTMLButtonElement | null;

  if (playBtn) {
    playBtn.disabled = state.playing || state.exporting || !state.profile;
    playBtn.textContent = state.playing ? 'Playing…' : 'Generate & Play';
  }
  if (stopBtn) {
    stopBtn.disabled = !state.playing || state.exporting;
  }
  if (exportBtn) {
    exportBtn.disabled = state.exporting || !state.profile;
    exportBtn.textContent = state.exporting
      ? `Exporting ${state.exportProgress}%…`
      : 'Export WAV';
  }

  // Queue strip
  const strip = document.getElementById('queue-strip');
  if (strip) {
    strip.innerHTML = state.queueItems.map((item, i) => `
      <div class="queue-thumb ${i === state.activeQueueIdx ? 'active' : ''} ${item.ready ? '' : 'loading'}" data-idx="${i}">
        <img src="${item.url}" />
        <button class="q-remove" data-idx="${i}" title="Remove">×</button>
      </div>
    `).join('');
  }
}

// Cross-fade image support
let activeImgSlot: 'a' | 'b' = 'a';

export function crossFadeImage(url: string, isFirst: boolean) {
  const imgA = document.getElementById('preview-img-a') as HTMLImageElement | null;
  const imgB = document.getElementById('preview-img-b') as HTMLImageElement | null;
  const placeholder = document.getElementById('drop-placeholder');

  if (!imgA || !imgB) return;

  if (isFirst) {
    // Show immediately without fade
    imgA.src = url;
    imgA.classList.add('visible');
    imgB.classList.remove('visible');
    activeImgSlot = 'a';
    if (placeholder) placeholder.style.display = 'none';
    return;
  }

  // Cross-fade: load into the inactive slot, then swap
  if (activeImgSlot === 'a') {
    imgB.src = url;
    imgB.classList.add('visible');
    imgA.classList.remove('visible');
    activeImgSlot = 'b';
  } else {
    imgA.src = url;
    imgA.classList.add('visible');
    imgB.classList.remove('visible');
    activeImgSlot = 'a';
  }

  if (placeholder) placeholder.style.display = 'none';
}
