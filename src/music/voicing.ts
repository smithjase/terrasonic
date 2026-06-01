import type { Feel } from '../analysis/feel.js';

export interface Voicing {
  tmpl: number[];
  name: string;
  key: string;
  reg: number;
  spread: boolean;
  serene: number;
  airTone: number;
}

const VOICINGS: Record<string, { tmpl: number[]; name: string }> = {
  bright:  { tmpl: [0, 7, 11, 16], name: 'Major 9th open' },
  warm:    { tmpl: [0, 7, 4, 14],  name: 'Major add9' },
  open:    { tmpl: [0, 7, 12, 17], name: 'Quartal/sus' },
  wistful: { tmpl: [0, 7, 3, 14],  name: 'Minor add9' },
  dark:    { tmpl: [0, 7, 3, 10],  name: 'Minor 7 low' },
};

export function pickVoicing(feel: Feel, p: { warm: number }): Voicing {
  const { valence, serene, space } = feel;
  let key: string;

  if (valence >= 0.55 && p.warm >= 0.66)     key = 'warm';
  else if (serene >= 0.5 && valence >= 0.5)   key = 'bright';
  else if (valence >= 0.6)                   key = 'bright';
  else if (valence >= 0.5)                  key = 'open';
  else if (valence >= 0.34)                   key = 'wistful';
  else                                        key = 'dark';

  let reg = 0;
  if (key === 'bright')   reg = serene >= 0.6 ? 7 : 5;
  else if (key === 'warm')    reg = 2;
  else if (key === 'open')    reg = -2;
  else if (key === 'wistful') reg = -5;
  else                      reg = -12;

  const v = VOICINGS[key];
  const spread = space > 0.55;
  const airTone = v.tmpl[v.tmpl.length - 1] + reg + (spread ? 24 : 12);

  return {
    tmpl: v.tmpl,
    name: v.name,
    key,
    reg,
    spread,
    serene,
    airTone,
  };
}
