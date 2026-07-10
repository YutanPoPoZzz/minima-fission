// Shared DSP building blocks — same lineage as galaxy/rain/drift/city.
// Pure module: no AudioWorklet globals, importable from Node for the tests.

// PolyBLEP anti-aliasing correction for sawtooth/square discontinuities.
// t: normalized phase [0,1), dt: phase increment per sample.
export function polyblep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// State-variable lowpass filter (topology-preserving transform).
// Stable across fast cutoff sweeps — the Reese bass and drum bus lean on this.
export class SVF {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.ic1 = 0;
    this.ic2 = 0;
  }

  reset() {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  // x: input sample, fc: cutoff Hz, res: resonance 0..~0.97
  lowpass(x, fc, res) {
    const g = Math.tan((Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr);
    const k = 2 - 2 * res;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + g * v1;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
}

// One-pole lowpass: the soft tone shaper used inside the voices and delays.
export class OnePoleLP {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.y = 0;
    this.a = 1;
    this.setCutoff(1000);
  }

  setCutoff(fc) {
    this.a = 1 - Math.exp((-2 * Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr);
  }

  process(x) {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

// One-pole highpass (DC-blocker topology) — noise brightener for hat/snare.
export class OnePoleHP {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.px = 0;
    this.py = 0;
    this.r = 0;
    this.setCutoff(2000);
  }

  setCutoff(fc) {
    this.r = Math.exp((-2 * Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr);
  }

  process(x) {
    const y = this.r * (this.py + x - this.px);
    this.px = x;
    this.py = y;
    return y;
  }
}

// Seeded xorshift32 PRNG — the CRITICAL chain-reaction dice. Deterministic per
// seed so a loop's mutations are coherent; the engine reseeds at step 0 of
// every bar so each pass through the pattern is its own variation.
export function xorshift32(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function next() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
