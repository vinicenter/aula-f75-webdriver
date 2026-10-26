// AULA F75 protocol, ported from aula-f75-linux-concept/src/protocol.rs (docs/PROTOCOL.md there).
//
// Two transports share the same payloads:
// * 2.4 GHz receiver (3554:fa09) and Bluetooth (3554:fa08): `CDev3632`, 20-byte report 0x13
//   `[13 cmd total index (sub<<4)|len data*14 checksum]`, checksum = sum(bytes 0..19).
// * USB cable (258a:010c): `CDevG5KB`, 520-byte feature report 0x06
//   `[06 cmd sub 00 total index size_lo size_hi data*512]`.
import { KEYS } from './layout';

export const LED_COUNT = 126; // 21 columns x 6 rows; led = column * 6 + row
export const MATRIX_LEN = 128; // KB.ini MatrixLen
export const LED_BLOCK_LEN = 128;
export const KEYMAP_LEN = MATRIX_LEN * 4;

export type RGB = [number, number, number];
export type Colours = RGB[]; // LED_COUNT entries, indexed by led
export type Code = [number, number, number, number];

export type Link = 'wired' | 'receiver' | 'bluetooth';

export const LINK_NAME: Record<Link, string> = { wired: 'USB-C', receiver: '2.4G', bluetooth: 'Bluetooth' };

/** Command numbers differ per transport (CDev3632 vs CDevG5KB vtables). */
export interface Cmds {
  keymap: number;
  ledMatrix: number;
  macros: number;
  led: number;
  realtime: number;
  readFlag: number;
}

export const WIRELESS: Cmds = { keymap: 0x01, ledMatrix: 0x02, macros: 0x03, led: 0x04, realtime: 0x88, readFlag: 0x40 };
export const WIRED: Cmds = { keymap: 0x03, ledMatrix: 0x06, macros: 0x05, led: 0x04, realtime: 0x08, readFlag: 0x80 };
export const WIRELESS_ONLINE = 0x07; // returns m_bOnline (1 = keyboard linked to receiver), not battery

export function cmds(link: Link): Cmds {
  return link === 'wired' ? WIRED : WIRELESS;
}

// ---------------------------------------------------------------- 20-byte wireless framing

export const REPORT_ID = 0x13;
export const PACKET_LEN = 20;
export const CHUNK = 14;

export function checksum(p: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < PACKET_LEN - 1; i++) s = (s + p[i]) & 0xff;
  return s;
}

/** CDev3632::AccessData (0x004862f0). */
export function writePackets(cmd: number, sub: number, data: Uint8Array): Uint8Array[] {
  const total = Math.ceil(data.length / CHUNK);
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = data.subarray(i * CHUNK, (i + 1) * CHUNK);
    const p = new Uint8Array(PACKET_LEN);
    p[0] = REPORT_ID;
    p[1] = cmd;
    p[2] = total;
    p[3] = i;
    p[4] = ((sub << 4) | chunk.length) & 0xff;
    p.set(chunk, 5);
    p[19] = checksum(p);
    out.push(p);
  }
  return out;
}

/** 0x004865d0 / SendCMD_3632 (0x00487070). */
export function readRequest(cmd: number, sub: number): Uint8Array {
  const p = new Uint8Array(PACKET_LEN);
  p[0] = REPORT_ID;
  p[1] = cmd;
  p[2] = 1;
  p[4] = (sub << 4) & 0xff;
  p[19] = checksum(p);
  return p;
}

export interface Reply {
  cmd: number;
  crcError: boolean;
  total: number;
  index: number;
  len: number;
}

export function parseReply(p: Uint8Array): Reply | null {
  if (p.length < PACKET_LEN || p[0] !== REPORT_ID) return null;
  return {
    cmd: p[1] & 0x7f,
    crcError: (p[1] & 0x80) !== 0 || (p[2] & 0x80) !== 0,
    total: p[2] & 0x7f,
    index: p[3],
    len: Math.min(p[4] & 0x0f, CHUNK),
  };
}

// ---------------------------------------------------------------- 520-byte wired framing

export const WIRED_REPORT = 0x06;
export const WIRED_LEN = 520;
export const WIRED_CHUNK = 512;

/** CDevG5KB::AccessData (0x0048b4d0) and the inlined Get* readers (e.g. 0x0048bc00). */
export function wiredPackets(cmd: number, sub: number, len: number, data?: Uint8Array): Uint8Array[] {
  const total = Math.ceil(len / WIRED_CHUNK);
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const off = i * WIRED_CHUNK;
    const size = Math.min(len - off, WIRED_CHUNK);
    const p = new Uint8Array(WIRED_LEN);
    p[0] = WIRED_REPORT;
    p[1] = cmd;
    p[2] = sub;
    p[4] = total;
    p[5] = i;
    p[6] = size & 0xff;
    p[7] = size >> 8;
    if (data) p.set(data.subarray(off, off + size), 8);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- lighting

export interface Effect {
  id: number;
  name: string;
  speed: boolean;
  brightness: boolean;
  colour: boolean;
}

/** KB.ini `LedOpt*` + Text/en tc_kb_led*. The order is the slot order in the LED block. */
export const EFFECTS: Effect[] = (
  [
    [1, 'Fixed On', false, true, true],
    [2, 'Respire', true, true, true],
    [3, 'Rainbow', true, true, false],
    [4, 'Flash Away', true, true, true],
    [5, 'Raindrops', true, true, true],
    [6, 'Rainbow Wheel', true, true, true],
    [7, 'Ripples', true, true, true],
    [8, 'Stars Twinkle', true, true, true],
    [9, 'Shadow Fade', true, true, true],
    [10, 'Retro Snake', true, true, true],
    [11, 'Neon Stream', true, true, true],
    [12, 'Reaction', true, true, true],
    [13, 'Sine Wave', true, true, true],
    [14, 'Scanner', true, true, true],
    [15, 'Windmill', true, true, false],
    [16, 'Waterfall', true, true, false],
    [17, 'Blossoming', true, true, false],
    [18, 'Storm', true, true, true],
    [21, 'Per-key', false, true, false],
    [0, 'Off', false, false, false],
  ] as const
).map(([id, name, speed, brightness, colour]) => ({ id, name, speed, brightness, colour }));
export const CUSTOM_MODE = 21;
/** "Fixed on": the hardware only takes a palette colour (3-bit nibble), see PALETTE. */
export const FIXED_MODE = 1;

export const PALETTE: RGB[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];
export const RANDOM_COLOUR = 7;

/** KB.ini SleepUI / SleepHW (seconds -> hardware value); 0 disables sleep. */
export const SLEEP: [number, number][] = [
  [0, 0], [60, 2], [90, 3], [120, 4], [180, 6], [240, 8], [300, 10], [600, 20], [900, 30], [1200, 40],
];
export const SLEEP_OFFSET = 0x18;

export function ledBlockValid(b: Uint8Array): boolean {
  return b.length >= LED_BLOCK_LEN && b[126] === 0x5a && b[127] === 0xa5;
}

/** Fields written by 0x0048d810. */
export function editLedBlock(b: Uint8Array, mode: number, brightness: number, speed: number, colour: number): void {
  b[9] = mode === CUSTOM_MODE ? 1 : 0;
  b[10] = mode;
  const slot = EFFECTS.findIndex((e) => e.id === mode);
  if (slot >= 0) {
    const o = 0x3a + slot * 2;
    b[o] = Math.min(brightness, 9);
    b[o + 1] = (Math.min(speed, 4) << 4) | (colour & 0x0f);
  }
}

export interface BlockEffect {
  mode: number;
  brightness: number;
  speed: number;
  colour: number;
}

export function effectFromBlock(b: Uint8Array): BlockEffect | null {
  const i = EFFECTS.findIndex((e) => e.id === b[10]);
  if (i < 0) return null;
  const o = 0x3a + i * 2;
  return { mode: b[10], brightness: Math.min(b[o], 9), speed: Math.min(b[o + 1] >> 4, 4), colour: b[o + 1] & 0x0f };
}

export function sleepFromBlock(b: Uint8Array): number {
  return SLEEP.find((s) => s[1] === b[SLEEP_OFFSET])?.[0] ?? 300;
}

/** Per-key planes for ledMatrix: R[126] G[126] B[126] + padding to 384 (0x0048dbc0). */
export function matrixPayload(c: Colours): Uint8Array {
  const buf = new Uint8Array(MATRIX_LEN * 3);
  c.forEach((px, led) => {
    for (let ch = 0; ch < 3; ch++) buf[ch * LED_COUNT + led] = px[ch];
  });
  return buf;
}

/** Inverse of matrixPayload: colours from a per-key matrix read back from the keyboard. */
export function matrixColours(b: Uint8Array): Colours {
  return Array.from({ length: LED_COUNT }, (_, led) => [b[led], b[LED_COUNT + led], b[2 * LED_COUNT + led]] as RGB);
}

/** Interleaved RGB frame for realtime, sub 0 (0x0047f250 builds 0x17a bytes). */
export function realtimePayload(c: Colours): Uint8Array {
  const buf = new Uint8Array(LED_COUNT * 3);
  c.forEach((px, led) => buf.set(px, led * 3));
  return buf;
}

// ---------------------------------------------------------------- key codes (0x0048c820)

/**
 * 4-byte hardware code per matrix index: `[type, a, b, c]`.
 * type 0 = keyboard `[0, modifiers, 0, usage]`, 2 = consumer `[2, 0, hi, lo]`,
 * 3 = macro `[3, mode, count, macro_index]`.
 */
export function keyCode(usage: number, mods = 0): Code {
  return [0, mods, 0, usage];
}
export function consumerCode(usage: number): Code {
  return [2, 0, usage >> 8, usage & 0xff];
}

export interface Target {
  label: string;
  group: string;
  code: Code;
}

/** Remap targets. */
export const TARGETS: Target[] = (() => {
  const v: Target[] = [{ label: 'Disabled', group: 'Special', code: [0, 0, 0, 0] }];
  for (let i = 0; i < 26; i++) v.push({ label: String.fromCharCode(65 + i), group: 'Letters', code: keyCode(0x04 + i) });
  [...'1234567890'].forEach((c, i) => v.push({ label: c, group: 'Numbers', code: keyCode(0x1e + i) }));
  for (let i = 0; i < 12; i++) v.push({ label: `F${i + 1}`, group: 'Function keys', code: keyCode(0x3a + i) });
  const named: [string, number][] = [
    ['Enter', 0x28], ['Esc', 0x29], ['Backspace', 0x2a], ['Tab', 0x2b], ['Space', 0x2c], ['-', 0x2d],
    ['=', 0x2e], ['[', 0x2f], [']', 0x30], ['\\', 0x31], [';', 0x33], ["'", 0x34], ['`', 0x35], [',', 0x36],
    ['.', 0x37], ['/', 0x38], ['Caps Lock', 0x39], ['Print Screen', 0x46], ['Scroll Lock', 0x47],
    ['Pause', 0x48], ['Insert', 0x49], ['Home', 0x4a], ['Page Up', 0x4b], ['Delete', 0x4c], ['End', 0x4d],
    ['Page Down', 0x4e], ['Right', 0x4f], ['Left', 0x50], ['Down', 0x51], ['Up', 0x52], ['Menu', 0x65],
  ];
  for (const [n, u] of named) v.push({ label: n, group: 'Editing and navigation', code: keyCode(u) });
  // modifiers are bits in byte 1 (confirmed on hardware: Left Shift = 00 02 00 00, Left Ctrl = 00 01 00 00)
  ['Left Ctrl', 'Left Shift', 'Left Alt', 'Left Win/Cmd', 'Right Ctrl', 'Right Shift', 'Right Alt', 'Right Win/Cmd'].forEach((n, i) =>
    v.push({ label: n, group: 'Modifiers', code: keyCode(0, 1 << i) }),
  );
  const media: [string, number][] = [
    ['Play / Pause', 0xcd], ['Next Track', 0xb5], ['Previous Track', 0xb6], ['Stop', 0xb7], ['Mute', 0xe2],
    ['Volume Up', 0xe9], ['Volume Down', 0xea], ['Calculator', 0x192], ['Browser', 0x196], ['Mail', 0x18a],
  ];
  for (const [n, u] of media) v.push({ label: n, group: 'Media', code: consumerCode(u) });
  return v;
})();

export const sameCode = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

const hex2 = (x: number) => x.toString(16).padStart(2, '0');

export function describeCode(c: Code): string {
  const t = TARGETS.find((t) => sameCode(t.code, c));
  if (t) return t.label;
  if (c[0] === 3) return `Macro ${c[3] + 1}`;
  if (c[0] === 0x0d && c[1] === 0 && c[2] === 0 && c[3] === 0) return 'Fn';
  return c.map(hex2).join(' ');
}

/** Factory code for a key, from its Windows VK in KB.ini. */
export function defaultCode(vk: number): Code | null {
  let usage: number;
  if (vk >= 0x41 && vk <= 0x5a) usage = 0x04 + (vk - 0x41);
  else if (vk >= 0x31 && vk <= 0x39) usage = 0x1e + (vk - 0x31);
  else if (vk >= 0x70 && vk <= 0x7b) usage = 0x3a + (vk - 0x70);
  else {
    const mods: Record<number, number> = { 0xa2: 0x01, 0xa0: 0x02, 0xa4: 0x04, 0x5b: 0x08, 0xa3: 0x10, 0xa1: 0x20 };
    if (vk in mods) return keyCode(0, mods[vk]);
    const table: Record<number, number> = {
      0x30: 0x27, 0x1b: 0x29, 0x09: 0x2b, 0x14: 0x39, 0x0d: 0x28, 0x08: 0x2a, 0x20: 0x2c, 0xc0: 0x35, 0xbd: 0x2d,
      0xbb: 0x2e, 0xdb: 0x2f, 0xdd: 0x30, 0xdc: 0x31, 0xba: 0x33, 0xde: 0x34, 0xbc: 0x36, 0xbe: 0x37, 0xbf: 0x38,
      0x2e: 0x4c, 0x21: 0x4b, 0x22: 0x4e, 0x23: 0x4d, 0x27: 0x4f, 0x25: 0x50, 0x28: 0x51, 0x26: 0x52,
    };
    if (!(vk in table)) return null;
    usage = table[vk];
  }
  return keyCode(usage);
}

export function codeAt(km: Uint8Array, led: number): Code {
  const i = led * 4;
  return [km[i], km[i + 1], km[i + 2], km[i + 3]];
}

/**
 * A base layer we are willing to edit: complete, and most letter/number keys at
 * their factory codes (catches shifted or truncated reads).
 */
export function keymapPlausible(layer0: Uint8Array, keys: { vk: number; led: number }[]): boolean {
  if (layer0.length < KEYMAP_LEN || !sameCode(layer0, keyCode(0x29))) return false;
  const checks = keys
    .filter(({ vk }) => (vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a))
    .map(({ vk, led }) => {
      const c = defaultCode(vk);
      return c !== null && sameCode(codeAt(layer0, led), c);
    });
  return checks.filter(Boolean).length * 10 >= checks.length * 8;
}

/** Factory base layer from the KB.ini layout (matches the F75's 2.4G read key for key). */
export function factoryLayer0(): Uint8Array {
  const km = new Uint8Array(KEYMAP_LEN);
  for (const k of KEYS) {
    const code: Code | null = k.vk === 0xfa ? [0x0d, 0, 0, 0] : defaultCode(k.vk); // Fn = 0d 00 00 00 on hardware
    if (code) km.set(code, k.led * 4);
  }
  return km;
}

export function keymapEncodingOk(layer0: Uint8Array): boolean {
  return keymapPlausible(layer0, KEYS);
}

export function hex(b: ArrayLike<number>): string {
  return Array.from(b, hex2).join(' ');
}
