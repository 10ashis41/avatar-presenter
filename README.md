# AI Clone Presenter

Record yourself once on your phone, then paste any script and get it back
delivered in your own face and voice.

**Live:** https://aiguyonthefly.com/aiclone/
**API:**  https://api.aiguyonthefly.com/presenter/

```
phone ──┐                      GCP VM                     rented GPU pod
        │  record + script   ┌──────────────┐   pulls    ┌────────────────┐
        └──────────────────▶ │ presence-api │ ◀───────── │ presence-worker│
                             │  (port 4010) │            │ Chatterbox TTS │
           watermarked       │  job store   │ ──────────▶│ MuseTalk sync  │
           preview   ◀───────┤  PAYWALL     │  final +   │ ffmpeg preview │
                             └──────────────┘  preview   └────────────────┘
```

Built on MuseTalk and Chatterbox rather than HeyGen for two reasons: HeyGen's
terms forbid reselling, and per-render cost drops from ~$72 to ~$0.09 for a
10-minute video. See `PRICING.md`.

---

## Status — 2026-09-19

The pipeline **works end to end on a GPU**. First real clone rendered today.

| | |
|---|---|
| Front end, API, Stripe, invite codes, paywall | ✅ live |
| Voice clone (Chatterbox, GPU) | ✅ **working** |
| Lip sync (LatentSync 1.6) | ✅ **working, DEFAULT — quality accepted** |
| Lip sync (MuseTalk) | ⚠️ works, quality rejected — kept for speed only |
| Watermark / preview / delivery | ✅ working |
| Orphaned-job recovery | ⚠️ works, but **kills renders over 30 min** — see GPU-RUNBOOK |
| Photo → video (EchoMimicV3) | ⚠️ **works end to end, quality rejected** — see GPU-RUNBOOK |

**Quality is resolved.** MuseTalk's output was rejected (the mouth "melts" —
inherent to its 256 px face region and single-frame generation). **LatentSync 1.6**
(512 px, temporal layers, Apache-2.0) was A/B tested on the same take and
accepted — "much better". It is now the default, and it was **no slower** on
that clip. See `GPU-RUNBOOK.md`.

**Everything about GPU setup, the six bugs found, measured render times and the
quality analysis lives in `GPU-RUNBOOK.md`.** Read that before touching a pod.

### Still to fix before any client uses this

- **`STRIPE_SECRET_KEY` is `sk_live_`**, not a test key, on a flow nobody has
  purchased through. A test key exists in `~/aiguy-chatbot/.env`.

### Cost right now

**Zero — all pods were terminated on 2026-09-20.** Nothing is
billing. Terminating (not stopping) also destroyed the volumes, so the next pod
re-downloads ~40 GB of weights: budget ~35 min for a cold rebuild, not 2 min.

A stopped pod still bills its disk (~$0.24/day for 90 GB). Stop it to pause compute;
terminate it to stop paying entirely.

---

## The paywall

The client can watch, but cannot take, until they pay.

Every job renders **two** files:

| File | Served by | Availability |
|---|---|---|
| `preview.mp4` | `GET /jobs/:id/preview` | always, once rendered |
| `final.mp4` | `GET /jobs/:id/final` | **402 Payment Required** until `paid` |

The preview is degraded on three independent axes, so stripping any one still
leaves the other two:

1. Repeated watermark bands across the frame (not a removable corner logo)
2. Half resolution
3. A periodic audio duck — the soundtrack can't be lifted cleanly either

The clean file is **never referenced in the browser** while locked. The polling
endpoint only ever returns the preview URL, `final.mp4` sits outside any static
directory, and requesting the path directly returns 402. There is no client-side
flag to flip.

### Unlocking after payment

```bash
source ~/avatar-presenter/api/.env
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.aiguyonthefly.com/presenter/admin/jobs/<JOB_ID>/pay
```

The client's page picks it up on its next poll — the lock card is replaced by a
download button. The job ID is shown to them on the locked screen as
"Reference:", so they can quote it to you.

List everything:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.aiguyonthefly.com/presenter/admin/jobs | python3 -m json.tool
```

> Stripe is **not** wired up yet. Today unlocking is a manual curl, which is
> correct for a first client — wire the webhook to this same endpoint when it
> becomes repetitive.

---

## Setting up the GPU — this is what makes a real clone

Nothing on the VM can produce a clone: no GPU, 3 GB RAM, no CUDA. The lip-sync
and voice-clone steps run on a rented pod. Worker code lives in its own private
repo so a pod can just clone it: **github.com/10ashis41/presence-worker**

### 1. Rent a pod

RunPod (console.runpod.io) → Pods → Deploy → **RTX 4090** (24 GB is enough),
template **RunPod PyTorch**. ~$0.34/hr community, ~$0.69/hr secure.

**Disk sizing matters and the two fields do different jobs:**

| Field | Holds | Set to |
|---|---|---|
| **Container Disk** | pip installs (torch, mmcv, mmdet, mmpose) | **40 GB** |
| **Volume Disk** (`/workspace`) | MuseTalk repo + ~10 GB of weights | **40 GB** |

The defaults (often 20 GB container) are too small — the mmlab stack alone is
10–15 GB and the install dies partway with a confusing error.

Do **not** build the Docker image on the VM: the image is ~20 GB and the VM has
15 GB free while hosting NMLN, EasyAppointments and the CRM.

### 2. Get the worker token

On the VM:

```bash
grep WORKER_TOKEN ~/avatar-presenter/api/.env
```

### 3. Run setup on the pod

In the pod's web terminal:

```bash
git clone https://github.com/10ashis41/presence-worker.git /workspace/presence-worker
cd /workspace/presence-worker
export WORKER_TOKEN=<paste from step 2>
bash setup_pod.sh
```

`setup_pod.sh` installs MuseTalk + the mmlab stack, downloads ~10 GB of weights,
installs Chatterbox, verifies the GPU is visible, then starts the worker polling
for jobs. First run takes **20–40 minutes**, almost all of it weight download.
Re-runs skip anything already present.

### 4. Submit a job and watch

With the worker running, go to https://aiguyonthefly.com/aiclone/ on your phone
and complete a real recording. The pod picks it up within ~20 s and logs each
stage. Then:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.aiguyonthefly.com/presenter/admin/jobs | python3 -m json.tool
```

### MuseTalk's own weight downloader is broken — we replaced it

`MuseTalk/download_weights.sh` **fails silently** (verified on a real pod,
2026-09-19). It calls the deprecated `huggingface-cli`, uses `gdown --id`
(a flag removed from current gdown), points `HF_ENDPOINT` at the
`hf-mirror.com` China mirror, and **checks no exit codes** — so it prints
`✅ All weights have been downloaded successfully!` having downloaded almost
nothing. The failure then surfaces ~20 minutes later, mid-render, as
`MuseTalk weights missing: .../musetalkV15/unet.pth`.

`worker/download_weights.py` replaces it: stable `huggingface_hub` Python API,
the real HF endpoint, positional `gdown` id, and every file verified against a
minimum size with a non-zero exit on any miss. Expected result (~8.8 GB):

```
    3242.6 MB  musetalkV15/unet.pth
    3242.6 MB  musetalk/pytorch_model.bin
    1419.1 MB  syncnet/latentsync_syncnet.pt
     388.0 MB  dwpose/dw-ll_ucoco_384.pth
     319.2 MB  sd-vae/diffusion_pytorch_model.bin
     144.1 MB  whisper/pytorch_model.bin
      50.8 MB  face-parse-bisent/79999_iter.pth
      44.7 MB  face-parse-bisent/resnet18-5c106cde.pth
```

### Base image must be Python 3.10

Use `runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04`. An Ubuntu 24.04
image gives Python 3.12, for which **torch 2.0.1 has no wheels at all** — pip
dies with `Could not find a version that satisfies torch==2.0.1`. `setup_pod.sh`
now pre-flights this and fails immediately with a clear message.

### Version pins — do not "upgrade" these

MuseTalk's README pins **torch 2.0.1 / cu118** and **mmcv 2.0.1**. The mmlab
compiled ops are tied to that torch build and newer torch fails *silently* —
wrong output rather than an error. `setup_pod.sh` and the Dockerfile both hold
these pins deliberately.

### Known-correct MuseTalk invocation

MuseTalk 1.5 does **not** take `--video_path` / `--audio_path`. It reads a YAML
task config and needs explicit unet paths plus a version flag:

```
python -m scripts.inference \
  --inference_config <task.yaml> --result_dir <out> \
  --unet_model_path models/musetalkV15/unet.pth \
  --unet_config models/musetalkV15/musetalk.json --version v15
```

`lipsync_musetalk()` writes that YAML per job. This was verified against the
upstream repo on 2026-09-18 — an earlier version of the worker used the wrong
flags and would have failed on the first run.

### Cost

A 10-minute video is ~16 billable minutes ≈ **$0.09** on a 4090. Set
`IDLE_EXIT=600` so the worker exits after 10 idle minutes and the pod can shut
down rather than bill while idle.

## Operating it

Service on the VM:

```bash
sudo systemctl status presence-api
sudo journalctl -u presence-api -f
```

Job data (takes, renders, metadata) lives in `~/avatar-presenter/api/data/<jobId>/`.
Nothing is deleted automatically — clean up old jobs yourself, since the takes
are large and they contain a client's face and voice.

Front end deploys with the rest of the site:

```bash
cd ~/aiguyonthefly && netlify deploy --prod --dir .
```

---

## Languages — English, Hebrew, Arabic

| Stage | Hebrew / Arabic support |
|---|---|
| **Script entry** | ✅ textarea auto-switches to RTL, shows a language badge, and uses a 130wpm duration estimate (vs 150 for English) |
| **TTS — Chatterbox Multilingual V3** | ✅ `ar` and `he` both in the 23-language set; clones the *same* voice across languages. Hebrew CER 0.93% in V3 |
| **TTS — ElevenLabs fallback** | ✅ `eleven_multilingual_v2` covers both; infers language from the text |
| **Lip sync — MuseTalk** | ⚠️ audio-driven and language-agnostic in principle, but **unverified for Arabic pharyngeals**. Check the first real render. |
| **Transcription (STT)** | not built — see below |

Language is detected from Unicode script blocks (Hebrew and Arabic occupy
distinct ranges, so character counting beats a statistical detector on short
scripts). Detection runs **twice, independently**: in the browser for RTL
display, and again in the worker. The browser value is only a hint, so a wrong
guess client-side cannot break a render.

Chatterbox note: English uses the English-only checkpoint (slightly better for
English); `he`/`ar` use `ChatterboxMultilingualTTS` with `t3_model="v3"` and an
explicit `language_id`.

### Not built: transcription

You asked for "read and transcribe". The pipeline currently goes
**script text → speech → video**. There is no speech→text step, because nothing
in the flow needs one yet. If you want the presenter to *speak* their script
instead of typing it, that's a separate feature — Whisper large-v3 handles both
Hebrew and Arabic, and you already run Deepgram `ar-JO` in the church
translator. Say the word and I'll add it.

## Render backends

Both ML stages are pluggable so the worker runs with or without a GPU:

| Env | Production (GPU) | No-GPU fallback |
|---|---|---|
| `TTS_BACKEND` | `chatterbox` — clones the presenter's own voice, free | `elevenlabs` — works anywhere, costs per character |
| `LIPSYNC_BACKEND` | `musetalk` — real lip sync | `passthrough` — **no lip sync at all** |

`passthrough` exists purely so the plumbing can be tested without a GPU. Its
output is **not a clone** — the mouth does not match the words — so it burns
"PIPELINE TEST — NO LIP SYNC" into the frame. It must never reach a client.

**There is no working avatar yet.** Both GPU backends are written but have never
executed. See below.

## What's tested vs not

| Component | Status |
|---|---|
| Front end (iOS + Android flows, validation) | ✅ tested in-browser, real files |
| Downscaling of oversized Android clips | ✅ 4K → 720p verified, audio intact |
| API job lifecycle | ✅ full round trip |
| **Paywall (402 → unlock → 200)** | ✅ verified |
| Watermark rendering | ✅ verified on real video |
| CORS from the deployed page | ✅ verified |
| Worker job loop, claim, upload, error path | ✅ ran for real against the live API |
| Narration via ElevenLabs fallback | ✅ real 8.8s audio from a real script |
| Auth: 401 on admin/worker/take endpoints | ✅ verified |
| Path traversal rejected | ✅ 3 variants |
| MuseTalk CLI invocation | ✅ corrected against upstream 2026-09-18 (was wrong, would have failed run 1) |
| **MuseTalk lip sync** | ❌ **never run — needs a GPU** |
| **Chatterbox voice clone** | ❌ **never run — needs a GPU** |
| **An actual cloned avatar** | ❌ **does not exist yet** |

This VM physically cannot run the models: no GPU, 3 GB RAM (needs ~12-16),
15 GB free disk (needs ~18), and no nvidia container runtime. It also hosts
NMLN, EasyAppointments and the CRM, so filling its disk to try is not worth the
risk.

Everything *around* the models is verified end-to-end. The models themselves
need a rented pod. Expect first-run debugging around MuseTalk's mmcv/mmpose
pins (notoriously brittle) and the exact output path its inference script
writes to — `lipsync_musetalk()` globs for the newest `.mp4` under the result
dir, which is the part most likely to need adjusting.

---

## Files

| Path | Purpose |
|---|---|
| `~/aiguyonthefly/aiclone/index.html` | Front end (deployed) |
| `api/server.js` | Job broker + paywall |
| `api/.env` | Tokens — **keep private** |
| `worker/run_worker.py` | Pulls jobs, orchestrates a render |
| `worker/tts_chatterbox.py` | Voice cloning + narration |
| `worker/watermark.sh` | Builds the client-safe preview |
| `worker/Dockerfile` | GPU image (torch 2.0.1/cu118 — pins matter) |
| `worker/setup_pod.sh` | One-shot setup for a fresh rented GPU pod |
| `GPU-RUNBOOK.md` | **GPU setup, all bugs found, measured timings, quality analysis** |
| `FULLBODY-MODELS.md` | Walk-and-talk / full-body tier research (separate product tier) |
| `PRICING.md` | Real per-minute costs and how to quote |
| `LICENSES.md` | Why every component is safe to resell |
