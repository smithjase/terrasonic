import type { ImageProfile } from './image.js';

export interface Feel {
  valence: number;
  energy: number;
  space: number;
  serene: number;
}

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, v));
}

export function deriveFeel(p: ImageProfile): Feel {
  const { light, warm, sat, density, contrast, tilt } = p;

  const vVal = p.vVal;
  const vEng = p.vEng;
  const vSpc = p.vSpc;

  const valence = vVal !== null
    ? vVal
    : clamp(0.28 + light * 0.5 + (warm - 0.5) * 0.35 + (1 - density) * 0.12);

  const energy = vEng !== null
    ? vEng
    : clamp(density * 0.5 + contrast * 0.7 + sat * 0.15);

  const space = vSpc !== null
    ? vSpc
    : clamp(0.30 + (1 - density) * 0.28 + light * 0.22 + Math.max(0, tilt) * 0.3);

  const serene = clamp(
    (1 - density) * 0.4 + light * 0.32 + (1 - Math.min(1, contrast * 2.2)) * 0.28 - energy * 0.15
  );

  return { valence, energy, space, serene };
}

export async function enrichWithVision(profile: ImageProfile, base64: string, mediaType: string): Promise<ImageProfile> {
  try {
    const resp = await fetch('/api/read-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mediaType }),
    });
    if (!resp.ok) throw new Error('API error');
    let text = await resp.text();
    // Strip markdown fences if present
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    // Slice to outer braces
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON');
    const json = JSON.parse(text.slice(start, end + 1));
    return {
      ...profile,
      desc: typeof json.desc === 'string' ? json.desc : null,
      mood: Array.isArray(json.mood) ? json.mood : null,
      vVal: typeof json.valence === 'number' ? Math.max(0, Math.min(1, json.valence)) : null,
      vEng: typeof json.energy === 'number' ? Math.max(0, Math.min(1, json.energy)) : null,
      vSpc: typeof json.space === 'number' ? Math.max(0, Math.min(1, json.space)) : null,
    };
  } catch {
    // Silently fall back to pixel values
    return profile;
  }
}
