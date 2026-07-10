// Breakbeat snare — the crack in the middle of the bar, plus the tiny ghost
// hits that give a chopped break its human shuffle. One voice serves both the
// `snare` and `ghost` pattern rows (a retrigger chokes the ringing hit, which
// is exactly how a tight break behaves).
//
// - body: two detuned triangle oscillators (a drum head and its overtone) with
//   a fast downward pitch blip at the front — TONE moves the pair's pitch;
// - snap: highpassed white noise over the body — SNAP is the wire/crack mix;
// - ghost: hits triggered with ghost=true come in at level*GHOST and decay
//   0.6x shorter — small, felt more than heard (per the DESIGN contract).

import { OnePoleHP } from './util.js';

const PARAMS = ['tone', 'snap', 'decay', 'ghost', 'level'];

export class Snare {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p1 = 0;
    this.p2 = 0;
    this.bodyEnv = 0;
    this.noiseEnv = 0;
    this.pitchEnv = 0; // fast blip 1 -> 0 for the front of the crack
    this.att = 1;
    this.amp = 1; // per-hit gain (velocity x ghost scaling)
    this.active = false;
    this.hp = new OnePoleHP(sampleRate);
    this.hp.setCutoff(1800);

    // canonical defaults — MUST match the DESIGN.md table / index.html values
    this.tone = 0.6; // 0..1 — body pitch
    this.snap = 0.65; // 0..1 — noise crack over the body
    this.decay = 0.16; // seconds to -60 dB
    this.ghost = 0.35; // 0..1 — level scale for ghost-row hits
    this.level = 0.8;

    this.bodyCoef = 0;
    this.noiseCoef = 0;
    this._recalc();
  }

  _recalc() {
    this.pitchCoef = Math.exp(-1 / (0.02 * this.sr)); // ~20 ms blip
    this.attStep = 1 / (0.001 * this.sr);
  }

  set(name, value) {
    if (PARAMS.includes(name)) {
      this[name] = value;
      this._recalc();
    }
  }

  // isGhost: ghost-row weak hit — level*GHOST, decay*0.6 (DESIGN contract)
  trigger(velocity = 1, isGhost = false) {
    this.amp = velocity * (isGhost ? this.ghost : 1);
    const d = this.decay * (isGhost ? 0.6 : 1);
    this.bodyCoef = Math.exp(Math.log(0.001) / (d * this.sr));
    this.noiseCoef = Math.exp(Math.log(0.001) / (d * 0.85 * this.sr));
    this.bodyEnv = 1;
    this.noiseEnv = 1;
    this.pitchEnv = 1;
    this.att = 0;
    this.p1 = 0;
    this.p2 = 0.19; // fixed offset so the pair doesn't cancel at the front
    this.active = true;
  }

  process() {
    if (!this.active) return 0;

    // body: two triangles — head at TONE, overtone a fifth-ish above
    const f1 = (160 + this.tone * 130) * (1 + 0.5 * this.pitchEnv);
    const f2 = f1 * 1.53;
    this.p1 += f1 / this.sr;
    if (this.p1 >= 1) this.p1 -= 1;
    this.p2 += f2 / this.sr;
    if (this.p2 >= 1) this.p2 -= 1;
    const tri1 = 1 - 4 * Math.abs(this.p1 - 0.5);
    const tri2 = 1 - 4 * Math.abs(this.p2 - 0.5);
    if (this.att < 1) this.att = Math.min(1, this.att + this.attStep);
    const body = (tri1 * 0.7 + tri2 * 0.4) * this.bodyEnv * this.att;

    // snap: highpassed noise crack riding the same hit
    const noise = this.hp.process(Math.random() * 2 - 1) * this.noiseEnv;

    const mix = body * (1 - this.snap * 0.4) + noise * (0.25 + this.snap * 1.05);
    this.bodyEnv *= this.bodyCoef;
    this.noiseEnv *= this.noiseCoef;
    this.pitchEnv *= this.pitchCoef;
    if (this.bodyEnv < 1e-4 && this.noiseEnv < 1e-4) this.active = false;

    // soft-bound so hot snap settings can't spike past the bus
    return Math.tanh(mix * this.amp * 1.1) * this.level;
  }
}
