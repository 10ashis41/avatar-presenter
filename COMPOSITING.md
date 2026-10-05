# Compositing — placing the clone into Eric's own video

Last updated: 2026-09-19

Two features Eric asked for, and they are **not** the same difficulty:

1. **Switch the clone's background** → needs a matte (the clone has to be cut out).
2. **Overlay the clone into a presentation video he made** → **usually needs no
   matte at all.**

Keeping them separate matters. The second one is not a GPU problem and not a model
problem; it is compositing, and it runs on CPU in seconds.

## Tier 1 — the presenter card (works today, no model, CPU only)

A rounded card in the corner of the scene, holding the clone. Everything a viewer
reads as "professional overlay" — corner radius, hairline border, soft drop shadow
— with **no background removal, no alpha inference, and no hair-edge failure mode.**

Tool: `tools/presenter_overlay.py`

```bash
# clone into a slide he exported, card bottom-right at 764px tall
python3 tools/presenter_overlay.py --scene slide.png --clone final.mp4 \
    --out out.mp4 --corner br --height 764

# clone into a screen recording / deck video (the real use case)
python3 tools/presenter_overlay.py --scene deck.mp4 --clone final.mp4 \
    --out out.mp4 --corner bl --height 520 --margin 56 --border none
```

Options: `--canvas WxH` (default 1920x1080), `--corner br|bl|tr|tl|c`,
`--height`, `--margin`, `--radius`, `--border HEX|none`, `--border-width`,
`--shadow`, `--scene-audio` (keep the scene's audio instead of the clone's).

`--scene` accepts a still **or** a video; a video is scaled and cropped to the
canvas, so a screen recording goes straight in.

Verified 2026-09-19: card-vs-clone mean pixel difference 3.94 on the video-scene
build (the clone really is in there), the scene area differs 19.85 between t=3s and
t=15s (the deck is playing, not a frozen still), and the card's corner rounds
correctly with the slide showing through.

Deliberate limitation: the drop shadow is baked into the scene only when the scene
is a still. For a video scene the shadow is skipped — compositing a blurred alpha
per frame costs more than it returns against moving footage.

## Tier 2 — full-scene placement / real background switching

Wanted when the clone should appear **in** the room or against a new background
with no card around it. This needs a matte, and there are two routes:

### Route A — green screen (best quality, free, trivial)
Chroma key instead of ML matting: perfect edges, no flicker, no licence questions,
runs in ffmpeg. If this is going to be a regular thing, this is the route. See
`SHOT-SPEC.md` for how to light it (separate screen light, subject 3+ feet off it,
watch for green spill on hair and shoulders).

### Route B — ML matting on the existing take (no reshoot) — **CHOSEN 2026-09-19**
Quality is bounded by the take and by hair edges. **Check licences before shipping
anything to a client** — this is the trap in this space:

| Model | Licence | Notes |
|---|---|---|
| BEN v2 | **MIT** | confidence-guided matting, hair-level, alpha output, 94.6M params |
| BiRefNet | **MIT** | high-res segmentation, image-focused; per-frame → pair with temporal smoothing |
| MatAnyone 2 (CVPR 2026) | **check — non-commercial tier exists** | best temporal stability, no green screen; needs a first-frame trimap seed |
| RVM | verify before use | tiny, realtime, temporal; softer hair |
| **Wav2Lip** | **NON-COMMERCIAL (LRS2 weights)** | do not ship. Not a matting model, but listed because people reach for it |

Seed the first frame with SAM 3.1 or RVM if the chosen model needs a trimap.

### The alpha asset (worth having either way)
Matting once lets the output be exported as an **alpha-channel asset**
(WebM VP9 alpha or ProRes 4444), which Eric can drop into CapCut / DaVinci and
place anywhere himself — no pipeline round-trip per new use case.

## Open questions for Eric

- Card style or full-scene placement? (Card is available now; full-scene needs the
  matte route chosen above.)
- Does his presentation have its own audio (music / voice-over) that should be
  mixed or ducked under the clone's narration?
- Should Tier 1 become a feature of the pipeline (a `scene` parameter on the job
  API) so a client can order a composite, or stay a local tool?

## Audio: three modes (implemented 2026-09-19)

Eric: "the presentations may or may not have their own audio" and the clone should read
whatever script he gives it. So the card tool takes `--audio`:

| mode | behaviour | when |
|---|---|---|
| `clone` (default) | narration only | deck has no audio, or its audio is irrelevant |
| `scene` | the deck's own audio, narration discarded | clone is silent/b-roll only |
| `mix` | narration on top, deck audio **ducked** under it | deck has music or a voice-over |

`mix` uses `sidechaincompress` keyed off the clone's narration (threshold 0.05, ratio 8,
attack 20ms, release 400ms). **Verified: 6.9 dB of attenuation** while the clone speaks
(-37.7 dB deck-alone -> -44.6 dB under narration).

Requesting `scene`/`mix` against a deck with no audio track warns on stderr and falls back
to `clone` instead of producing a silent file. Verified.

Note the clone always reads **whatever script is supplied** — that is the existing pipeline
(script -> cloned voice -> lip sync), not something compositing changes. The composite is
just where the finished clip is placed.

## Decision: BEN2, wired into the worker

**BEN2 (Prama LLC, MIT)** — verified in both the repo LICENSE and the model card
(`license: mit`). Their *enhanced* model is behind a paid API, but the Base model we
use is open, so commercial use is fine.

**RVM is out.** It is the obvious human video-matting model (temporal, real-time) but the
repo was re-released under **GPL-3.0** — copyleft, not something to ship inside a product
we sell. Checked before building rather than after.

How it is wired:

| Piece | Detail |
|---|---|
| Worker env | `MATTE_BACKEND` (default `ben2`, `none` disables), `MATTE_REFINE` (default on), `MATTE_PYTHON` |
| Where it runs | **after lip sync**, on the finished clip — so one matte serves any number of scenes with no re-render (LatentSync only rewrites the mouth, so the cut-out stays valid for a take) |
| Environment | installed into the **LatentSync venv** to reuse its CUDA torch 2.5.1 instead of adding a second ~2.5 GB download; guarded so a torch move fails the provisioning loudly |
| Output | WebM VP9 alpha from BEN2, converted to **ProRes 4444 (.mov)** — same alpha, a container every editor opens |
| API | result kind `alpha` -> `alpha.mov`, plus `GET /jobs/:id/alpha` (paywalled like `/final`) |
| Failure mode | matting is **non-fatal** — if it breaks, `final.mp4` is unaffected |

**Status:** code pushed to `presence-worker` (`a20c46b`), API route deployed and verified
(`/jobs/:id/alpha` -> 404 "Not ready" before completion). **Not yet exercised on a real
clip** — the pod must restart to provision BEN2 (~10 min of setup), and a restart was
deferred so it would not kill the guidance render in flight. The first matte test is the
next action, and Eric should judge the hair edges before this is called done.
