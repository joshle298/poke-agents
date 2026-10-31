/**
 * A small Web Audio stand-in for the sound engine tests: nodes record how
 * they are wired, params record their automation, buffer sources record
 * start/stop and end when a test says so, and decodeAudioData turns
 * `fakeAudioBytes(label, duration)` into a buffer. No real audio.
 */

export interface ParamCall {
  op: 'set' | 'linear' | 'exp' | 'cancel';
  value?: number;
  time: number;
}

export class FakeParam {
  value: number;
  readonly calls: ParamCall[] = [];

  constructor(value: number) {
    this.value = value;
  }

  setValueAtTime(value: number, time: number): this {
    this.calls.push({ op: 'set', value, time });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ op: 'linear', value, time });
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ op: 'exp', value, time });
    this.value = value;
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.calls.push({ op: 'cancel', time });
    return this;
  }

  last(): ParamCall | undefined {
    return this.calls[this.calls.length - 1];
  }
}

export class FakeNode {
  readonly outputs: FakeNode[] = [];

  connect<T extends FakeNode>(node: T): T {
    this.outputs.push(node);
    return node;
  }

  disconnect(): void {
    this.outputs.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

export class FakeBuffer {
  readonly numberOfChannels = 1;
  readonly label: string;
  readonly duration: number;

  constructor(label: string, duration: number) {
    this.label = label;
    this.duration = duration;
  }

  getChannelData(): Float32Array {
    return new Float32Array(480).fill(0.1);
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  private readonly endedListeners: Array<() => void> = [];

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(when = 0): void {
    this.stoppedAt = when;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.endedListeners.push(listener);
  }

  /** The source reached its end (or its stop time). */
  end(): void {
    for (const listener of this.endedListeners) listener();
    this.onended?.();
  }

  /** The envelope gain the engine put after this source. */
  get env(): FakeGain {
    return this.outputs[0] as FakeGain;
  }
}

/** Bytes FakeAudioContext.decodeAudioData decodes. */
export function fakeAudioBytes(label: string, duration: number): ArrayBuffer {
  return new TextEncoder().encode(`audio:${label}:${duration}`).buffer as ArrayBuffer;
}

export class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  readonly sampleRate = 48_000;
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];

  async resume(): Promise<void> {
    this.state = 'running';
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createWaveShaper(): FakeNode & { curve: Float32Array | null; oversample: string } {
    return Object.assign(new FakeNode(), { curve: null, oversample: 'none' });
  }

  async decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
    const match = /^audio:(\S+):([\d.]+)$/.exec(new TextDecoder().decode(data));
    if (!match) throw new Error('EncodingError: unable to decode audio data');
    return new FakeBuffer(match[1], Number(match[2]));
  }

  /** Sources playing a buffer whose label starts with `prefix`. */
  playing(prefix: string): FakeSource[] {
    return this.sources.filter((s) => s.buffer?.label.startsWith(prefix) === true);
  }
}
