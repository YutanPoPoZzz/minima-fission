# minima fission

Chain-reaction breakbeats groovebox — the fifth unit in the **minima** series
(galaxy / rain / drift / city / **fission**).

Nuclear-fission themed: a glowing nucleus, an electron orbit of 16 steps, a
neutron playhead that splits lit nodes as it passes. Green × yellow on black.

**Play it in the browser:** https://yutanpopozzz.github.io/minima-fission/

## Sound

- Breakbeats / jungle, 160 BPM by default, 16 steps = 1 bar
- 4 voices, all synthesized (no samples):
  - **KICK** — punchy sine-sweep kick
  - **SNARE** — snappy snare with a separate ghost-note row
  - **HATS** — closed / open metallic hats (open chokes closed)
  - **BASS** — detuned-saw Reese sub with per-step pitch and glide
- FX: tempo-synced dotted-⅛ delay, plate reverb, bitcrush, kick sidechain, swing
- **CRITICAL** — the hero macro. Withdraw the control rod (top-left drag) to push
  the pattern toward criticality: snare/hat retrigger rolls, denser ghosts,
  opening filters, and geiger ticks near meltdown. Fully reversible — return the
  rod and the original pattern is restored.

## Run

Web: any static server over `src/` (it is plain Web Audio + AudioWorklet).

```sh
npx serve src
```

Desktop (Electron):

```sh
npm install
npm start        # dev
npm run dist     # portable .exe
```

## Tests

```sh
npm test         # renders voices/effects to WAV in test/out and checks them
```

## License

MIT
