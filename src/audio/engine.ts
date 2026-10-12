// Every sound in the game, synthesised with Web Audio: no audio files to
// download or license. Two buses, effects and music, under one master with a
// compressor so a big fight can't clip.
//
// Browsers only allow audio after the player interacts with the page, so the
// AudioContext is created on the first click or key (unlock()).

import type { Cue, CueName } from "./cues";

export type SoundMode = "on" | "sfx" | "off";
const MODE_KEY = "uptime:sound";
const MODES: SoundMode[] = ["on", "sfx", "off"];

const MASTER = 0.7;
const SFX = 0.9;
const MUSIC = 0.2;

/** D minor-ish progression, the "deep web" mood: Dm - Bb - F - C. MIDI notes. */
const CHORDS = [
  [50, 53, 57, 62],
  [46, 50, 53, 58],
  [41, 45, 48, 53],
  [48, 52, 55, 60],
];
const BAR_S = 4.8;

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  mode: SoundMode;
  /** For tests and the debug hook: how many cues have played, by name. */
  readonly played = new Map<CueName | "ui", number>();
  private tension = 0;
  private nextBar = 0;
  private nextStep = 0;
  private bar = 0;
  private step = 0;

  constructor() {
    const saved = localStorage.getItem(MODE_KEY) as SoundMode | null;
    this.mode = saved && MODES.includes(saved) ? saved : "on";
  }

  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /** Call from a user gesture. Safe to call again. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = (this.ctx = new Ctor());
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 6;
    this.master = ctx.createGain();
    this.sfx = ctx.createGain();
    this.music = ctx.createGain();
    this.sfx.connect(this.master);
    this.music.connect(this.master);
    this.master.connect(compressor).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    this.applyMode();
    this.nextBar = this.nextStep = ctx.currentTime + 0.1;
    setInterval(() => this.schedule(), 50);
  }

  /** On, effects only, off. Remembered. */
  cycle(): SoundMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
    localStorage.setItem(MODE_KEY, this.mode);
    this.applyMode();
    return this.mode;
  }

  /** 0..1: enemies near your base. The music leans in. */
  setTension(value: number): void {
    this.tension += (value - this.tension) * 0.05;
  }

  play(cue: Cue): void {
    this.played.set(cue.name, (this.played.get(cue.name) ?? 0) + 1);
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || this.mode === "off") return;
    const out = ctx.createStereoPanner();
    out.pan.value = cue.pan;
    const gain = ctx.createGain();
    gain.gain.value = cue.volume;
    gain.connect(out).connect(this.sfx);
    SOUNDS[cue.name](this.voice(ctx, gain));
  }

  /** Small interface sounds: a button, a placement, an order. */
  ui(kind: "click" | "place" | "order"): void {
    this.played.set("ui", (this.played.get("ui") ?? 0) + 1);
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || this.mode === "off") return;
    const v = this.voice(ctx, this.sfx);
    if (kind === "click") v.tone("sine", 1400, 1400, 0.03, 0.12);
    if (kind === "order") v.tone("triangle", 660, 990, 0.06, 0.12);
    if (kind === "place") {
      v.tone("square", 220, 440, 0.08, 0.1);
      v.noise(2000, 0.05, 0.08);
    }
  }

  private applyMode(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.mode === "off" ? 0 : MASTER, t, 0.05);
    this.sfx.gain.setTargetAtTime(SFX, t, 0.05);
    this.music.gain.setTargetAtTime(this.mode === "on" ? MUSIC : 0, t, 0.3);
  }

  // --- building blocks --------------------------------------------------------

  private voice(ctx: AudioContext, out: AudioNode): Voice {
    const now = ctx.currentTime;
    const envelope = (peak: number, attack: number, length: number, at: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, at + attack + length);
      g.connect(out);
      return g;
    };
    return {
      tone: (type, from, to, length, peak, delay = 0) => {
        const at = now + delay;
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(from, at);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + length);
        osc.connect(envelope(peak, 0.005, length, at));
        osc.start(at);
        osc.stop(at + length + 0.05);
      },
      noise: (cutoff, length, peak, delay = 0, sweepTo?: number) => {
        const at = now + delay;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(cutoff, at);
        if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, at + length);
        src.connect(filter).connect(envelope(peak, 0.004, length, at));
        src.start(at, Math.random() * 0.5);
        src.stop(at + length + 0.05);
      },
      chord: (notes, length, peak, type = "triangle", delay = 0, spacing = 0) => {
        notes.forEach((n, i) => {
          const at = now + delay + i * spacing;
          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.value = midi(n);
          osc.connect(envelope(peak, 0.01, length, at));
          osc.start(at);
          osc.stop(at + length + 0.05);
        });
      },
    };
  }

  // --- music ------------------------------------------------------------------

  /** A short look-ahead scheduler: pads every bar, an arpeggio that gets busier with tension. */
  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const horizon = ctx.currentTime + 0.2;
    while (this.nextBar < horizon) {
      this.pad(CHORDS[this.bar % CHORDS.length]!, this.nextBar);
      this.bar += 1;
      this.nextBar += BAR_S;
    }
    // Steps: 8 per bar when calm, 16 when the base is under pressure.
    const steps = this.tension > 0.35 ? 16 : 8;
    while (this.nextStep < horizon) {
      const chord = CHORDS[Math.floor((this.nextStep - 0.1) / BAR_S) % CHORDS.length] ?? CHORDS[0]!;
      const pattern = [0, 2, 1, 3, 2, 1, 3, 2];
      const note = chord[pattern[this.step % pattern.length]!]! + 12;
      const level = 0.035 + this.tension * 0.07;
      if (this.step % 2 === 0 || this.tension > 0.15) this.pluck(note, this.nextStep, level);
      if (this.tension > 0.5 && this.step % 4 === 0) this.kick(this.nextStep, 0.25 * this.tension);
      this.step += 1;
      this.nextStep += BAR_S / steps;
    }
  }

  private pad(notes: number[], at: number): void {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700 + this.tension * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.05, at + 1.4);
    g.gain.linearRampToValueAtTime(0.0001, at + BAR_S + 0.6);
    filter.connect(g).connect(this.music);
    for (const n of notes) {
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = midi(n);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(at);
        osc.stop(at + BAR_S + 0.7);
      }
    }
    // A low root underneath.
    const bass = ctx.createOscillator();
    bass.type = "sine";
    bass.frequency.value = midi(notes[0]! - 12);
    bass.connect(g);
    bass.start(at);
    bass.stop(at + BAR_S + 0.7);
  }

  private pluck(note: number, at: number, level: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = midi(note);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2400, at);
    filter.frequency.exponentialRampToValueAtTime(300, at + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    osc.connect(filter).connect(g).connect(this.music);
    osc.start(at);
    osc.stop(at + 0.35);
  }

  private kick(at: number, level: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(120, at);
    osc.frequency.exponentialRampToValueAtTime(40, at + 0.15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(g).connect(this.music);
    osc.start(at);
    osc.stop(at + 0.25);
  }
}

interface Voice {
  /** A tone sweeping `from` -> `to` Hz. */
  tone(type: OscillatorType, from: number, to: number, length: number, peak: number, delay?: number): void;
  /** Filtered noise, optionally sweeping the filter. */
  noise(cutoff: number, length: number, peak: number, delay?: number, sweepTo?: number): void;
  /** Notes (MIDI) together, or rolled with `spacing` seconds between. */
  chord(notes: number[], length: number, peak: number, type?: OscillatorType, delay?: number, spacing?: number): void;
}

/** One recipe per cue. Kept short: these fire a lot. */
const SOUNDS: Record<CueName, (v: Voice) => void> = {
  shot: (v) => v.tone("square", 1800, 500, 0.05, 0.25),
  "hit-building": (v) => {
    v.noise(900, 0.12, 0.5);
    v.tone("triangle", 160, 90, 0.1, 0.4);
  },
  death: (v) => {
    v.noise(2400, 0.14, 0.5, 0, 300);
    v.tone("sawtooth", 600, 120, 0.14, 0.18);
  },
  "death-big": (v) => {
    v.noise(1800, 0.6, 0.8, 0, 120);
    v.tone("sawtooth", 220, 40, 0.6, 0.4);
  },
  "building-down": (v) => {
    v.noise(1200, 1.0, 0.9, 0, 80);
    v.tone("sine", 90, 30, 0.9, 0.7);
  },
  wave: (v) => {
    // A two-note alert horn.
    v.tone("sawtooth", 220, 220, 0.35, 0.35);
    v.tone("sawtooth", 165, 165, 0.5, 0.35, 0.38);
  },
  boss: (v) => {
    v.tone("sawtooth", 110, 110, 0.6, 0.5);
    v.tone("sawtooth", 104, 104, 0.6, 0.5);
    v.tone("sawtooth", 82, 82, 1.1, 0.5, 0.65);
    v.noise(400, 1.6, 0.4, 0.1);
  },
  fortified: (v) => v.chord([45, 52, 57], 0.5, 0.15, "square", 0, 0.08),
  founded: (v) => v.chord([62, 66, 69, 74], 0.9, 0.18, "triangle", 0, 0.09),
  alarm: (v) => {
    for (let i = 0; i < 3; i += 1) v.tone("square", 880, 880, 0.12, 0.25, i * 0.22);
  },
  failover: (v) => {
    v.tone("square", 660, 330, 0.3, 0.3);
    v.chord([57, 62], 0.5, 0.2, "triangle", 0.3);
  },
  offline: (v) => {
    v.tone("sawtooth", 440, 55, 1.4, 0.4);
    v.noise(600, 1.2, 0.3, 0.2, 100);
  },
  "cast-blast": (v) => {
    v.noise(3000, 0.5, 0.8, 0, 200);
    v.tone("sine", 140, 40, 0.5, 0.7);
  },
  "cast-strike": (v) => {
    v.tone("sawtooth", 2400, 200, 0.25, 0.45);
    v.noise(5000, 0.15, 0.5);
  },
  "cast-heal": (v) => v.chord([72, 76, 79, 84], 0.7, 0.18, "sine", 0, 0.06),
  "cast-decoy": (v) => {
    v.tone("triangle", 500, 900, 0.2, 0.35);
    v.tone("triangle", 700, 1200, 0.2, 0.3, 0.15);
  },
  "cast-summon": (v) => {
    for (let i = 0; i < 4; i += 1) v.tone("square", 300 + i * 120, 600 + i * 160, 0.09, 0.22, i * 0.07);
  },
  "cast-buff": (v) => {
    v.chord([62, 69, 74], 0.8, 0.2, "sawtooth", 0, 0.05);
    v.noise(6000, 0.4, 0.2, 0, 1500);
  },
  "level-up": (v) => v.chord([67, 71, 74, 79, 83], 0.6, 0.18, "triangle", 0, 0.07),
  "hero-down": (v) => v.chord([62, 58, 53], 0.6, 0.2, "triangle", 0, 0.15),
  "hero-up": (v) => v.chord([62, 69], 0.5, 0.18, "triangle", 0, 0.1),
  researched: (v) => v.chord([74, 79], 0.4, 0.2, "sine", 0, 0.08),
  error: (v) => v.tone("square", 180, 140, 0.12, 0.2),
  victory: (v) => v.chord([62, 66, 69, 74, 78, 81, 86], 1.6, 0.2, "triangle", 0, 0.12),
  defeat: (v) => {
    v.chord([62, 61, 60, 59], 1.2, 0.22, "sawtooth", 0, 0.35);
    v.noise(500, 2.2, 0.3, 0.3, 60);
  },
};
