// The audio engine. Runs on the audio thread (AudioWorklet), which owns the
// master clock and the 16-step sequencer — same architecture as minima galaxy
// / rain / drift / city. The UI thread only sends parameter/pattern messages
// through the port and receives the current step back for the playhead.
//
// fission's identity over its siblings: chopped-breaks jungle at 160 BPM —
// punch kick, cracking snare with tiny ghost notes, fine hat grid, a rolling
// Reese sub with per-step pitch, and a thin bitcrush crust on the drum bus.
// CRITICAL is the hero macro — the chain reaction: snare/hat hits split into
// 2/3/4 retrigger fragments (probability and split count rise with critical),
// ghost density climbs, the delay feedback creeps up, the drum-bus filter
// vents open, and past 0.7 a Geiger counter starts ticking. The dice are a
// seeded xorshift reseeded at step 0, so each bar is a coherent variation —
// and critical=0 is ALWAYS the exact programmed pattern.
//
// This file is the only place AudioWorklet globals (sampleRate,
// AudioWorkletProcessor, registerProcessor) are referenced; the dsp/ modules
// stay pure so Node can import them for the offline render tests.

import { Kick } from './dsp/kick.js';
import { Snare } from './dsp/snare.js';
import { Hat } from './dsp/hat.js';
import { Bass } from './dsp/bass.js';
import { DubDelay, Reverb, Ducker, Filter, Bitcrush, Geiger } from './dsp/effects.js';
import { xorshift32 } from './dsp/util.js';

const STEPS = 16;

class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.playing = false;
    this.bpm = 160; // canonical default
    this.stepIndex = 0;
    this.sampleInStep = 0;
    this.swing = 0.06; // canonical default (fx `swing`)

    this.voices = {
      kick: new Kick(sampleRate),
      snare: new Snare(sampleRate),
      hat: new Hat(sampleRate),
      bass: new Bass(sampleRate),
    };

    this.delay = new DubDelay(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.ducker = new Ducker(sampleRate);
    this.drumFilter = new Filter(sampleRate);
    this.crush = new Bitcrush();
    this.geiger = new Geiger(sampleRate);
    this.syncDelay(); // dotted eighth (3 sixteenth steps)

    // trigger rows (0/1). The UI pushes its own state on startup; these are
    // the canonical defaults from DESIGN.md in case it doesn't. The hat has
    // TWO rows (closed/open) sharing one voice — open wins on a shared step
    // and chokes the closed tail; the snare likewise owns `snare` + `ghost`.
    this.patterns = {
      kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      ghost: [0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1],
      hatC: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0],
      hatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
      bass: [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
    };
    // per-step semitone offsets for the bass (-12..+12), canonical defaults
    this.bassNotes = [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, -2, 0, 0, 0, 0];

    // FX base values the UI can override. CRITICAL modulates on top of these.
    this.delaySend = 0.25; // fx `delay`
    this.delayFeedback = 0.45; // fx `feedback`
    this.reverbSend = 0.2; // fx `reverb`
    // fx `crush` and `duck` live directly on their processors (defaults there)

    // CRITICAL (0 = stable core, 1 = meltdown): retriggers, ghost density,
    // delay feedback, drum filter, geiger. Dice reseed at step 0 each bar.
    this.critical = 0;
    this.rng = null;
    this.loopSeed = 22222;
    this.retrigs = []; // scheduled sub-step retrigger hits {in, track, vel}

    this.muted = { kick: false, snare: false, hat: false, bass: false };
    this.master = 0.85;

    this.applyCritical();
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  get samplesPerStep() {
    // 16th notes: one beat is 60/bpm seconds, one step is a quarter of that.
    return Math.max(1, Math.round(((60 / this.bpm) * sampleRate) / 4));
  }

  // swing: even steps stretch, odd steps shrink — pairs keep the same total
  stepLength(index) {
    const sps = this.samplesPerStep;
    return Math.max(1, Math.round(sps * (index % 2 === 0 ? 1 + this.swing : 1 - this.swing)));
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'play':
        this.stepIndex = 0;
        this.sampleInStep = 0;
        this.retrigs.length = 0;
        this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        this.retrigs.length = 0;
        break;
      case 'bpm':
        this.bpm = Math.min(190, Math.max(60, msg.value));
        this.syncDelay();
        break;
      case 'master':
        this.master = Math.min(1, Math.max(0, msg.value));
        break;
      case 'mute':
        if (msg.track in this.muted) this.muted[msg.track] = !!msg.value;
        break;
      case 'steps':
        if (this.patterns[msg.track]) this.patterns[msg.track] = msg.steps;
        break;
      case 'param':
        if (this.voices[msg.track]) this.voices[msg.track].set(msg.name, msg.value);
        break;
      case 'fx':
        this.setFxParam(msg.name, msg.value);
        break;
      case 'critical':
        this.critical = Math.min(1, Math.max(0, msg.value));
        this.applyCritical();
        break;
      case 'bassNotes':
        if (Array.isArray(msg.notes) && msg.notes.length === STEPS) this.bassNotes = msg.notes;
        break;
    }
  }

  syncDelay() {
    // dotted eighth = 3 sixteenth steps — the jungle throw
    this.delay.setTimeSamples(3 * this.samplesPerStep);
  }

  setFxParam(name, value) {
    switch (name) {
      case 'delay':
        this.delaySend = value;
        break;
      case 'feedback':
        this.delayFeedback = value;
        this.applyCritical();
        break;
      case 'reverb':
        this.reverbSend = value;
        break;
      case 'crush':
        this.crush.set('amount', value);
        break;
      case 'duck':
        this.ducker.set('amount', value);
        break;
      case 'swing':
        this.swing = Math.min(0.3, Math.max(0, value));
        break;
    }
  }

  // fold CRITICAL into the continuous targets: the delay feedback creeps up a
  // little, the drum-bus filter vents open with a touch of resonance, and the
  // geiger arms past 0.7. All return home exactly at 0.
  applyCritical() {
    const c = this.critical;
    this.delay.feedback = Math.min(0.9, this.delayFeedback + c * 0.12);
    this.drumFilter.set(9000 + (16000 - 9000) * c, c * 0.12);
    this.geiger.density = c > 0.7 ? (c - 0.7) / 0.3 : 0;
  }

  // reseed the chain-reaction dice — called at step 0 of every bar, so each
  // pass is its own coherent variation (drift DESCENT flow, but seeded).
  reseed() {
    this.loopSeed = (this.loopSeed * 1664525 + 1013904223) >>> 0;
    this.rng = xorshift32(this.loopSeed ^ 0x9e3779b9);
  }

  // pick a retrigger split: 2 at low critical, up to 4 near meltdown
  pickDiv(c) {
    const span = 1 + Math.floor(c * 2.01); // 1..3 choices
    return Math.min(4, 2 + Math.floor(this.rng() * span));
  }

  triggerStep(index) {
    if (index === 0 || !this.rng) this.reseed();
    const c = this.critical;
    const len = this.stepLength(index);

    // KICK — the anchor; never mutated, never ducked
    if (this.patterns.kick[index]) {
      this.voices.kick.trigger(1);
      this.ducker.trigger();
    }

    // SNARE — main crack + ghosts. CRITICAL adds ghosts into empty steps
    // (density up, additive only) and splits main hits into 2/3/4 fragments.
    const snareHit = this.patterns.snare[index];
    let ghostHit = this.patterns.ghost[index];
    if (!snareHit && !ghostHit && c > 0 && this.rng() < c * 0.35) ghostHit = 1;
    if (snareHit) {
      this.voices.snare.trigger(1, false);
      if (c > 0 && this.rng() < c * 0.5) {
        const div = this.pickDiv(c);
        for (let k = 1; k < div; k++) {
          // fragments ramp up toward the next hit — the classic jungle roll
          const vel = 0.55 + 0.35 * (k / (div - 1));
          this.retrigs.push({ in: Math.round((len * k) / div), track: 'snare', vel });
        }
      }
    } else if (ghostHit) {
      this.voices.snare.trigger(1, true); // level*ghost, decay*0.6 in the voice
    }

    // HAT — open wins a shared step and chokes the closed tail (one voice).
    // CRITICAL splits closed ticks into ratchets.
    const open = this.patterns.hatO[index];
    const closed = this.patterns.hatC[index];
    if (open) {
      this.voices.hat.trigger(true, 1);
    } else if (closed) {
      this.voices.hat.trigger(false, 0.9);
      if (c > 0 && this.rng() < c * 0.55) {
        const div = this.pickDiv(c);
        for (let k = 1; k < div; k++) {
          this.retrigs.push({ in: Math.round((len * k) / div), track: 'hatC', vel: 0.65 });
        }
      }
    }

    // BASS — programmed steps only, pitched by the bassNotes row over ROOT
    if (this.patterns.bass[index]) {
      this.voices.bass.trigger(1, this.bassNotes[index] | 0);
    }
  }

  // fire any scheduled retrigger fragments whose countdown has elapsed
  runRetrigs() {
    for (let j = this.retrigs.length - 1; j >= 0; j--) {
      const r = this.retrigs[j];
      if (--r.in <= 0) {
        if (r.track === 'snare') this.voices.snare.trigger(r.vel, false);
        else this.voices.hat.trigger(false, r.vel);
        this.retrigs[j] = this.retrigs[this.retrigs.length - 1];
        this.retrigs.pop();
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];

    for (let i = 0; i < left.length; i++) {
      if (this.playing) {
        if (this.sampleInStep === 0) {
          this.triggerStep(this.stepIndex);
          this.port.postMessage({ type: 'step', index: this.stepIndex });
        }
        if (this.retrigs.length) this.runRetrigs();
        this.sampleInStep++;
        if (this.sampleInStep >= this.stepLength(this.stepIndex)) {
          this.sampleInStep = 0;
          this.stepIndex = (this.stepIndex + 1) % STEPS;
        }
      }

      const kickS = this.voices.kick.process() * (this.muted.kick ? 0 : 1);
      const snareS = this.voices.snare.process() * (this.muted.snare ? 0 : 1);
      const hatS = this.voices.hat.process() * (this.muted.hat ? 0 : 1);
      const bassS = this.voices.bass.process() * (this.muted.bass ? 0 : 1);
      const tick = this.playing ? this.geiger.process() * 0.25 : 0;

      // sends: the snare is the main throw into the dotted-eighth delay, the
      // hat a lighter one, the bass just a shade; the reverb is a small plate
      // centred on the snare with a little of the delay tail folded in.
      const delayOut = this.delay.process(
        (snareS * 0.7 + hatS * 0.35 + bassS * 0.12) * this.delaySend
      );
      const verbOut = this.reverb.process((snareS * 0.8 + delayOut * 0.35) * this.reverbSend);

      // sidechain: everything except the kick breathes when the kick lands
      const duck = this.ducker.process();

      // drum bus: kick (unducked) + snare/hat/geiger, through the bitcrush
      // crust and the CRITICAL-vented lowpass. The kick rides inside so the
      // crush glues the whole kit, but it skips the duck.
      const drums = this.drumFilter.process(
        this.crush.process(kickS + (snareS + hatS + tick) * duck)
      );

      // the sub and the wet returns duck under the kick, then everything meets
      const mix = drums + (bassS + delayOut + verbOut) * duck;

      // master soft-clip — the contract: master = tanh(mix * master)
      left[i] = Math.tanh(mix * this.master);
      right[i] = left[i];
    }
    return true;
  }
}

registerProcessor('fission-engine', EngineProcessor);
