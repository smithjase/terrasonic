import * as Tone from 'tone';
import { analyseImage } from './analysis/image.js';
import { deriveFeel, enrichWithVision } from './analysis/feel.js';
import { pickVoicing } from './music/voicing.js';
import { buildSourceBuffer } from './audio/source.js';
import { TerraSonicEngine } from './audio/engine.js';
import { exportWAV } from './audio/export.js';
import { updateUI, crossFadeImage, setAnalyser, type UIState } from './ui/ui.js';
import type { ImageProfile } from './analysis/image.js';
import type { Feel } from './analysis/feel.js';
import type { Voicing } from './music/voicing.js';

interface QueueItem {
  file: File;
  url: string;
  profile: ImageProfile | null;
  feel: Feel | null;
  voicing: Voicing | null;
  sourceBuffer: AudioBuffer | null;
}

const CYCLE_MS = 3 * 60 * 1000;
const CROSSFADE_SECS = 10;

const engineA = new TerraSonicEngine();
const engineB = new TerraSonicEngine();
let activeEngine = engineA;
let nextEngine = engineB;

const queue: QueueItem[] = [];
let queueIdx = -1;
let cycleTimer: ReturnType<typeof setTimeout> | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let cycleStartTime = 0;
let transitioning = false;

const state: UIState = {
  status: 'Drop nature photographs to begin.',
  profile: null,
  feel: null,
  voicing: null,
  playing: false,
  exporting: false,
  exportProgress: 0,
  queueItems: [],
  activeQueueIdx: -1,
};

function render() { updateUI(state); }
render();

function deriveMode(feel: Feel) {
  return feel.energy > 0.6 ? 'motion' as const : 'stillness' as const;
}

function syncQueueState() {
  state.queueItems = queue.map(it => ({ url: it.url, ready: it.sourceBuffer !== null }));
  state.activeQueueIdx = queueIdx;
}

// --- API key ---
const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement | null;
const apiKeyStatus = document.getElementById('api-key-status');
if (apiKeyInput) {
  const saved = sessionStorage.getItem('ts_api_key');
  if (saved) { apiKeyInput.value = saved; if (apiKeyStatus) apiKeyStatus.textContent = '✓'; }
  apiKeyInput.addEventListener('input', () => {
    const val = apiKeyInput.value.trim();
    sessionStorage.setItem('ts_api_key', val);
    if (apiKeyStatus) apiKeyStatus.textContent = val ? '✓' : '';
  });
}

// --- Drop zone ---
const dropZone = document.getElementById('drop-zone')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
  files.forEach(addToQueue);
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  Array.from(fileInput.files ?? []).forEach(addToQueue);
  fileInput.value = '';
});

const addMoreBtn = document.getElementById('add-more-btn');
addMoreBtn?.addEventListener('click', e => {
  e.stopPropagation(); // don't also trigger drop-zone click
  fileInput.click();
});

// Queue remove button delegation
document.getElementById('queue-strip')?.addEventListener('click', e => {
  const btn = (e.target as Element).closest('.q-remove') as HTMLElement | null;
  if (btn) {
    e.stopPropagation();
    const idx = parseInt(btn.dataset.idx ?? '-1', 10);
    removeFromQueue(idx);
  }
});

async function addToQueue(file: File) {
  const url = URL.createObjectURL(file);
  const item: QueueItem = { file, url, profile: null, feel: null, voicing: null, sourceBuffer: null };
  queue.push(item);
  syncQueueState();

  // Show first image immediately
  if (queue.length === 1) {
    crossFadeImage(url, true);
    document.getElementById('add-more-btn')?.classList.add('visible');
    state.status = 'Analysing image…';
  } else {
    state.status = `${queue.length} images queued…`;
  }
  render();

  try {
    const { profile, base64, mediaType } = await analyseImage(file);
    const apiKey = sessionStorage.getItem('ts_api_key') ?? '';
    const enriched = apiKey ? await enrichWithVision(profile, base64, mediaType, apiKey) : profile;
    item.profile = enriched;
    item.feel = deriveFeel(enriched);
    item.voicing = pickVoicing(item.feel, enriched);
    item.sourceBuffer = await buildSourceBuffer(profile);

    syncQueueState();
    if (!state.playing && queue.filter(i => i.sourceBuffer).length === 1) {
      // First image ready — update profile display and enable play
      state.profile = item.profile;
      state.feel = item.feel;
      state.voicing = item.voicing;
      state.status = 'Ready. Press Generate & Play.';
    } else if (state.playing) {
      state.status = `Playing ${queueIdx + 1} of ${queue.length}`;
    } else {
      state.status = `${queue.filter(i => i.sourceBuffer).length} of ${queue.length} images ready.`;
    }
    render();
  } catch (err) {
    state.status = `Error analysing image: ${(err as Error).message}`;
    render();
  }
}

function removeFromQueue(idx: number) {
  if (idx < 0 || idx >= queue.length) return;
  const item = queue[idx];
  URL.revokeObjectURL(item.url);
  queue.splice(idx, 1);

  if (queue.length === 0) {
    // Stop everything
    stopAll();
    return;
  }

  // Adjust queueIdx
  if (idx < queueIdx) {
    queueIdx--;
  } else if (idx === queueIdx && state.playing) {
    // Currently playing item removed — transition immediately
    queueIdx = Math.min(queueIdx, queue.length - 1);
    if (queue.length > 0) {
      clearCycleTimers();
      transitionTo(queueIdx);
    }
  }

  syncQueueState();
  render();
}

function clearCycleTimers() {
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

function scheduleNextCycle() {
  clearCycleTimers();
  if (queue.length <= 1) return; // no cycling needed

  cycleStartTime = Date.now();
  countdownInterval = setInterval(() => {
    if (!state.playing) return;
    const remaining = Math.max(0, CYCLE_MS - (Date.now() - cycleStartTime));
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const current = queue[queueIdx];
    const desc = current?.profile?.desc ? `"${current.profile.desc}"` : `Image ${queueIdx + 1} of ${queue.length}`;
    state.status = `Playing ${desc} · Next in ${mins}:${String(secs).padStart(2, '0')}`;
    render();
  }, 1000);

  cycleTimer = setTimeout(() => {
    const nextIdx = (queueIdx + 1) % queue.length;
    transitionTo(nextIdx);
  }, CYCLE_MS);
}

async function transitionTo(nextIdx: number) {
  if (transitioning) return;
  const item = queue[nextIdx];
  if (!item?.sourceBuffer || !item.profile || !item.feel || !item.voicing) {
    // Not ready — wait 5s and retry
    cycleTimer = setTimeout(() => transitionTo(nextIdx), 5000);
    return;
  }

  transitioning = true;
  clearCycleTimers();

  const mode = deriveMode(item.feel);
  await nextEngine.init(item.profile, item.feel, item.voicing, mode, item.sourceBuffer, 180);
  nextEngine.fadeIn(CROSSFADE_SECS);
  activeEngine.fadeOut(CROSSFADE_SECS);

  // Visual cross-fade
  crossFadeImage(item.url, false);

  queueIdx = nextIdx;
  state.profile = item.profile;
  state.feel = item.feel;
  state.voicing = item.voicing;
  syncQueueState();
  render();

  setTimeout(async () => {
    const old = activeEngine;
    activeEngine = nextEngine;
    nextEngine = old;
    await old.stop();
    transitioning = false;
    scheduleNextCycle();
  }, CROSSFADE_SECS * 1000);
}

async function stopAll() {
  clearCycleTimers();
  transitioning = false;
  await Promise.all([engineA.stop(), engineB.stop()]);
  state.playing = false;
  state.profile = null;
  state.feel = null;
  state.voicing = null;
  state.status = queue.length > 0 ? 'Stopped. Press Generate & Play to restart.' : 'Drop nature photographs to begin.';
  setAnalyser(null);
  syncQueueState();
  render();
}

// --- Play ---
document.getElementById('btn-play')?.addEventListener('click', async () => {
  // Find first ready item
  const firstReady = queue.findIndex(i => i.sourceBuffer !== null);
  if (firstReady === -1) return;

  const item = queue[firstReady];
  state.status = 'Starting engine…';
  state.playing = true;
  render();

  try {
    await Tone.start();
    const mode = deriveMode(item.feel!);
    await activeEngine.init(item.profile!, item.feel!, item.voicing!, mode, item.sourceBuffer!, 180);
    activeEngine.fadeIn(3);

    queueIdx = firstReady;
    state.profile = item.profile;
    state.feel = item.feel;
    state.voicing = item.voicing;
    syncQueueState();

    crossFadeImage(item.url, true);

    // Connect analyser for viz
    const ctx = Tone.getContext().rawContext as AudioContext;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    setAnalyser(analyser);

    const desc = item.profile!.desc ? `"${item.profile!.desc}"` : `Image ${firstReady + 1} of ${queue.length}`;
    state.status = queue.length > 1 ? `Playing ${desc}` : `Playing: ${desc}`;
    render();

    scheduleNextCycle();
  } catch (err) {
    state.status = `Engine error: ${(err as Error).message}`;
    state.playing = false;
    render();
  }
});

// --- Stop ---
document.getElementById('btn-stop')?.addEventListener('click', stopAll);

// --- Export ---
document.getElementById('btn-export')?.addEventListener('click', async () => {
  const activeIdx = queueIdx >= 0 ? queueIdx : queue.findIndex(i => i.sourceBuffer !== null);
  if (activeIdx === -1) return;
  const item = queue[activeIdx];
  if (!item.profile || !item.feel || !item.voicing) return;

  const durSelect = document.getElementById('export-dur') as HTMLSelectElement;
  const durationSecs = parseInt(durSelect?.value ?? '60', 10);

  state.exporting = true;
  state.exportProgress = 0;
  state.status = 'Rendering offline…';
  render();

  try {
    const mode = deriveMode(item.feel);
    const blob = await exportWAV(
      item.profile, item.feel, item.voicing, mode, durationSecs,
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
