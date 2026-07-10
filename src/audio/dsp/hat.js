// Hi-hat — the fine-grained tick grid of the break. One voice serves both the
// closed and the open pattern rows: a single trigger(open, vel) call retriggers
// the same envelope, so any new hit chokes the ringing one. The engine sends
// the open hit when both rows land on a step (open wins), and an open hat is
// choked by the next closed tick exactly like a real pair of cymbals.
//
// The tone is a 606-ish metallic cluster: six square oscillators at inharmonic
// frequencies, blended with a little white noise, then highpassed at TONE.
// Two decay times — a tight tick (decayC) for closed, a wash (decayO) for open.

import { OnePoleHP } from './util.js';

const PARAMS = ['tone', 'decayC', 'decayO', 'level'];

// inharmonic cluster — roughly a 808/606 ratio set pushed up into the metal
const FREQS = [3229, 4581, 5723, 6893, 8117, 9463];

export class Hat {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.env = 0;
    this.decayCoef = 0;
    this.active = false;
    this.hp = new OnePoleHP(sampleRate);
    this.phases = new Float64Array([0.11, 0.37, 0.58, 0.73, 0.29, 0.91]);

    // canonical defaults — MUST match the DESIGN.md table / index.html values
    this.tone = 0.6; // 0..1 — highpass position (3k..12k, exponential)
    this.decayC = 0.045; // closed decay to -60 dB
    this.decayO = 0.28; // open decay to -60 dB
    this.level = 0.5;
    this._recalc();
  }

  _recalc() {
    this.hp.setCutoff(3000 * Math.pow(2, this.tone * 2)); // 3 kHz .. 12 kHz
    this.coefC = Math.exp(Math.log(0.001) / (this.decayC * this.sr));
    this.coefO = Math.exp(Math.log(0.001) / (this.decayO * this.sr));
  }

  set(name, value) {
    if (PARAMS.includes(name)) {
      this[name] = value;
      this._recalc();
    }
  }

  // open: boolean — long wash vs tight tick; vel: 0..1.
  // Retriggering ALWAYS restarts the envelope => new hit chokes the old one.
  trigger(open, velocity = 1) {
    this.env = velocity;
    this.decayCoef = open ? this.coefO : this.coefC;
    this.active = true;
  }

  process() {
    if (!this.active) return 0;
    // metallic cluster: six squares summed (aliasing is fine up here — it just
    // adds to the noise-like shimmer this voice wants anyway)
    let m = 0;
    for (let i = 0; i < 6; i++) {
      this.phases[i] += FREQS[i] / this.sr;
      if (this.phases[i] >= 1) this.phases[i] -= 1;
      m += this.phases[i] < 0.5 ? 1 : -1;
    }
    m /= 6;
    const noise = Math.random() * 2 - 1;
    const s = this.hp.process(m * 0.75 + noise * 0.5) * this.env;
    this.env *= this.decayCoef;
    if (this.env < 1e-4) this.active = false;
    return s * this.level;
  }
}
