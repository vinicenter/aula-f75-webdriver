// Connection, keyboard jobs and live streaming, ported from aula-f75-linux-concept/src/worker.rs.
import { Audio, silence, type Source } from './audio';
import { DeviceError, F75, FILTERS, pick } from './device';
import { Engine, PALETTES, dim, presetSolid, type Fx } from './fx';
import { buffer, macroKeyCode, textEvents } from './macros';
import * as p from './protocol';
import { keymapBackup, type MacroDef, type Profile } from './profiles';
import type { Colours, Link } from './protocol';

export interface Events {
  /** Connection changed (null = no keyboard). */
  link(link: Link | null, message?: string): void;
  online(online: boolean): void;
  /** Lighting read from the keyboard, on connect and then periodically; only sent when it changed. */
  block(b: Lighting): void;
  keymap(layer: number, codes: Uint8Array, backup: Uint8Array): void;
  busy(busy: boolean): void;
  done(message: string): void;
  error(message: string): void;
  /** Streamed frame (null = streaming stopped) and audio bands. */
  frame(c: Colours | null, bands: number[] | null): void;
}

/** LED settings plus, in per-key mode, the colours stored on the keyboard (null = could not read). */
export type Lighting = p.BlockEffect & { sleep: number; colours: Colours | null };

/** What is streamed live (USB-C only). */
export interface Live {
  fx: Fx | null;
  audio: Audio | null;
  audioFx: Fx;
  palette: number;
  speed: number;
  sensitivity: number;
  brightness: number; // 0..9, applied to streamed frames
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const supported = () => 'hid' in navigator;

export class Controller {
  kb: F75 | null = null;
  live: Live = { fx: null, audio: null, audioFx: 'spectrum', palette: 0, speed: 1, sensitivity: 1, brightness: 9 };
  private keymaps = new Map<number, Uint8Array>();
  private backups = new Map<number, Uint8Array>();
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private streamingLoop = false;
  /** Bumped by every lighting write, so a read that started before it is thrown away. */
  private gen = 0;
  private refreshing = false;
  private lastRead = '';
  private lastRadioRefresh = 0;

  constructor(
    private ev: Events,
    private profile: () => Profile,
  ) {}

  /** Reconnects to a keyboard granted on an earlier visit and follows hotplug. */
  async init() {
    if (!supported()) return;
    navigator.hid.addEventListener('connect', () => void this.attachBest());
    navigator.hid.addEventListener('disconnect', (e) => {
      if (e.device !== this.kb?.dev) return;
      this.drop('Keyboard disconnected');
      void this.attachBest();
    });
    await this.attachBest();
    setInterval(() => void this.pollOnline(), 20_000);
    // cable reads are cheap: follow changes made with the keyboard's own Fn shortcuts
    setInterval(() => {
      if (this.kb?.link === 'wired' && !document.hidden) this.refresh();
    }, 2000);
    // 2.4G: radio traffic can make the computer repeat keys, so only read when the page comes back
    const back = () => {
      if (document.hidden || this.kb?.link !== 'receiver') return;
      if (performance.now() - this.lastRadioRefresh < 5000) return;
      this.lastRadioRefresh = performance.now();
      this.refresh();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
  }

  /** Browser chooser: the user picks the keyboard once, later visits reconnect by themselves. */
  async request() {
    const chosen = await navigator.hid.requestDevice({ filters: FILTERS });
    if (!chosen.length) return;
    await this.attachBest(true);
  }

  private async attachBest(force = false) {
    const best = pick(await navigator.hid.getDevices());
    if (!best) return;
    if (this.kb && !force) {
      // switch only to a preferred link (cable > 2.4G > Bluetooth)
      const order: Link[] = ['wired', 'receiver', 'bluetooth'];
      if (this.kb.dev === best.dev || order.indexOf(best.link) >= order.indexOf(this.kb.link)) return;
    }
    if (this.kb) {
      const old = this.kb;
      this.drop();
      await old.close();
    }
    const kb = new F75(best.dev, best.link);
    try {
      await kb.open();
    } catch (e) {
      this.ev.error(`Could not open the keyboard: ${msg(e)}`);
      return;
    }
    this.kb = kb;
    this.ev.link(kb.link);
    if (kb.link === 'bluetooth') return;
    await this.job(async () => {
      const online = await kb.online();
      this.ev.online(online);
      if (online && !this.streaming()) await this.readLighting(kb, this.gen);
    });
  }

  /** Reads the LED block (and per-key colours in per-key mode) and reports it if it changed. */
  private async readLighting(kb: F75, gen: number) {
    const b = await kb.getLedBlock();
    const e = p.effectFromBlock(b);
    if (!e) return;
    const colours = e.mode === p.CUSTOM_MODE ? await kb.getPerKey().catch(() => null) : null;
    // a write queued meanwhile, a new connection or a live effect make this read stale
    if (gen !== this.gen || kb !== this.kb || this.streaming()) return;
    const l: Lighting = { ...e, sleep: p.sleepFromBlock(b), colours };
    const key = JSON.stringify(l);
    if (key === this.lastRead) return;
    this.lastRead = key;
    this.ev.block(l);
  }

  /** Silent background read: no busy indicator, errors ignored (asleep or unplugged: next try). */
  refresh() {
    const kb = this.kb;
    if (!kb || kb.link === 'bluetooth' || this.streaming() || this.pending || this.refreshing) return;
    this.refreshing = true;
    const gen = this.gen;
    this.chain = this.chain.then(async () => {
      try {
        await this.readLighting(kb, gen);
      } catch {
        /* ignore */
      } finally {
        this.refreshing = false;
      }
    });
  }

  private drop(message?: string) {
    this.kb = null;
    this.lastRead = '';
    this.keymaps.clear();
    this.backups.clear();
    this.stopAudio();
    this.live.fx = null;
    this.ev.link(null, message);
  }

  private async pollOnline() {
    // radio traffic can swallow key releases on 2.4G (auto-repeat), so ask rarely
    if (this.kb?.link !== 'receiver' || this.pending) return;
    try {
      this.ev.online(await this.kb.online());
    } catch {
      this.ev.online(false);
    }
  }

  /** Runs keyboard jobs one after another; failures become an error message. */
  job(f: () => Promise<string | void>): Promise<void> {
    this.pending++;
    this.ev.busy(true);
    const r = this.chain.then(async () => {
      try {
        if (!this.kb) throw new DeviceError('No keyboard connected.');
        const m = await f();
        if (m) this.ev.done(m);
      } catch (e) {
        this.ev.error(msg(e));
      } finally {
        if (--this.pending === 0) this.ev.busy(false);
      }
    });
    this.chain = r;
    return r;
  }

  private get dev(): F75 {
    if (!this.kb) throw new DeviceError('No keyboard connected.');
    return this.kb;
  }

  get wired() {
    return this.kb?.link === 'wired';
  }

  // ------------------------------------------------------------ lighting

  lighting(pr: Profile) {
    this.gen++;
    return this.job(() => writeLighting(this.dev, pr));
  }

  setSleep(s: number) {
    this.gen++;
    return this.job(async () => {
      await this.dev.setSleep(s);
      return s === 0 ? 'Sleep disabled: lights stay on' : `Sleep after ${sleepLabel(s)}`;
    });
  }

  // ------------------------------------------------------------ keymaps

  private async keymap(layer: number): Promise<Uint8Array> {
    const cached = this.keymaps.get(layer);
    if (cached) return cached.slice();
    const km = await this.dev.getKeymap(layer);
    let backup = keymapBackup(layer, km);
    // the factory base layer is known key for key; use it when no good read was ever saved
    if (layer === 0 && !p.keymapEncodingOk(backup)) backup = p.factoryLayer0();
    this.keymaps.set(layer, km);
    this.backups.set(layer, backup);
    return km.slice();
  }

  private sendKeymap(layer: number) {
    const k = this.keymaps.get(layer);
    const b = this.backups.get(layer);
    if (k && b) this.ev.keymap(layer, k, b);
  }

  private async guard() {
    await this.keymap(0);
    if (!p.keymapEncodingOk(this.backups.get(0)!)) {
      throw new DeviceError('Unexpected key encoding on this keyboard: remapping disabled to be safe.');
    }
  }

  /** Next keymap use reads the keyboard again. */
  forgetKeymaps() {
    this.keymaps.clear();
  }

  loadKeymap(layer: number) {
    return this.job(async () => {
      await this.keymap(layer);
      this.sendKeymap(layer);
    });
  }

  remap(layer: number, led: number, code: p.Code) {
    return this.job(async () => {
      await this.guard();
      const km = await this.keymap(layer);
      km.set(code, led * 4);
      await this.dev.setKeymap(layer, km);
      this.keymaps.set(layer, km);
      this.sendKeymap(layer);
      return `Key remapped to ${p.describeCode(code)}`;
    });
  }

  restoreKeymap(layer: number) {
    return this.job(async () => {
      await this.keymap(layer);
      const b = this.backups.get(layer)!.slice();
      await this.dev.setKeymap(layer, b);
      this.keymaps.set(layer, b);
      this.sendKeymap(layer);
      return 'Default layout restored';
    });
  }

  /** Keys holding a macro code that is no longer assigned go back to their factory code. */
  private withMacros(km: Uint8Array, defs: MacroDef[]) {
    const backup = this.backups.get(0)!;
    for (let led = 0; led < p.MATRIX_LEN; led++) {
      if (km[led * 4] === 3) km.set(backup.subarray(led * 4, led * 4 + 4), led * 4);
    }
    defs.forEach((d, i) => km.set(macroKeyCode(i, 1), d.led * 4));
  }

  writeMacros(all: MacroDef[]) {
    const defs = usable(all);
    return this.job(async () => {
      if (!this.wired) throw new DeviceError('Macros need the USB-C cable.');
      await this.guard();
      const km = await this.keymap(0);
      this.withMacros(km, defs);
      // same order as OemDrv ApplySetting: key matrix first, then the macro area
      await this.dev.setKeymapAndMacros(km, macroBuffer(defs));
      this.keymaps.set(0, km);
      this.sendKeymap(0);
      return defs.length ? `${defs.length} macro(s) saved to the keyboard` : 'Macros removed';
    });
  }

  applyProfile(pr: Profile) {
    const macros = usable(pr.macros);
    this.gen++;
    return this.job(async () => {
      const kb = this.dev;
      await writeLighting(kb, pr);
      await kb.setSleep(pr.sleep);
      // key layouts (missing = factory) + macros; skipped if the layout read looks wrong.
      // Macros only take over the cable: on 2.4G the macro keys are left as they are.
      try {
        await this.guard();
      } catch {
        return `Profile "${pr.name}" applied (without key layout)`;
      }
      for (const layer of [0, 1]) {
        const current = await this.keymap(layer);
        const want = (pr.keymaps[layer] ?? this.backups.get(layer)!).slice();
        if (layer === 0) {
          if (this.wired) this.withMacros(want, macros);
          else for (const m of macros) want.set(current.subarray(m.led * 4, m.led * 4 + 4), m.led * 4);
        }
        if (!sameBytes(current, want)) {
          if (layer === 0 && this.wired && macros.length) await kb.setKeymapAndMacros(want, macroBuffer(macros));
          else await kb.setKeymap(layer, want);
          this.keymaps.set(layer, want);
        }
        this.sendKeymap(layer);
      }
      return `Profile "${pr.name}" applied`;
    });
  }

  // ------------------------------------------------------------ live streaming (USB-C)

  streaming() {
    return this.live.fx !== null || this.live.audio !== null;
  }

  startFx(fx: Fx) {
    if (!this.wired) return this.ev.error('Live effects need the USB-C cable.');
    this.stopAudio();
    this.live.fx = fx;
    void this.loop();
  }

  async startAudio(source: Source, fx: Fx) {
    if (!this.wired) return this.ev.error('Audio sync needs the USB-C cable.');
    this.live.audioFx = fx;
    if (!this.live.audio) {
      try {
        const a = await Audio.start(source);
        a.onEnded = () => this.stopLive();
        this.live.audio = a;
      } catch (e) {
        return this.ev.error(`Audio capture cancelled: ${msg(e)}`);
      }
    }
    this.live.fx = null;
    void this.loop();
  }

  private stopAudio() {
    this.live.audio?.stop();
    this.live.audio = null;
  }

  /** Stops streaming and puts the profile's own lighting back. */
  stopLive() {
    const was = this.streaming();
    this.live.fx = null;
    this.stopAudio();
    if (was && this.kb) void this.lighting(this.profile());
  }

  private async loop() {
    if (this.streamingLoop) return;
    this.streamingLoop = true;
    const engine = new Engine();
    const t0 = performance.now();
    while (this.streaming() && this.wired) {
      const start = performance.now();
      const l = this.live;
      const snap = l.audio ? l.audio.snapshot(l.sensitivity) : silence();
      const fx = l.audio ? l.audioFx : l.fx!;
      const c = engine.frame(fx, PALETTES[l.palette % PALETTES.length][1], (start - t0) / 1000, l.speed, snap);
      this.ev.frame(c, l.audio ? snap.bands : null);
      try {
        // queued keyboard jobs go first; frames wait their turn
        if (!this.pending) await this.dev.frame(dim(c, l.brightness));
      } catch (e) {
        this.ev.error(msg(e));
        this.live.fx = null;
        this.stopAudio();
        break;
      }
      await sleep(Math.max(0, 20 - (performance.now() - start))); // ~50 fps
    }
    this.streamingLoop = false;
    this.ev.frame(null, null);
  }
}

/**
 * The profile's lighting on the keyboard. Fixo with a free RGB colour has no hardware form (the
 * effect only takes a palette colour), so it goes out as per-key mode with every key that colour.
 */
async function writeLighting(kb: F75, pr: Profile): Promise<string> {
  if (pr.mode === p.FIXED_MODE && pr.solid) {
    await kb.setPerKey(presetSolid(pr.solid), pr.brightness);
    return 'Fixed color saved to the keyboard';
  }
  if (pr.mode === p.CUSTOM_MODE) {
    await kb.setPerKey(pr.colours, pr.brightness);
    return 'Per-key colors saved to the keyboard';
  }
  await kb.setEffect(pr.mode, pr.brightness, pr.speed, pr.colour);
  return 'Lighting updated';
}

/** Macros that can go to the keyboard: bound to a key and not empty. */
const usable = (defs: MacroDef[]) => defs.filter((d) => d.led >= 0 && d.led < p.MATRIX_LEN && d.text);

export function macroBuffer(defs: MacroDef[]): Uint8Array {
  return buffer(defs.map((d) => ({ name: d.name, events: textEvents(d.text, 12) })));
}

export function sleepLabel(s: number): string {
  if (s === 0) return 'Never';
  if (s % 60 === 0) return `${s / 60} min`;
  return `${(s / 60).toFixed(1)} min`;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function msg(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') return 'permission denied by the browser';
  return e instanceof Error ? e.message : String(e);
}
