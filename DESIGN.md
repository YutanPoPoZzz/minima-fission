# minima fission — DESIGN CONTRACT (canonical)

minimaシリーズ5機目。**核分裂ブレイクビーツ**。差し色 = **緑 × 黄**（ウランガラス／チェレンコフの緑＋警告イエロー）。
アーキテクチャは galaxy/drift/city と同一: 素Web Audio + AudioWorklet 自前DSP、全部シンセ（サンプル無し）、Electron。src/ はそのまま Web(Pages) にもなる。

**この表が唯一の正**。DSP既定値と index.html のスライダー value は必ず一致させること（起動時 pushAllState がHTML値をエンジンへ送るため、ズレると鳴らない）。

## 音のキャラ
- ブレイクビーツ / ジャングル。**BPM 160** 既定。16 step = 1小節（16分）。
- 刻んだ生ドラム感: パンチキック、スナップの効いたスネア＋ゴーストノート、細かいハット、うねるReeseサブベース。
- ヒーローマクロ **CRITICAL（臨界）** 0..1: 連鎖反応 = スネア/ハットのリトリガー（roll/ratchet）確率と分割数が上がる＋ゴースト密度up＋ディレイfeedback微増＋ドラムバスのフィルター開。>0.7 でガイガーカウンター的ランダムtick（微小ノイズクリック）を追加。step0 で乱数再抽選、0.0 で完全に原パターン復帰（drift DESCENT と同流儀）。

## processor / ファイル
- `registerProcessor('fission-engine', ...)` — src/audio/engine-processor.js
- dsp モジュール: src/audio/dsp/{kick,snare,hat,bass,effects,util}.js（pure module、Workletグローバル非依存。driftと同流儀）
- test: test/render-voices.js, test/render-effects.js（node で WAV 書き出し、test/wav.js 使用）

## トラック / ステップ行
| track (mute名) | step行 | 内容 |
|---|---|---|
| kick  | `kick` | パンチキック |
| snare | `snare`, `ghost` | メインスネア＋ゴースト（小音量・短い） |
| hat   | `hatC`, `hatO` | closed / open |
| bass  | `bass` (+ `bassNotes[16]` 半音オフセット -12..+12) | Reeseサブ、per-stepピッチ、glide |

## 既定パターン（16step、1=点灯）
- kick:  `1000 0000 0010 0000` → steps 0, 10
- snare: `0000 1000 0000 1000` → steps 4, 12
- ghost: `0000 0001 0100 0001` → steps 7, 9, 15
- hatC:  `1010 1010 1010 1000` → 偶数step（14はopenに譲る）
- hatO:  `0000 0000 0000 0010` → step 14
- bass:  `1001 0000 1001 0000` → steps 0, 3, 8, 11
- bassNotes: 全16 = 0（rootそのまま）ただし step3 = +3, step11 = -2

## パラメータ表（canonical — DSP既定 = HTML value）
range はスライダー min/max/step。

### KICK (track `kick`)
| name | range | default |
|---|---|---|
| tune | 30..70 step1 | 48 |
| decay | 0.05..0.5 step0.01 | 0.22 |
| punch | 0..1 step0.01 | 0.7 |
| drive | 0..1 step0.01 | 0.35 |
| level | 0..1 step0.01 | 0.9 |

### SNARE (track `snare`)
| name | range | default |
|---|---|---|
| tone | 0..1 step0.01 | 0.6 |
| snap | 0..1 step0.01 | 0.65 |
| decay | 0.05..0.4 step0.01 | 0.16 |
| ghost | 0..1 step0.01 | 0.35 |
| level | 0..1 step0.01 | 0.8 |

### HAT (track `hat`)
| name | range | default |
|---|---|---|
| tone | 0..1 step0.01 | 0.6 |
| decayC | 0.01..0.15 step0.005 | 0.045 |
| decayO | 0.05..0.6 step0.01 | 0.28 |
| level | 0..1 step0.01 | 0.5 |

### BASS (track `bass`)
| name | range | default |
|---|---|---|
| root | 0..11 step1 | 5 (F) |
| cutoff | 100..2000 step10 | 700 |
| reso | 0..1 step0.01 | 0.3 |
| detune | 0..1 step0.01 | 0.4 |
| glide | 0..0.3 step0.005 | 0.06 |
| decay | 0.1..1 step0.01 | 0.5 |
| level | 0..1 step0.01 | 0.85 |

### FX（`fx` メッセージ、name/value）
| name | range | default | 内容 |
|---|---|---|---|
| delay | 0..1 step0.01 | 0.25 | 付点8分テンポ同期ディレイのsend量（snare/hat/bass少量） |
| feedback | 0..0.9 step0.01 | 0.45 | ディレイfeedback |
| reverb | 0..1 step0.01 | 0.2 | 小さめplate、snare中心send |
| crush | 0..1 step0.01 | 0.15 | ドラムバスbitcrush（ローファイ質感） |
| duck | 0..1 step0.01 | 0.35 | kick以外をサイドチェイン |
| swing | 0..0.3 step0.01 | 0.06 | 16分スイング |

### その他
| 項目 | 値 |
|---|---|
| bpm | 60..190 step1、default **160** |
| master | 0..1、default 0.85（プレビュー検証時は 0.04 に落として聴取） |
| critical | 0..1、default 0 |
| localStorage key | `minima-fission-v1` |
| PTN スロット | 4（galaxy/drift と同じ） |

## メッセージ契約
- UI→engine: `{type:'play'}` `{type:'stop'}` `{type:'bpm',value}` `{type:'master',value}` `{type:'mute',track,value}`（track: kick|snare|hat|bass） `{type:'steps',track,steps[16]}`（track: kick|snare|ghost|hatC|hatO|bass） `{type:'param',track,name,value}` `{type:'fx',name,value}` `{type:'critical',value}` `{type:'bassNotes',notes[16]}`
- engine→UI: `{type:'step',index}` のみ。

## DSP実装メモ
- kick: sine pitch-sweep + click(punch) + tanh(drive)。
- snare: 三角波2発(body, toneで音程) + HPFノイズ(snap)。ghost行は level×ghost かつ decay×0.6 の弱打。
- hat: 6つの矩形波の金属クラスタ or HPFノイズ、toneでHPF周波数。hatO 発音時に hatC の鳴り残りをchoke。
- bass: 鋸波2osc（detuneでReese幅）+ glide + LPF(cutoff,reso)。bassNotes で半音オフセット。rootの基準 = A1系で root=5 が F1 (~43.65Hz) 付近になる低さ。
- effects: DubDelay(付点8分)/plate reverb/bitcrush/ducker は drift の effects.js を流用改変してよい。
- master = tanh(mix * master)。
- CRITICAL のリトリガー: 発音イベントを step 内で 2/3/4 分割リピート（確率・分割数は critical に比例）。乱数は xorshift 等の自前シードで、step0 ごとに再シード。

## ビジュアル契約（galaxy DNA 必須）
[[minima-new-module-design-rule]] 準拠: **galaxyの src/{index.html,style.css,renderer.js} を実コピー元にしてテーマ差分を当てる**。
- 共通言語: 漆黒シネマティック背景＋強フィルムグレイン＋ビネット＋EB Garamond＋「白い光の肉抜き／発光オーブ・光跡」のみ。塗り・グレー・リアルイラスト禁止。
- 差し色: `--accent: #4dff88`（緑）/ `--accent2: #ffe14d`（黄）。基調は白黒のまま、差し色は控えめに。
- シーン = **原子**: 
  - 中央 = **原子核**（発光オーブ7個前後のクラスタ、緑と黄が混ざる、呼吸アニメ）= 再生トグル（galaxyの太陽相当）。再生中は強くパルス。
  - 16ステップ = 原子核を囲む**電子軌道リング**上の16ノード。点灯step=緑の光球。
  - プレイヘッド = 軌道を周回する**中性子**（明るい白緑の粒＋短い光跡）。点灯ノード通過時に**核分裂フラッシュ**: ノードが2つの核破片に割れる演出＋黄色の中性子光条が2〜3本飛ぶ＋衝撃波リング。
  - 4トラック = 周囲に浮かぶ4つの**同位体アトム**（小さな核ドット＋楕円軌道の線画、galaxyの惑星相当）。タップでそのトラックのエディタへ、ミュートで減光。ラベル KICK/SNARE/HATS/BASS（セリフ）。
  - CRITICAL = 左上の**制御棒**: 白線画の縦ロッド＋ブラケット、上下ドラッグで引き抜き量=critical。%表示。高criticalで原子核が黄白に燃え、ガイガー的な微小フラッシュ＋中性子光条が増える。
  - 背景: 微細な粒子の星野＋時々流れる中性子ストリーク（galaxyの彗星相当）。
- エディタ/操作系: galaxyのUI構造（ステップ入力、パラメータスライダー群、MUTE/GEN、PTN 4スロット、BPM/master）をそのまま踏襲し、行構成とパラメータ名だけ本表に差し替え。BASSは galaxy 同様 per-step 上下ドラッグで音程（半音、音名表示）。
- タイトル: `minima fission` ＋ 小さな英字サブコピー（例: "chain-reaction breakbeats"）。
