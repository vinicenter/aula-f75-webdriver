// WebHID transport for the F75, ported from aula-f75-linux-concept/src/device.rs.
// Every public method runs through one queue, so packets of different jobs never interleave
// (the Rust app gets the same guarantee from its single device thread).
import * as p from './protocol';
import type { Colours, Link } from './protocol';

/** Connected F75 interfaces we may ask the browser for. */
export const FILTERS: HIDDeviceFilter[] = [
  { vendorId: 0x258a, productId: 0x010c }, // USB-C cable
  { vendorId: 0x3554, productId: 0xfa09, usagePage: 0xff02 }, // 2.4G receiver
  { vendorId: 0x3554, productId: 0xfa08, usagePage: 0xff02 }, // Bluetooth
];

/**
 * AULA's driver only configures the F75 over the cable (and the receiver); over Bluetooth the
 * keyboard returns one packet of each reply and config traffic breaks typing, so we never send.
 */
export const BT_UNSUPPORTED =
  "Bluetooth can't configure the keyboard. Use the USB-C cable or the 2.4G receiver; settings are stored on the keyboard and keep working over Bluetooth.";

export class DeviceError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function linkOf(d: HIDDevice): Link | null {
  if (d.vendorId === 0x258a && d.productId === 0x010c) return 'wired';
  if (d.vendorId === 0x3554 && d.productId === 0xfa09) return 'receiver';
  if (d.vendorId === 0x3554 && d.productId === 0xfa08) return 'bluetooth';
  return null;
}

/** The HID interface that carries the config reports for this link. */
function isConfigInterface(d: HIDDevice, link: Link): boolean {
  return d.collections.some((c) =>
    link === 'wired'
      ? (c.featureReports ?? []).some((r) => r.reportId === p.WIRED_REPORT)
      : c.usagePage === 0xff02 && (c.outputReports ?? []).some((r) => r.reportId === p.REPORT_ID),
  );
}

const ORDER: Link[] = ['wired', 'receiver', 'bluetooth'];

/** Best granted interface: cable, then 2.4G receiver, then Bluetooth (view only). */
export function pick(devices: HIDDevice[]): { dev: HIDDevice; link: Link } | null {
  const found = devices
    .map((dev) => ({ dev, link: linkOf(dev) }))
    .filter((x): x is { dev: HIDDevice; link: Link } => x.link !== null && isConfigInterface(x.dev, x.link));
  found.sort((a, b) => ORDER.indexOf(a.link) - ORDER.indexOf(b.link));
  return found[0] ?? null;
}

export class F75 {
  readonly cmds: p.Cmds;
  /** Raw packet trace (null = off). */
  trace: string[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private inbox: Uint8Array[] = [];
  private waiter: (() => void) | null = null;
  /** The keyboard's own brightness is held at 9 while we stream, so frames are only dimmed once. */
  private held = false;

  constructor(
    readonly dev: HIDDevice,
    readonly link: Link,
  ) {
    this.cmds = p.cmds(link);
  }

  async open(): Promise<void> {
    if (!this.dev.opened) await this.dev.open();
    this.dev.addEventListener('inputreport', this.onReport);
  }

  async close(): Promise<void> {
    this.dev.removeEventListener('inputreport', this.onReport);
    try {
      if (this.dev.opened) await this.dev.close();
    } catch {
      /* already gone */
    }
  }

  /** Runs `job` after every job queued before it. */
  run<T>(job: () => Promise<T>): Promise<T> {
    const r = this.queue.then(job, job);
    this.queue = r.catch(() => undefined);
    return r;
  }

  private tr(line: string) {
    if (this.trace && this.trace.length < 600) this.trace.push(line);
  }

  // ------------------------------------------------------------ 2.4G receiver (CDev3632)

  /** Only report 0x13 is ours; keyboard/mouse reports on the same interface are skipped. */
  private onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== p.REPORT_ID) return;
    const pk = new Uint8Array(p.PACKET_LEN);
    pk[0] = e.reportId;
    pk.set(new Uint8Array(e.data.buffer, e.data.byteOffset, Math.min(e.data.byteLength, p.PACKET_LEN - 1)), 1);
    this.tr(`< ${p.hex(pk)}`);
    if (this.inbox.length < 256) this.inbox.push(pk);
    this.waiter?.();
  };

  private async send20(pk: Uint8Array) {
    this.tr(`> ${p.hex(pk)}`);
    await this.dev.sendReport(pk[0], pk.slice(1));
  }

  private async recv20(timeoutMs: number): Promise<[Uint8Array, p.Reply] | null> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const pk = this.inbox.shift();
      if (pk) {
        const r = p.parseReply(pk);
        if (r) return [pk, r];
        continue;
      }
      const left = deadline - performance.now();
      if (left <= 0) return null;
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        this.waiter = () => {
          clearTimeout(t);
          res();
        };
      });
      this.waiter = null;
    }
  }

  /** AccessData (0x004862f0): per-packet delay, then wait for the receiver's ack (retry ×5). */
  private async wirelessWrite(cmd: number, sub: number, data: Uint8Array, delayMs: number) {
    const wantsAck = (cmd & 0x80) === 0; // live frames are not acknowledged
    const packets = p.writePackets(cmd, sub, data);
    for (let i = 0; i < packets.length; i++) {
      for (let tries = 0; ; tries++) {
        await sleep(delayMs);
        this.inbox.length = 0;
        await this.send20(packets[i]);
        if (!wantsAck) break;
        let ack: p.Reply | null = null;
        for (let n = 0; n < 20; n++) {
          const got = await this.recv20(1000);
          if (!got) break;
          if (got[0][1] === cmd) {
            ack = got[1];
            break;
          }
        }
        if (ack && !ack.crcError && ack.index === i) break;
        if (ack && !ack.crcError) throw new DeviceError(`cmd 0x${cmd.toString(16)}: ack ${ack.index} for packet ${i}`);
        if (tries >= 4) throw new DeviceError('No reply from the keyboard (asleep or out of range?). Press a key and try again.');
      }
    }
  }

  /**
   * Multi-packet read. Chunks are placed by packet index and merged across retries (the radio
   * occasionally drops one); a read with gaps is never returned.
   */
  private async wirelessRead(cmd: number, sub: number, len: number): Promise<Uint8Array> {
    let out = new Uint8Array(Math.max(len, p.CHUNK));
    let got: boolean[] = [];
    let total = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(60);
      this.inbox.length = 0;
      await this.send20(p.readRequest(cmd, sub));
      for (;;) {
        const r = await this.recv20(500);
        if (!r) break;
        const [pk, reply] = r;
        if (reply.cmd !== (cmd & 0x7f)) continue;
        if (reply.crcError) break;
        if (total === 0) {
          total = Math.max(reply.total, 1);
          got = new Array(total).fill(false);
        }
        const i = reply.index;
        if (i >= total || reply.total !== total) continue;
        const off = i * p.CHUNK;
        if (out.length < off + reply.len) {
          const grown = new Uint8Array(off + reply.len);
          grown.set(out);
          out = grown;
        }
        out.set(pk.subarray(5, 5 + reply.len), off);
        got[i] = true;
        if (got.every(Boolean)) return out.slice(0, len);
      }
    }
    throw new DeviceError(
      `Incomplete reply to 0x${cmd.toString(16)}: is the keyboard asleep or out of range? Press a key and try again.`,
    );
  }

  // ------------------------------------------------------------ USB-C cable (CDevG5KB)

  private async wiredSend(pk: Uint8Array) {
    this.tr(`> ${p.hex(pk.subarray(0, 24))} ... (${p.WIRED_LEN} bytes)`);
    let err: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.dev.sendFeatureReport(pk[0], pk.slice(1));
        return;
      } catch (e) {
        err = e;
      }
      await sleep(70);
    }
    throw new DeviceError(`Feature report failed: ${err}`);
  }

  private async wiredWrite(cmd: number, sub: number, data: Uint8Array, delayMs: number) {
    for (const pk of p.wiredPackets(cmd, sub, data.length, data)) {
      await sleep(delayMs);
      await this.wiredSend(pk);
    }
  }

  /** Header via SetFeature, wait 20 ms, GetFeature returns the payload at byte 8 (0x0048bc00). */
  private async wiredRead(cmd: number, sub: number, len: number): Promise<Uint8Array> {
    const out = new Uint8Array(len);
    let at = 0;
    for (const pk of p.wiredPackets(cmd, sub, len)) {
      const size = pk[6] | (pk[7] << 8);
      await sleep(20);
      await this.wiredSend(pk);
      await sleep(20);
      const dv = await this.dev.receiveFeatureReport(p.WIRED_REPORT);
      let buf = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      // Chrome returns the report id as the first byte; be tolerant of hosts that strip it
      if (buf.length !== p.WIRED_LEN && (buf.length === p.WIRED_LEN - 1 || buf[0] !== p.WIRED_REPORT)) {
        const withId = new Uint8Array(buf.length + 1);
        withId[0] = p.WIRED_REPORT;
        withId.set(buf, 1);
        buf = withId;
      }
      this.tr(`< ${p.hex(buf.subarray(0, 24))} ... (${buf.length} bytes)`);
      if (buf.length < 8 + size) throw new DeviceError(`Short reply over the cable (${buf.length} bytes)`);
      out.set(buf.subarray(8, 8 + size), at);
      at += size;
    }
    return out;
  }

  // ------------------------------------------------------------ shared (call inside run())

  private async write(cmd: number, sub: number, data: Uint8Array, delayMs: number) {
    if (this.link === 'bluetooth') throw new DeviceError(BT_UNSUPPORTED);
    if (this.link === 'wired') await this.wiredWrite(cmd, sub, data, Math.min(delayMs, 20));
    else await this.wirelessWrite(cmd, sub, data, delayMs);
  }

  private async read(cmd: number, sub: number, len: number): Promise<Uint8Array> {
    if (this.link === 'bluetooth') throw new DeviceError(BT_UNSUPPORTED);
    const rc = cmd | this.cmds.readFlag;
    return this.link === 'wired' ? this.wiredRead(rc, sub, len) : this.wirelessRead(rc, sub, len);
  }

  private async ledBlock(): Promise<Uint8Array> {
    const b = await this.read(this.cmds.led, 0, p.LED_BLOCK_LEN);
    if (!p.ledBlockValid(b)) throw new DeviceError('LED block signature 5A A5 missing; nothing was written.');
    return b;
  }

  /** Read-modify-write of the 128-byte LED block, like OemDrv. */
  private async editBlock(f: (b: Uint8Array) => void) {
    const b = await this.ledBlock();
    f(b);
    await this.write(this.cmds.led, 0, b, 15);
  }

  private effect(mode: number, brightness: number, speed: number, colour: number) {
    return this.editBlock((b) => p.editLedBlock(b, mode, brightness, speed, colour));
  }

  // ------------------------------------------------------------ public jobs

  /** 2.4G: is the keyboard linked to the receiver (m_bOnline). Cable/Bluetooth: always true. */
  online(): Promise<boolean> {
    return this.run(async () => (this.link === 'receiver' ? (await this.wirelessRead(p.WIRELESS_ONLINE, 0, 1))[0] !== 0 : true));
  }

  getLedBlock(): Promise<Uint8Array> {
    return this.run(() => this.ledBlock());
  }

  setEffect(mode: number, brightness: number, speed: number, colour: number): Promise<void> {
    return this.run(async () => {
      this.held = false;
      await this.effect(mode, brightness, speed, colour);
    });
  }

  /** Seconds from protocol.SLEEP (0 = never). */
  setSleep(seconds: number): Promise<void> {
    const hw = p.SLEEP.find((s) => s[0] === seconds)?.[1] ?? 2;
    return this.run(() => this.editBlock((b) => (b[p.SLEEP_OFFSET] = hw)));
  }

  setPerKey(colours: Colours, brightness: number): Promise<void> {
    return this.run(async () => {
      this.held = false;
      await this.write(this.cmds.ledMatrix, 0, p.matrixPayload(colours), 15);
      await this.effect(p.CUSTOM_MODE, brightness, 0, 0);
    });
  }

  /**
   * Live frame, not acknowledged. Vendor pacing: 10 ms per packet on 2.4G (0x00487330), 7 ms wired
   * (0x0048c6e0). The first frame switches the keyboard to per-key mode at full brightness.
   */
  frame(colours: Colours): Promise<void> {
    return this.run(async () => {
      if (!this.held) {
        await this.effect(p.CUSTOM_MODE, 9, 0, 0);
        this.held = true;
      }
      await this.write(this.cmds.realtime, 0, p.realtimePayload(colours), this.link === 'wired' ? 7 : 10);
    });
  }

  /**
   * Per-key colours stored on the keyboard (read form of ledMatrix). The vendor app never reads
   * them back, so this is unverified on hardware; callers treat a failure as "unknown".
   */
  getPerKey(): Promise<Colours> {
    return this.run(async () => p.matrixColours(await this.read(this.cmds.ledMatrix, 0, p.MATRIX_LEN * 3)));
  }

  getKeymap(layer: number): Promise<Uint8Array> {
    return this.run(() => this.read(this.cmds.keymap, layer, p.KEYMAP_LEN));
  }

  setKeymap(layer: number, data: Uint8Array): Promise<void> {
    return this.run(() => this.write(this.cmds.keymap, layer, data, 15));
  }

  /**
   * Key matrix then macro area, like OemDrv ApplySetting. 2.4G: 512-byte pages, sub = page,
   * 100 ms apart (0x004868a0); cable: one transfer (0x0048b960).
   */
  setKeymapAndMacros(km: Uint8Array, buf: Uint8Array): Promise<void> {
    return this.run(async () => {
      await this.write(this.cmds.keymap, 0, km, 15);
      if (!buf.length) return;
      await sleep(100);
      if (this.link === 'wired') return this.write(this.cmds.macros, 0, buf, 20);
      for (let page = 0; page * 0x200 < buf.length; page++) {
        await this.write(this.cmds.macros, page, buf.subarray(page * 0x200, (page + 1) * 0x200), 15);
        await sleep(100);
      }
    });
  }
}
