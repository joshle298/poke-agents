/**
 * Renders an SfxRecipe (sfxRecipes.ts) with Web Audio: one oscillator (or a
 * filtered noise source) per voice, an ADSR gain envelope that always starts
 * and ends at silence (no clicks), linear or exponential slides, and vibrato
 * through `detune`. Also builds the bit-crush shaper the engine puts after
 * the synth.
 */

import type { SfxRecipe, Voice, Wave } from './sfxRecipes.js';
import { WAVE_LEVEL } from './sfxRecipes.js';

/** Fourier terms for the pulse waves. */
const PULSE_HARMONICS = 48;
/** Extra time a source runs after its envelope reached zero. */
const STOP_TAIL_SEC = 0.02;
/** Exponential ramps can't reach 0 Hz. */
const MIN_SLIDE_HZ = 20;
/** Samples in the bit-crush shaper's curve. */
const CRUSH_CURVE_SAMPLES = 2048;
/** A band-pass keeps only a sliver of white noise's energy. Noise voices get
 *  this fraction of the loss back (from the filter's noise bandwidth,
 *  π/2 · f/Q), so a whoosh sits as loud as a tone of the same `gain`. */
const NOISE_MAKEUP_SCALE = 0.9;
const NOISE_MAKEUP_MAX = 6;

/** Gain that restores a band-passed noise voice to a tone-like level. */
export function noiseMakeup(voice: Voice, sampleRate: number): number {
  const mean = Math.sqrt(voice.freq * (voice.freqEnd ?? voice.freq));
  const bandwidth = (Math.PI / 2) * (mean / (voice.q ?? 1));
  const loss = Math.sqrt(sampleRate / 2 / bandwidth);
  return Math.min(NOISE_MAKEUP_MAX, Math.max(1, loss * NOISE_MAKEUP_SCALE));
}

const pulseWaves = new WeakMap<BaseAudioContext, Map<number, PeriodicWave>>();
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  let byDuty = pulseWaves.get(ctx);
  if (!byDuty) {
    byDuty = new Map();
    pulseWaves.set(ctx, byDuty);
  }
  let wave = byDuty.get(duty);
  if (!wave) {
    const real = new Float32Array(PULSE_HARMONICS + 1);
    const imag = new Float32Array(PULSE_HARMONICS + 1);
    for (let n = 1; n <= PULSE_HARMONICS; n++) {
      real[n] = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * duty);
    }
    wave = ctx.createPeriodicWave(real, imag);
    byDuty.set(duty, wave);
  }
  return wave;
}

/** One second of white noise per context, looped by noise voices. */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

function slide(param: AudioParam, voice: Voice, t0: number): void {
  param.setValueAtTime(voice.freq, t0);
  if (voice.freqEnd === undefined || voice.freqEnd === voice.freq) return;
  const end = t0 + (voice.slideTime ?? voice.duration);
  param.exponentialRampToValueAtTime(Math.max(MIN_SLIDE_HZ, voice.freqEnd), end);
}

function oscillatorFor(ctx: BaseAudioContext, wave: Exclude<Wave, 'noise'>): OscillatorNode {
  const osc = ctx.createOscillator();
  if (wave === 'square' || wave === 'triangle') osc.type = wave;
  else osc.setPeriodicWave(pulseWave(ctx, wave === 'pulse25' ? 0.25 : 0.125));
  return osc;
}

function playVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  voice: Voice,
  when: number,
): void {
  const t0 = when + voice.start;
  const tEnd = t0 + voice.duration;
  const peak = voice.gain * WAVE_LEVEL[voice.wave];

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + voice.attack);
  env.gain.linearRampToValueAtTime(peak * voice.sustain, t0 + voice.attack + voice.decay);
  env.gain.setValueAtTime(peak * voice.sustain, Math.max(t0, tEnd - voice.release));
  env.gain.linearRampToValueAtTime(0, tEnd);
  env.connect(destination);

  let source: AudioScheduledSourceNode;
  let pitched: OscillatorNode | null = null;
  if (voice.wave === 'noise') {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx);
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = voice.q ?? 1;
    slide(filter.frequency, voice, t0);
    const makeup = ctx.createGain();
    makeup.gain.value = noiseMakeup(voice, ctx.sampleRate);
    noise.connect(filter);
    filter.connect(makeup);
    makeup.connect(env);
    source = noise;
  } else {
    pitched = oscillatorFor(ctx, voice.wave);
    slide(pitched.frequency, voice, t0);
    pitched.connect(env);
    source = pitched;
  }

  if (pitched && voice.vibratoHz && voice.vibratoCents) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = voice.vibratoHz;
    const depth = ctx.createGain();
    depth.gain.value = voice.vibratoCents;
    lfo.connect(depth);
    depth.connect(pitched.detune);
    lfo.start(t0);
    lfo.stop(tEnd + STOP_TAIL_SEC);
  }

  source.start(t0);
  source.stop(tEnd + STOP_TAIL_SEC);
  // Free the graph once it is done.
  source.onended = () => env.disconnect();
}

/** Schedule every voice of `recipe` at audio time `when`; returns its end time. */
export function playRecipe(
  ctx: BaseAudioContext,
  destination: AudioNode,
  recipe: SfxRecipe,
  when: number,
): number {
  let end = when;
  for (const voice of recipe.voices) {
    playVoice(ctx, destination, voice, when);
    end = Math.max(end, when + voice.start + voice.duration);
  }
  return end;
}

/** A WaveShaper that quantizes amplitude to `levels` steps: the synth's
 *  bit-crushed, chip-like edge. */
export function createCrusher(ctx: BaseAudioContext, levels: number): WaveShaperNode {
  const half = Math.max(1, levels / 2);
  const curve = new Float32Array(CRUSH_CURVE_SAMPLES);
  for (let i = 0; i < CRUSH_CURVE_SAMPLES; i++) {
    const x = (i / (CRUSH_CURVE_SAMPLES - 1)) * 2 - 1;
    curve[i] = Math.round(x * half) / half;
  }
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = 'none';
  return shaper;
}
