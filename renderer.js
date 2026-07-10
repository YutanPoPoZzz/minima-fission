// minima fission — UI thread. The same architecture as galaxy, reinterpreted
// as an ATOM undergoing a chain reaction, in the series' light vocabulary:
//
//   galaxy orbit rings -> ONE electron orbit ring; its 16 nodes are the steps
//                         (lit step = a green light-orb).
//   galaxy playhead    -> a NEUTRON circling the ring with a short light
//                         trail; crossing a lit node fires a FISSION flash:
//                         the node splits into two fragments, 2-3 yellow
//                         neutron rays fly out and a shockwave ring bursts.
//   galaxy planets     -> four ISOTOPE atoms (small nucleus dot + elliptical
//                         electron-shell line-art): KICK/SNARE/HATS/BASS.
//                         Tap to open the editor; muting dims the whole atom.
//   galaxy sun         -> the central NUCLEUS: a breathing cluster of glowing
//                         orbs = play/stop; its shockwave is the kick
//                         sidechain. It burns yellow-white as CRITICAL rises.
//   galaxy black hole  -> CRITICAL: a control rod, top-left. Drag up/down to
//                         pull it out; geiger ticks and neutron streaks
//                         multiply as criticality rises.
//
// Owns the AudioContext and messages the fission engine in the AudioWorklet.

const STEPS = 16;
const NS = 'http://www.w3.org/2000/svg';
const CX = 160;
const CY = 130;
const TILT = 0.42; // vertical squash of the orbit plane
const RING_R = 104; // electron orbit ring radius

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Euclidean rhythm: distribute k hits as evenly as possible across n steps,
// optionally rotated. (Local copy — the audio bundle is owned by the DSP.)
function euclid(k, n, rotate = 0) {
  const raw = [];
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    bucket += k;
    if (bucket >= n) {
      bucket -= n;
      raw.push(1);
    } else {
      raw.push(0);
    }
  }
  const first = raw.indexOf(1);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(raw[(i + first - rotate + 2 * n) % n]);
  }
  return out;
}

let audioCtx = null;
let engine = null;
let playing = false;
let bpm = 160;
let critical = 0;

// trigger rows (0/1). Six rows, four voices — snare has main + ghost rows,
// the hat has closed + open rows. Initial pattern: the DESIGN.md canonical
// breakbeat (kick on 0/10, backbeat snare, ghost shuffle, 16th hats, Reese
// bass anchored on 0/3/8/11).
const toggles = {
  kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  ghost: [0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1],
  hatC: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0],
  hatO: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
  bass: [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
};

// bass row: per-step semitone offset from ROOT, -12..+12
const bassNotes = Array.from({ length: STEPS }, () => 0);
bassNotes[3] = 3;
bassNotes[11] = -2;

function send(msg) {
  engine?.port.postMessage(msg);
  scheduleSave(); // any outgoing state change also persists (debounced)
}

function sendBassNotes() {
  send({ type: 'bassNotes', notes: bassNotes });
}

function pushAllState() {
  send({ type: 'bpm', value: bpm });
  send({ type: 'critical', value: critical });
  send({ type: 'master', value: parseFloat(document.getElementById('master-vol').value) });
  for (const [track, steps] of Object.entries(toggles)) {
    send({ type: 'steps', track, steps });
  }
  sendBassNotes();
  document.querySelectorAll('.params input[data-param]').forEach((input) => {
    sendParam(input);
  });
}

// ---- audio setup ----

async function ensureAudio() {
  if (engine) return;
  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  await audioCtx.audioWorklet.addModule('audio/engine-processor.js');
  engine = new AudioWorkletNode(audioCtx, 'fission-engine', {
    outputChannelCount: [2],
  });
  engine.connect(audioCtx.destination);
  engine.port.onmessage = (e) => {
    if (e.data.type === 'step') movePlayhead(e.data.index);
  };
  pushAllState();
}

// ---- atom scene ----

// the four isotope atoms floating around the nucleus (galaxy's planets)
const ISO = {
  bass: { x: 96, y: 46, s: 1.0, label: 'BASS' },
  hat: { x: 240, y: 52, s: 0.85, label: 'HATS' },
  kick: { x: 58, y: 208, s: 1.15, label: 'KICK' },
  snare: { x: 262, y: 202, s: 1.0, label: 'SNARE' },
};

const space = document.getElementById('space');
const ringNodes = [];
const nodePos = [];
const dotMeta = []; // background dust particles that wander
const isotopeEls = {};
const selectionRings = {};
let neutronG = null;
let fissionG = null;
let fissionRays = null;
let sunIcon = null;
let sunEl = null;
let sunHazeEl = null;
let nucleusScaleEl = null;
let nucleusBurnEl = null;
let burstEl = null;
let cometA = null;
let cometB = null;
const geigerTicks = [];

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// project a point on the tilted orbit plane; depth is 0 at the back, 1 in front
function proj(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return {
    x: CX + r * Math.cos(a),
    y: CY + TILT * r * Math.sin(a),
    depth: (Math.sin(a) + 1) / 2,
  };
}

// atmosphere: gradients, glow/grain filters, haze banks, neutron streaks
function buildAtmosphere() {
  const defs = el('defs');

  const glow = el('filter', { id: 'glow', x: '-120%', y: '-120%', width: '340%', height: '340%' });
  glow.appendChild(el('feGaussianBlur', { stdDeviation: 3.2, result: 'b' }));
  const merge = el('feMerge');
  merge.appendChild(el('feMergeNode', { in: 'b' }));
  merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(merge);
  defs.appendChild(glow);

  // pale green chamber haze
  const haze = el('radialGradient', { id: 'haze', cx: '50%', cy: '46%', r: '52%' });
  haze.appendChild(el('stop', { offset: '0%', 'stop-color': '#d7f2e2', 'stop-opacity': 0.3 }));
  haze.appendChild(el('stop', { offset: '55%', 'stop-color': '#bfe4d0', 'stop-opacity': 0.1 }));
  haze.appendChild(el('stop', { offset: '100%', 'stop-color': '#bfe4d0', 'stop-opacity': 0 }));
  defs.appendChild(haze);

  // nucleus body glow: white core falling off through Cherenkov green
  const sunHaze = el('radialGradient', { id: 'nucleus-haze' });
  sunHaze.appendChild(el('stop', { offset: '0%', 'stop-color': '#f4fff8', 'stop-opacity': 1 }));
  sunHaze.appendChild(el('stop', { offset: '45%', 'stop-color': '#7dffab', 'stop-opacity': 0.4 }));
  sunHaze.appendChild(el('stop', { offset: '100%', 'stop-color': '#4dff88', 'stop-opacity': 0 }));
  defs.appendChild(sunHaze);

  // criticality burn: the yellow-white heat that grows with CRITICAL
  const burn = el('radialGradient', { id: 'burn' });
  burn.appendChild(el('stop', { offset: '0%', 'stop-color': '#fff8d9', 'stop-opacity': 0.95 }));
  burn.appendChild(el('stop', { offset: '50%', 'stop-color': '#ffe14d', 'stop-opacity': 0.35 }));
  burn.appendChild(el('stop', { offset: '100%', 'stop-color': '#ffe14d', 'stop-opacity': 0 }));
  defs.appendChild(burn);

  // luminous orb: tiny hot core, wide green falloff — no flat white areas
  const orb = el('radialGradient', { id: 'orb' });
  orb.appendChild(el('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 1 }));
  orb.appendChild(el('stop', { offset: '35%', 'stop-color': '#d9ffe8', 'stop-opacity': 0.85 }));
  orb.appendChild(el('stop', { offset: '100%', 'stop-color': '#4dff88', 'stop-opacity': 0 }));
  defs.appendChild(orb);

  // a lit step node: a small green light-orb
  const nodeGreen = el('radialGradient', { id: 'node-green' });
  nodeGreen.appendChild(el('stop', { offset: '0%', 'stop-color': '#eafff2', 'stop-opacity': 1 }));
  nodeGreen.appendChild(el('stop', { offset: '55%', 'stop-color': '#4dff88', 'stop-opacity': 0.75 }));
  nodeGreen.appendChild(el('stop', { offset: '100%', 'stop-color': '#4dff88', 'stop-opacity': 0 }));
  defs.appendChild(nodeGreen);

  // a kick node runs hotter: white into warning yellow
  const nodeHot = el('radialGradient', { id: 'node-hot' });
  nodeHot.appendChild(el('stop', { offset: '0%', 'stop-color': '#fffbe6', 'stop-opacity': 1 }));
  nodeHot.appendChild(el('stop', { offset: '55%', 'stop-color': '#ffe14d', 'stop-opacity': 0.75 }));
  nodeHot.appendChild(el('stop', { offset: '100%', 'stop-color': '#ffe14d', 'stop-opacity': 0 }));
  defs.appendChild(nodeHot);

  // vertical light pillar through the nucleus
  const beam = el('radialGradient', { id: 'beam' });
  beam.appendChild(el('stop', { offset: '0%', 'stop-color': '#e9fff2', 'stop-opacity': 1 }));
  beam.appendChild(el('stop', { offset: '100%', 'stop-color': '#e9fff2', 'stop-opacity': 0 }));
  defs.appendChild(beam);

  // stray neutron streaks (comets): white-green fade
  const fade = el('linearGradient', { id: 'fade' });
  fade.appendChild(el('stop', { offset: '0%', 'stop-color': '#d9f4e4', 'stop-opacity': 0 }));
  fade.appendChild(el('stop', { offset: '70%', 'stop-color': '#e9fff2', 'stop-opacity': 0.5 }));
  fade.appendChild(el('stop', { offset: '100%', 'stop-color': '#f6fffa', 'stop-opacity': 1 }));
  defs.appendChild(fade);

  space.appendChild(defs);

  // chamber haze banks, drifting very slowly (CSS animation)
  space.appendChild(el('ellipse', { class: 'haze-a', cx: 88, cy: 72, rx: 112, ry: 60, fill: 'url(#haze)', opacity: 0.5 }));
  space.appendChild(el('ellipse', { class: 'haze-b', cx: 250, cy: 206, rx: 120, ry: 68, fill: 'url(#haze)', opacity: 0.4 }));

  // vertical light pillar rising through the nucleus
  space.appendChild(el('ellipse', { class: 'beam', cx: CX, cy: CY, rx: 15, ry: 128, fill: 'url(#beam)' }));

  // stray neutrons: a light streak periodically crosses the chamber
  cometA = el('path', { class: 'comet comet-a', d: 'M 16 214 C 60 118 158 52 306 34', pathLength: 100, stroke: 'url(#fade)', 'stroke-width': 0.9, fill: 'none', opacity: 0.55 });
  cometB = el('path', { class: 'comet comet-b', d: 'M 44 240 C 96 186 190 172 296 190', pathLength: 100, stroke: 'url(#fade)', 'stroke-width': 0.7, fill: 'none', opacity: 0.35 });
  space.appendChild(cometA);
  space.appendChild(cometB);

  // fine dust particles wandering through the dark
  for (let i = 0; i < 18; i++) {
    const bx = 14 + Math.random() * 292;
    const by = 14 + Math.random() * 232;
    const dot = el('circle', { cx: bx, cy: by, r: (0.5 + Math.random() * 0.7).toFixed(2), fill: 'var(--light)', opacity: (0.1 + Math.random() * 0.2).toFixed(2) });
    space.appendChild(dot);
    dotMeta.push({
      el: dot,
      bx,
      by,
      ph: Math.random() * 6.28,
      w: 0.25 + Math.random() * 0.5,
      ax: 3 + Math.random() * 4,
      ay: 2 + Math.random() * 3,
    });
  }

  // faint distant sparks, twinkling out of phase
  for (const [x, y, r] of [[52, 196, 1.1], [296, 226, 0.9], [124, 24, 0.8], [206, 244, 0.7]]) {
    const star = el('circle', { class: 'bg-star', cx: x, cy: y, r, fill: 'var(--text)' });
    star.style.animationDelay = `${(Math.random() * 5).toFixed(2)}s`;
    star.style.animationDuration = `${(3.5 + Math.random() * 3).toFixed(2)}s`;
    space.appendChild(star);
  }
}

// the electron orbit ring carrying the 16 step nodes, plus two decorative
// shells that precess slowly (the classic atom line-art)
function buildRing() {
  // decorative crossed shells, pure line-art
  const decorA = el('g', { class: 'orbit-decor' });
  decorA.style.transformOrigin = `${CX}px ${CY}px`;
  decorA.appendChild(el('ellipse', { cx: CX, cy: CY, rx: 88, ry: 30, fill: 'none', stroke: 'rgba(232,244,238,0.2)', 'stroke-width': 0.6, transform: `rotate(-24 ${CX} ${CY})` }));
  space.appendChild(decorA);
  const decorB = el('g', { class: 'orbit-decor rev' });
  decorB.style.transformOrigin = `${CX}px ${CY}px`;
  decorB.appendChild(el('ellipse', { cx: CX, cy: CY, rx: 92, ry: 26, fill: 'none', stroke: 'rgba(232,244,238,0.16)', 'stroke-width': 0.6, transform: `rotate(28 ${CX} ${CY})` }));
  space.appendChild(decorB);

  // the sequencer ring itself
  space.appendChild(el('ellipse', { class: 'orbit-ring', cx: CX, cy: CY, rx: RING_R, ry: RING_R * TILT, fill: 'none', stroke: 'rgba(232,244,238,0.32)', 'stroke-width': 0.7 }));

  // 16 step nodes strung on the ring
  for (let i = 0; i < STEPS; i++) {
    const p = proj(RING_R, i * 22.5);
    nodePos.push(p);
    const dot = el('circle', { cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: 2, fill: 'none', stroke: 'rgba(232,244,238,0.5)', 'stroke-width': 0.8 });
    dot.dataset.depth = p.depth.toFixed(3);
    space.appendChild(dot);
    ringNodes.push(dot);
  }

  // the fission flash rig: shockwave ring + two nuclear fragments + three
  // yellow neutron rays. Repositioned to a node and replayed on each split.
  fissionG = el('g', { class: 'fission' });
  fissionG.appendChild(el('circle', { class: 'shock', cx: 0, cy: 0, r: 5.5, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.3 }));
  fissionG.appendChild(el('circle', { class: 'frag-a', cx: 0, cy: 0, r: 2.4, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.2, filter: 'url(#glow)' }));
  fissionG.appendChild(el('circle', { class: 'frag-b', cx: 0, cy: 0, r: 2, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.2, filter: 'url(#glow)' }));
  fissionRays = el('g');
  fissionRays.style.transformOrigin = '0px 0px';
  for (const a of [15, 135, 255]) {
    const rad = (a * Math.PI) / 180;
    fissionRays.appendChild(el('line', {
      class: 'ray',
      x1: (Math.cos(rad) * 4).toFixed(2),
      y1: (Math.sin(rad) * 4).toFixed(2),
      x2: (Math.cos(rad) * 12).toFixed(2),
      y2: (Math.sin(rad) * 12).toFixed(2),
      stroke: 'var(--accent2)',
      'stroke-width': 1.1,
      'stroke-linecap': 'round',
      filter: 'url(#glow)',
    }));
  }
  fissionG.appendChild(fissionRays);
  space.appendChild(fissionG);

  // the neutron playhead: bright white-green particle + short light trail,
  // drawn pointing along +x and rotated to the ring's heading
  neutronG = el('g', { class: 'neutron' });
  neutronG.appendChild(el('polygon', { points: '-15,0 -4,-1.7 -4,1.7', fill: 'var(--accent)', opacity: 0.35, filter: 'url(#glow)' }));
  neutronG.appendChild(el('circle', { class: 'neutron-glow', cx: 0, cy: 0, r: 4.4, fill: 'url(#orb)', opacity: 0.6 }));
  neutronG.appendChild(el('circle', { class: 'neutron-core', cx: 0, cy: 0, r: 1.9, fill: '#eafff2', filter: 'url(#glow)' }));
  space.appendChild(neutronG);
  parkNeutron();

  // geiger ticks: tiny flashes that fire at random as criticality rises
  for (let i = 0; i < 4; i++) {
    const tick = el('circle', { class: 'geiger', cx: CX, cy: CY, r: 1.2, fill: 'var(--accent2-bright)', filter: 'url(#glow)' });
    space.appendChild(tick);
    geigerTicks.push(tick);
  }
}

// heading (degrees) of the ring at node `index`, from the tangent between its
// neighbours — so the neutron's trail streams behind its direction of travel
function headingAt(index) {
  const prev = nodePos[(index - 1 + STEPS) % STEPS];
  const next = nodePos[(index + 1) % STEPS];
  return (Math.atan2(next.y - prev.y, next.x - prev.x) * 180) / Math.PI;
}

// park the neutron, dimmed, at step 0 so the ring always has its particle
function parkNeutron() {
  const p = nodePos[0];
  lastDeg = headingAt(0);
  neutronG.style.transition = 'none';
  neutronG.style.transform = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) rotate(${lastDeg.toFixed(1)}deg)`;
  neutronG.style.opacity = 0.28;
}

// an isotope atom: small glowing nucleus dot + two precessing electron-shell
// ellipses, annotated with a serif label (galaxy's planet)
function buildIsotope(track, cfg) {
  const g = el('g', { class: 'planet', transform: `translate(${cfg.x} ${cfg.y})`, 'data-track': track });
  const s = cfg.s;
  // generous invisible hit area (the atom core is small)
  g.appendChild(el('circle', { cx: 0, cy: 4, r: 24, fill: 'transparent' }));
  const ring = el('circle', { class: 'select-ring', cx: 0, cy: 0, r: 16 * s + 3, stroke: 'var(--cream)', 'stroke-width': 0.9, fill: 'none', opacity: 0 });
  g.appendChild(ring);

  // electron shells — hollow line-art, precessing slowly
  const shellA = el('g', { class: 'iso-orbit' });
  shellA.appendChild(el('ellipse', { cx: 0, cy: 0, rx: (13 * s).toFixed(2), ry: (4.6 * s).toFixed(2), fill: 'none', stroke: 'rgba(232,244,238,0.55)', 'stroke-width': 0.7, transform: 'rotate(-58)' }));
  const shellB = el('g', { class: 'iso-orbit rev' });
  shellB.appendChild(el('ellipse', { cx: 0, cy: 0, rx: (13 * s).toFixed(2), ry: (4.6 * s).toFixed(2), fill: 'none', stroke: 'rgba(232,244,238,0.4)', 'stroke-width': 0.7, transform: 'rotate(58)' }));
  shellA.style.animationDelay = `${(Math.random() * -16).toFixed(2)}s`;
  shellB.style.animationDelay = `${(Math.random() * -22).toFixed(2)}s`;
  g.appendChild(shellA);
  g.appendChild(shellB);

  // the small nucleus — this is what pulses on hits
  const scaleWrap = el('g', { class: 'planet-scale' });
  const body = el('g', { class: 'planet-body' });
  body.appendChild(el('circle', { cx: 0, cy: 0, r: (5.2 * s).toFixed(2), fill: 'url(#orb)', opacity: 0.55 }));
  body.appendChild(el('circle', { cx: 0, cy: 0, r: (2.4 * s).toFixed(2), fill: 'none', stroke: '#ffffff', 'stroke-width': 1.2, filter: 'url(#glow)' }));
  scaleWrap.appendChild(body);
  g.appendChild(scaleWrap);

  // thin leader line down to the annotation label, like a technical diagram
  const halo = 13 * s + 3;
  g.appendChild(el('line', { x1: 0, y1: halo + 1, x2: 0, y2: halo + 7, stroke: 'var(--dim)', 'stroke-width': 0.5 }));
  const text = el('text', { y: halo + 18, 'text-anchor': 'middle', class: 'planet-label' });
  text.textContent = cfg.label;
  g.appendChild(text);

  g.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    selectTrack(track);
  });
  selectionRings[track] = ring;
  isotopeEls[track] = g;
  return g;
}

function buildScene() {
  buildAtmosphere();
  buildRing();

  // isotope atoms (after the ring so they sit on top)
  for (const [track, cfg] of Object.entries(ISO)) {
    space.appendChild(buildIsotope(track, cfg));
  }

  // fx: a small luminous point floating top-right, annotated like the rest
  const fx = el('g', { class: 'planet', transform: 'translate(291 24)', 'data-track': 'fx' });
  fx.appendChild(el('circle', { cx: 0, cy: 8, r: 18, fill: 'transparent' }));
  const fxRing = el('circle', { class: 'select-ring', cx: 0, cy: 0, r: 11, stroke: 'var(--cream)', 'stroke-width': 0.9, fill: 'none', opacity: 0 });
  const fxBody = el('g', { class: 'planet-body bob' });
  fxBody.appendChild(el('circle', { cx: 0, cy: 0, r: 6, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.1, filter: 'url(#glow)' }));
  fx.appendChild(el('line', { x1: 0, y1: 8, x2: 0, y2: 15, stroke: 'var(--dim)', 'stroke-width': 0.5 }));
  const fxText = el('text', { y: 26, 'text-anchor': 'middle', class: 'planet-label' });
  fxText.textContent = 'FX';
  fx.appendChild(fxRing);
  fx.appendChild(fxBody);
  fx.appendChild(fxText);
  fx.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    selectTrack('fx');
  });
  selectionRings.fx = fxRing;
  isotopeEls.fx = fx;
  space.appendChild(fx);

  buildCritical();

  // the NUCLEUS = play button (a breathing cluster of orbs, drawn last so it
  // floats on top of the ring)
  const sun = el('g', { class: 'sun' });
  sunHazeEl = el('circle', { class: 'sun-haze', cx: CX, cy: CY, r: 42, fill: 'url(#nucleus-haze)', opacity: 0.75 });
  sun.appendChild(sunHazeEl);
  // criticality burn: fades in as the rod is pulled (yellow-white heat)
  nucleusBurnEl = el('circle', { class: 'nucleus-burn', cx: CX, cy: CY, r: 30, fill: 'url(#burn)', opacity: 0 });
  sun.appendChild(nucleusBurnEl);
  // shockwave ring that expands on every kick — the sidechain, visualized
  burstEl = el('circle', { class: 'sun-burst', cx: CX, cy: CY, r: 17, stroke: '#ffffff', 'stroke-width': 1, fill: 'none', opacity: 0 });
  sun.appendChild(burstEl);

  // the nucleon cluster: ~7 hollow orbs of light packed around the centre,
  // green and yellow mixed in among the white
  nucleusScaleEl = el('g', { class: 'nucleus-cluster' });
  const NUCLEONS = [
    [0, -10.5, 4.2, '#ffffff'],
    [9.5, -4.5, 4.6, 'var(--accent)'],
    [10, 5.5, 3.8, '#ffffff'],
    [1.5, 11, 4.4, 'var(--accent2)'],
    [-9, 7, 4.2, '#ffffff'],
    [-11, -3.5, 3.6, 'var(--accent)'],
    [-3.5, -4, 2.6, '#ffffff'],
  ];
  for (const [dx, dy, r, stroke] of NUCLEONS) {
    nucleusScaleEl.appendChild(el('circle', { cx: CX + dx, cy: CY + dy, r, fill: 'none', stroke, 'stroke-width': 1.1, opacity: 0.85, filter: 'url(#glow)' }));
  }
  sun.appendChild(nucleusScaleEl);

  // refined play control: faint outer corona, loading arc, stroked glyph
  sun.appendChild(el('circle', { cx: CX, cy: CY, r: 20.5, stroke: 'rgba(232,244,238,0.3)', 'stroke-width': 0.7, fill: 'none' }));
  sun.appendChild(el('circle', { class: 'sun-load', cx: CX, cy: CY, r: 16.5, stroke: '#ffffff', 'stroke-width': 1.3, fill: 'none', 'stroke-dasharray': '26 78', 'stroke-linecap': 'round', filter: 'url(#glow)' }));
  sunIcon = el('path', { class: 'sun-icon', d: playPath(), fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', filter: 'url(#glow)' });
  sun.appendChild(sunIcon);
  sun.classList.add('loading');
  sunEl = sun;
  sun.addEventListener('pointerdown', togglePlay);
  space.appendChild(sun);

  refreshOverview();
}

function playPath() {
  return `M${CX - 3.5} ${CY - 5.5} L${CX + 6} ${CY} L${CX - 3.5} ${CY + 5.5} Z`;
}

// two slim bars while playing — tap to stop
function stopPath() {
  return `M${CX - 3} ${CY - 5} L${CX - 3} ${CY + 5} M${CX + 3} ${CY - 5} L${CX + 3} ${CY + 5}`;
}

// ---- CRITICAL: the control rod, top-left — drag up/down to pull it out ----

let rodEl = null;
let rodLines = null;
let criticalValue = null;
const criticalSlider = document.getElementById('critical-slider');

function buildCritical() {
  const g = el('g', { class: 'critical', transform: 'translate(36 26)' });
  const hit = el('rect', { x: -16, y: -20, width: 32, height: 62, fill: 'transparent' });
  g.appendChild(hit);

  const throb = el('g', { class: 'rod-throb' });
  // the rod housing: top mount bracket + two vertical guide rails
  throb.appendChild(el('line', { x1: -9, y1: -13, x2: 9, y2: -13, stroke: 'var(--light)', 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: 0.7 }));
  throb.appendChild(el('line', { x1: -5.5, y1: -13, x2: -5.5, y2: 17, stroke: 'var(--light)', 'stroke-width': 0.7, opacity: 0.35 }));
  throb.appendChild(el('line', { x1: 5.5, y1: -13, x2: 5.5, y2: 17, stroke: 'var(--light)', 'stroke-width': 0.7, opacity: 0.35 }));

  // the rod itself: a vertical bar of light with a grip head; it slides UP as
  // CRITICAL rises (the rod withdrawing from the core)
  rodEl = el('g', { class: 'rod' });
  rodEl.style.transition = 'transform 80ms linear';
  rodLines = [
    el('line', { x1: 0, y1: -8, x2: 0, y2: 16, stroke: 'var(--light)', 'stroke-width': 3, 'stroke-linecap': 'round', filter: 'url(#glow)' }),
    el('line', { x1: -3.5, y1: -10.5, x2: 3.5, y2: -10.5, stroke: 'var(--light)', 'stroke-width': 2, 'stroke-linecap': 'round', filter: 'url(#glow)' }),
  ];
  for (const line of rodLines) rodEl.appendChild(line);
  throb.appendChild(rodEl);
  g.appendChild(throb);

  const label = el('text', { y: 30, 'text-anchor': 'middle', class: 'planet-label' });
  label.textContent = 'CRITICAL';
  criticalValue = el('text', { y: 41, 'text-anchor': 'middle', class: 'critical-value' });
  criticalValue.textContent = '0%';
  g.appendChild(label);
  g.appendChild(criticalValue);

  g.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      g.setPointerCapture(e.pointerId);
    } catch {}
    const startY = e.clientY;
    const start = critical;
    const onMove = (ev) => setCritical(start + (startY - ev.clientY) / 130);
    const onUp = () => {
      g.removeEventListener('pointermove', onMove);
      g.removeEventListener('pointerup', onUp);
    };
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', onUp);
  });
  space.appendChild(g);
}

function setCritical(value) {
  critical = Math.min(1, Math.max(0, value));
  send({ type: 'critical', value: critical });
  criticalValue.textContent = `${Math.round(critical * 100)}%`;
  // the rod withdraws upward as criticality rises
  rodEl.style.transform = `translateY(${(-critical * 13).toFixed(1)}px)`;
  // the reaction goes hot: rod + readout turn warning yellow, the nucleus
  // burns yellow-white
  const lit = critical > 0.001;
  for (const line of rodLines) line.setAttribute('stroke', lit ? 'var(--accent2)' : 'var(--light)');
  criticalValue.style.fill = lit ? 'var(--accent2-bright)' : 'var(--dim)';
  nucleusBurnEl.setAttribute('opacity', (0.85 * critical).toFixed(2));
  if (criticalSlider) criticalSlider.value = critical;
  // stray neutrons streak faster and harder
  cometA.style.animationDuration = `${(9 / (1 + critical * 1.8)).toFixed(2)}s`;
  cometB.style.animationDuration = `${(14 / (1 + critical * 1.8)).toFixed(2)}s`;
}

// ---- overview: light the ring nodes to match the pattern ----

function nodeState(i) {
  if (toggles.kick[i]) return 'kick';
  if (toggles.snare[i] || toggles.ghost[i] || toggles.hatC[i] || toggles.hatO[i] || toggles.bass[i]) return 'on';
  return 'off';
}

function setNode(i) {
  const dot = ringNodes[i];
  const depth = parseFloat(dot.dataset.depth);
  const baseR = 2.2 + 1.6 * depth;
  const st = nodeState(i);
  if (st === 'off') {
    dot.setAttribute('r', baseR.toFixed(2));
    dot.setAttribute('fill', 'none');
    dot.setAttribute('stroke', 'rgba(232,244,238,0.4)');
    dot.setAttribute('stroke-width', 0.7);
    dot.style.opacity = 0.6;
  } else {
    dot.setAttribute('r', (baseR + 0.8).toFixed(2));
    dot.setAttribute('fill', st === 'kick' ? 'url(#node-hot)' : 'url(#node-green)');
    dot.setAttribute('stroke', st === 'kick' ? 'var(--accent2)' : 'var(--accent)');
    dot.setAttribute('stroke-width', st === 'kick' ? 1.5 : 1.1);
    dot.style.opacity = 1;
  }
}

function refreshOverview() {
  for (let i = 0; i < STEPS; i++) setNode(i);
}

// ---- track selection ----

function selectTrack(track) {
  for (const [key, ring] of Object.entries(selectionRings)) {
    ring.setAttribute('opacity', key === track ? 1 : 0);
  }
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${track}`);
  });
  document.getElementById('editor').classList.add('open');
  document.body.classList.add('editor-open'); // hides the bottom bars under the sheet
}

document.querySelectorAll('.close-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('editor').classList.remove('open');
    document.body.classList.remove('editor-open');
    for (const ring of Object.values(selectionRings)) ring.setAttribute('opacity', 0);
  });
});

// ---- transport ----

async function togglePlay() {
  // flip the UI instantly — audio setup catches up in the background
  playing = !playing;
  sunIcon.setAttribute('d', playing ? stopPath() : playPath());
  if (playing) {
    lastStep = -1;
    neutronG.style.opacity = 0.95;
  } else {
    parkNeutron();
    clearEditorPlayhead();
  }
  await ensureAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  send({ type: playing ? 'play' : 'stop' });
}

const bpmValue = document.getElementById('bpm-value');
function setBpm(value) {
  bpm = Math.min(190, Math.max(60, value));
  bpmValue.textContent = bpm;
  send({ type: 'bpm', value: bpm });
}
// tap steps once; holding repeats after a beat, for fast sweeps
function bindHold(btn, step) {
  let delay = null;
  let repeat = null;
  const start = (e) => {
    e.preventDefault();
    step();
    delay = setTimeout(() => {
      repeat = setInterval(step, 65);
    }, 400);
  };
  const end = () => {
    clearTimeout(delay);
    clearInterval(repeat);
  };
  btn.addEventListener('pointerdown', start);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    btn.addEventListener(ev, end);
  }
}
bindHold(document.getElementById('bpm-up'), () => setBpm(bpm + 1));
bindHold(document.getElementById('bpm-down'), () => setBpm(bpm - 1));

const masterVol = document.getElementById('master-vol');
masterVol.addEventListener('input', () => {
  send({ type: 'master', value: parseFloat(masterVol.value) });
});

// ---- playhead ----

const editorRows = ['kick', 'snare', 'ghost', 'hatC', 'hatO', 'bass'];
let lastStep = -1;
let lastDeg = 0;

function movePlayhead(index) {
  const p = nodePos[index];
  // face the direction of travel; unwrap the angle so the neutron turns the
  // short way at the loop instead of spinning backwards
  let deg = headingAt(index);
  while (deg - lastDeg > 180) deg -= 360;
  while (deg - lastDeg < -180) deg += 360;
  lastDeg = deg;
  const to = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) rotate(${deg.toFixed(1)}deg)`;
  // travel smoothly node to node, but snap on the loop wrap
  if (index <= lastStep) {
    neutronG.style.transition = 'none';
    neutronG.style.transform = to;
    requestAnimationFrame(() => {
      neutronG.style.transition = 'transform 90ms linear';
    });
  } else {
    neutronG.style.transition = 'transform 90ms linear';
    neutronG.style.transform = to;
  }
  lastStep = index;

  // the neutron strikes a LIT node: FISSION — the node splits in two, yellow
  // neutron rays fly out and a shockwave ring bursts
  if (nodeState(index) !== 'off') fireFission(p);

  pulse('kick', toggles.kick[index]);
  pulse('snare', toggles.snare[index] || toggles.ghost[index]);
  pulse('hat', toggles.hatC[index] || toggles.hatO[index]);
  pulse('bass', toggles.bass[index]);

  for (const track of editorRows) {
    const cells = document.getElementById(`steps-${track}`).children;
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('playhead', i === index);
    }
  }
}

function pulse(track, active) {
  if (!active) return;
  const body = isotopeEls[track].querySelector('.planet-body');
  body.classList.remove('hit');
  void body.getBoundingClientRect(); // restart the animation
  body.classList.add('hit');
  if (track === 'kick') {
    burstEl.classList.remove('go');
    void burstEl.getBoundingClientRect();
    burstEl.classList.add('go');
  }
}

function fireFission(p) {
  fissionG.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
  // throw the rays at a fresh angle every split
  fissionRays.style.transform = `rotate(${(Math.random() * 360).toFixed(0)}deg)`;
  fissionG.classList.remove('go');
  void fissionG.getBoundingClientRect(); // restart the animations
  fissionG.classList.add('go');
}

// ---- ambient motion: breathing nucleus, wandering dust, geiger ticks ----

let lastFrame = 0;
let tickIndex = 0;

function animate(t) {
  // clamp dt so returning from a hidden tab doesn't jump the scene
  const dt = Math.min(lastFrame ? (t - lastFrame) / 1000 : 0, 0.1);
  lastFrame = t;

  // the nucleus breathes — harder and faster while the reaction runs
  const amp = playing ? 0.085 : 0.045;
  const rate = playing ? 430 : 1500;
  const s = 1 + amp * Math.sin(t / rate) + critical * 0.05 * Math.sin(t / 210);
  nucleusScaleEl.style.transform = `scale(${s.toFixed(4)})`;
  sunHazeEl.style.transform = `scale(${(1 + 0.055 * Math.sin(t / 1700)).toFixed(4)})`;

  // dust particles wander freely; criticality stirs them up
  const dotAmp = 1 + critical * 1.4;
  for (const m of dotMeta) {
    const ts = t / 1000;
    m.el.setAttribute('cx', (m.bx + m.ax * dotAmp * Math.sin(ts * m.w + m.ph)).toFixed(2));
    m.el.setAttribute('cy', (m.by + m.ay * dotAmp * Math.cos(ts * m.w * 0.8 + m.ph * 1.7)).toFixed(2));
  }

  // geiger ticks: random micro-flashes, more frequent as criticality rises
  if (critical > 0.05 && Math.random() < critical * 3.2 * dt) {
    const tick = geigerTicks[tickIndex++ % geigerTicks.length];
    tick.setAttribute('cx', (CX + (Math.random() - 0.5) * 170).toFixed(1));
    tick.setAttribute('cy', (CY + (Math.random() - 0.5) * 120).toFixed(1));
    tick.classList.remove('go');
    void tick.getBoundingClientRect();
    tick.classList.add('go');
  }

  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// film grain flicker: reseed the noise a few times a second
const grainTurb = document.querySelector('.grain-overlay feTurbulence');
if (grainTurb) {
  setInterval(() => grainTurb.setAttribute('seed', (Math.random() * 1000) | 0), 100);
}

function clearEditorPlayhead() {
  document.querySelectorAll('.step.playhead').forEach((c) => c.classList.remove('playhead'));
}

// ---- editor: toggle rows (kick, snare, ghost, hats) ----

const rowButtons = { kick: [], snare: [], ghost: [], hatC: [], hatO: [] };

function buildToggleRow(track) {
  const container = document.getElementById(`steps-${track}`);
  for (let i = 0; i < STEPS; i++) {
    const btn = document.createElement('button');
    btn.className = 'step' + (toggles[track][i] ? ' on' : '');
    btn.addEventListener('click', () => {
      toggles[track][i] = toggles[track][i] ? 0 : 1;
      btn.classList.toggle('on');
      send({ type: 'steps', track, steps: toggles[track] });
      refreshOverview();
    });
    container.appendChild(btn);
    rowButtons[track].push(btn);
  }
}

function refreshToggleRow(track) {
  rowButtons[track].forEach((btn, i) => btn.classList.toggle('on', !!toggles[track][i]));
}

// ---- editor: bass row (click toggles, vertical drag edits pitch) ----
// Notes are semitone offsets (-12..+12) from the ROOT slider; the label shows
// the resulting absolute note name (root 0..11 = C1..B1, so root 5 = F1).

const rootInput = document.querySelector('#panel-bass input[data-param="root"]');

function noteName(offset) {
  const v = parseInt(rootInput.value, 10) + offset; // semitones above C1
  const idx = ((v % 12) + 12) % 12;
  const oct = 1 + Math.floor(v / 12);
  return NOTE_NAMES[idx] + oct;
}

function buildBassRow() {
  const container = document.getElementById('steps-bass');
  for (let i = 0; i < STEPS; i++) {
    const btn = document.createElement('button');
    btn.className = 'step bass-step';
    const label = document.createElement('span');
    label.className = 'note';
    btn.appendChild(label);
    container.appendChild(btn);
    renderBassStep(i);

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {}
      const startY = e.clientY;
      const startNote = bassNotes[i];
      let dragged = false;

      const onMove = (ev) => {
        const delta = Math.round((startY - ev.clientY) / 8);
        if (delta !== 0) dragged = true;
        const note = Math.min(12, Math.max(-12, startNote + delta));
        if (note !== bassNotes[i]) {
          bassNotes[i] = note;
          if (!toggles.bass[i]) {
            toggles.bass[i] = 1;
            send({ type: 'steps', track: 'bass', steps: toggles.bass });
          }
          renderBassStep(i);
          sendBassNotes();
          refreshOverview();
        }
      };
      const onUp = () => {
        btn.removeEventListener('pointermove', onMove);
        btn.removeEventListener('pointerup', onUp);
        if (!dragged) {
          toggles.bass[i] = toggles.bass[i] ? 0 : 1;
          renderBassStep(i);
          send({ type: 'steps', track: 'bass', steps: toggles.bass });
          refreshOverview();
        }
      };
      btn.addEventListener('pointermove', onMove);
      btn.addEventListener('pointerup', onUp);
    });
  }
}

function renderBassStep(i) {
  const btn = document.getElementById('steps-bass').children[i];
  btn.classList.toggle('on', !!toggles.bass[i]);
  btn.querySelector('.note').textContent = noteName(bassNotes[i]);
}

function refreshBassUI() {
  for (let i = 0; i < STEPS; i++) renderBassStep(i);
}

// moving ROOT retunes every step label
rootInput.addEventListener('input', refreshBassUI);

// ---- GEN: pattern generators (euclidean breakbeats) ----

const ri = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[ri(arr.length)];

function regenerate(track) {
  if (track === 'kick') {
    toggles.kick = euclid(pick([2, 3, 3, 4]), STEPS, ri(2));
    toggles.kick[0] = 1; // always land on the one
    send({ type: 'steps', track: 'kick', steps: toggles.kick });
    refreshToggleRow('kick');
  } else if (track === 'snare') {
    // backbeat anchors + an occasional displaced hit, then a ghost shuffle
    toggles.snare = Array.from({ length: STEPS }, () => 0);
    toggles.snare[4] = 1;
    toggles.snare[12] = 1;
    if (Math.random() < 0.45) toggles.snare[pick([7, 10, 15])] = 1;
    toggles.ghost = Array.from({ length: STEPS }, (_, i) =>
      !toggles.snare[i] && Math.random() < 0.22 ? 1 : 0);
    send({ type: 'steps', track: 'snare', steps: toggles.snare });
    send({ type: 'steps', track: 'ghost', steps: toggles.ghost });
    refreshToggleRow('snare');
    refreshToggleRow('ghost');
  } else if (track === 'hat') {
    toggles.hatC = euclid(5 + ri(6), STEPS);
    toggles.hatO = euclid(1 + ri(3), STEPS, -2); // lean toward the offbeats
    for (let i = 0; i < STEPS; i++) {
      if (toggles.hatO[i]) toggles.hatC[i] = 0; // open takes the slot
    }
    send({ type: 'steps', track: 'hatC', steps: toggles.hatC });
    send({ type: 'steps', track: 'hatO', steps: toggles.hatO });
    refreshToggleRow('hatC');
    refreshToggleRow('hatO');
  } else if (track === 'bass') {
    toggles.bass = euclid(4 + ri(4), STEPS, ri(3));
    toggles.bass[0] = 1; // a rolling sub anchored on the downbeat
    const OFFSETS = [-12, -5, -2, 0, 0, 0, 0, 3, 5, 7, 12];
    for (let i = 0; i < STEPS; i++) {
      bassNotes[i] = toggles.bass[i] ? pick(OFFSETS) : 0;
    }
    send({ type: 'steps', track: 'bass', steps: toggles.bass });
    sendBassNotes();
    refreshBassUI();
  }
  refreshOverview();
}

document.querySelectorAll('.gen-btn').forEach((btn) => {
  btn.addEventListener('click', () => regenerate(btn.dataset.gen));
});

// jump straight to a layer's editor — no need to chase a drifting atom
document.querySelectorAll('.jump-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    selectTrack(btn.dataset.jump);
  });
});

// ---- CRITICAL slider (mirrors the control-rod drag) ----

if (criticalSlider) {
  criticalSlider.addEventListener('input', () => setCritical(parseFloat(criticalSlider.value)));
}

// ---- pattern slots & persistence ----
// Four independent workspaces (steps + bass notes + voice params + fx).
// Switching slots auto-saves the old one; everything persists to
// localStorage, so a reload or app restart comes back where you left off.

const SLOT_COUNT = 4;
const STORAGE_KEY = 'minima-fission-v1';
let activeSlot = 0;
let saveTimer = null;

function collectParams() {
  const params = {};
  document.querySelectorAll('.params input[data-param]').forEach((input) => {
    const track = input.closest('.track').dataset.track;
    (params[track] ??= {})[input.dataset.param] = input.value;
  });
  return params;
}

function snapshotSlot() {
  return {
    toggles: JSON.parse(JSON.stringify(toggles)),
    bassNotes: bassNotes.slice(),
    params: collectParams(),
  };
}

let slots = Array.from({ length: SLOT_COUNT }, snapshotSlot);

function applySlot(slot) {
  for (const key of Object.keys(toggles)) {
    toggles[key] = slot.toggles[key].slice();
    send({ type: 'steps', track: key, steps: toggles[key] });
    if (rowButtons[key]) refreshToggleRow(key);
  }
  const notes = Array.isArray(slot.bassNotes) ? slot.bassNotes : [];
  for (let i = 0; i < STEPS; i++) {
    bassNotes[i] = notes[i] | 0;
  }
  sendBassNotes();
  for (const [track, ps] of Object.entries(slot.params)) {
    for (const [name, value] of Object.entries(ps)) {
      const input = document.querySelector(`#panel-${track} input[data-param="${name}"]`);
      if (input) {
        input.value = value;
        sendParam(input);
      }
    }
  }
  refreshBassUI();
  refreshOverview();
}

function persist() {
  slots[activeSlot] = snapshotSlot();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      active: activeSlot,
      bpm,
      master: parseFloat(masterVol.value),
      critical,
      slots,
    }));
  } catch {}
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}

function switchSlot(n) {
  if (n === activeSlot) return;
  slots[activeSlot] = snapshotSlot();
  activeSlot = n;
  applySlot(slots[n]);
  document.querySelectorAll('.ptn-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.ptn) === n);
  });
  persist();
}

document.querySelectorAll('.ptn-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    switchSlot(Number(btn.dataset.ptn));
  });
});

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.slots) && data.slots.length === SLOT_COUNT) slots = data.slots;
    activeSlot = Math.min(SLOT_COUNT - 1, Math.max(0, data.active | 0));
    if (data.bpm) setBpm(data.bpm);
    if (data.master != null) masterVol.value = data.master;
    if (data.critical != null) setCritical(data.critical);
    applySlot(slots[activeSlot]);
    document.querySelectorAll('.ptn-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.ptn) === activeSlot);
    });
  } catch (err) {
    console.error(`restore failed: ${err.message}`);
  }
}

// ---- mute toggles: tap to silence a layer, tap again to bring it back ----

const muteState = { kick: false, snare: false, hat: false, bass: false };

function setMute(track, value) {
  muteState[track] = value;
  send({ type: 'mute', track, value });
  // every button for this track shows the same state (space bar + panel)
  document.querySelectorAll(`.mute-btn[data-mute="${track}"]`).forEach((b) => {
    b.classList.toggle('muting', value);
  });
  // the layer's isotope atom sinks into the dark while muted
  isotopeEls[track].style.opacity = value ? 0.18 : '';
}

document.querySelectorAll('.mute-btn').forEach((btn) => {
  const track = btn.dataset.mute;
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setMute(track, !muteState[track]);
  });
});

// ---- parameter sliders ----

function sendParam(input) {
  const track = input.closest('.track').dataset.track;
  const value = parseFloat(input.value);
  if (track === 'fx') {
    send({ type: 'fx', name: input.dataset.param, value });
  } else {
    send({ type: 'param', track, name: input.dataset.param, value });
  }
}

document.querySelectorAll('.params input[data-param]').forEach((input) => {
  input.addEventListener('input', () => sendParam(input));
});

// ---- init ----

buildScene();
buildToggleRow('kick');
buildToggleRow('snare');
buildToggleRow('ghost');
buildToggleRow('hatC');
buildToggleRow('hatO');
buildBassRow();
restore(); // bring back saved patterns before anything is heard
selectTrack('kick');
// start closed on mobile
document.getElementById('editor').classList.remove('open');
document.body.classList.remove('editor-open');

// Load the engine eagerly. In Electron there is no autoplay restriction; in a
// browser the context starts suspended and is resumed by the play button.
ensureAudio()
  .then(() => console.log('audio engine ready'))
  .catch((err) => console.error(`audio engine failed to load: ${err.message}`))
  .finally(() => sunEl.classList.remove('loading'));
