// Reese sub bass — the rolling low end under the break. Two detuned sawtooth
// oscillators beat against each other (DETUNE sets the Reese width => the
// characteristic slow churn), run through a resonant SVF lowpass (CUTOFF/RESO)
// and softly saturated so it stays fat and bounded.
//
// Monophonic with GLIDE: a retrigger slides the pitch from wherever it was,
// so bassNotes lines snake between steps like a proper jungle sub. Per-step
// pitch comes in through trigger(vel, note) as a semitone offset (-12..+12)
// on top of ROOT.
//
// ROOT reference (DESIGN contract): the A1 family — root=9 lands on A1
// (55 Hz), so the default root=5 is F1 (~43.65 Hz). Deep.

import { SVF, polyblep } from './util.js';

const PARAMS = ['root', 'cutoff', 'reso', 'detune', 'glide', 'decay', 'level'];

export class Bass {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p1 = 0; // saw A
    this.p2 = 0.31; // saw B — fixed offset so the pair never starts locked
    this.freq = 43.65; // current (glided) frequency
    this.target = 43.65; // where the note is heading
    this.env = 0;
    this.att = 1;
    this.active = false;
    this.lp = new SVF(sampleRate);

    // canonical defaults — MUST match the DESIGN.md table / index.html values
    this.root = 5; // 0..11 semitones — 5 = F (F1 ~43.65 Hz)
    this.cutoff = 700; // lowpass cutoff Hz
    this.reso = 0.3; // 0..1 filter resonance
    this.detune = 0.4; // 0..1 Reese width (0..~2.8% per side)
    this.glide = 0.06; // portamento seconds (one-pole time constant)
    this.decay = 0.5; // amplitude decay to -60 dB
    this.level = 0.85;
    this._recalc();
  }

  _recalc() {
    this.envCoef = Math.exp(Math.log(0.001) / (this.decay * this.sr));
    // glide as a one-pole time constant; ~0 glide snaps instantly
    this.glideCoef = this.glide > 1e-4 ? Math.exp(-1 / (this.glide * this.sr)) : 0;
    this.attStep = 1 / (0.003 * this.sr);
  }

  set(name, value) {
    if (PARAMS.includes(name)) {
      this[name] = value;
      this._recalc();
    }
  }

  // note: per-step semitone offset from the bassNotes row (-12..+12)
  trigger(velocity = 1, note = 0) {
    // A1 (55 Hz) at root=9; root=5 default lands on F1 (~43.65 Hz)
    this.target = 55 * Math.pow(2, (this.root - 9 + note) / 12);
    if (!this.active) this.freq = this.target; // first hit snaps, no swoop-in
    this.env = velocity;
    this.att = 0;
    this.active = true;
  }

  process() {
    if (!this.active) return 0;
    // glide toward the target pitch
    this.freq = this.target + (this.freq - this.target) * this.glideCoef;

    // the Reese pair: two band-limited saws detuned around the note
    const d = this.detune * 0.028; // up to ~2.8% per side (~48 cents spread)
    const dt1 = (this.freq * (1 + d)) / this.sr;
    const dt2 = (this.freq * (1 - d)) / this.sr;
    this.p1 += dt1;
    if (this.p1 >= 1) this.p1 -= 1;
    this.p2 += dt2;
    if (this.p2 >= 1) this.p2 -= 1;
    const sawA = 2 * this.p1 - 1 - polyblep(this.p1, dt1);
    const sawB = 2 * this.p2 - 1 - polyblep(this.p2, dt2);

    const filtered = this.lp.lowpass((sawA + sawB) * 0.5, this.cutoff, this.reso * 0.9);

    if (this.att < 1) this.att = Math.min(1, this.att + this.attStep);
    const pre = filtered * this.env * this.att;
    // soft-saturate: fattens the churn AND bounds the output below the bus
    const out = Math.tanh(pre * 1.4);

    this.env *= this.envCoef;
    if (this.env < 1e-4) this.active = false;
    return out * this.level;
  }
}
