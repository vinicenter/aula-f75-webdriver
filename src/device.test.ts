// The WebHID transport against an emulated F75 (cable feature reports, receiver input reports).
import { describe, expect, it } from 'vitest';
import { F75, pick } from './device';
import { buffer, macroKeyCode, textEvents } from './macros';
import * as p from './protocol';

/** Minimal keyboard: LED block, key layers, per-key matrix, live frames. */
class Keyboard {
  block = new Uint8Array(128);
  layers = [p.factoryLayer0(), new Uint8Array(p.KEYMAP_LEN)];
  matrix = new Uint8Array(384);
  macroPages: Uint8Array[] = [];
  frames = 0;
  constructor() {
    this.block[10] = 1;
    this.block[126] = 0x5a;
    this.block[127] = 0xa5;
  }
  /** Data for a read command (cmd without its read flag). */
  read(cmd: number, sub: number, c: p.Cmds): Uint8Array {
    if (cmd === c.led) return this.block.slice();
    if (cmd === c.keymap) return this.layers[sub].slice();
    if (cmd === c.ledMatrix) return this.matrix.slice();
    if (cmd === p.WIRELESS_ONLINE) return Uint8Array.of(1);
    throw new Error(`read ${cmd}`);
  }
  write(cmd: number, sub: number, data: Uint8Array, c: p.Cmds) {
    if (cmd === c.led) this.block = data.slice();
    else if (cmd === c.keymap) this.layers[sub] = data.slice();
    else if (cmd === c.ledMatrix) this.matrix = data.slice();
    else if (cmd === c.realtime) this.frames++;
    else if (cmd === c.macros) this.macroPages[sub] = data.slice();
    else throw new Error(`write ${cmd}`);
  }
}

type Listener = (e: { reportId: number; data: DataView }) => void;

class FakeDevice {
  opened = false;
  listeners: Listener[] = [];
  pending = new Uint8Array(0);
  /** wireless writes being assembled */
  parts: Uint8Array[] = [];
  dropOnce = true;
  constructor(
    readonly vendorId: number,
    readonly productId: number,
    readonly collections: unknown[],
    readonly kb: Keyboard,
  ) {}
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(_: string, f: Listener) {
    this.listeners.push(f);
  }
  removeEventListener() {}
  private takeParts(): Uint8Array {
    const all = new Uint8Array(this.parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of this.parts) {
      all.set(x, o);
      o += x.length;
    }
    this.parts = [];
    return all;
  }
  private emit(reportId: number, bytes: Uint8Array) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    setTimeout(() => this.listeners.forEach((f) => f({ reportId, data })), 1);
  }

  // cable: feature report 6, Chrome returns the report id as byte 0
  async sendFeatureReport(id: number, d: Uint8Array) {
    expect(id).toBe(p.WIRED_REPORT);
    expect(d.length).toBe(p.WIRED_LEN - 1);
    const [cmd, sub, size] = [d[0], d[1], d[5] | (d[6] << 8)];
    if (cmd & 0x80) {
      const data = this.kb.read(cmd & 0x7f, sub, p.WIRED);
      const r = new Uint8Array(p.WIRED_LEN);
      r.set([p.WIRED_REPORT, cmd, sub, 0, d[3], d[4], size & 0xff, size >> 8]);
      r.set(data.subarray(d[4] * 512, d[4] * 512 + size), 8);
      this.pending = r;
      return;
    }
    // payloads over 512 bytes arrive as several reports: [.. total index ..]
    this.parts[d[4]] = d.slice(7, 7 + size);
    if (d[4] + 1 === d[3]) this.kb.write(cmd, sub, this.takeParts(), p.WIRED);
  }
  async receiveFeatureReport(id: number) {
    expect(id).toBe(p.WIRED_REPORT);
    return new DataView(this.pending.buffer);
  }

  // receiver: report 0x13, 19 bytes without the id
  async sendReport(id: number, d: Uint8Array) {
    expect(id).toBe(p.REPORT_ID);
    expect(d.length).toBe(p.PACKET_LEN - 1);
    const pk = Uint8Array.of(id, ...d);
    expect(pk[19]).toBe(p.checksum(pk));
    const [cmd, total, index, sub, len] = [pk[1], pk[2], pk[3], pk[4] >> 4, pk[4] & 0x0f];
    this.emit(0x04, new Uint8Array(19)); // keyboard input on the same interface: must be ignored
    if (cmd === p.WIRELESS_ONLINE || (cmd & 0x40 && !(cmd & 0x80))) {
      const data = this.kb.read(cmd === p.WIRELESS_ONLINE ? cmd : cmd & 0x3f, sub, p.WIRELESS);
      const replies = p.writePackets(cmd, sub, data);
      replies.forEach((r, i) => {
        if (i === 3 && replies.length > 4 && this.dropOnce) {
          this.dropOnce = false; // the radio loses one packet: the read must retry and merge
          return;
        }
        this.emit(p.REPORT_ID, r.slice(1));
      });
      return;
    }
    this.parts[index] = pk.slice(5, 5 + len);
    if (!(cmd & 0x80)) this.emit(p.REPORT_ID, Uint8Array.of(cmd, total, index, len, ...new Uint8Array(15)));
    if (index + 1 === total) this.kb.write(cmd, sub, this.takeParts(), p.WIRELESS);
  }
}

const wiredDev = (kb: Keyboard) =>
  new FakeDevice(0x258a, 0x010c, [{ usagePage: 0xff00, featureReports: [{ reportId: 6 }] }], kb);
const receiverDev = (kb: Keyboard) =>
  new FakeDevice(0x3554, 0xfa09, [{ usagePage: 0xff02, outputReports: [{ reportId: 0x13 }] }], kb);
const keyboardOnlyDev = (kb: Keyboard) => new FakeDevice(0x258a, 0x010c, [{ usagePage: 1, inputReports: [{ reportId: 1 }] }], kb);

async function connect(dev: FakeDevice) {
  const best = pick([dev as unknown as HIDDevice])!;
  const f = new F75(best.dev, best.link);
  await f.open();
  return f;
}

describe('pick', () => {
  it('prefers the cable and skips interfaces without config reports', () => {
    const kb = new Keyboard();
    const devs = [receiverDev(kb), keyboardOnlyDev(kb), wiredDev(kb)] as unknown as HIDDevice[];
    expect(pick(devs)?.link).toBe('wired');
    expect(pick([devs[0], devs[1]])?.link).toBe('receiver');
    expect(pick([devs[1]])).toBeNull();
  });
});

describe.each([
  ['wired', wiredDev],
  ['receiver', receiverDev],
] as const)('F75 over %s', (_, make) => {
  it('edits the LED block, keymaps and per-key colours', async () => {
    const kb = new Keyboard();
    const f = await connect(make(kb));
    expect(await f.online()).toBe(true);

    await f.setEffect(13, 7, 3, 2);
    expect(p.effectFromBlock(kb.block)).toEqual({ mode: 13, brightness: 7, speed: 3, colour: 2 });
    await f.setSleep(0);
    expect(kb.block[p.SLEEP_OFFSET]).toBe(0);
    expect(p.ledBlockValid(kb.block)).toBe(true);

    const km = await f.getKeymap(0);
    expect(p.keymapEncodingOk(km)).toBe(true);
    km.set(p.keyCode(0x04), 0); // Esc -> A
    await f.setKeymap(0, km);
    expect([...p.codeAt(kb.layers[0], 0)]).toEqual([0, 0, 0, 0x04]);

    const c: p.Colours = Array.from({ length: p.LED_COUNT }, (_, i) => [i, 0, 255 - i]);
    await f.setPerKey(c, 9);
    expect(kb.matrix[5]).toBe(5);
    expect(kb.matrix[2 * p.LED_COUNT + 5]).toBe(250);
    expect(kb.block[10]).toBe(p.CUSTOM_MODE);
    expect(await f.getPerKey()).toEqual(c);
  }, 20_000);

  it('writes the key matrix, then the macro area', async () => {
    const kb = new Keyboard();
    const f = await connect(make(kb));
    // long enough to need two 512-byte pages over 2.4G
    const buf = buffer([{ name: 'long', events: textEvents('the quick brown fox jumps over the lazy dog '.repeat(2), 12) }]);
    expect(buf.length).toBeGreaterThan(512);
    const km = p.factoryLayer0();
    km.set(macroKeyCode(0), 78 * 4); // F12
    await f.setKeymapAndMacros(km, buf);
    expect([...p.codeAt(kb.layers[0], 78)]).toEqual([3, 1, 1, 0]);
    const pages = kb.macroPages;
    if (f.link === 'wired') expect(pages.length).toBe(1);
    else expect(pages.map((x) => x.length)).toEqual([512, buf.length - 512]);
    const joined = new Uint8Array(pages.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of pages) {
      joined.set(x, o);
      o += x.length;
    }
    expect([...joined]).toEqual([...buf]);
  }, 20_000);

  it('streams live frames after switching to per-key mode', async () => {
    const kb = new Keyboard();
    const f = await connect(make(kb));
    const c: p.Colours = Array.from({ length: p.LED_COUNT }, () => [1, 2, 3]);
    await Promise.all([f.frame(c), f.frame(c)]);
    expect(kb.frames).toBe(2);
    expect(kb.block[10]).toBe(p.CUSTOM_MODE);
  }, 20_000);
});

describe('bluetooth', () => {
  it('refuses to configure', async () => {
    const kb = new Keyboard();
    const f = await connect(new FakeDevice(0x3554, 0xfa08, [{ usagePage: 0xff02, outputReports: [{ reportId: 0x13 }] }], kb));
    expect(f.link).toBe('bluetooth');
    await expect(f.setEffect(1, 9, 0, 0)).rejects.toThrow(/Bluetooth/);
  });
});
