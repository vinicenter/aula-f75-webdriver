// Software effects streamed as live frames, ported from aula-f75-linux-concept/src/fx.rs.
import { BANDS, type Snapshot } from './audio';
import { KEYS } from './layout';
import { LED_COUNT, type Colours, type RGB } from './protocol';

export const PALETTES: [string, RGB[]][] = [
  ['Neon', [[0, 255, 90], [190, 255, 0], [255, 40, 0]]],
  ['Rainbow', [[255, 0, 0], [255, 160, 0], [255, 255, 0], [0, 255, 0], [0, 200, 255], [60, 0, 255], [220, 0, 255]]],
  ['Synthwave', [[40, 10, 255], [255, 0, 210], [0, 230, 255]]],
  ['Ocean', [[0, 20, 140], [0, 140, 255], [140, 255, 255]]],
  ['Fire', [[140, 0, 0], [255, 60, 0], [255, 220, 40]]],
  ['Sunset', [[255, 50, 90], [255, 150, 40], [120, 40, 255]]],
  ['Ice', [[220, 245, 255], [80, 170, 255], [20, 40, 210]]],
  ['Toxic', [[10, 255, 30], [170, 255, 0], [0, 110, 40]]],
];

export function sample(pal: RGB[], t: number): RGB {
  t = (((t % 1) + 1) % 1) * (pal.length - 1);
  const i = Math.min(Math.floor(t), pal.length - 2);
  const f = t - i;
  const [a, b] = [pal[i], pal[i + 1]];
  return [0, 1, 2].map((c) => Math.floor(a[c] + (b[c] - a[c]) * f)) as RGB;
}

function scale(c: RGB, v: number): RGB {
  v = Math.min(Math.max(v, 0), 1);
  return c.map((x) => Math.floor(x * v)) as RGB;
}

export type Fx = 'wave' | 'breathe' | 'twinkle' | 'plasma' | 'rain' | 'fire' | 'spectrum' | 'mirror';

export const STUDIO: [Fx, string][] = [
  ['wave', 'Wave'],
  ['breathe', 'Breathe'],
  ['twinkle', 'Twinkle'],
  ['plasma', 'Plasma'],
  ['rain', 'Matrix Rain'],
  ['fire', 'Fire'],
];
export const AUDIO: [Fx, string][] = [
  ['spectrum', 'Spectrum'],
  ['mirror', 'Mirror'],
];

/** Physical key geometry: (led, x 0..1 left→right, y 0..1 top→bottom, column 0..20, row 0..5). */
const GEO = KEYS.map((k) => {
  const x = Math.min(Math.max(((k.rect[0] + k.rect[2]) / 2 - 42.5) / 575, 0), 1);
  const y = Math.min(Math.max(((k.rect[1] + k.rect[3]) / 2 - 44) / 206, 0), 1);
  return { l: k.led, x, y, col: Math.round(x * 20), row: Math.round(y * 5) };
});

export const black = (): Colours => Array.from({ length: LED_COUNT }, () => [0, 0, 0] as RGB);

export class Engine {
  private seed = 0x12345678;
  private glow = new Float32Array(LED_COUNT);
  private hue = new Float32Array(LED_COUNT);
  private drops = new Float32Array(21);
  private heat = Array.from({ length: 21 }, () => new Float32Array(6));
  private lastT = 0;

  private rand(): number {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    this.seed >>>= 0;
    return (this.seed % 10000) / 10000;
  }

  frame(fx: Fx, pal: RGB[], t: number, speed: number, a: Snapshot): Colours {
    const dt = Math.min(Math.max(t - this.lastT, 0), 0.2);
    this.lastT = t;
    const ts = t * speed;
    const c = black();
    switch (fx) {
      case 'wave':
        for (const g of GEO) c[g.l] = sample(pal, g.x - ts * 0.25);
        break;
      case 'breathe': {
        const v = (0.5 + 0.5 * Math.sin(ts * 2)) ** 2 * 0.95 + 0.05;
        for (const g of GEO) c[g.l] = scale(sample(pal, ts * 0.05 + g.x * 0.3), v);
        break;
      }
      case 'twinkle':
        for (const { l } of GEO) {
          this.glow[l] = Math.max(this.glow[l] - dt * 1.2 * speed, 0);
          if (this.rand() < dt * 0.9 * speed) {
            this.glow[l] = 1;
            this.hue[l] = this.rand();
          }
          c[l] = scale(sample(pal, this.hue[l]), this.glow[l]);
        }
        break;
      case 'plasma':
        for (const g of GEO) {
          const v = Math.sin(g.x * 7 + ts) + Math.sin(g.y * 5 - ts * 1.3) + Math.sin((g.x + g.y) * 4 + ts * 0.7);
          c[g.l] = sample(pal, v / 6 + 0.5);
        }
        break;
      case 'rain':
        for (let col = 0; col < 21; col++) {
          this.drops[col] += dt * speed * (3 + Math.abs(Math.sin(col * 1.7)) * 3);
          if (this.drops[col] > 9 + this.rand() * 4) this.drops[col] = 0;
        }
        for (const g of GEO) {
          const d = this.drops[g.col] - g.row;
          const v = d >= 0 && d < 4 ? 1 - d / 4 : 0;
          c[g.l] = scale(sample(pal, 1 - v * 0.6), v);
        }
        break;
      case 'fire': {
        const energy = 0.6 + a.bass * 0.8;
        for (let col = 0; col < 21; col++) {
          for (let row = 0; row < 6; row++) {
            const base =
              row === 5 ? energy * (0.6 + this.rand() * 0.5) : this.heat[col][row + 1] * (0.55 + this.rand() * 0.35);
            this.heat[col][row] = this.heat[col][row] * 0.35 + base * 0.65;
          }
        }
        for (const g of GEO) {
          const h = Math.min(this.heat[g.col][g.row], 1);
          c[g.l] = scale(sample(pal, h * 0.99), h * 1.4);
        }
        break;
      }
      case 'spectrum':
        for (const g of GEO) {
          const lit = Math.round(a.bands[Math.min(g.col, BANDS - 1)] * 6);
          const h = 5 - g.row;
          if (h < lit) c[g.l] = sample(pal, (h / 5) * 0.99);
        }
        break;
      case 'mirror':
        for (const g of GEO) {
          const band = Math.abs(g.col - 10) * 2; // bass in the middle
          const half = Math.round(a.bands[Math.min(band, BANDS - 1)] * 3.5);
          const d = Math.trunc(Math.abs(g.row * 2 - 5) / 2); // distance from middle rows
          if (d < half) c[g.l] = sample(pal, (Math.abs(g.col - 10) / 10) * 0.99);
        }
        break;
    }
    return c;
  }
}

/** Brightness 0..9 as a linear LED level, on a curve that looks even to the eye (4/9 ~ half). */
export function level(b: number): number {
  return (Math.min(b, 9) / 9) ** 2.2;
}

export function dim(c: Colours, b: number): Colours {
  const k = level(b);
  return c.map((px) => px.map((v) => Math.round(v * k)) as RGB);
}

function hsv(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const [p, q, t] = [v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)];
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return [Math.floor(r * 255), Math.floor(g * 255), Math.floor(b * 255)];
}

export function presetRainbow(): Colours {
  const c = black();
  for (const k of KEYS) c[k.led] = hsv(((k.rect[0] + k.rect[2]) / 2 / 679) * 0.85, 1, 1);
  return c;
}

export function presetGradient(a: RGB, b: RGB): Colours {
  const c = black();
  for (const g of GEO) c[g.l] = sample([a, b], g.x * 0.999);
  return c;
}

export function presetSolid(rgb: RGB): Colours {
  const c = black();
  for (const k of KEYS) c[k.led] = [...rgb];
  return c;
}
