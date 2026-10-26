// On-keyboard macros, ported from aula-f75-linux-concept/src/macros.rs
// (OemDrv `FUN_0048d2d0` buffer and `FUN_0048cf00` events).
//
// Buffer: N × [addr u16, size u16] (addr from buffer start), then per macro
// `name_len, UTF-16LE name (≤ 30 chars), events…`; only the used bytes are written.
// Event: `[(type << 4) | release << 7 | delay[19:16], delay[15:8], delay[7:0], code]`
// type 0 = key (HID usage), 1 = modifier (0xe0-0xe7), 2 = mouse button, 3/4 = mouse X/Y, 5 = wheel.
// Key matrix code for a macro key: `[0x03, mode, count, macro_index]` (mode 1 = play `count` times).
import type { Code } from './protocol';

export interface Macro {
  name: string;
  events: Ev[];
}

export interface Ev {
  usage: number;
  down: boolean;
  delayMs: number; // wait after this event
}

export function macroKeyCode(index: number, count = 1): Code {
  return [3, 1, Math.max(count, 1), index];
}

const isModifier = (usage: number) => usage >= 0xe0 && usage <= 0xe7;

/** Text to key events (US layout); unsupported characters are skipped. */
export function textEvents(text: string, delay: number): Ev[] {
  const ev: Ev[] = [];
  for (const ch of text) {
    const u = charUsage(ch);
    if (!u) continue;
    const [usage, shift] = u;
    if (shift) ev.push({ usage: 0xe1, down: true, delayMs: 4 });
    ev.push({ usage, down: true, delayMs: delay });
    ev.push({ usage, down: false, delayMs: 4 });
    if (shift) ev.push({ usage: 0xe1, down: false, delayMs: delay });
  }
  return ev;
}

const PLAIN = '1234567890\n\t -=[]\\;\'`,./';
const PLAIN_CODES = [
  0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34,
  0x35, 0x36, 0x37, 0x38,
];
const SHIFTED = '!@#$%^&*()';
const SHIFTED2 = '_+{}|:"~<>?';
const SHIFTED2_CODES = [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38];

export function charUsage(ch: string): [number, boolean] | null {
  const c = ch.charCodeAt(0);
  if (ch >= 'a' && ch <= 'z') return [0x04 + (c - 97), false];
  if (ch >= 'A' && ch <= 'Z') return [0x04 + (c - 65), true];
  let i = PLAIN.indexOf(ch);
  if (i >= 0) return [PLAIN_CODES[i], false];
  i = SHIFTED.indexOf(ch);
  if (i >= 0) return [PLAIN_CODES[i], true];
  i = SHIFTED2.indexOf(ch);
  return i >= 0 ? [SHIFTED2_CODES[i], true] : null;
}

/** Characters of `text` the keyboard cannot type (non US-ASCII). */
export function unsupportedChars(text: string): string[] {
  return [...new Set([...text].filter((c) => !charUsage(c)))];
}

function blob(m: Macro): number[] {
  const name: number[] = [];
  for (let k = 0; k < Math.min(m.name.length, 30); k++) {
    const cu = m.name.charCodeAt(k); // UTF-16LE
    name.push(cu & 0xff, cu >> 8);
  }
  const b = [name.length, ...name];
  for (const e of m.events) {
    const d = Math.min(e.delayMs, 0xfffff);
    const kind = isModifier(e.usage) ? 1 : 0;
    let head = (kind << 4) | ((d >> 16) & 0x0f);
    if (!e.down) head |= 0x80;
    b.push(head, (d >> 8) & 0xff, d & 0xff, e.usage);
  }
  return b;
}

/** The bytes OemDrv sends: address table + macro blobs, no padding. */
export function buffer(macros: Macro[]): Uint8Array {
  const blobs = macros.map(blob);
  const out: number[] = [];
  let addr = macros.length * 4;
  for (const b of blobs) {
    out.push(addr & 0xff, addr >> 8, b.length & 0xff, b.length >> 8);
    addr += b.length;
  }
  for (const b of blobs) out.push(...b);
  return Uint8Array.from(out);
}
