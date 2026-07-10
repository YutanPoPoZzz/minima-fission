// Offline sanity checks for the fission voices: kick, snare (+ghost), hat,
// and the Reese bass. Renders each to test/out/*.wav and verifies the
// numbers: bounded output, no NaN, decay behaviour, tune/tone response,
// ghost scaling, choke, detune churn, glide, and per-step pitch.

import { Kick } from '../src/audio/dsp/kick.js';
import { Snare } from '../src/audio/dsp/snare.js';
import { Hat } from '../src/audio/dsp/hat.js';
import { Bass } from '../src/audio/dsp/bass.js';
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

// upward zero crossings inside a window -> rough pitch
function zeroCrossFreq(buf, from, to) {
  let n = 0;
  for (let i = from + 1; i < to; i++) {
    if (buf[i - 1] < 0 && buf[i] >= 0) n++;
  }
  return (n * SR) / (to - from);
}

// window "brightness" = rms(first-difference)/rms — a crude spectral-centroid
// proxy used for the tone/snap/cutoff checks
function brightness(arr, from, to) {
  let dsum = 0;
  for (let i = from + 1; i < to; i++) {
    const dd = arr[i] - arr[i - 1];
    dsum += dd * dd;
  }
  return Math.sqrt(dsum / (to - from)) / (rms(arr, from, to) + 1e-9);
}

// ---- kick: punch, sweep landing on TUNE, decay ----
{
  const kick = new Kick(SR);
  const buf = new Float32Array(SR);
  kick.trigger(1);
  for (let i = 0; i < buf.length; i++) buf[i] = kick.process();

  const s = stats(buf);
  check(!s.hasNaN, 'kick: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.2, `kick: peak in range (${s.peak.toFixed(3)})`);
  const early = rms(buf, 0, SR * 0.1);
  const late = rms(buf, SR * 0.5, SR * 0.7);
  check(late < early * 0.05, 'kick: decays');

  // TUNE: after the sweep settles the sine should sit near tune (48 Hz)
  const f48 = zeroCrossFreq(buf, SR * 0.08, SR * 0.18);
  check(f48 > 40 && f48 < 64, `kick: settles near TUNE=48 (${f48.toFixed(1)} Hz)`);
  const k65 = new Kick(SR);
  k65.set('tune', 65);
  const b65 = new Float32Array(SR * 0.25);
  k65.trigger(1);
  for (let i = 0; i < b65.length; i++) b65[i] = k65.process();
  const f65 = zeroCrossFreq(b65, SR * 0.08, SR * 0.18);
  check(f65 > f48 + 8, `kick: TUNE raises pitch (${f48.toFixed(1)} -> ${f65.toFixed(1)} Hz)`);

  // PUNCH: more punch = a louder front transient (click) in the first 5 ms
  const front = (punch) => {
    const k = new Kick(SR);
    k.set('punch', punch);
    k.trigger(1);
    const o = new Float32Array(SR * 0.05);
    for (let i = 0; i < o.length; i++) o[i] = k.process();
    return brightness(o, 0, SR * 0.005);
  };
  const soft = front(0);
  const hard = front(1);
  check(hard > soft * 1.3, `kick: PUNCH sharpens the front (${soft.toFixed(3)} -> ${hard.toFixed(3)})`);

  writeFileSync(join(__dirname, 'out', 'kick.wav'), toWav(buf, SR));
  console.log(`kick ok (peak ${s.peak.toFixed(3)}, tune ${f48.toFixed(1)} Hz)`);
}

// ---- snare: crack + decay, ghost hits scaled by GHOST, SNAP brightens ----
{
  const snare = new Snare(SR);
  const buf = new Float32Array(SR * 0.75);
  snare.trigger(1, false); // main crack at 0
  for (let i = 0; i < SR * 0.4; i++) buf[i] = snare.process();
  snare.trigger(1, true); // ghost at 0.4 s
  for (let i = SR * 0.4; i < buf.length; i++) buf[i] = snare.process();

  const s = stats(buf);
  check(!s.hasNaN, 'snare: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.2, `snare: peak in range (${s.peak.toFixed(3)})`);
  const tail = rms(buf, SR * 0.3, SR * 0.38);
  check(tail < 0.005, 'snare: main hit decays fast');

  // GHOST: the ghost hit peaks well below the main hit (level*ghost=0.35)
  let mainPeak = 0;
  for (let i = 0; i < SR * 0.1; i++) mainPeak = Math.max(mainPeak, Math.abs(buf[i]));
  let ghostPeak = 0;
  for (let i = SR * 0.4; i < SR * 0.5; i++) ghostPeak = Math.max(ghostPeak, Math.abs(buf[i]));
  check(
    ghostPeak > 0.02 && ghostPeak < mainPeak * 0.6,
    `snare: ghost is a weak hit (main ${mainPeak.toFixed(3)}, ghost ${ghostPeak.toFixed(3)})`
  );

  // SNAP: more snap = more highpassed noise = brighter hit
  const snapEdge = (snap) => {
    const sn = new Snare(SR);
    sn.set('snap', snap);
    sn.trigger(1, false);
    const o = new Float32Array(SR * 0.12);
    for (let i = 0; i < o.length; i++) o[i] = sn.process();
    return brightness(o, 0, o.length);
  };
  const dull = snapEdge(0);
  const crack = snapEdge(1);
  check(crack > dull * 1.3, `snare: SNAP brightens (${dull.toFixed(3)} -> ${crack.toFixed(3)})`);

  writeFileSync(join(__dirname, 'out', 'snare.wav'), toWav(buf, SR));
  console.log(`snare ok (peak ${s.peak.toFixed(3)}, ghost/main ${(ghostPeak / mainPeak).toFixed(2)})`);
}

// ---- hat: closed tick vs open wash, choke, TONE brightens ----
{
  const hat = new Hat(SR);
  const buf = new Float32Array(SR);
  hat.trigger(false, 1); // closed at 0
  for (let i = 0; i < SR * 0.25; i++) buf[i] = hat.process();
  hat.trigger(true, 1); // open at 0.25 s
  for (let i = SR * 0.25; i < SR; i++) buf[i] = hat.process();

  const s = stats(buf);
  check(!s.hasNaN, 'hat: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.02, `hat: peak in range (${s.peak.toFixed(3)})`);
  const closedTail = rms(buf, SR * 0.1, SR * 0.15); // 100 ms after the closed tick
  const openTail = rms(buf, SR * 0.45, SR * 0.5); // 200 ms after the open hat
  check(closedTail < 0.005, 'hat: closed tick decays fast');
  check(openTail > closedTail * 3, 'hat: open rings longer than closed');

  // CHOKE: a closed tick right after an open hit must kill the open tail —
  // compare the tail level with and without the choking tick
  const renderChoke = (choke) => {
    const h = new Hat(SR);
    h.trigger(true, 1);
    const o = new Float32Array(SR * 0.3);
    for (let i = 0; i < o.length; i++) {
      if (choke && i === Math.floor(SR * 0.06)) h.trigger(false, 1);
      o[i] = h.process();
    }
    return rms(o, SR * 0.15, SR * 0.25);
  };
  const rung = renderChoke(false);
  const choked = renderChoke(true);
  check(choked < rung * 0.4, `hat: retrigger chokes the tail (${rung.toFixed(4)} -> ${choked.toFixed(4)})`);

  // TONE: higher tone = higher highpass = brighter hiss
  const toneEdge = (tone) => {
    const h = new Hat(SR);
    h.set('tone', tone);
    h.trigger(true, 1);
    const o = new Float32Array(SR * 0.15);
    for (let i = 0; i < o.length; i++) o[i] = h.process();
    return brightness(o, 0, o.length);
  };
  const dark = toneEdge(0);
  const bright = toneEdge(1);
  check(bright > dark * 1.1, `hat: TONE brightens (${dark.toFixed(3)} -> ${bright.toFixed(3)})`);

  writeFileSync(join(__dirname, 'out', 'hat.wav'), toWav(buf, SR));
  console.log(`hat ok (peak ${s.peak.toFixed(3)}, choke ${rung.toFixed(4)}->${choked.toFixed(4)})`);
}

// ---- bass: Reese churn, decay, per-step pitch, glide, cutoff ----
{
  const bass = new Bass(SR);
  const buf = new Float32Array(SR * 2);
  bass.trigger(1, 0);
  for (let i = 0; i < SR; i++) buf[i] = bass.process();
  bass.trigger(1, 3); // the +3 step from the default bassNotes
  for (let i = SR; i < buf.length; i++) buf[i] = bass.process();

  const s = stats(buf);
  check(!s.hasNaN, 'bass: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.1, `bass: peak in range (${s.peak.toFixed(3)})`);
  const early = rms(buf, 0, SR * 0.1);
  const late = rms(buf, SR * 0.8, SR * 0.95);
  check(late < early * 0.2, 'bass: note decays');
  writeFileSync(join(__dirname, 'out', 'bass.wav'), toWav(buf, SR));

  // NOTE OFFSET: +12 semitones must double the fundamental. detune off and the
  // same waveform shape at 2x speed doubles the zero-cross count exactly.
  const renderNote = (note) => {
    const b = new Bass(SR);
    b.set('detune', 0);
    b.set('reso', 0);
    b.set('cutoff', 2000);
    b.set('decay', 1);
    b.trigger(1, note);
    const o = new Float32Array(SR * 0.5);
    for (let i = 0; i < o.length; i++) o[i] = b.process();
    return zeroCrossFreq(o, SR * 0.05, SR * 0.45);
  };
  const fLow = renderNote(0);
  const fHigh = renderNote(12);
  const ratio = fHigh / fLow;
  check(ratio > 1.7 && ratio < 2.35, `bass: +12 doubles pitch (${fLow.toFixed(1)} -> ${fHigh.toFixed(1)} Hz)`);

  // GLIDE: after a retrigger to +12 the (internal, one-pole-glided) frequency
  // must still be climbing partway, then land on the target.
  const g = new Bass(SR);
  g.set('glide', 0.12);
  g.set('decay', 1);
  g.trigger(1, 0);
  for (let i = 0; i < SR * 0.05; i++) g.process();
  const fStart = g.freq;
  g.trigger(1, 12);
  for (let i = 0; i < SR * 0.06; i++) g.process(); // mid-glide (~half a time constant)
  const fMid = g.freq;
  for (let i = 0; i < SR; i++) g.process(); // glide fully arrived
  const fEnd = g.freq;
  check(
    fMid > fStart * 1.1 && fMid < fEnd * 0.92 && Math.abs(fEnd / (fStart * 2) - 1) < 0.02,
    `bass: GLIDE slides pitch (${fStart.toFixed(1)} -> ${fMid.toFixed(1)} -> ${fEnd.toFixed(1)} Hz)`
  );

  // CUTOFF: a higher lowpass cutoff lets more edge through
  const renderCut = (cut) => {
    const b = new Bass(SR);
    b.set('cutoff', cut);
    b.set('decay', 1);
    b.trigger(1, 0);
    const o = new Float32Array(SR * 0.3);
    for (let i = 0; i < o.length; i++) o[i] = b.process();
    return brightness(o, 0, o.length);
  };
  const darkB = renderCut(100);
  const brightB = renderCut(2000);
  check(brightB > darkB * 1.2, `bass: CUTOFF opens the tone (${darkB.toFixed(3)} -> ${brightB.toFixed(3)})`);

  // DETUNE: the Reese churn — with detune up, the amplitude envelope must
  // wobble (beating) far more than the detune-0 render. Windowed log-RMS with
  // the exponential decay trend removed by linear regression.
  const renderDet = (det) => {
    const b = new Bass(SR);
    b.set('detune', det);
    b.set('decay', 1);
    b.trigger(1, 0);
    const o = new Float32Array(SR * 1.4);
    for (let i = 0; i < o.length; i++) o[i] = b.process();
    return o;
  };
  const beatDev = (arr) => {
    const n = 12;
    const w = Math.floor(SR * 0.1);
    const logs = [];
    for (let k = 0; k < n; k++) logs.push(Math.log(rms(arr, k * w, (k + 1) * w) + 1e-9));
    // remove the linear (log-domain exponential decay) trend
    const xm = (n - 1) / 2;
    const ym = logs.reduce((a, v) => a + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let k = 0; k < n; k++) {
      num += (k - xm) * (logs[k] - ym);
      den += (k - xm) * (k - xm);
    }
    const slope = num / den;
    let varr = 0;
    for (let k = 0; k < n; k++) {
      const r = logs[k] - (ym + slope * (k - xm));
      varr += r * r;
    }
    return Math.sqrt(varr / n);
  };
  const still = beatDev(renderDet(0));
  const churn = beatDev(renderDet(0.9));
  check(churn > still * 2 && churn > 0.02, `bass: DETUNE churns (dev ${still.toFixed(4)} -> ${churn.toFixed(4)})`);

  console.log(
    `bass ok (peak ${s.peak.toFixed(3)}, +12 ratio ${ratio.toFixed(2)}, ` +
      `glide ${fStart.toFixed(1)}->${fMid.toFixed(1)}->${fEnd.toFixed(1)} Hz, churn ${still.toFixed(4)}->${churn.toFixed(4)})`
  );
}

console.log(ok ? '\nALL CHECKS PASSED — wavs in test/out/' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
