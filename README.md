# aula-75-webdriver

A configurator for the **AULA F75** keyboard that runs in the browser. Nothing to install:
open the site, click **Connect keyboard** and you're done.

Inspired by [F75 Studio](https://github.com/trenbolone1122/aula-f75-linux) (`trenbolone1122/aula-f75-linux`), the native
Linux app, and ported from it to the web using **WebHID** instead of hidapi. The protocol is
the same one, recovered from AULA's official driver with Ghidra; see the original project's
[PROTOCOL.md](https://github.com/trenbolone1122/aula-f75-linux/blob/HEAD/docs/PROTOCOL.md).

## Features

* **Lighting:** the keyboard's 18 built-in effects with brightness, speed and color; Fixed On
  also takes any RGB color. Per-key painting (click or drag), color picker and presets.
  The page follows changes made with the keyboard's own Fn shortcuts.
* **Live effects** (USB-C): Wave, Breathe, Twinkle, Plasma, Matrix Rain and Fire at
  ~50 fps, with 8 palettes.
* **Audio sync** (USB-C): Spectrum and Mirror, driven by audio from a tab, the screen or
  the microphone.
* **Keys:** remap any key on the base or Fn layer; restore the factory layout.
* **Macros** (USB-C): text the keyboard types by itself, even without the site.
* **Power:** sleep timeout, including Never.
* **Profiles:** stored in the browser, with JSON export/import.

Everything is written to the keyboard right away and keeps working on any computer.

| Connection | Effects and per-key | Remap | Macros | Live and audio |
|---|---|---|---|---|
| USB-C cable | Yes | Yes | Yes | Yes |
| 2.4G receiver | Yes | Yes | No | No |
| Bluetooth | No | No | No | No |

## Requirements

* Chrome, Edge or Opera **on a computer** (WebHID isn't available in Firefox, Safari or
  mobile browsers).
* The site must be served over **HTTPS** (or `localhost`).
* **Linux:** the browser needs access to `hidraw`. Install the udev rule once and replug
  the keyboard (the same [rule as the original project](https://github.com/trenbolone1122/aula-f75-linux/blob/HEAD/packaging/70-aula-f75.rules)):

  ```bash
  sudo tee /etc/udev/rules.d/70-aula-f75.rules <<'EOF'
  SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", ATTRS{idProduct}=="fa09", TAG+="uaccess"
  SUBSYSTEM=="hidraw", ATTRS{idVendor}=="258a", ATTRS{idProduct}=="010c", TAG+="uaccess"
  EOF
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

  Windows, macOS and ChromeOS work with nothing extra.

## Development

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # protocol, macros and WebHID transport against an emulated F75
npm run build     # static site in dist/
```

`dist/` is plain HTML/CSS/JS and can go on any static host.

## Layout

Each module matches a file in the original project's [`src/`](https://github.com/trenbolone1122/aula-f75-linux/blob/HEAD/src).

| File | Source in the Linux project | Role |
|---|---|---|
| `src/protocol.ts` | `protocol.rs` | Packets, checksums, LED block, per-key colors, key codes |
| `src/layout.ts` | `layout.rs` | Position, VK and LED index of the 80 keys |
| `src/device.ts` | `device.rs` | WebHID transport: feature report 0x06 (cable), report 0x13 (2.4G) |
| `src/macros.ts` | `macros.rs` | Macro buffer and text → events |
| `src/controller.ts` | `worker.rs` | Connection, job queue, periodic reads, layout cache, live streaming |
| `src/fx.ts`, `src/audio.ts` | `fx.rs`, `audio.rs` | Live effects; audio via Web Audio |
| `src/profiles.ts` | `state.rs` | Profiles in `localStorage` |
| `src/main.ts`, `src/keyboard-view.ts` | `ui.rs`, `kbview.rs` | User interface |

## Known limitations

* Not tested on real hardware yet: the logic is a 1:1 port of F75 Studio (verified on an
  F75) and is tested against an emulated keyboard, but WebHID's behaviour with a real F75
  still needs to be confirmed, especially the feature reports over the cable.
* The Lighting tab follows the keyboard by itself (Fn shortcut changes included): every
  2 s over the cable and, on 2.4G, only when you come back to the page, so the radio isn't
  flooded. Reading the per-key colors stored on the keyboard is experimental: AULA's driver
  never reads them back; if the read fails, the site keeps the profile's colors.
* Custom RGB color only on Fixed On: the keyboard's other effects only accept the 8 palette
  colors. Fixed On with a custom color is written as per-key mode with every key that
  color. The protocol's "RGB table" command, which may define the palette, hasn't been
  decoded yet.
* Live effects need the tab open; browsers slow down timers in background tabs.
* AULA's music modes (`aula_music.rs`) haven't been ported yet.
* Bluetooth is view only. As in the original project, nothing is sent over it (the keyboard
  answers only partially and config traffic disrupts typing).
* Macros type as on a US keyboard (no accented characters).

## Credits

* Protocol, layout, effects and udev rule: [F75 Studio / aula-f75-linux](https://github.com/trenbolone1122/aula-f75-linux).
* Rajdhani font (SIL Open Font License, `public/fonts/OFL.txt`).
