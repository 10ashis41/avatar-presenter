# AI Clone Presenter — real cost comparison

> **Decision taken 2026-09-18:** self-hosted MuseTalk + Chatterbox on a rented
> GPU. Everything below about API pricing is kept as the justification for that
> call — at ~$0.09 per 10-minute video vs $72 on OmniHuman, the APIs are only
> worth revisiting if the self-hosted quality doesn't clear the bar.

All prices pulled from the live `belt app pricing` API on 2026-09-18, not from marketing pages.

## Cost per finished minute of video

| Option | Price | Per minute | Needs | Notes |
|---|---|---|---|---|
| **Tavus** | $59/mo + $1.00/min | **$1.00** | photo/video twin | Cheapest per-minute; monthly floor |
| **PixVerse Lipsync** (`falai/pixverse-lipsync`) | $0.04/sec | **$2.40** | **base video**, not a photo | Cheapest on inference.sh — but you must already have footage of the person talking |
| **HeyGen Avatar IV** | ~$4.00/min | **$4.00** | photo | ToS blocks reselling/white-label by default |
| **Fabric 1.0 480p** (`falai/fabric-1-0`) | $0.08/sec | **$4.80** | photo | |
| **OmniHuman 1.5** (`bytedance/omnihuman-1-5`) | $0.12/sec | **$7.20** | photo | Best quality from a still image |
| **Fabric 1.0 720p** | $0.15/sec | **$9.00** | photo | |

## What this means for the deal

**The premise "inference.sh is cheaper than HeyGen" is only half true.** The flagship
image-to-avatar models (OmniHuman, Fabric 720p) are *more* expensive per minute than
HeyGen. What inference.sh actually buys you is:

- **No subscription** — pure per-render, good for sporadic client work
- **No reselling restriction** — the real reason to move off HeyGen

### Worked example: a 20-minute presentation

| Option | Cost of one 20-min render |
|---|---|
| Tavus | $20 (+ $59/mo) |
| PixVerse Lipsync | $48 |
| HeyGen | $80 |
| Fabric 480p | $96 |
| OmniHuman 1.5 | **$144** |

Re-renders matter: clients revise scripts. Budget 2–3 renders per final video.
At OmniHuman rates a single 20-minute presentation with two revisions is ~$430 in
raw cost — price the engagement accordingly, or you'll lose money on revisions.

### Recommended structure for reselling

1. **Quote per finished minute, with a revision cap** (e.g. 2 included). Don't quote flat.
2. **Use PixVerse ($2.40/min) when the client can give you 30–60s of base video**
   of the presenter. Cheapest path and the lip-sync quality is strong.
3. **Use OmniHuman ($7.20/min) only when all you have is a still photo.** Charge for it.
4. **Evaluate Tavus** if this becomes recurring volume — at $1/min it beats everything
   here, and the $59/mo floor disappears into the margin fast.

## Non-negotiable before selling

- **Written likeness + voice consent** from the person being cloned.
- **Contract clause on avatar ownership** — who owns the trained voice/avatar when
  the engagement ends.
- Several US states now have right-of-publicity / AI-likeness statutes. This is the
  part that generates lawsuits, not the model license.


---

## Self-hosted (what we actually built)

Computed from live GPU rental rates, 2026-09-18:

| | 10-min video |
|---|---|
| 10 min @ 25fps | 15,000 frames |
| MuseTalk ~30fps | 8.3 min |
| Chatterbox TTS + ffmpeg | ~3 min |
| Cold start (container pull) | ~5 min |
| **Billable** | **~16 min** |
| **RTX 4090 @ $0.34/hr** | **$0.09** |

Even at 3x slower than MuseTalk's claimed throughput: ~$0.19. Still ~380x
cheaper than OmniHuman.

> ### ⚠️ SUPERSEDED BY MEASUREMENT — 2026-09-19
>
> The estimates above were wrong. First real GPU render measured:
> **~8 minutes to produce 5.1 seconds of video** on an RTX 3090
> (~4 min voice clone + ~4 min MuseTalk lip sync).
>
> Much of that is fixed model-loading overhead, so longer videos will **not**
> scale linearly — but the per-minute figure is unknown until a long-form test
> is run. **Do not quote a client a turnaround or a price until that happens.**
>
> Measured components:
>
> | | Cold | Warm |
> |---|---|---|
> | Chatterbox TTS | ~4.7 min | ~10 s |
> | MuseTalk lip sync | ~4 min | ~4 min |
> | Full install from bare pod | ~15 min (MuseTalk) / ~35 min (+LatentSync) | |
> | Restart with caches | ~2 min | |
>
> Also note: **LatentSync is materially slower than MuseTalk**, and it is the
> option likely needed for acceptable quality. Re-measure after the A/B.
> See `GPU-RUNBOOK.md`.

### What to charge

At ~$0.09 of compute, cost is irrelevant to pricing — charge on value.
$300–500 per presentation is defensible against HeyGen-based competitors who
are paying $40–80 per render.

Still quote **per finished minute with a revision cap** (2 included). Not
because revisions cost you money any more, but because they cost you *time*,
and an uncapped revision cycle is how agency engagements go bad.

---

## Commercial comparison for one 5-minute video (compiled 2026-09-18)

Normalized from live plan/credit pages + the API rates above. Figures are the cost
attributable to a single 5-minute (300s) render — i.e. what that one video eats out of
a plan, or what it costs pay-as-you-go.

### Daily-driver tools (someone Googles "AI avatar video", signs up)

| Path | 5-min cost | Mechanism / catch |
|---|---|---|
| Synthesia Basic (free) | **$0** | 10 min/mo, watermarked, 600 of 1,200 credits |
| Colossyan Starter (free) | **$0** | 20 NEO min/mo, watermarked |
| HeyGen Creator $29 — Avatar III | **$0.73** | 15 of 600 credits; 40 such videos/mo |
| HeyGen Creator $29 — Avatar IV/V | **$4.83** | 20 cr/min → 100 cr = 1/6 of the month |
| D-ID Lite $5.90 | **$1.48** | 20-credit tier |
| Tavus Starter $22 / Builder $59 | **$1.83 / $1.69** | 60 / 175 min included |
| Vidnoz $14.99 | **$5.00** | 150 of 450 credits |
| Synthesia Starter $29 (10 min/mo) | **$14.50** | half the monthly allowance — one video |
| Synthesia Creator $89 (30 min/mo) | **$14.83** | 1/6 of the month |
| Colossyan Professional $89 | **$14.83** | NEO minutes |
| HeyGen Business $149 (1,500 cr) | **$9.93** | Avatar IV; also the tier that raises the Avatar IV cap to 5 min |
| HeyGen ~$4/min posted rate (earlier note) | **$20.00** | plan-amortized Avatar IV; credit system makes the real spread $0.73–9.93 |

### Pay-as-you-go per render (no subscription — what a builder pays)

| Path | 5-min cost |
|---|---|
| Tavus overage | **$5.00** ($1/min) |
| D-ID API | **$7.50–20.00** ($1.50–4/min) |
| PixVerse Lipsync | **$12.00** (needs existing footage) |
| Fabric 480p / 720p | **$24.00 / $45.00** |
| OmniHuman 1.5 | **$36.00** |
| HeyGen API, Avatar IV (100 credits) | **$50.00–99.00** ($0.50/credit Scale, $0.99/credit Pro) |

### Done-for-you market (they don't want to learn a tool)

Fiverr "AI spokesperson / talking avatar" gigs: **$5–30** for 30–60s, **$85–95** up to
1.5–3 min, **$695+** for premium custom-avatar + cloned voice. A 5-minute clip lands
roughly **$50–300** mid-market. Note these sellers are usually paying HeyGen/D-ID
subscriptions underneath — i.e. reselling the same category of tool.

### Self-hosted (us)

5 min ≈ 8 billable GPU minutes on a rented RTX 4090 @ $0.34/hr = **$0.05**
(~$0.07–0.09 once serverless; ~$0.19 at 3x slower than MuseTalk's claim).

### What this says about pricing

- The *cost* floor competitors can reach is $0.73 (old avatar model, plan already paid
  for) and the typical commercial spend is **$5–100 per 5-min render**, or a
  **$29–149/mo plan that only yields 10–30 minutes**.
- Credits **don't roll over** and **re-renders charge the full amount again** — three
  passes at a 5-min Avatar IV video on HeyGen Creator is ~$14–15 of plan value; the same
  three renders cost us ~$0.15. That's the real wedge: revision-heavy, client-likeness work.
- So $300–500 per presentation sits at the top of mid-market freelance and well under
  premium custom-clone gigs, against a $0.05 cost basis. Cost is not the constraint;
  the constraint is proving the clone quality.

