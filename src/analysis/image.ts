export interface ImageProfile {
  light: number;
  warm: number;
  sat: number;
  density: number;
  contrast: number;
  tilt: number;
  root: number;
  seed: number;
  mood: string[] | null;
  desc: string | null;
  vVal: number | null;
  vEng: number | null;
  vSpc: number | null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return [h * 360, s, l];
}

export async function analyseImage(file: File): Promise<{ profile: ImageProfile; base64: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  const W = 96, H = 72;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;

  const lums: number[] = [];
  const topLums: number[] = [];
  const botLums: number[] = [];
  let warmNum = 0, warmDen = 0, satSum = 0;
  const horizDiffs: number[] = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [h, s, l] = rgbToHsl(r, g, b);
      lums.push(l);
      satSum += s;
      // Warmth: hue in warm range (cos((hue-30)*pi/180)+1)/2 weighted by sat
      const hueOff = (h - 30) * Math.PI / 180;
      warmNum += s * (Math.cos(hueOff) + 1) / 2;
      warmDen += s;
      if (y < H / 2) topLums.push(l); else botLums.push(l);
      // Horizontal diff
      if (x > 0) {
        const ip = (y * W + (x - 1)) * 4;
        const rp = data[ip], gp = data[ip + 1], bp = data[ip + 2];
        const lp = 0.2126 * rp / 255 + 0.7152 * gp / 255 + 0.0722 * bp / 255;
        const lc = 0.2126 * r / 255 + 0.7152 * g / 255 + 0.0722 * b / 255;
        horizDiffs.push(Math.abs(lc - lp));
      }
    }
  }

  // Mean luminance
  const meanLum = lums.reduce((a, b) => a + b, 0) / n;
  // p85 luminance
  const sortedLums = [...lums].sort((a, b) => a - b);
  const p85Lum = sortedLums[Math.floor(0.85 * n)];
  const light = 0.4 * meanLum + 0.6 * p85Lum;

  // Warmth
  const warm = warmDen > 0 ? warmNum / warmDen : 0.5;

  // Sat
  const sat = satSum / n;

  // Contrast (luminance std dev)
  const lumMean = meanLum;
  const lumVar = lums.reduce((acc, l) => acc + (l - lumMean) ** 2, 0) / n;
  const contrast = Math.sqrt(lumVar);

  // Density
  const meanHorizDiff = horizDiffs.reduce((a, b) => a + b, 0) / horizDiffs.length;
  const density = Math.min(1, Math.max(0, meanHorizDiff * 4.5));

  // Tilt
  const topMean = topLums.reduce((a, b) => a + b, 0) / topLums.length;
  const botMean = botLums.reduce((a, b) => a + b, 0) / botLums.length;
  const tilt = (topMean - botMean) / (n / 2);

  // Root
  const root = Math.min(62, Math.max(40, 50 + Math.round((light - 0.5) * 16)));

  // Seed
  const seedRaw = (Math.floor(warm * 611 + light * 1009 + density * 331 + contrast * 733) >>> 0) || 12345;
  const seed = seedRaw;

  // Convert image to base64
  const fullCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const fullCtx = fullCanvas.getContext('2d')!;
  fullCtx.drawImage(bitmap, 0, 0);
  const blob = await fullCanvas.convertToBlob({ type: file.type || 'image/jpeg' });
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  const base64 = btoa(binary);
  const mediaType = (file.type || 'image/jpeg') as string;

  return {
    profile: {
      light, warm, sat, density, contrast, tilt, root, seed,
      mood: null, desc: null, vVal: null, vEng: null, vSpc: null,
    },
    base64,
    mediaType,
  };
}
