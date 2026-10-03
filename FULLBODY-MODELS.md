# Full-body "walk and talk" — how this is done, what to use, and how to beat the commercial options

Researched 2026-09-18. Companion to `PRICING.md` and `LICENSES.md`.

## The core distinction that answers the whole question

The current pipeline (MuseTalk) is **lip-sync / re-enactment**: it preserves a real
performance and re-animates the mouth. Walk-and-talk requires a **generative
full-body animation** model. Different architecture, different cost class, different
failure modes.

Two mechanisms exist, and picking the right one is the whole ballgame:

| | Audio-driven generation | Video-driven transfer |
|---|---|---|
| Input | photo + audio (+ prompt) | **driving video** + character image |
| Motion comes from | the model *invents* it | real human performance |
| Examples | OmniHuman 1.5 (API only), HunyuanVideo-Avatar, OmniAvatar, FantasyTalking, EchoMimic | **Wan-Animate-2 / Wan2.2-Animate-14B** |
| Failure mode | floaty motion, uncanny gestures, identity drift | needs good driving footage; scene blend artifacts |
| Quality ceiling | highest from a still photo | highest overall *when you control the drive* |

**Strategy: use video-driven for hero motion (walk, turn, gesture at a screen) and
audio-driven for straight talking-head segments.**

## The models, with licences and hardware (verified 2026-09-18)

| Model | Licence | VRAM | Notes |
|---|---|---|---|
| **Wan-Animate-2** (Wan-Video, Jul 2026) | **Apache 2.0** | 24 GB fp8 @720p (good); ~8–12 GB GGUF Q4 @480p | 14B DiT, end-to-end from a driving video, **text-driven viewpoint control** (decouples output camera from the driving video), plus a **Lite variant targeting real-time/streaming**. Repo defaults tuned for 8×A800 @720p; 480p on 2×A800. README: *"We claim no rights over your generated contents."* |
| **Wan2.2-Animate-14B** (Sep 2025) | **Apache 2.0** | ≥80 GB official; fp8 in ComfyUI 24 GB+ | Animation mode (still image copies driving motion/expression/lips) + replacement mode (swap a character in existing footage). |
| **HunyuanVideo-Avatar** (Tencent) | Tencent Community Licence | 24 GB min (very slow), 96 GB recommended, 80 GB can OOM; TeaCache community route ~10 GB | MM-DiT, audio-driven, multi-character, emotion-controllable. HF repo ~80 GB. **Licence carve-outs (EU/UK/South Korea territory) — see LICENSES.md.** |
| **OmniAvatar** (Zhejiang/Alibaba, Jun 2025) | check repo (builds on Wan2.1) | 36 GB full · 21 GB w/ 7B offload (19.4 s/it) · **8 GB extreme offload (22.1 s/it)** · 14.3 GB on 4×GPU FSDP (4.8 s/it) | 14B **audio-driven full-body** with adaptive body animation — the practical entry point for testing on a single 4090. |
| **OmniHuman 1.5** (ByteDance) | **API only — no weights released** | n/a | Available via BytePlus (official), Runware, Replicate, fal. $0.12/sec ≈ $72 per 10-min video. This is the quality bar to beat. |

**We cannot self-host OmniHuman.** Anyone claiming otherwise is wrong. Our options are:
rent the API, or use open weights (Wan-Animate-2 is the strongest and cleanest-licensed).

## Measured throughput (this is the number that makes it feasible)

From a documented ComfyUI run of Wan-Animate-2 on a 24 GB card, 480×832, 81 frames:

- Cold start to first output: **4 min 12 s**
- Repeat-run median: **1 min 48 s** (with WanAnimate2Cache)
- Peak VRAM: **21.4 GB** (int8_convrot + cache on GPU), ~12–15 GB additional system RAM
- One documented failure in five runs (output resolution not divisible by 16)

81 frames @ 24 fps ≈ 3.4 s of finished video per ~1.8 min of GPU.

**A 10-minute full-body video ≈ 176 clips ≈ ~5 GPU-hours ≈ $1.80–4.00** at
RTX 4090 rates ($0.34/hr community, $0.74 secure; A100 80GB $1.19–1.39/hr;
H100 PCIe $1.99/hr community / $2.89 secure).

Compare: our talking-head pipeline is **$0.05** per 10 minutes; the OmniHuman API is
**$72**. Full-body self-hosted sits between — roughly 20–35× cheaper than the API at
volume, ~40–80× more expensive than lip-sync re-enactment.

The real cost is **person-time**: drive capture, compositing, QA. Budget hours per
finished video, not minutes. Price accordingly (this is a $1.5–5K deliverable, not a
$300 one).

## The production recipe for "walking, talking, gesturing at a screen"

Model choice is maybe 40% of perceived quality. The rest is this:

1. **Capture a driving performance.** Film a performer (you, or a paid stand-in with
   written consent) against a plain evenly lit wall doing the walk, turn and
   point-at-screen gestures, 60–90 s of coverage per beat, 4K, 24–25 fps, even 3-point
   lighting. **No green screen** — see the background section below. Wardrobe silhouette
   matters, since it's what the model copies.
2. **Generate** with Wan-Animate-2 in animation mode: client's approved image + driving
   video → same motion, client's identity.
3. **Control the camera with the text prompt** (Wan-Animate-2 viewpoint control) so the
   output angle matches the virtual set instead of inheriting the driving camera.
4. **Composite.** Generate on a clean plate → key/rotoscope → place on the slide set
   with matching light direction, a contact shadow under the feet, slight defocus and
   grain on the deck. Mismatched lighting direction is what makes composites read fake.
5. **Polish chain:** MuseTalk lip-sync correction pass on the generated output
   (hybrid: generative body + re-enactment mouth — fixes the worst artifact class),
   RIFE frame interpolation to 60 fps, CodeFormer/GFPGAN face restore,
   Real-ESRGAN upscale to 1080p/4K.
6. **Edit like a real production:** wide full-body → medium → close-up → full-screen
   deck B-roll, cut on the beat. Editing rhythm hides generative artifacts better than
   any model upgrade.

## Backgrounds: what actually controls the output (this decides the green-screen question)

From the Wan-Animate paper itself:

- **Animation Mode — the output background comes from the SOURCE IMAGE, not the driving
  video.** *"In Animation Mode, the character from a source image is animated according to
  the motion of the character in a reference video, while the background from the source
  image is preserved."* It is an I2V task. The drive supplies **motion only** (2D skeleton via
  VitPose + raw face frames for expression, with identity leakage explicitly trained out).
- **Replacement Mode — the output background comes from the DRIVING VIDEO**, with a
  Relighting LoRA matching lighting and colour tone so the swapped character sits in the
  original scene.
- Output aspect ratio follows the source image in Animation Mode and the driving video in
  Replacement Mode.

**Consequences:**

1. **No green screen is required — and it is arguably the wrong choice.** In Animation Mode
   the drive's background never appears in the output, so keying it is pointless, and green
   spill on skin and hair actively pollutes the transferred identity. A plain, evenly lit wall
   is strictly better.
2. **You control the output background by editing the still image.** Their own training
   pipeline edits backgrounds with Qwen-Image-Edit. For us: take the client's photo, replace
   the background with a flat plate or the set we want, and that becomes the scene. No
   filming, no chroma.
3. **Use Replacement Mode when you want a real environment** (e.g. the presenter in front of
   an actual studio screen with correct perspective and parallax). Then you shoot in the real
   location, not against a chroma screen.
4. To cut the presenter onto a branded deck: generate against a plain reference-image
   background, then matte with SAM 2 / BiRefNet / RVM (no chroma key needed) and composite.

## The driving performance: who, and how often

- The drive supplies **motion, not identity** — so it does **not have to be the client**.
  A stand-in, ourselves, or licensed stock footage all work. (Consent still has to cover the
  client's likeness being depicted doing that motion.)
- **Build a reusable motion library** — record each beat once, reuse forever across every
  client: walk-in, turn to camera, point at screen, open-palm gesture, nod/listen, walk-out.
  That library is the real scalable asset. It is not "film the client every time."
- A drive can also be **synthesised** (text-to-video) or taken from stock if nobody can be
  filmed at all.
- Wan-Animate generates **short clips (~81 frames ≈ 3.4 s at 24 fps)**, so a 10-minute video is
  ~176 segments cut together. Shoot drives as discrete 5–10 s beats, not one long take.
- Drive specs: 1080p+ (4K preferred), 24–30 fps, full body framed with space in the direction
  of the gesture, locked-off or smoothly moving camera, even lighting, plain background, no
  logos/patterns on clothing, no hands crossing the face.

## The alternative with NO filming at all

**Audio-driven models** (OmniHuman 1.5 via API, OmniAvatar, HunyuanVideo-Avatar) generate the
motion from a photo + audio. No drive, no performer, no capture session — that is exactly what
"type a script and the avatar walks and gestures" means. Trade-offs: lower motion realism,
weaker control over *what* is pointed at and where the camera sits, and the SOTA option is
rented per second. Use it when the client cannot be filmed; use the video-driven route when
quality and control matter.

## Reference-image checklist (input quality dominates output quality)

- One unobstructed face at useful resolution; portrait/upper-body/full-body framing that
  **matches the intended motion** (ask for full-body framing if they must walk).
- Deliberate wardrobe, accessories, background, hairstyle — all of it gets copied.
- Leave empty space in the direction of gestures and camera movement.
- Clean, authorised voice track, one dominant speaker; avoid profiles, hands crossed
  near the face, harsh shadows, music, echo, overlapping voices.

## How to be better than the commercial options (ranked by leverage)

1. **Drive real motion.** This is the single biggest lever and it is the one thing a
   photo-to-avatar API cannot do. It is also why the output looks filmed rather than
   generated.
2. **Never let the model improvise the mouth.** Hybrid generate → MuseTalk pass.
3. **Match the audio to the visual space** — room tone and a touch of reverb; dry dead
   audio in a "big room" screams fake. Use the best voice clone available.
4. **Compositing discipline** — light direction, contact shadows, defocus, grain.
5. **Cut rhythm** (see step 6 above).
6. **Measure it, don't assert it** — the OmniAvatar paper's metric set is the target:
   Sync-C ↑ / Sync-D ↓ (lip-sync), FID ↓ / FVD ↓ (visual quality/temporal), IQA ↑,
   ASE ↑ (audio-emotion alignment). We can compute Sync-C/D, identity similarity
   (ArcFace) and mouth-region sharpness on clips once we have both ours and a competitor's.

## Recommended sequence (given: no GPU, no RunPod account, cost-cutting mode)

**Step 0 — sell it before building it.** Offer the walk-and-talk tier as a premium
production ($1.5–5K), fulfil the first one via the OmniHuman API (~$72 cost, zero
capex, zero setup) and use that output as our quality benchmark. No build risk.

**Step 1 — validate on cheap hardware.** One RunPod RTX 4090 ($0.34/hr), ComfyUI +
Wan-Animate-2 fp8, 3-second test on our own face. Total cost: well under $1.
Gate: does it hold identity and look non-generated?

**Step 2 — build the pipeline** (capture rig checklist → animate → composite → polish).
The moat is this pipeline, not the model — anyone can download the weights.

**Step 3 — only then consider self-hosting at scale** (dedicated pod vs serverless:
RunPod A100 serverless $2.72/hr breaks even against a $1.39/hr dedicated pod at ~373
active hours/month).

## Open questions to resolve before quoting a client

- Written likeness + voice consent covering *generated* motion, not just a talking head.
- If a stand-in is used for the driving performance, that's a second consent and a
  disclosure question in itself.
- Who owns the generated deck footage, and may we reuse the avatar after the engagement.
