// Send effects and bus processing — the reactor hall around the break.
// Same bones as the drift/galaxy dub chain (tempo-synced filtered delay,
// Schroeder reverb, sidechain ducker) tuned tighter and brighter for 160 BPM
// breaks, plus the fission-specific stages: a drum-bus Bitcrush (the thin
// lo-fi crust), a drum-bus Filter that CRITICAL pushes open, and a Geiger
// tick generator that starts crackling past criticality (>0.7).

import { SVF, OnePoleHP } from './util.js';

// Tempo-synced delay with lowpass + highpass filtering inside the feedback
// loop, so each repeat gets darker and thinner — the dub echo throw. The
// engine syncs the time to a dotted eighth (3 sixteenth steps).
export class DubDelay {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.buf = new Float32Array(Math.ceil(sampleRate * 4.0));
    this.writeIdx = 0;
    this.timeSamples = Math.floor(sampleRate * 0.28);
    this.feedback = 0.45;
    this.color = 1300; // lowpass cutoff in the loop — darker repeats
    this.level = 0.9; // the engine scales the SEND, so the return runs hot
    this.lp = new SVF(sampleRate);
    this.hpX = 0;
    this.hpY = 0;
  }

  setTimeSamples(n) {
    this.timeSamples = Math.min(this.buf.length - 1, Math.max(32, Math.floor(n)));
  }

  process(x) {
    const len = this.buf.length;
    const readIdx = (this.writeIdx - this.timeSamples + len) % len;
    const echo = this.buf[readIdx];
    // filter the feedback path: darker (lowpass) and thinner (highpass) each
    // time around, so retriggered snares smear into haze instead of mud
    let fb = this.lp.lowpass(echo, this.color, 0);
    const hp = 0.992 * (this.hpY + fb - this.hpX);
    this.hpX = fb;
    this.hpY = hp;
    fb = hp;
    this.buf[this.writeIdx] = x + fb * this.feedback;
    this.writeIdx = (this.writeIdx + 1) % len;
    return echo * this.level;
  }
}

// Small plate — a compact Schroeder (four damped combs + two allpasses) with
// SHORT loops, so it reads as a snare plate rather than drift's valley wash.
export class Reverb {
  constructor(sampleRate) {
    this.sr = sampleRate;
    const scale = sampleRate / 44100;
    this.combs = [1113, 1188, 1277, 1356].map((n) => ({
      buf: new Float32Array(Math.floor(n * scale)),
      idx: 0,
      damp: 0,
      g: 0,
    }));
    this.allpasses = [225, 556].map((n) => ({
      buf: new Float32Array(Math.floor(n * scale)),
      idx: 0,
    }));
    this.decay = 1.4; // seconds — a tight plate behind the snare
    this.level = 0.6;
    this._recalc();
  }

  _recalc() {
    // comb feedback gain for the requested decay time (-60 dB after `decay` s)
    for (const c of this.combs) {
      const loopSec = c.buf.length / this.sr;
      c.g = Math.pow(10, (-3 * loopSec) / this.decay);
    }
  }

  set(name, value) {
    if (name === 'decay') {
      this.decay = value;
      this._recalc();
    } else if (name === 'level') {
      this.level = value;
    }
  }

  process(x) {
    let s = 0;
    for (const c of this.combs) {
      const out = c.buf[c.idx];
      // damping inside the comb loop darkens the tail as it rings out
      c.damp = out * 0.3 + c.damp * 0.7;
      c.buf[c.idx] = x + c.damp * c.g;
      c.idx = (c.idx + 1) % c.buf.length;
      s += out;
    }
    s *= 0.25;
    for (const a of this.allpasses) {
      const buffered = a.buf[a.idx];
      const out = -s + buffered;
      a.buf[a.idx] = s + buffered * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      s = out;
    }
    return s * this.level;
  }
}

// Sidechain ducker — everything except the kick breathes when the kick lands.
export class Ducker {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.env = 0;
    this.amount = 0.35; // canonical default (fx `duck`)
    this.release = 0.12; // fast recovery — a quick breath at 160 BPM
    this._recalc();
  }

  _recalc() {
    this.relCoef = Math.exp(-1 / (this.release * this.sr));
  }

  set(name, value) {
    if (name === 'amount') this.amount = value;
    else if (name === 'release') {
      this.release = value;
      this._recalc();
    }
  }

  trigger() {
    this.env = 1;
  }

  process() {
    const gain = 1 - this.amount * this.env;
    this.env *= this.relCoef;
    return gain;
  }
}

// Drum-bus Filter: an SVF lowpass over the drum bus. Slightly closed at rest
// (part of the lo-fi crust); CRITICAL pushes it open with a touch of resonance
// — the reactor vents glowing as the chain reaction builds.
export class Filter {
  constructor(sampleRate) {
    this.svf = new SVF(sampleRate);
    this.cutoff = 9000; // Hz — the at-rest (critical=0) drum bus top
    this.res = 0;
  }

  set(cutoff, res = 0) {
    this.cutoff = cutoff;
    this.res = res;
  }

  process(x) {
    return this.svf.lowpass(x, this.cutoff, this.res);
  }
}

// Drum-bus Bitcrush — sample-rate reduction + bit quantise, dry/wet blended by
// AMOUNT. At the default 0.15 it's a thin dusting of aliased grit (the lo-fi
// break texture); cranked, it chews the drums into 8-bit rubble. amount<=~0
// is an exact passthrough so crush 0 is truly clean.
export class Bitcrush {
  constructor() {
    this.amount = 0.15; // canonical default (fx `crush`)
    this.held = 0;
    this.acc = 0;
  }

  set(name, value) {
    if (name === 'amount') this.amount = value;
  }

  process(x) {
    const a = this.amount;
    if (a < 1e-3) return x;
    // rate reduction: hold each sample for 1..15 samples (squared curve so
    // low amounts stay subtle)
    this.acc += 1;
    const factor = 1 + a * a * 14;
    if (this.acc >= factor) {
      this.acc -= factor;
      // bit reduction: 12 bits down to ~4.5 bits at full crush
      const steps = Math.pow(2, 12 - a * 7.5);
      this.held = Math.round(x * steps) / steps;
    }
    const wet = Math.min(1, a * 2.5);
    return x + (this.held - x) * wet;
  }
}

// Geiger counter — sparse random ticks (tiny highpassed noise clicks) that
// appear past criticality. density 0..1 sets the average tick rate (~18/s at
// full density); 0 is silent and cheap. Uses its own xorshift state so the
// audio thread never touches Math.random for the timing.
export class Geiger {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.density = 0;
    this.env = 0;
    this.hp = new OnePoleHP(sampleRate);
    this.hp.setCutoff(3500);
    this.s = 0x1badb002;
    this.coef = Math.exp(Math.log(0.001) / (0.004 * sampleRate)); // ~4 ms tick
  }

  _rnd() {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }

  process() {
    if (this.density > 0 && this._rnd() < (this.density * 18) / this.sr) {
      this.env = 0.4 + 0.6 * this._rnd();
    }
    if (this.env < 1e-4) return 0;
    const out = this.hp.process((this._rnd() * 2 - 1) * this.env);
    this.env *= this.coef;
    return out * 0.5;
  }
}
