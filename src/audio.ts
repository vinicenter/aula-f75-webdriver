// Audio capture -> 21 spectrum bands, ported from aula-f75-linux-concept/src/audio.rs.
// The Linux app reads the PulseAudio monitor; a page can only get sound the user shares with it:
// a tab / the whole screen with "share audio" (getDisplayMedia), or a microphone.

export const BANDS = 21; // one per keyboard column
const N = 2048;

/** What the effects see each frame. */
export interface Snapshot {
  bands: number[]; // 0..1, smoothed
  bass: number;
}

export const silence = (): Snapshot => ({ bands: new Array(BANDS).fill(0), bass: 0 });

export type Source = 'screen' | 'mic';

export class Audio {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private db: Float32Array<ArrayBuffer>;
  private edges: number[];
  private peak = 1e-3;
  private levels = silence();
  /** Called when the user stops sharing from the browser's own UI. */
  onEnded: (() => void) | null = null;

  private constructor(private stream: MediaStream) {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = N;
    this.analyser.smoothingTimeConstant = 0;
    this.ctx.createMediaStreamSource(stream).connect(this.analyser); // not to the speakers: no echo
    this.db = new Float32Array(this.analyser.frequencyBinCount);
    const rate = this.ctx.sampleRate;
    // log-spaced band edges 40 Hz .. 12 kHz
    this.edges = Array.from({ length: BANDS + 1 }, (_, i) => {
      const f = 40 * (12000 / 40) ** (i / BANDS);
      return Math.min(Math.max(Math.floor((f / rate) * N), 1), N / 2);
    });
    for (const t of stream.getTracks()) t.addEventListener('ended', () => this.onEnded?.());
  }

  static async start(source: Source): Promise<Audio> {
    let stream: MediaStream;
    if (source === 'mic') {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } else {
      // Chrome only offers audio together with video; the video track is dropped right away
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => {
        t.stop();
        stream.removeTrack(t);
      });
      if (!stream.getAudioTracks().length) {
        throw new Error('No audio was shared. Tick "Share audio" in the browser dialog.');
      }
    }
    return new Audio(stream);
  }

  stop() {
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }

  /** Reads the analyser once and returns the current levels, scaled by sensitivity. */
  snapshot(sensitivity: number): Snapshot {
    this.analyser.getFloatFrequencyData(this.db);
    const bands = new Array<number>(BANDS).fill(0);
    for (let i = 0; i < BANDS; i++) {
      const [a, z] = [this.edges[i], Math.max(this.edges[i + 1], this.edges[i] + 1)];
      for (let k = a; k < z && k < this.db.length; k++) bands[i] = Math.max(bands[i], 10 ** (this.db[k] / 20));
    }
    this.peak = Math.max(this.peak * 0.995, Math.max(...bands), 1e-3); // auto gain
    const l = this.levels;
    for (let i = 0; i < BANDS; i++) {
      const v = Math.min((bands[i] / this.peak) ** 0.6 * 1.15, 1);
      l.bands[i] = v > l.bands[i] ? v : l.bands[i] * 0.82 + v * 0.18; // fast attack, slow release
    }
    l.bass = (l.bands[0] + l.bands[1] + l.bands[2] + l.bands[3]) / 4;
    const k = (v: number) => Math.min(v * sensitivity, 1);
    return { bands: l.bands.map(k), bass: k(l.bass) };
  }
}
