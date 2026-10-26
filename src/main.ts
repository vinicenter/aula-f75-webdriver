import './style.css';
import { Controller, sleepLabel, supported } from './controller';
import { AUDIO, PALETTES, STUDIO, presetGradient, presetRainbow, presetSolid, type Fx } from './fx';
import { KeyboardView } from './keyboard-view';
import { KEYS } from './layout';
import { unsupportedChars } from './macros';
import * as P from './profiles';
import * as p from './protocol';
import type { Colours, Link, RGB } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

const KEY_LABEL = new Map(KEYS.map((k) => [k.led, k.label || 'Space']));
const toHex = (c: RGB) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const press = (els: HTMLElement[], on: (el: HTMLElement) => boolean) =>
  els.forEach((el) => el.setAttribute('aria-pressed', String(on(el))));

// ---------------------------------------------------------------- state

let prof = P.active();
let tab = 'light';
let tool: 'paint' | 'pick' = 'paint';
let link: Link | null = null;
let online = true;
let liveFrame: Colours | null = null;
let layer = 0;
const keymaps: ({ codes: Uint8Array; backup: Uint8Array } | null)[] = [null, null];
let selectedKey: number | null = null;
let macroPick: number | null = null; // index of the macro waiting for a key click
let audioSrc: 'screen' | 'mic' = 'screen';
let perKeyTimer = 0;
/** Local lighting edits not yet sent: background reads must not overwrite them. */
let dirty = false;

const save = () => P.save(prof);

// ---------------------------------------------------------------- keyboard view

const view = new KeyboardView($<HTMLElement>('#kb') as unknown as SVGSVGElement, {
  down(led) {
    if (tab === 'light' && prof.mode === p.CUSTOM_MODE) {
      if (tool === 'pick') {
        prof.brush = [...prof.colours[led]];
        tool = 'paint';
        save();
        renderLight();
      } else paint(led);
    } else if (tab === 'keys') {
      selectedKey = led;
      renderKeys();
    } else if (tab === 'macros' && macroPick !== null) {
      const taken = prof.macros.findIndex((m, i) => m.led === led && i !== macroPick);
      if (taken >= 0) return toast(`That key already has the macro "${prof.macros[taken].name}"`, true);
      if (led === 53) return toast("The Fn key can't hold a macro", true);
      prof.macros[macroPick].led = led;
      macroPick = null;
      save();
      renderMacros();
    }
  },
  drag(led) {
    if (tab === 'light' && prof.mode === p.CUSTOM_MODE && tool === 'paint') paint(led);
  },
  up() {
    if (tab === 'light' && prof.mode === p.CUSTOM_MODE && tool === 'paint') schedulePerKey();
  },
});

function paint(led: number) {
  dirty = true;
  prof.colours[led] = [...prof.brush];
  view.setColours(prof.colours);
}

/** Per-key colours go to the keyboard shortly after the last stroke. */
function schedulePerKey() {
  dirty = true;
  save();
  clearTimeout(perKeyTimer);
  perKeyTimer = window.setTimeout(() => {
    dirty = false;
    if (link && link !== 'bluetooth') {
      ctl.stopLive();
      void ctl.lighting(prof);
    }
  }, 350);
}

function renderBoard() {
  if (liveFrame) {
    view.setMode('live');
    view.setColours(liveFrame);
    view.setLabels(null);
    view.setSelected(new Set());
    $('#hint').textContent = 'Live effect running';
    return;
  }
  if (tab === 'keys') {
    view.setMode('select');
    view.setColours(null);
    const km = keymaps[layer];
    if (km) {
      const labels = new Map<number, string>();
      const changed = new Set<number>();
      for (const k of KEYS) {
        const code = p.codeAt(km.codes, k.led);
        labels.set(k.led, code.every((x) => x === 0) ? '·' : p.describeCode(code));
        if (!p.sameCode(code, p.codeAt(km.backup, k.led))) changed.add(k.led);
      }
      view.setLabels(labels, changed);
    } else view.setLabels(null);
    view.setSelected(new Set(selectedKey === null ? [] : [selectedKey]));
    $('#hint').textContent = layer ? 'Fn layer: what keys do while Fn is held' : 'Base layer';
    return;
  }
  if (tab === 'macros') {
    view.setMode(macroPick !== null ? 'select' : 'view');
    view.setColours(null);
    view.setLabels(new Map(prof.macros.map((m, i) => [m.led, `M${i + 1}`])));
    view.setSelected(new Set(prof.macros.map((m) => m.led)));
    $('#hint').textContent = macroPick !== null ? 'Click the key that will trigger the macro' : '';
    return;
  }
  view.setLabels(null);
  view.setSelected(new Set());
  if (prof.mode === p.CUSTOM_MODE) {
    view.setMode('paint');
    view.setColours(prof.colours);
    $('#hint').textContent = tool === 'pick' ? 'Click a key to copy its color' : 'Click or drag to paint';
  } else {
    view.setMode('view');
    const eff = p.EFFECTS.find((e) => e.id === prof.mode);
    if (!eff || prof.mode === 0) view.setColours(null);
    else if (prof.mode === p.FIXED_MODE && prof.solid) view.setColours(presetSolid(prof.solid));
    else if (prof.mode === 3 || !eff.colour || prof.colour === p.RANDOM_COLOUR) view.setColours(presetRainbow());
    else view.setColours(presetSolid(p.PALETTE[prof.colour]));
    $('#hint').textContent = eff && prof.mode ? `Keyboard effect: ${eff.name} (approximate preview)` : 'Lights off';
  }
}

// ---------------------------------------------------------------- lighting tab

const effectsEl = $('#effects');
for (const e of p.EFFECTS) {
  const b = document.createElement('button');
  b.textContent = e.name;
  b.dataset.mode = String(e.id);
  b.onclick = () => {
    prof.mode = e.id;
    save();
    renderLight();
    sendLighting();
  };
  effectsEl.append(b);
}

const coloursEl = $('#colours');
[...p.PALETTE, null].forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.colour = String(i);
  b.title = c ? ['Red', 'Green', 'Blue', 'Yellow', 'Magenta', 'Cyan', 'White'][i] : 'Random';
  b.style.background = c ? toHex(c) : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)';
  b.onclick = () => {
    prof.colour = i;
    prof.solid = null;
    save();
    renderLight();
    sendLighting();
  };
  coloursEl.insertBefore(b, $('#fixed-rgb-field'));
});

// Fixo with any RGB colour (sent as per-key mode, see controller writeLighting)
const fixedRgb = $<HTMLInputElement>('#fixed-rgb');
fixedRgb.oninput = () => {
  dirty = true;
  prof.solid = fromHex(fixedRgb.value);
  renderLight();
};
fixedRgb.onchange = () => {
  prof.solid = fromHex(fixedRgb.value);
  save();
  renderLight();
  sendLighting();
};

const BRUSHES: RGB[] = [
  [255, 255, 255], [255, 0, 0], [255, 100, 0], [255, 220, 0], [57, 255, 106], [0, 220, 255], [0, 60, 255], [180, 0, 255], [255, 0, 140], [0, 0, 0],
];
const brushesEl = $('#brush-swatches');
for (const c of BRUSHES) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = toHex(c);
  b.title = c.every((x) => x === 0) ? 'Off' : toHex(c);
  b.onclick = () => {
    prof.brush = [...c];
    tool = 'paint';
    save();
    renderLight();
  };
  brushesEl.append(b);
}

$<HTMLInputElement>('#brush').oninput = (e) => {
  prof.brush = fromHex((e.target as HTMLInputElement).value);
  tool = 'paint';
  save();
  renderLight();
};
$$('#tool button').forEach(
  (b) =>
    (b.onclick = () => {
      tool = b.dataset.tool as typeof tool;
      renderLight();
    }),
);

$$('[data-preset]').forEach(
  (b) =>
    (b.onclick = () => {
      const k = b.dataset.preset;
      if (k === 'fill') prof.colours = presetSolid(prof.brush);
      if (k === 'rainbow') prof.colours = presetRainbow();
      if (k === 'gradient') prof.colours = presetGradient(prof.brush, [prof.brush[2], prof.brush[0], prof.brush[1]]);
      if (k === 'clear') prof.colours = presetSolid([0, 0, 0]);
      renderLight();
      schedulePerKey();
    }),
);

function bindRange(id: string, out: string, fmt: (v: number) => string, set: (v: number) => void, commit: () => void) {
  const el = $<HTMLInputElement>(id);
  el.oninput = () => {
    set(Number(el.value));
    $(out).textContent = fmt(Number(el.value));
  };
  el.onchange = commit;
}
// dragging a slider is a local edit until it is released (onchange sends it)
bindRange('#bright', '#bright-out', String, (v) => ((dirty = true), (prof.brightness = v)), () => (save(), sendLighting()));
bindRange('#pk-bright', '#pk-bright-out', String, (v) => ((dirty = true), (prof.brightness = v)), () => (save(), sendLighting()));
bindRange('#speed', '#speed-out', String, (v) => ((dirty = true), (prof.speed = v)), () => (save(), sendLighting()));

function sendLighting() {
  dirty = false;
  if (!link || link === 'bluetooth') return;
  ctl.stopLive();
  void ctl.lighting(prof);
}

function renderLight() {
  const eff = p.EFFECTS.find((e) => e.id === prof.mode) ?? p.EFFECTS[0];
  press($$('#effects button'), (b) => Number(b.dataset.mode) === prof.mode);
  const rgbFixed = prof.mode === p.FIXED_MODE && !!prof.solid;
  press($$('#colours button'), (b) => !rgbFixed && Number(b.dataset.colour) === prof.colour);
  $('#fixed-rgb-field').hidden = prof.mode !== p.FIXED_MODE;
  $('#fixed-rgb-field').setAttribute('aria-pressed', String(rgbFixed));
  const rgbEl = $('#fixed-rgb-field');
  if (prof.solid) $<HTMLInputElement>('#fixed-rgb').value = toHex(prof.solid);
  // the swatch shows the chosen colour, or a colour wheel with "+" until one is picked
  rgbEl.style.background = prof.solid ? toHex(prof.solid) : '';
  rgbEl.toggleAttribute('data-set', !!prof.solid);
  press($$('#tool button'), (b) => b.dataset.tool === tool);
  $<HTMLInputElement>('#bright').value = String(prof.brightness);
  $('#bright-out').textContent = String(prof.brightness);
  $<HTMLInputElement>('#pk-bright').value = String(prof.brightness);
  $('#pk-bright-out').textContent = String(prof.brightness);
  $<HTMLInputElement>('#speed').value = String(prof.speed);
  $('#speed-out').textContent = String(prof.speed);
  $('#bright').closest('.field')!.classList.toggle('disabled', !eff.brightness);
  $('#speed-field').classList.toggle('disabled', !eff.speed);
  $('#colour-field').classList.toggle('disabled', !eff.colour);
  // per-key mode shows the painting tools instead of the effect settings
  $('#perkey').hidden = prof.mode !== p.CUSTOM_MODE;
  $('#adjust').hidden = prof.mode === p.CUSTOM_MODE;
  $<HTMLInputElement>('#brush').value = toHex(prof.brush);
  renderBoard();
}

// ---------------------------------------------------------------- live tab

for (const [fx, name] of STUDIO) {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.fx = fx;
  b.onclick = () => {
    ctl.startFx(fx);
    renderLive();
  };
  $('#studio').append(b);
}
for (const [fx, name] of AUDIO) {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.fx = fx;
  b.onclick = async () => {
    await ctl.startAudio(audioSrc, fx as Fx);
    renderLive();
  };
  $('#audio-fx').append(b);
}
$$('#audio-src button').forEach(
  (b) =>
    (b.onclick = () => {
      audioSrc = b.dataset.src as typeof audioSrc;
      if (ctl.live.audio) ctl.stopLive(); // the new source is picked on the next start
      renderLive();
    }),
);
PALETTES.forEach(([name, pal], i) => {
  const b = document.createElement('button');
  b.dataset.palette = String(i);
  const bar = document.createElement('i');
  bar.style.background = `linear-gradient(90deg, ${pal.map(toHex).join(',')})`;
  b.append(bar, name);
  b.onclick = () => {
    prof.palette = i;
    ctl.live.palette = i;
    save();
    renderLive();
  };
  $('#palettes').append(b);
});
bindRange('#lspeed', '#lspeed-out', (v) => `${v.toFixed(1)}×`, (v) => (ctl.live.speed = v), () => {});
bindRange('#lbright', '#lbright-out', String, (v) => (ctl.live.brightness = v), () => {});
bindRange('#sens', '#sens-out', (v) => `${v.toFixed(1)}×`, (v) => (ctl.live.sensitivity = v), () => {});
$('#live-stop').onclick = () => {
  ctl.stopLive();
  renderLive();
};

function renderLive() {
  const l = ctl.live;
  press($$('#studio button'), (b) => !l.audio && l.fx === b.dataset.fx);
  press($$('#audio-fx button'), (b) => !!l.audio && l.audioFx === b.dataset.fx);
  press($$('#audio-src button'), (b) => b.dataset.src === audioSrc);
  press($$('#palettes button'), (b) => Number(b.dataset.palette) === l.palette);
  $('#lspeed-out').textContent = `${l.speed.toFixed(1)}×`;
  $('#lbright-out').textContent = String(l.brightness);
  $('#sens-out').textContent = `${l.sensitivity.toFixed(1)}×`;
  $<HTMLButtonElement>('#live-stop').disabled = !ctl.streaming();
}

const meter = $('#meter');
for (let i = 0; i < 21; i++) meter.append(document.createElement('i'));

// ---------------------------------------------------------------- keys tab

const targetEl = $<HTMLSelectElement>('#target');
{
  const groups = new Map<string, HTMLOptGroupElement>();
  p.TARGETS.forEach((t, i) => {
    let g = groups.get(t.group);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = t.group;
      groups.set(t.group, g);
      targetEl.append(g);
    }
    g.append(new Option(t.label, String(i)));
  });
}

$$('#layer button').forEach(
  (b) =>
    (b.onclick = () => {
      layer = Number(b.dataset.layer);
      renderKeys();
      if (!keymaps[layer]) loadKeys();
    }),
);

function loadKeys() {
  if (link && link !== 'bluetooth') void ctl.loadKeymap(layer);
}

/** Keeps the profile's layouts equal to what is on the keyboard (null = factory). */
function syncProfileKeymap(l: number) {
  const km = keymaps[l];
  if (!km) return;
  const same = km.codes.every((x, i) => x === km.backup[i]);
  // macro keys are owned by the macro list, not the layout
  prof.keymaps[l] = same ? null : km.codes.slice();
  save();
}

$('#remap').onclick = async () => {
  if (selectedKey === null) return;
  await ctl.remap(layer, selectedKey, p.TARGETS[Number(targetEl.value)].code);
  syncProfileKeymap(layer);
};
$('#unmap').onclick = async () => {
  const km = keymaps[layer];
  if (selectedKey === null || !km) return;
  await ctl.remap(layer, selectedKey, p.codeAt(km.backup, selectedKey));
  syncProfileKeymap(layer);
};
$('#restore').onclick = async () => {
  if (!confirm(`Restore the factory layout of the ${layer ? 'Fn' : 'base'} layer?`)) return;
  await ctl.restoreKeymap(layer);
  syncProfileKeymap(layer);
};
$('#reload-keys').onclick = () => {
  keymaps[layer] = null;
  ctl.forgetKeymaps();
  loadKeys();
  renderKeys();
};

function renderKeys() {
  press($$('#layer button'), (b) => Number(b.dataset.layer) === layer);
  const km = keymaps[layer];
  const can = !!km && selectedKey !== null && link !== null && link !== 'bluetooth';
  targetEl.disabled = !can;
  $<HTMLButtonElement>('#remap').disabled = !can;
  $<HTMLButtonElement>('#restore').disabled = !km;
  $<HTMLButtonElement>('#reload-keys').disabled = !link || link === 'bluetooth';
  const info = $('#key-info');
  if (!link) info.textContent = 'Connect the keyboard to read its current layout.';
  else if (link === 'bluetooth') info.textContent = "Bluetooth can't remap keys. Use the cable or the 2.4G receiver.";
  else if (!km) info.textContent = 'Reading the keyboard layout…';
  else if (selectedKey === null) info.textContent = 'Click a key in the drawing to choose what it does.';
  else {
    const code = p.codeAt(km.codes, selectedKey);
    const def = p.codeAt(km.backup, selectedKey);
    info.innerHTML = '';
    info.append('Key ', bold(KEY_LABEL.get(selectedKey)!), ' now does ', bold(p.describeCode(code)));
    if (!p.sameCode(code, def)) info.append(' (default: ', bold(p.describeCode(def)), ')');
    const idx = p.TARGETS.findIndex((t) => p.sameCode(t.code, code));
    if (idx >= 0) targetEl.value = String(idx);
    $<HTMLButtonElement>('#unmap').disabled = !can || p.sameCode(code, def);
  }
  if (selectedKey === null || !km) $<HTMLButtonElement>('#unmap').disabled = true;
  renderBoard();
}

function bold(s: string) {
  const b = document.createElement('b');
  b.textContent = s;
  return b;
}

// ---------------------------------------------------------------- macros tab

$('#macro-add').onclick = () => {
  prof.macros.push({ name: `Macro ${prof.macros.length + 1}`, text: '', led: -1 });
  macroPick = prof.macros.length - 1;
  save();
  renderMacros();
};
$('#macro-write').onclick = () => {
  const ready = prof.macros.filter((m) => m.led >= 0 && m.text);
  if (ready.length !== prof.macros.length) return toast('Each macro needs a key and some text', true);
  void ctl.writeMacros(prof.macros);
};

function renderMacros() {
  const list = $('#macro-list');
  list.innerHTML = '';
  if (!prof.macros.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No macros yet. Click "Add macro".';
    list.append(e);
  }
  prof.macros.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'macro';
    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.textContent = m.led >= 0 ? `Key: ${KEY_LABEL.get(m.led) ?? m.led}` : 'Choose key';
    pick.setAttribute('aria-pressed', String(macroPick === i));
    pick.onclick = () => {
      macroPick = macroPick === i ? null : i;
      renderMacros();
    };
    const name = document.createElement('input');
    name.type = 'text';
    name.value = m.name;
    name.maxLength = 30;
    name.placeholder = 'Name';
    name.oninput = () => {
      m.name = name.value;
      save();
    };
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.className = 'danger';
    del.onclick = () => {
      prof.macros.splice(i, 1);
      macroPick = null;
      save();
      renderMacros();
    };
    const text = document.createElement('textarea');
    text.value = m.text;
    text.placeholder = 'Text the keyboard will type';
    const warn = document.createElement('div');
    warn.className = 'warn';
    const check = () => {
      const bad = unsupportedChars(m.text);
      warn.textContent = bad.length ? `Will be skipped (not on the US layout): ${bad.join(' ')}` : '';
    };
    text.oninput = () => {
      m.text = text.value;
      check();
      save();
    };
    check();
    row.append(pick, name, del, text, warn);
    list.append(row);
  });
  renderBoard();
}

// ---------------------------------------------------------------- power tab

const sleepEl = $<HTMLSelectElement>('#sleep');
for (const [s] of p.SLEEP) sleepEl.append(new Option(sleepLabel(s), String(s)));
sleepEl.onchange = () => {
  prof.sleep = Number(sleepEl.value);
  save();
  if (link && link !== 'bluetooth') void ctl.setSleep(prof.sleep);
};

// ---------------------------------------------------------------- profiles

const profileEl = $<HTMLSelectElement>('#profile');

function renderProfiles() {
  profileEl.innerHTML = '';
  for (const n of P.list()) profileEl.append(new Option(n, n, false, n === prof.name));
}

function switchTo(next: P.Profile) {
  prof = next;
  save();
  ctl.live.palette = prof.palette;
  renderAll();
  if (link && link !== 'bluetooth') {
    ctl.stopLive();
    void ctl.applyProfile(prof);
  }
}

profileEl.onchange = () => {
  const next = P.load(profileEl.value);
  if (next) switchTo(next);
};

function askName(title: string, initial: string): string | null {
  const n = prompt(title, initial)?.trim();
  if (!n) return null;
  if (P.list().includes(n) && n !== prof.name) {
    toast('A profile with that name already exists', true);
    return null;
  }
  return n;
}

$$('[data-profile]').forEach(
  (b) =>
    (b.onclick = () => {
      (b.closest('details') as HTMLDetailsElement).open = false;
      switch (b.dataset.profile) {
        case 'new': {
          const n = askName('Name of the new profile', 'New profile');
          if (n) switchTo(P.newProfile(n));
          break;
        }
        case 'dup': {
          const n = askName('Name of the copy', `${prof.name} (copy)`);
          if (n) switchTo({ ...structuredClone(prof), name: n });
          break;
        }
        case 'rename': {
          const n = askName('New name', prof.name);
          if (n && n !== prof.name) {
            P.remove(prof.name);
            prof.name = n;
            save();
            renderProfiles();
          }
          break;
        }
        case 'delete': {
          if (P.list().length < 2) return toast("Can't delete the only profile", true);
          if (!confirm(`Delete the profile "${prof.name}"?`)) return;
          P.remove(prof.name);
          switchTo(P.load(P.list()[0])!);
          break;
        }
        case 'export': {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([P.exportJson(prof)], { type: 'application/json' }));
          a.download = `aula-75-${prof.name.replace(/[^\w-]+/g, '_')}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          break;
        }
        case 'import':
          $('#import-file').click();
          break;
        case 'apply':
          if (!link || link === 'bluetooth') return toast('Connect the keyboard with the cable or the 2.4G receiver', true);
          ctl.stopLive();
          void ctl.applyProfile(prof);
          break;
      }
    }),
);

$<HTMLInputElement>('#import-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const imported = P.importJson(await file.text());
    let name = imported.name;
    for (let i = 2; P.list().includes(name); i++) name = `${imported.name} (${i})`;
    switchTo({ ...imported, name });
    toast(`Profile "${name}" imported`);
  } catch (err) {
    toast(`Could not import: ${(err as Error).message}`, true);
  }
};

// close the profile menu on outside click
document.addEventListener('click', (e) => {
  const d = $<HTMLDetailsElement>('details.menu');
  if (d.open && !d.contains(e.target as Node)) d.open = false;
});

// ---------------------------------------------------------------- tabs, status, toasts

$$('[role=tab]').forEach(
  (b) =>
    (b.onclick = () => {
      tab = b.dataset.tab!;
      macroPick = null;
      $$('[role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      $$('[data-panel]').forEach((s) => (s.hidden = s.dataset.panel !== tab));
      if (tab === 'keys' && !keymaps[layer]) loadKeys();
      if (tab === 'keys' || tab === 'macros') {
        // macros are written into the base layer; read it first so the "changed" marks are right
        if (!keymaps[0]) loadKeys();
      }
      renderAll();
    }),
);

let toastTimer = 0;
function toast(text: string, error = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.textContent = ''), error ? 7000 : 2800);
}

function renderStatus() {
  const s = $('#status');
  s.className = 'pill';
  if (!link) s.textContent = 'Disconnected';
  else if (link === 'receiver' && !online) {
    s.textContent = '2.4G: keyboard asleep';
    s.classList.add('warn');
  } else if (link === 'bluetooth') {
    s.textContent = 'Bluetooth (view only)';
    s.classList.add('warn');
  } else {
    s.textContent = `Connected via ${p.LINK_NAME[link]}`;
    s.classList.add('ok');
  }
  $('#connect').textContent = link ? 'Switch keyboard' : 'Connect keyboard';
  document.body.classList.toggle('wired', link === 'wired');
}

function renderAll() {
  renderProfiles();
  renderLight();
  renderLive();
  renderKeys();
  renderMacros();
  sleepEl.value = String(prof.sleep);
  renderStatus();
  renderBoard();
}

// ---------------------------------------------------------------- controller

const ctl = new Controller(
  {
    link(l, message) {
      link = l;
      online = true;
      keymaps[0] = keymaps[1] = null;
      if (message) toast(message, true);
      else if (l) toast(`Keyboard connected via ${p.LINK_NAME[l]}`);
      if (l && l !== 'bluetooth' && (tab === 'keys' || tab === 'macros')) loadKeys();
      renderAll();
    },
    online(o) {
      online = o;
      renderStatus();
    },
    block(b) {
      // what the keyboard shows right now becomes the profile's lighting (Fn shortcuts included)
      if (dirty) return;
      const solid = prof.mode === p.FIXED_MODE && prof.solid ? presetSolid(prof.solid) : null;
      if (solid && b.mode === p.CUSTOM_MODE && b.colours && b.colours.every((c, i) => c.every((x, k) => x === solid[i][k]))) {
        if (prof.brightness === b.brightness && prof.sleep === b.sleep) return;
        prof.brightness = b.brightness;
        prof.sleep = b.sleep;
        save();
        renderLight();
        sleepEl.value = String(prof.sleep);
        return;
      }
      const coloursChanged = !!b.colours && b.colours.some((c, i) => c.some((x, k) => x !== prof.colours[i][k]));
      if (
        !coloursChanged &&
        !solid &&
        prof.mode === b.mode &&
        prof.brightness === b.brightness &&
        prof.speed === b.speed &&
        prof.colour === b.colour &&
        prof.sleep === b.sleep
      )
        return;
      if (b.mode === p.FIXED_MODE) prof.solid = null; // the keyboard shows a palette colour
      prof.mode = b.mode;
      prof.brightness = b.brightness;
      prof.speed = b.speed;
      prof.colour = b.colour;
      prof.sleep = b.sleep;
      if (b.colours) prof.colours = b.colours;
      save();
      renderLight();
      sleepEl.value = String(prof.sleep);
    },
    keymap(l, codes, backup) {
      keymaps[l] = { codes, backup };
      if (tab === 'keys') renderKeys();
      else renderBoard();
    },
    busy(b) {
      $('#busy').hidden = !b;
    },
    done(m) {
      toast(m);
    },
    error(m) {
      toast(m, true);
      renderLive();
    },
    frame(c, bands) {
      liveFrame = c;
      meter.hidden = !bands;
      if (bands) [...meter.children].forEach((el, i) => ((el as HTMLElement).style.height = `${Math.max(bands[i], 0.03) * 100}%`));
      renderBoard();
      if (!c) renderLive();
    },
  },
  () => prof,
);
ctl.live.palette = prof.palette;

$('#connect').onclick = async () => {
  try {
    await ctl.request();
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') toast(`Could not connect: ${(e as Error).message}`, true);
  }
};

if (!supported()) {
  $('#unsupported').hidden = false;
  $<HTMLButtonElement>('#connect').disabled = true;
}

renderAll();
void ctl.init();
