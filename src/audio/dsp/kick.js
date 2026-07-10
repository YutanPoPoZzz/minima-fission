// Jungle punch kick — all synthesised, no samples. Three parts to one hit:
//
// - body: a sine at TUNE that starts well above the landing note and sweeps
//   down fast — the chopped-breaks "boom" that reads as weight;
// - click: a very short highpassed noise transient right at the front so the
//   hit cuts through the hat clatter on small speakers;
// - DRIVE: tanh saturation on the body that squares it toward an analog thump.
//
// PUNCH here is 0..1 (per the fission contract, unlike drift's Hz value): it
// scales BOTH the pitch-drop depth and the click level, so one knob goes from
// a round sub-thud to a full smacking break kick.

import { OnePoleHP } from './util.js';

const PARAMS = ['tune', 'decay', 'punch', 'drive', 'level'];

export class Kick {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.phase = 0;
    this.env = 0; // body amplitude, decays exponentially toward 0
    this.pitchEnv = 0; // pitch sweep 1 -> 0
    this.att = 1; // short ramp so the body never clicks on its own
    this.clickEnv = 0; // the front transient
    this.active = false;
    this.hp = new OnePoleHP(sampleRate);
    this.hp.setCutoff(1500);

    // canonical defaults — MUST match the DESIGN.md table / index.html values
    this.tune = 48; // sub frequency in Hz — the landing "note"
    this.decay = 0.22; // seconds to -60 dB — tight break-kick thump
    this.punch = 0.7; // 0..1 — pitch-drop depth + click amount
    this.drive = 0.35; // 0..1 saturation on the body
    this.level = 0.9;

    this.pitchDecay = 0.035; // how fast the pitch drop settles — snappy
    this._recalc();
  }

  _recalc() {
    this.envCoef = Math.exp(Math.log(0.001) / (this.decay * this.sr));
    this.pitchCoef = Math.exp(-1 / (this.pitchDecay * this.sr));
    this.clickCoef = Math.exp(Math.log(0.001) / (0.003 * this.sr)); // ~3 ms
    this.attStep = 1 / (0.0015 * this.sr);
  }

  set(name, value) {
    if (PARAMS.includes(name)) {
      this[name] = value;
      this._recalc();
    }
  }

  trigger(velocity = 1) {
    this.env = velocity;
    this.pitchEnv = 1;
    this.clickEnv = velocity;
    this.att = 0;
    this.phase = 0;
    this.active = true;
  }

  process() {
    if (!this.active) return 0;

    // body: sine that starts (30 + punch*170) Hz above tune and dives down
    const sweep = 30 + this.punch * 170;
    const freq = this.tune + sweep * this.pitchEnv;
    this.phase += (2 * Math.PI * freq) / this.sr;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    if (this.att < 1) this.att = Math.min(1, this.att + this.attStep);
    let body = Math.sin(this.phase) * this.env * this.att;
    // DRIVE: soft-saturate, normalised so the peak stays put as it fattens
    const d = 1 + this.drive * 5;
    body = Math.tanh(body * d) / Math.tanh(d);
    this.env *= this.envCoef;
    this.pitchEnv *= this.pitchCoef;

    // click: the front tick — PUNCH brings it forward for the chopped-up feel
    let click = 0;
    if (this.clickEnv > 1e-4) {
      const amt = 0.08 + this.punch * 0.34;
      click = this.hp.process((Math.random() * 2 - 1) * this.clickEnv) * amt;
      this.clickEnv *= this.clickCoef;
    }

    if (this.env < 1e-4 && this.clickEnv < 1e-4) this.active = false;
    return (body + click) * this.level;
  }
}
