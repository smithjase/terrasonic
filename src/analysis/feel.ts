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

export async function enrichWithVision(profile: ImageProfile, base64: string, mediaType: string, apiKey: string): Promise<ImageProfile> {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: `Analyse this photograph for ambient music generation. Base your values on the scene's emotional meaning and impact — not pixel colours.

Return ONLY a JSON object, no other text:
{
  "desc": "one evocative sentence about the scene's atmosphere",
  "mood": ["tag1", "tag2", "tag3"],
  "valence": 0.0,
  "energy": 0.0,
  "space": 0.0
}

Fields:
- mood: 3–5 words capturing the feeling (e.g. "violent", "serene", "melancholic")
- valence: emotional tone 0–1 (0 = dark/threatening/tense, 1 = joyful/peaceful/uplifting)
- energy: intensity 0–1 (0 = still/hushed/serene, 1 = violent/chaotic/overwhelming)
- space: openness 0–1 (0 = enclosed/dense/intimate, 1 = vast/boundless/expansive)

Examples: volcanic eruption → energy 0.95, valence 0.15, space 0.35
          misty mountain lake at dawn → energy 0.1, valence 0.8, space 0.85
          dense rainforest → energy 0.35, valence 0.65, space 0.2`,
            },
          ],
        }],
      }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();
    let text: string = data.content?.[0]?.text ?? '';
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in response');
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
    return profile; // silently fall back to pixel analysis
  }
}
