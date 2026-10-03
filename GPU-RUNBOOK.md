# GPU worker runbook

Everything learned getting the render pipeline actually running on a GPU,
2026-09-19. All findings below were observed on a real pod, not inferred.

Worker repo: **github.com/10ashis41/presence-worker** (public, no secrets —
`WORKER_TOKEN` is passed at runtime).

---

## Current state

| | |
|---|---|
| Pod | RTX 3090, Community, **$0.22/hr**, 24 GB VRAM |
| Image | `runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04` |
| Disks | container 40 GB + volume 50 GB (`/workspace`) |
| Voice clone | ✅ **working** — Chatterbox on CUDA |
| Lip sync (MuseTalk) | ⚠️ works but **quality rejected** — kept for speed only |
| Lip sync (LatentSync) | ✅ **working — DEFAULT**, quality accepted |
| LatentSync quality settings | **steps 40, DeepCache OFF, seed 1247** (2026-09-19) |
| Narration loudness | ✅ normalised to **-16 LUFS** before lip sync (was -27.9 dB mean) |
| Worker → API beacon | ✅ `POST /worker/hello`; read with `GET /admin/worker` |
| Paywall / delivery | ✅ working |

---

## Deploy a pod from scratch

RunPod → Pods → Deploy → **RTX 3090** (or 4090) → Community →
image above → **Container Disk 40 GB, Volume Disk 50 GB**.

Set env: `WORKER_TOKEN`, `API_BASE`, `TTS_BACKEND`, `LIPSYNC_BACKEND`, `IDLE_EXIT`.

Set the container start command to self-provision:

```bash
bash -lc 'set -x; D=/workspace/presence-worker;
  if [ -d $D/.git ]; then git -C $D fetch --all && git -C $D reset --hard origin/main;
  else git clone https://github.com/10ashis41/presence-worker.git $D; fi;
  cd $D && (bash setup_pod.sh 2>&1; echo "SETUP_EXIT=$?") | tee /workspace/setup.log;
  sleep infinity'
```

The `fetch || clone` form matters: `/workspace` persists, so a plain `git clone`
fails on restart and the pod silently runs **stale code**.

**Restart, don't recreate**, to pick up code changes — weights live on the volume
and a terminate destroys them (≈35 min to re-download).

---

## Three isolated Python environments — this is load-bearing

MuseTalk, Chatterbox and LatentSync pin **mutually incompatible torch versions**.
They cannot share an interpreter.

| Environment | torch | Used by |
|---|---|---|
| system python | **2.0.1+cu118** | MuseTalk + mmcv/mmdet/mmpose |
| `/workspace/cbvenv` | 2.6.0+cu124 | Chatterbox TTS |
| `/workspace/lsvenv` | 2.5.1 | LatentSync |

The worker reaches them via `CHATTERBOX_PYTHON` and `LATENTSYNC_PYTHON`.

`setup_pod.sh` asserts system torch is still 2.0.x before starting the worker —
if anything upgrades it, the run aborts with a clear message instead of failing
20 minutes later inside a render.

---

## Bugs found and fixed (all verified on a real pod)

### 1. Base image gives Python 3.12 → torch 2.0.1 has no wheels
```
ERROR: Could not find a version that satisfies the requirement torch==2.0.1
       (from versions: 2.2.0+cu118, … 2.7.1+cu118)
```
Ubuntu 24.04 images ship Python 3.12. MuseTalk needs **3.10**.
**Fix:** use the py3.10 image above. `setup_pod.sh` now pre-flights the Python
version and exits immediately with an explanation.

### 2. MuseTalk's `download_weights.sh` fails *silently*
Prints `✅ All weights have been downloaded successfully!` having downloaded
almost nothing. Four defects: deprecated `huggingface-cli`, removed `gdown --id`
flag, `HF_ENDPOINT` pointed at a China mirror, and **no exit-code checks**.
Surfaces ~20 min later as `MuseTalk weights missing: …/musetalkV15/unet.pth`.
**Fix:** `worker/download_weights.py` — stable `huggingface_hub` API, real HF
endpoint, positional gdown id, every file size-verified, non-zero exit on any miss.

### 3. MuseTalk's CLI does not take `--video_path` / `--audio_path`
It reads a **YAML task config** and needs explicit unet paths plus a version flag:
```
python -m scripts.inference --inference_config <task.yaml> --result_dir <out> \
  --unet_model_path models/musetalkV15/unet.pth \
  --unet_config models/musetalkV15/musetalk.json --version v15
```
**Fix:** `lipsync_musetalk()` writes that YAML per job.

### 4. Chatterbox clobbers torch → mmcv ABI break
```
ImportError: mmcv/_ext…so: undefined symbol: _ZN2at4_ops10zeros_like4call…
```
`pip install chatterbox-tts` upgraded system torch 2.0.1 → 2.6.0. mmcv ships
**precompiled** ops bound to the 2.0.1 C++ ABI.
**Fix:** Chatterbox moved to its own venv.

### 5. `huggingface_hub` 1.x breaks transformers
```
ImportError: huggingface-hub>=0.19.3,<1.0 is required … found 1.32.0
```
Caused by my own `pip install -U huggingface_hub` in the weight step.
**Fix:** pin `huggingface_hub<1.0`.

### 6. Orphaned jobs — ✅ FIXED
A job is set to `rendering` on claim. If the worker died mid-render the job
**stayed `rendering` forever**, because `/work` only hands out `queued` jobs —
a customer's render would silently strand with no recovery. Hit twice during
testing when a restart killed a worker that had claimed a job ~0.6 s earlier.

**Fix:** the worker now heartbeats (`progressAt`) on every progress update, and
`/work` sweeps any `rendering` job whose last heartbeat is older than
`STALE_CLAIM_MS` (default **30 min**) back to `queued`, incrementing `reclaims`.

Tested both directions, which is the part that matters:
- dead worker, no heartbeat → reclaimed (`reclaims=1`) and re-claimed ✅
- **live worker heartbeating through a long render → never interrupted** ✅

The second case is why the heartbeat exists rather than a naive timeout: a plain
age check would yank a legitimately slow LatentSync render off a working GPU.
30 min is deliberately generous for the same reason.

`/admin/jobs` now surfaces `claimedAt` and `reclaims`, so a job that keeps
failing and retrying is visible instead of silent.

**Operational note that still applies:** when restarting a pod, restart first,
wait for `worker up`, *then* requeue — otherwise the dying worker claims the job
on its way out and you wait 30 min for the sweep.

---

## Measured performance (RTX 3090)

Input: 22.6 s take, 720×1280 @ 60 fps. Output: 5.1 s video.

| Stage | Cold | Warm |
|---|---|---|
| Chatterbox TTS | ~4.7 min (downloads models) | **~10 s** |
| MuseTalk lip sync | ~4 min | ~4 min |
| Watermark + upload | seconds | seconds |
| **Total** | **~8 min for 5 s of video** | |

Full install from a bare pod: **~15 min** (MuseTalk) / **~35 min** (with LatentSync).
Restart with everything cached: **~2 min**.

> ⚠️ **All earlier cost/turnaround estimates are obsolete.** The old figure of
> "11 min for a 10-minute video" is wrong. Most of the 8 min is fixed overhead,
> so longer videos will not scale linearly — but a **long-form test render is
> required** before quoting any client a turnaround.

HF cache lives at `/workspace/hf-cache` so model downloads survive restarts.

---

## Quality: why MuseTalk looks like the mouth is "melting"

Rejected on visual quality 2026-09-19. The cause is **inherent to the model**,
not configuration — from MuseTalk's own Limitations section:

- **Resolution:** works on a **256×256** face region → upscaled into a 720×1280
  frame. The source face was ~500–700 px tall, so real captured detail is thrown away.
- **Jitter:** "single-frame generation" — every frame generated independently,
  no temporal consistency. *This is the melting.*
- **Identity:** "lip shape and color not well preserved."

`bbox_shift` only controls mouth openness. It cannot fix this.

### ✅ RESOLVED — LatentSync is the default (2026-09-19)

A/B on identical take + script. Eric's verdict: **"LatentSync is much better."**
The melting is gone. LatentSync is now the default backend.

Measured on the A/B clip:

| | MuseTalk | LatentSync 1.6 |
|---|---|---|
| Output size (same res, same clip) | 971 KB | **4.25 MB — 4.4×** |
| Lip-sync wall time | ~4 min | **~4 min (no slower)** |
| Audio/video duration match | 5.08 s video vs 5.8 s narration — **~0.7 s likely truncated** | 7.36 s / 7.28 s — consistent |

Two things that defied expectation:
1. **LatentSync was not slower on this clip.** The "quality costs speed" tradeoff
   did not materialise at 20 steps on a 5-second render. May not hold for long
   videos — re-measure on a long-form test.
2. **MuseTalk appears to truncate**: its output ran shorter than the narration
   it was given. Not audibly confirmed, but the arithmetic is clear.

### LatentSync 1.6 — the quality alternative

| | MuseTalk | LatentSync 1.6 |
|---|---|---|
| Face resolution | 256 px | **512 px** |
| Temporal consistency | none (per-frame) | **temporal layers + TREPA** |
| Architecture | one-step inpainting | multi-step latent diffusion (SD) |
| Speed | fast | **much slower** |
| VRAM | modest | 8 GB (v1.5) / **18 GB (v1.6)** |
| Licence | MIT | **Apache-2.0** ✅ |

Industry summary: *"MuseTalk is fast but capped at 256×256; LatentSync is slow
but beautiful."*

Quality knobs (exposed as env vars):
- `LATENTSYNC_STEPS` (20–50) — upstream's main lever; higher = better, slower
- `LATENTSYNC_GUIDANCE` (1.0–3.0) — higher = tighter sync, can reintroduce jitter

### Mouth blotches at lip closures — what to try (2026-09-19)

Eric's observation: *"very good, but the mouth flashes as a mushed blotch
whenever my lips touch, and the top lip doesn't move much."*

Mechanism: the mouth is **generated from the narration audio**, not copied from
the take. At a lip closure (m/b/p) the audio carries the least information AND
the model's fixed lower-face mask (`latentsync/utils/mask.png`) means those
pixels are invented, not preserved. The paper itself flags teeth/lips as the
flicker-prone high-frequency regions.

Levers, cheapest first (worker knobs now exist for all of these; the local
`worker/` files are byte-identical to `presence-worker`, so a push + pod restart
deploys them):

1. **`NARRATION_LUFS=-16`** (now the default). Measured on the last render:
   mean **-27.9 dB**, peak -9.0 dB — quiet speech, and the model's audio
   features are weakest exactly where articulation fails. Verified locally:
   normalising lifts it to **-16.8 / -1.5 dB**. Set `0` to disable.
2. **`LATENTSYNC_DEEPCACHE=0`**. DeepCache caches UNet features
   (`cache_interval=3`) to go faster — an approximation that lands on the
   high-frequency detail we care about (lips, teeth). Cheapest single A/B.
3. **`LATENTSYNC_STEPS=40`** (from 20). Upstream's main quality lever; roughly
   doubles render time. This is fix #1 in the list below and has NOT been tried.
4. **`LATENTSYNC_SEED=1247`** (now default) — pins sampling so an A/B compares
   the settings rather than luck, and a good render is reproducible.
5. **`LATENTSYNC_GUIDANCE=2.0`** (from 1.5) — tighter sync; watch for jitter.
6. **Capture-side ceiling:** even lighting, no clipped highlights (the test take
   is backlit), and a tighter face framing so the 512px crop isn't upscaling.
   Clipped lip/teeth pixels give the model nothing to reconstruct at contact.
7. **Advanced, risky:** a smaller mask in the config preserves more original
   sharp pixels at contact — but the model was trained with that mask, so expect
   sync to degrade. Treat as an experiment, not a fix.

Cannot yet be answered: LatentSync 1.6 is what we run; I could not confirm a
newer upstream release from this machine (the tags query returned empty), so
"upgrade the model" is not a lever to point at.

### If LatentSync still isn't good enough

In order of expected impact:
1. `inference_steps` 20 → 40–50 (roughly doubles render time)
2. **Re-record with even lighting** — the test take is backlit by a window,
   blowing out one side of the face; models reconstruct clipped highlights badly
3. GFPGAN / CodeFormer restoration pass — sharpens, but per-frame restoration
   can *add* flicker; test, don't assume
4. A different model class entirely — see `FULLBODY-MODELS.md` (far costlier)

---

## Verifying that a pod is actually running the current code

The pod pulls `presence-worker` **on container start**, so a code change is not
live until a **restart** (restart, don't recreate — weights live on the volume).
That used to be unverifiable from outside: you could only guess from render
duration.

Now the worker beacons its resolved settings at startup:

```bash
curl -s https://api.aiguyonthefly.com/presenter/admin/worker \
  -H "authorization: Bearer $ADMIN_TOKEN"
# -> {"at":…,"host":"…","lipsync":"latentsync",
#     "latentsync":{"steps":40,"guidance":1.5,"seed":1247,"deepcache":false,
#                   "narration_lufs":"-16"},"secondsAgo":…,"stale":false}
```

If `stale` is true or the call 404s, the pod has not checked in since the last
API restart — i.e. it is running older code or is down.

**Second, independent check:** the delivered video's audio. Loudness
normalisation is applied to the narration *before* lip sync, so a new render
whose audio measures ~**-16 dB mean** (rather than ~-28 dB) proves the current
worker code actually ran, regardless of what the beacon says.

**Ordering rule for a settings A/B** (this bit us): stage the job but do **not**
queue it until after the restart. A job queued while an old worker is still
polling gets claimed immediately, rendering with the OLD settings and burning
~11 minutes of pod time.

## Cost control

`IDLE_EXIT=0` today, so **the pod runs until stopped** — $0.22/hr ≈ **$5.28/day**.

| | Cost |
|---|---|
| Running 24/7 | $5.28/day |
| **Stopped** (volume only, 50 GB @ $0.20/GB/mo) | ~**$0.33/day** |
| Per render | ~$0.04 (MuseTalk) |

**Stop the pod when not testing.** Restart is ~2 min with everything cached.

Autoscaler design (proposed, not built): start the pod when a user **taps record**
— the 2–4 min they spend recording and pasting a script hides the cold start
entirely — and stop after 15 idle minutes.

Serverless breaks even against an autoscaled pod at roughly **3 renders/day**;
below that serverless is cheaper, above it the pod wins. See `PRICING.md`.

## 2026-09-19 — quality-pass render result

Job `f4da1ec7d8438117` — same take and script as the approved render, settings only:

| | approved render | quality pass |
|---|---|---|
| steps | 20 | **40** |
| DeepCache | on (interval 3) | **off** |
| guidance | 2 (pod env) | 2 (pod env) |
| output | 18.68s, 720x1280 | 19.28s, 720x1280 |
| wall clock | ~11 min | **20:35** |
| audio mean / max | -27.9 / -9.0 dB | **-16.8 / -1.5 dB** |

- Confirmed live three ways: the startup beacon (`steps: 40, deepcache: false`), the job
  state, and the pod's own log showing `27/40` on the diffusion progress bar.
- Independent proof the new code ran: the **output audio loudness**. The loudnorm step is
  the only thing that moves mean volume from -27.9 to -16.8, so the measurement cannot be
  faked by a stale status flag.
- Throughput for planning: LatentSync samples 16-frame chunks at ~1.15 it/s → ~35s of GPU
  per 16 frames (~0.64s of 25fps video). Use this, not the old 11-min figure, when quoting
  turnaround.

**Env overrides beat code defaults.** The pod's env carries `LATENTSYNC_GUIDANCE=2`, so the
1.5 default in `run_worker.py` never applied. The beacon reports *resolved* settings so
this is visible instead of assumed.

## 2026-09-19 — mouth/cheek mush: measured cause (not the encoder)

Eric's report after the quality pass: articulation improved, but mush persists and
now shows in the **cheeks**. Diagnosis, from source + pixels:

**Mechanism** (`latentsync/utils/image_processor.py`, `scripts/inference.py`): the face
is landmark-warped to a canonical crop, **resized to 512x512**, regenerated by the
audio-conditioned diffusion model inside a **fixed mask** (`latentsync/utils/mask.png` —
same mask for every subject), then warped back into frame. So:
- everything inside the mask is generated → generated-skin smoothness, not real pores;
- the mask covers mouth **and cheeks/jaw**, which is why cheek mush appears even though
  only the mouth is meant to change;
- the resample factor is `source face size / canonical crop size` → a tight close-up
  forces a downscale-then-upscale round trip;
- head motion moves the mask with the alignment → the patch swims.

**Measurement** (per-cell high-frequency detail vs. the take, 8x12 grid on frame at t=2s):
38-48% retained in the mouth/chin core, 70-90% at the cheeks, ~100% elsewhere. Localised
loss = the mask, not the encoder.

**Encoder ruled out.** The deliverable is `imageio` → `libx264 -crf 13` (High profile).
The CRF 23 `veryfast` setting in `lipsync_passthrough` applies to the passthrough path
only — it is **not** in the delivered file. 1.8 Mbps at 720x1280 at CRF 13 is a *symptom*
of soft content: x264 does not spend bits where there is no detail. Do not chase this.

Also unavoidable without patching upstream: `util.read_video()` re-encodes the take to
25 fps CRF 18 before processing.

**Fix direction: the take, not the settings.** See `SHOT-SPEC.md`. Wider framing moves the
resample factor toward 1.0, a still head stops the patch swimming, and more light means
less noise for the model to smooth away.

**Experiment in flight** (job `354d4b208b2c4aff`): the same take scaled to 70% and padded
back to 720x1280 — a simulated wider shot, isolating framing from every other variable.
Re-measure the same grid afterward; if retention in the mouth region rises materially,
the reshoot recommendations in `SHOT-SPEC.md` are confirmed by measurement rather than
theory.

**Next step if framing alone is not enough:** detail transfer — re-inject the original
take's high-frequency band inside the mask region (taking care to leave the mouth itself
alone, since the original mouth shape no longer matches). This is the only route to real
skin texture, because the model will never synthesise authentic pores.

## 2026-09-19 — lip polish FAILED perceptual validation (do not re-try as-is)

Eric's report, after watching the A/B: **no visible difference** between the clone and
the "polished" version. Verified — he was right.

- The edit was genuinely applied: panels 2 vs 3 of the delivered sheet differ by mean 0.50,
  max 145, with **2.75-3.37% of pixels changed by >=5 levels** (0.05-0.09% in the raw
  frames). Present, real, and **imperceptible**.
- Why the metric lied: `stddev(FIND_EDGES)` in the lip box moved 16.3 -> 17.9 at closure
  frames (85% -> 94% of the take's value). A few percent of pixels shifting a few levels
  is enough to move that statistic while changing nothing you can see.
- **Lesson: validate a measurement instrument against perception before trusting it.**
  A proxy metric is only useful once it has been shown to track what the eye sees. This
  instrument has now failed that check at least once.

**Also corrected, same day:** the earlier "38-48% detail loss in the mouth/chin core" was
an extraction artifact (`-ss` input seek vs `fps` filter landed on different frames — mean
pixel difference 2.87, max 202 — and the mouth was in a different shape). Over 15 averaged
frames the same cell reads 93%. The clone's worst frame is 97% of its own median.

**What DOES reproduce Eric's complaint** (the one instrument that passed):
conditioning on the take's own lip state, per frame, in a tight lip box (310,655)-(455,815):
- frames where the take's lips are **crispest** (pressed): clone retains **81-89%** (mean 85%)
- all other frames: **94-100%**
- and the clone's absolute lip detail barely rises at closures (take 17.3 -> 19.1-19.4; clone
  -> only ~16.0-16.9), i.e. **the model under-articulates the bilabial seal** rather than
  adding noise.

That is the benchmark to hold any future model or setting against.

## 2026-09-19 — guidance experiment + the real cost of a pod restart

**Restarting the pod re-runs full provisioning.** The container start command does
`git fetch && git reset --hard origin/main` then `bash setup_pod.sh`, which steps through
all 6 stages again — at step 2/6 it reinstalls MuseTalk's pinned torch 2.0.1. Observed:
**still provisioning 8+ minutes** after the restart, worker not polling. This is not the
~2 minutes previously assumed, and it directly affects two things:
- the autoscaler idea (start on "tap record", stop when idle) — every cold start pays this;
- quoted turnaround, since a cold pod adds ~10 min before a render even begins.

**Pod settings can be changed from the agent now**, no RunPod UI needed:
`update-pod` with the full env map (preserve every existing var — including `WORKER_TOKEN`,
`API_BASE`, `LIPSYNC_BACKEND`, `TTS_BACKEND`, `IDLE_EXIT`) then `pod-action restart`.
Verified: `LATENTSYNC_GUIDANCE 2.0 -> 3.0` with all 7 other vars intact.

**Experiment queued** (job `d1e40ed2966cf107`): identical take and script to the 85%
baseline render, with **guidance 3.0 instead of 2.0** as the only change. Rationale: the
model *under-articulates* the bilabial seal (take's lip detail rises 17.3 -> 19.1-19.4 at
closures; the clone only reaches ~16.0-16.9), and guidance is the knob that strengthens
audio adherence. Measure with the closure instrument and compare against 85%.

**Caveat on the pod env as a settings mechanism:** env changes need a restart, and a restart
costs ~10 min of provisioning. Per-job settings carried in the job payload and applied by
the worker would avoid this entirely — worth doing before any further knob-tuning.

## 2026-09-19 — matting step added (BEN2)

`run_worker.py` now runs a matte pass after lip sync and uploads it as the `alpha` result
(`MATTE_BACKEND=ben2` by default, `none` to disable). Installed into the LatentSync venv by
`setup_pod.sh` step 5b, with a guard that fails provisioning if torch moved, and the weights
pre-fetched into the persistent HF cache.

Consequence worth remembering: **the next pod restart will take longer than usual** (~10 min
of provisioning already, plus the BEN2 install on first run). Deferred until the guidance
render finished so it would not be killed mid-render.

Also fixed the same day: `render_watch.py` treated a stale worker poll as "pod down", but a
render in progress legitimately stops the polling loop (only progress beats continue). It now
only reports pod-down when nothing is rendering, and says "busy rendering another job"
otherwise. Verified with the `--drill` fixture.

## 2026-09-19 — sharding: rendering one job across several workers

**Why it is possible.** LatentSync walks the video in independent 16-frame chunks —
its own pipeline source shows each chunk getting its own audio embeds, faces and
denoising loop, with no state passed between them — and `prepare_latents` builds one
noise tensor and repeats it across every frame. So a worker given frames
`[start, end)` on a 16-frame boundary produces the pixels it would have produced
inside a whole-video render. That is the property that makes the expensive stage
splittable.

**What it buys: time only, not money.** ~64 GPU-minutes per minute of video either
way. 10-minute video = ~10.7 GPU-hours = ~$2.35 on a 3090 regardless; splitting just
turns that into ~80 min wall-clock across 8 pods. Cost per video is unchanged.

**Flow** (all driven by what workers ask for; `GET /work?v=2`):

| step | who | what |
|---|---|---|
| `prepare` | first worker | runs TTS once, uploads the narration (pinned, shared) |
| `part` | every worker | trims the narration slice + take slice, lip syncs, uploads `part<i>.mp4` |
| assemble | the API | ffmpeg concat of parts (video) + the pinned narration (audio) -> `final.mp4` |
| `finish` | any worker | watermark + matte the assembled file, upload, mark done |

**Verified 2026-09-19, without a GPU** (synthetic parts, real API): plan computed from
a 30s narration as 750 frames -> `[0,384)`, `[384,750)` with both starts 16-frame
aligned; a part killed with `/part/:i/fail` was released and re-handed to another
worker; all parts in triggered assembly automatically and produced a concatenated
`final.mp4` with the narration muxed; and a `?v=1` request returned 204 throughout, so
an older worker is never handed a task it cannot parse.

**The coupling rule.** Task payloads are meaningless to a worker that predates them.
This was not hypothetical: the first deploy sent a `part` task to the then-running old
worker, which took it for a normal job and died with `FAILED: KeyError('script')`.
Hence the `?v=2` gate — the API and worker must be deployed together, and the gate is
what makes it safe to deploy them at different times.

**Known gaps before this is production:**
- A real multi-pod render has not been run yet; the seam between parts is measured by
  theory (identical noise, aligned boundaries) but not yet by pixels.
- Cold-start floor: each pod re-runs `setup_pod.sh` (~10 min, and BEN2 made it longer).
  Provisioning overlaps the work, so an 8-way split of a 10-minute video lands nearer
  ~20-25 min than 80.
- **Pod volumes are per-pod and the account has no network volume**, so every cold pod
  re-downloads the weights. Sharing one network volume (~$3.50/month for 50 GB) is the
  next infrastructure step and is what makes fan-out cheap.
- Sharded parts loop the take **continuously forward**, whereas the single-worker path
  alternates forward/backward. Visual continuity across a seam therefore depends on
  the take having modest head motion; a take with big movement may show a pose jump.

## 2026-09-19 — matte cleanup: tested and rejected; mouth knob chased twice

**The chair ghost cannot be cleaned in post.** The pale region in the matte (a dark chair
against a dark background and dark clothing) sits at mid alpha and is **contiguous with the
person's silhouette** — flood-filling the person's component and zeroing everything else
leaves it untouched: at thresholds 60/100/150 the chair region's alpha only moves 114.8 ->
105-109 while the torso stays 255. "Keep the largest blob" is the obvious fix and it does
not work here. The cause is contrast in the shot, and only the shot fixes it (bright or
plain background, or green screen).

**Mouth sharpness: the quality pass may have been backwards.** More diffusion steps converge
toward the model's smoothest prediction; fewer steps retain more high-frequency texture.
The render Eric called "very good" ran at **20 steps with DeepCache ON**; the quality pass
took it to 40 steps with DeepCache off, which reads as *smoother* — i.e. blurrier — on a
close-up face. Guidance 3 then made it clearly worse, and guidance 2 changed nothing
perceptible. Settings reverted to the known-good combination (steps 20, DeepCache on,
guidance 2) for a direct A/B against job `320916c1`. Side benefit: ~4x faster renders.

**Measured 2026-09-19 (late): the steps question is answered — and the answer is "it does
not matter".** The closure instrument was re-run over three renders of the same take and
script: 20 steps + DeepCache on retained **82.6%**, 40 steps + no cache **78.5%**, and the
reverted 20-step **79.3%**, with all-frames detail at 4.29/4.28/4.28. A 0.2% spread is
noise. So the paragraph above is retired: **steps and DeepCache do not move the mouth on
this take**, and the "more steps = smoother" theory is retracted. Standard: **20 steps +
DeepCache on** (~4× faster, identical output).

The instrument caveat still stands, though: it reproduces *direction* on gross changes and
has never been validated against Eric's eye, so it is a hint, not a verdict. What settled
this was not the proxy — it was three renders differing only in settings, judged by the
person paying for them.

**EchoMimicV3 — the photo path (installed 2026-09-19, opt-in).**
```
INSTALL_ECHOMIMIC=1        # in the pod env; setup_pod.sh step 6b runs install_echomimic.sh
EM_REPO=/workspace/echomimic_v3
EM_PYTHON=/workspace/emvenv/bin/python
EM_STEPS=5                 # the model's own recommendation for a talking head
EM_PARTIAL=113             # frames per generation chunk; larger = more VRAM
```
- **Preview model, not flash-pro**: flash-pro's audio encoder is a Chinese wav2vec2
  (`TencentGameMate/chinese-wav2vec2-base`); our narration is English, and the preview path
  uses `facebook/wav2vec2-base-960h`. Choosing flash for speed would have cost lip-sync
  accuracy on English.
- **~22 GB** of weights (Wan2.1-Fun-1.3B-InP is 18.5 GB, 10.8 of that the T5 encoder; the
  EchoMimic transformer is 3.3 GB; wav2vec2 is 0.4 GB). `install_echomimic.sh` **measures
  free space first and refuses below 26 GB** — a half-downloaded weight file looks installed
  on the next boot, and the failure would only appear mid-render.
- **Non-fatal by contract.** It is installed beside the lip-sync pipeline, never instead of
  it: every failure path exits 0 with an explanation so a failed experiment cannot stop the
  pod from booting.
- **No CLI exists.** `infer_preview.py` keeps every path in a `Config` class and reads its
  inputs from a fixed `datasets/echomimicv3_demos/{imgs,audios,prompts,masks}/<name>`
  layout, so `em_driver.py` lays our inputs out in that shape and patches the Config at
  runtime, anchored on `self.save_path` — so an upstream refactor aborts loudly instead of
  silently producing a clip of the wrong length. The patched copy is written **inside the
  repo**, because the script does `from src... import` and python puts the *script's*
  directory on `sys.path`, not the working directory.
- Length follows the audio (`int(duration × 25 fps)`); output is 768×768 @ 25 fps; long
  video is handled by the model's own overlapping chunks (`partial_video_length` +
  `overlap_video_length` + a linear cross-fade).
- Watch the beacon: `GET /admin/worker` now reports an `echomimic` block
  (`installed: true/false`), because the install is optional and otherwise only answerable
  by reading pod logs.
- **Still unmeasured: speed and cost per minute.** Time the first real generation before
  quoting anyone a turnaround.


---

## EchoMimicV3 — first successful render, and why it was rejected (2026-09-20)

**Status: WORKS END TO END. Quality rejected for client deliverables. Pods terminated.**

Job `9a8d838a57ba38ba` is the first photo-to-video render this project has ever completed:
a still headshot + a cloned-voice narration in, 14.28 s of 768x768 25 fps video out.

### The measurement that decides its use

| | |
|---|---|
| Output | 14.28 s, 357 frames, 768x768, 25 fps |
| Generation | **39.5 min** on an A40 48 GB (chunk 49) |
| Per second of video | **~166 s of GPU** |
| Cost, this clip | $0.34 at $0.49/hr |
| **Extrapolated 10-minute video** | **~29 hours, ~$14.50** |

LatentSync is ~47 s of GPU per second of video on a $0.22/hr 3090 — roughly **3.5x faster
and 8x cheaper**. Some of that gap is the chunk-size drop to 49; a bigger card that can
hold chunk 113 would recover part of it, not all.

**Conclusion: EchoMimic is a SHORT-FORM tool.** Under ~60 s it is usable and needs no camera
from the client. For a 10-minute presentation it is not viable, and LatentSync stays the
backend for that.

### Why Eric rejected the output

> "It starts out ok then turns into cartoony in appearance. I can't use this as a deliverable
> to a customer."

Confirmed on a frame contact sheet (0.6 / 3.5 / 7.0 / 10.5 / 13.6 s):

- **Frame 1 is photoreal; later frames drift toward illustration** — skin, hair and fabric
  all gain saturation and lose photographic texture as the clip runs.
- **Hands melt.** Clasped hands are clean at 0.6 s, smearing by 3.5 s, and an unrecognisable
  white mass from 7 s on. The classic generative failure on hands.
- Mild background warping at the frame edges.

**What it DID do right** — and it is the thing LatentSync cannot do: it *generates* motion.
Head turns, tilts and expression changes are invented from the audio, not copied from a
source take. Identity held across all 357 frames. The problem is fidelity, not motion.

### Cheapest quality experiment if this is revisited

**Crop the source photo to head-and-shoulders.** Hands that are not in frame cannot melt,
which removes the single worst artifact at zero cost. Then, in order: `EM_STEPS` above 5
(5 is tuned for speed, not fidelity), and `EM_SIZE` — but 768 already OOMed at chunk 113.

### The six bugs, all fixed and pushed

Three of these are the SAME pattern — a co-installed package silently replacing something
torch depends on. Watch for it whenever this venv changes.

| Commit | Bug |
|---|---|
| `a838469` | `EM_MODELS` never exported; the weights downloader is a python child and never saw it |
| `a57a80f` | transformer weights written one directory too deep, so the "already have them" guard never matched |
| `2e13277` | requirements.txt installed torch 2.14 over the pinned cu124 trio, breaking torchaudio |
| `d290b88` | retina-face imports `tensorflow.keras`, removed in TF 2.16 — fixed with tf-keras + `TF_USE_LEGACY_KERAS` |
| `4e14926` | Wan base DiT never downloaded (allow_patterns had no `*.safetensors`) AND the guard only checked the directory, so it was skipped on every boot -> `KeyError: 'patch_embedding.weight'` |
| `a1ae545` / `0d2a234` | TensorFlow must be hidden from the GPU **across its import**, not after it — otherwise it loads its own cuDNN and torch's first conv3d dies |
| `f963d68` | TensorFlow overwrites torch's `nvidia-cudnn-cu12` -> `CUDNN_STATUS_NOT_INITIALIZED`. Fixed by re-pinning what torch declares, **plus a conv3d smoke test at install time** |
| `6d3dfd0` | chunk 113 OOMs a 48 GB card mid-diffusion (42.5 of 44.4 GiB used); default is now 49 |

**The install-time conv3d smoke test is the important one.** Every bug above surfaced ~4
minutes into a render, after Chatterbox had already done its work. The install now proves
the failing operation works before any job is queued.

### OPEN BUG — the stale-claim sweep will kill long renders

`reclaimStale()` treats >30 min without a heartbeat as an orphaned job. `run_worker.py`
heartbeats **between steps**, and EchoMimic generation is ONE step lasting 40 minutes. At
11:37 on 2026-09-20 it was ~4 minutes from requeueing a job that was rendering at 100% GPU.

Worked around externally for that render; **not fixed in the worker.** `run_worker.py` needs
to heartbeat on a timer while a long subprocess runs. This affects ANY long render, not just
EchoMimic — a 10-minute LatentSync job would hit it too.
