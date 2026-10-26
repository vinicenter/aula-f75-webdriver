// The F75 drawn from the KB.ini key rectangles, in its current colours. Click or drag over keys.
import { KEYS } from './layout';
import type { Colours, RGB } from './protocol';

const NS = 'http://www.w3.org/2000/svg';

export interface ViewHandlers {
  /** Pointer pressed on a key (start of a click or a drag). */
  down(led: number): void;
  /** Pointer dragged onto another key while pressed. */
  drag(led: number): void;
  up(): void;
}

const ARROWS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→' };

export class KeyboardView {
  private keys = new Map<number, { g: SVGGElement; rect: SVGRectElement; text: SVGTextElement; label: string }>();
  private pressed = false;
  private last = -1;

  constructor(
    private svg: SVGSVGElement,
    private h: ViewHandlers,
  ) {
    svg.setAttribute('viewBox', '14 14 632 266');
    const body = document.createElementNS(NS, 'rect');
    Object.entries({ x: 18, y: 18, width: 624, height: 258, rx: 16, class: 'case' }).forEach(([k, v]) =>
      body.setAttribute(k, String(v)),
    );
    svg.append(body);
    for (const k of KEYS) {
      const [x0, y0, x1, y1] = k.rect;
      const g = document.createElementNS(NS, 'g');
      g.dataset.led = String(k.led);
      g.classList.add('key');
      const rect = document.createElementNS(NS, 'rect');
      Object.entries({ x: x0 - 3, y: y0 - 3, width: x1 - x0 + 6, height: y1 - y0 + 6, rx: 5 }).forEach(([a, v]) =>
        rect.setAttribute(a, String(v)),
      );
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', String((x0 + x1) / 2));
      text.setAttribute('y', String((y0 + y1) / 2 + 3.5));
      const label = ARROWS[k.label] ?? k.label;
      text.textContent = label;
      g.append(rect, text);
      svg.append(g);
      this.keys.set(k.led, { g, rect, text, label });
    }

    svg.addEventListener('pointerdown', (e) => {
      const led = this.ledAt(e.clientX, e.clientY);
      if (led < 0) return;
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      this.pressed = true;
      this.last = led;
      this.h.down(led);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!this.pressed) return;
      const led = this.ledAt(e.clientX, e.clientY);
      if (led >= 0 && led !== this.last) {
        this.last = led;
        this.h.drag(led);
      }
    });
    const end = () => {
      if (!this.pressed) return;
      this.pressed = false;
      this.last = -1;
      this.h.up();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  private ledAt(x: number, y: number): number {
    const el = document.elementFromPoint(x, y)?.closest<SVGGElement>('g.key');
    return el ? Number(el.dataset.led) : -1;
  }

  /** Key colours (null = unlit keycaps). */
  setColours(c: Colours | null) {
    for (const [led, k] of this.keys) {
      const rgb: RGB | null = c ? c[led] : null;
      if (rgb && (rgb[0] || rgb[1] || rgb[2])) {
        k.rect.style.fill = `rgb(${rgb.join(',')})`;
        k.g.style.setProperty('--glow', `rgba(${rgb.join(',')},0.55)`);
        // dark label on bright keys
        const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        k.g.classList.toggle('bright', lum > 140);
        k.g.classList.add('lit');
      } else {
        k.rect.style.fill = '';
        k.g.classList.remove('lit', 'bright');
      }
    }
  }

  /** Overrides key labels (e.g. the remapped function); null = printed legends. */
  setLabels(labels: Map<number, string> | null, changed: Set<number> = new Set()) {
    for (const [led, k] of this.keys) {
      const l = labels?.get(led) ?? k.label;
      k.text.textContent = l.length > 7 ? l.slice(0, 6) + '…' : l;
      k.text.classList.toggle('small', l.length > 4);
      k.g.classList.toggle('changed', changed.has(led));
    }
  }

  setSelected(leds: Set<number>) {
    for (const [led, k] of this.keys) k.g.classList.toggle('selected', leds.has(led));
  }

  setMode(mode: string) {
    this.svg.dataset.mode = mode;
  }
}
