// Profiles in localStorage, ported from aula-f75-linux-concept/src/state.rs. Each profile holds the
// full keyboard setup: lighting, sleep, the base/Fn key layouts (null = factory layout) and text
// macros. Profiles can be exported and imported as JSON files.
import { presetRainbow } from './fx';
import { CUSTOM_MODE, KEYMAP_LEN, LED_COUNT, keymapEncodingOk, type Colours, type RGB } from './protocol';

export interface MacroDef {
  name: string;
  text: string;
  led: number;
}

export interface Profile {
  name: string;
  mode: number; // hardware effect id (protocol.EFFECTS)
  colours: Colours;
  brush: RGB;
  brightness: number;
  speed: number;
  colour: number;
  sleep: number;
  keymaps: [Uint8Array | null, Uint8Array | null]; // base, Fn
  macros: MacroDef[];
  palette: number;
  /** Free RGB colour for Fixo (null = palette colour); sent as per-key mode with every key this colour. */
  solid: RGB | null;
}

const KEY = 'f75.profiles';
const ACTIVE = 'f75.active';

export function newProfile(name: string): Profile {
  return {
    name,
    mode: CUSTOM_MODE,
    colours: presetRainbow(),
    brush: [57, 255, 106],
    brightness: 9,
    speed: 2,
    colour: 0,
    sleep: 300,
    keymaps: [null, null],
    macros: [],
    palette: 0,
    solid: null,
  };
}

const toHex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/** JSON-safe form (byte arrays as hex). */
function serialise(p: Profile) {
  return {
    ...p,
    colours: p.colours.map(toHex),
    brush: toHex(p.brush),
    keymaps: p.keymaps.map((k) => (k ? toHex(k) : null)),
    solid: p.solid ? toHex(p.solid) : null,
  };
}

function parse(o: any): Profile {
  const p = newProfile(typeof o?.name === 'string' && o.name ? o.name : 'Default');
  const num = (v: unknown, d: number, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : d);
  const rgb = (h: unknown, d: RGB): RGB => {
    const b = typeof h === 'string' ? fromHex(h) : null;
    return b && b.length === 3 ? [b[0], b[1], b[2]] : d;
  };
  p.mode = num(o.mode, p.mode, 255);
  if (Array.isArray(o.colours)) for (let i = 0; i < LED_COUNT; i++) p.colours[i] = rgb(o.colours[i], p.colours[i]);
  p.brush = rgb(o.brush, p.brush);
  p.brightness = num(o.brightness, 9, 9);
  p.speed = num(o.speed, 2, 4);
  p.colour = num(o.colour, 0, 7);
  p.sleep = num(o.sleep, 300, 3600);
  if (Array.isArray(o.keymaps)) {
    p.keymaps = [0, 1].map((i) => {
      const b = typeof o.keymaps[i] === 'string' ? fromHex(o.keymaps[i]) : null;
      return b && b.length === KEYMAP_LEN ? b : null;
    }) as Profile['keymaps'];
  }
  if (Array.isArray(o.macros)) {
    p.macros = o.macros
      .filter((m: any) => typeof m?.text === 'string' && Number.isInteger(m?.led))
      .map((m: any) => ({ name: String(m.name ?? ''), text: m.text, led: m.led }));
  }
  p.palette = num(o.palette, 0, 255);
  if (typeof o.solid === 'string') p.solid = rgb(o.solid, [255, 255, 255]);
  return p;
}

function readAll(): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, unknown>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota: profiles just don't persist */
  }
}

/** All profile names (sorted), creating "Default" on first run. */
export function list(): string[] {
  const names = Object.keys(readAll());
  if (!names.length) {
    save(newProfile('Default'));
    return ['Default'];
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function load(name: string): Profile | null {
  const o = readAll()[name];
  return o ? parse(o) : null;
}

export function save(p: Profile) {
  const all = readAll();
  all[p.name] = serialise(p);
  writeAll(all);
  setActive(p.name);
}

export function remove(name: string) {
  const all = readAll();
  delete all[name];
  writeAll(all);
}

function setActive(name: string) {
  try {
    localStorage.setItem(ACTIVE, name);
  } catch {
    /* ignore */
  }
}

export function active(): Profile {
  const names = list();
  let want: string | null = null;
  try {
    want = localStorage.getItem(ACTIVE);
  } catch {
    /* ignore */
  }
  return (want && load(want)) || load(names[0]) || newProfile('Default');
}

export function exportJson(p: Profile): string {
  return JSON.stringify({ aula75Webdriver: 1, profile: serialise(p) }, null, 2);
}

export function importJson(text: string): Profile {
  const o = JSON.parse(text);
  if (!o || typeof o !== 'object' || !o.profile) throw new Error('Invalid profile file');
  return parse(o.profile);
}

/**
 * First good base/Fn layout read is kept as the factory backup for "Restore default layout".
 * A base-layer backup that fails the sanity check (e.g. a shifted read) is replaced.
 */
export function keymapBackup(layer: number, current: Uint8Array): Uint8Array {
  const key = `f75.keymap-layer${layer}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const b = fromHex(saved);
      if (b.length === current.length && (layer !== 0 || keymapEncodingOk(b))) return b;
    }
  } catch {
    /* ignore */
  }
  if (layer === 0 && !keymapEncodingOk(current)) return current.slice(); // never save a suspicious layout
  try {
    localStorage.setItem(key, toHex(current));
  } catch {
    /* ignore */
  }
  return current.slice();
}
