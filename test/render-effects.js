// Offline sanity checks for the FX bus (delay spacing, reverb tail, ducker,
// drum filter, bitcrush, geiger) plus a render of the REAL engine: the
// engine-processor is imported under a tiny AudioWorklet shim and driven for
// four bars at the canonical defaults — once at critical=0 and once at
// critical=0.8 — writing the listenable loops to test/out/.

import { DubDelay, Reverb, Ducker, Filter, Bitcrush, Geiger } from '../src/audio/dsp/effects.js';
import { toWav, stats, rms } from './wav.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SR = 48000;
let ok = true;

function check(cond, label) {
  if (!cond) {
    ok = false;
    console.error(`FAIL: ${label}`);
  }
}

mkdirSync(join(__dirname, 'out'), { recursive: true });

// ---- delay: an impulse should come back after exactly timeSamples ----
{
  const delay = new DubDelay(SR);
  delay.setTimeSamples(10000);
  delay.level = 1;
  const buf = new Float32Array(40000);
  for (let i = 0; i < buf.length; i++) buf[i] = delay.process(i === 0 ? 1 : 0);

  let firstEcho = -1;
  for (let i = 1; i < buf.length; i++) {
    if (Math.abs(buf[i]) > 0.01) {
      firstEcho = i;
      break;
    }
  }
  check(firstEcho === 10000, `delay: first echo at timeSamples (got ${firstEcho})`);
  const e1 = Math.abs(buf[10000]);
  let e2 = 0;
  for (let i = 19900; i < 20200; i++) e2 = Math.max(e2, Math.abs(buf[i]));
  check(e2 > 0.005 && e2 < e1, `delay: feedback echo decays (${e1.toFixed(2)} -> ${e2.toFixed(2)})`);
  console.log('delay ok');
}

// ---- reverb: impulse tail should ring then decay, no NaN ----
{
  const reverb = new Reverb(SR);
  reverb.set('decay', 1.4);
  reverb.set('level', 1);
  const buf = new Float32Array(SR * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = reverb.process(i === 0 ? 1 : 0);

  const early = rms(buf, 0, SR * 0.2);
  const mid = rms(buf, SR * 0.8, SR * 1.0);
  const late = rms(buf, SR * 2.5, SR * 2.8);
  check(!buf.some(Number.isNaN), 'reverb: no NaN');
  check(early > 0, 'reverb: produces a tail');
  check(mid < early && late < mid, 'reverb: tail decays');
  console.log('reverb ok');
}

// ---- ducker: gain dips on trigger and recovers ----
{
  const ducker = new Ducker(SR);
  ducker.set('amount', 0.6);
  ducker.set('release', 0.1);
  ducker.trigger();
  const g0 = ducker.process();
  for (let i = 0; i < SR * 0.5 - 1; i++) ducker.process();
  const gLate = ducker.process();
  check(Math.abs(g0 - 0.4) < 0.01, `ducker: dips to 1-amount (got ${g0.toFixed(3)})`);
  check(gLate > 0.99, `ducker: recovers (got ${gLate.toFixed(3)})`);
  console.log('ducker ok');
}

// ---- drum filter: a low cutoff should attenuate highs, an open one passes --
{
  const tone = (fHz, cutoff) => {
    const f = new Filter(SR);
    f.set(cutoff, 0);
    const buf = new Float32Array(SR);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = f.process(Math.sin((2 * Math.PI * fHz * i) / SR));
    }
    return rms(buf, SR * 0.5, SR); // settled portion
  };
  const highThroughClosed = tone(6000, 500);
  const highThroughOpen = tone(6000, 16000);
  check(!Number.isNaN(highThroughClosed), 'drum filter: no NaN');
  check(
    highThroughClosed < highThroughOpen * 0.2,
    `drum filter: closed cutoff attenuates highs (${highThroughClosed.toFixed(3)} vs ${highThroughOpen.toFixed(3)})`
  );
  console.log('drum filter ok');
}

// ---- bitcrush: amount 0 is a clean passthrough, cranked it mangles ----
{
  const sine = (i) => 0.7 * Math.sin((2 * Math.PI * 300 * i) / SR);
  const clean = new Bitcrush();
  clean.set('amount', 0);
  let cleanDiff = 0;
  for (let i = 0; i < SR * 0.2; i++) cleanDiff = Math.max(cleanDiff, Math.abs(clean.process(sine(i)) - sine(i)));
  check(cleanDiff < 1e-9, `bitcrush: amount 0 passes clean (diff ${cleanDiff.toExponential(1)})`);

  const dirty = new Bitcrush();
  dirty.set('amount', 0.8);
  const buf = new Float32Array(SR * 0.2);
  let meanDiff = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = dirty.process(sine(i));
    meanDiff += Math.abs(buf[i] - sine(i));
  }
  meanDiff /= buf.length;
  const s = stats(buf);
  check(!s.hasNaN, 'bitcrush: no NaN');
  check(s.peak <= 1.0, `bitcrush: bounded (${s.peak.toFixed(3)})`);
  check(meanDiff > 0.01, `bitcrush: cranked amount mangles (mean diff ${meanDiff.toFixed(4)})`);
  console.log('bitcrush ok');
}

// ---- geiger: silent at density 0, quiet random ticks at density 1 ----
{
  const quiet = new Geiger(SR);
  quiet.density = 0;
  let qPeak = 0;
  for (let i = 0; i < SR; i++) qPeak = Math.max(qPeak, Math.abs(quiet.process()));
  check(qPeak === 0, `geiger: density 0 is silent (peak ${qPeak})`);

  const hot = new Geiger(SR);
  hot.density = 1;
  const buf = new Float32Array(SR * 2);
  for (let i = 0; i < buf.length; i++) buf[i] = hot.process();
  const s = stats(buf);
  check(!s.hasNaN, 'geiger: no NaN');
  check(s.peak > 0.01 && s.peak < 0.6, `geiger: ticks present, small (peak ${s.peak.toFixed(3)})`);
  const r = rms(buf, 0, buf.length);
  check(r < 0.05, `geiger: stays a background crackle (rms ${r.toFixed(4)})`);
  console.log('geiger ok');
}

// ---- the real engine, four bars at the canonical defaults ------------------
// Shim the AudioWorklet globals, import the actual engine-processor, and run
// its process() loop — the same code path the app ships.
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {}, onmessage: null };
  }
};
let EngineClass = null;
globalThis.registerProcessor = (name, cls) => {
  check(name === 'fission-engine', `engine: registers as fission-engine (got ${name})`);
  EngineClass = cls;
};
await import('../src/audio/engine-processor.js');
check(!!EngineClass, 'engine: registerProcessor called');

function renderLoop(critical, bars) {
  const e = new EngineClass();
  const steps = [];
  e.port.postMessage = (m) => {
    if (m.type === 'step') steps.push(m.index);
  };
  e.onMessage({ type: 'critical', value: critical });
  e.onMessage({ type: 'play' });
  const total = e.samplesPerStep * 16 * bars;
  const buf = new Float32Array(total);
  const block = 128;
  const L = new Float32Array(block);
  const R = new Float32Array(block);
  for (let off = 0; off < total; off += block) {
    e.process([], [[L, R]]);
    buf.set(L.subarray(0, Math.min(block, total - off)), off);
  }
  return { buf, steps };
}

{
  const bars = 4;
  const cold = renderLoop(0, bars);
  const hot = renderLoop(0.8, bars);

  for (const [label, r] of [
    ['crit0', cold],
    ['crit08', hot],
  ]) {
    const s = stats(r.buf);
    check(!s.hasNaN, `engine ${label}: no NaN`);
    check(s.peak <= 1.0, `engine ${label}: bounded (peak ${s.peak.toFixed(3)})`);
    check(s.peak > 0.15, `engine ${label}: not silent (peak ${s.peak.toFixed(3)})`);
    const r2 = rms(r.buf, 0, r.buf.length);
    check(r2 > 0.01, `engine ${label}: audible energy (rms ${r2.toFixed(4)})`);
    check(
      r.steps.length === 16 * bars && r.steps[0] === 0 && r.steps[17] === 1,
      `engine ${label}: sequencer stepped ${16 * bars} times (got ${r.steps.length})`
    );
    console.log(`engine ${label}: peak ${s.peak.toFixed(3)}, rms ${r2.toFixed(4)}`);
  }

  // CRITICAL must actually change the output: retriggers + ghosts + filter
  let diff = 0;
  for (let i = 0; i < cold.buf.length; i++) diff += Math.abs(cold.buf[i] - hot.buf[i]);
  diff /= cold.buf.length;
  check(diff > 1e-3, `engine: critical=0.8 mutates the loop (mean diff ${diff.toFixed(5)})`);

  writeFileSync(join(__dirname, 'out', 'fission-loop-crit0.wav'), toWav(cold.buf, SR));
  writeFileSync(join(__dirname, 'out', 'fission-loop-crit08.wav'), toWav(hot.buf, SR));
  console.log('engine loops written (fission-loop-crit0.wav, fission-loop-crit08.wav)');
}

console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
