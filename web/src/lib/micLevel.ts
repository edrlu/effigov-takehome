"use client";

/**
 * One shared microphone level meter for the call console.
 *
 * The waveform and the volume chip both want the live input level at animation
 * rate. Pushing that through React state would re-render the whole console
 * sixty times a second, so instead a single Web Audio analyser runs one rAF
 * loop and hands the level straight to subscribers, which write it to the DOM
 * themselves. The loop and the AudioContext only exist while there is both a
 * track and at least one subscriber.
 */

type Listener = (level: number) => void;

/** Attack is fast so a syllable registers; release is slow so bars do not flicker. */
const ATTACK = 0.55;
const RELEASE = 0.12;

export class LevelMeter {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private frame = 0;
  private level = 0;
  private listeners = new Set<Listener>();

  setTrack(track: MediaStreamTrack | null): void {
    if (track === this.track) return;
    this.teardown();
    this.track = track;
    this.sync();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.level);
    this.sync();
    return () => {
      this.listeners.delete(listener);
      this.sync();
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.track = null;
    this.teardown();
  }

  private sync(): void {
    const wanted = this.track !== null && this.listeners.size > 0;
    if (wanted) this.start();
    else this.stop();
  }

  private start(): void {
    if (this.frame !== 0) return;
    if (!this.analyser) {
      const track = this.track;
      if (!track || typeof window === "undefined") return;
      try {
        const context = new AudioContext();
        const stream = new MediaStream([track]);
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        this.context = context;
        this.stream = stream;
        this.source = source;
        this.analyser = analyser;
        this.data = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      } catch {
        // No Web Audio (or an autoplay-blocked context): the waveform simply
        // rests instead of the console failing to render.
        return;
      }
    }
    // A context created before a user gesture starts suspended.
    void this.context?.resume().catch(() => undefined);
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private teardown(): void {
    this.stop();
    this.source?.disconnect();
    void this.context?.close().catch(() => undefined);
    this.source = null;
    this.analyser = null;
    this.context = null;
    this.stream = null;
    this.data = null;
    this.level = 0;
    for (const listener of this.listeners) listener(0);
  }

  private tick = (): void => {
    this.frame = 0;
    const analyser = this.analyser;
    const data = this.data;
    if (!analyser || !data) return;

    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let index = 0; index < data.length; index += 1) {
      const sample = (data[index] - 128) / 128;
      sum += sample * sample;
    }
    // Speech RMS sits near 0.05-0.2; scale so ordinary talking fills the bar.
    const rms = Math.sqrt(sum / data.length);
    const target = Math.min(1, rms * 4.2);
    const smoothing = target > this.level ? ATTACK : RELEASE;
    this.level += (target - this.level) * smoothing;

    for (const listener of this.listeners) listener(this.level);
    this.frame = requestAnimationFrame(this.tick);
  };
}
