# Shot spec — how to record a take that survives lip sync

Last updated: 2026-09-19

The take determines the quality ceiling of the whole product. This is not
marketing talk: LatentSync **round-trips the entire face through a 512×512
intermediate** (see below), so framing, light, and stillness of the take decide
what the finished clone can possibly look like. No amount of GPU time fixes a
bad take.

## Why the take is the ceiling

From `latentsync/utils/image_processor.py` + `scripts/inference.py`:

1. `AlignRestore.align_warp_face()` finds the eyes and nose, then **warps the
   face to a canonical crop** using those landmarks — this normalises scale and
   rotation frame by frame.
2. That crop is resized to **512×512** (`cv2.resize(..., INTER_LANCZOS4)`).
3. The audio-conditioned diffusion model regenerates the lower face inside a
   **fixed mask** (`latentsync/utils/mask.png`, resized to 512 — the same mask
   for every subject, not derived from your landmarks).
4. `Restoring <N> faces...` — the generated 512 face is **warped back** into the
   original frame and composited through that mask.

Consequences:

- Everything inside the mask is *generated*, so it carries generated-skin
  smoothness rather than real pores. The mask covers the mouth **and the cheeks
  and jaw**, which is why cheek mush appears even though only the mouth is
  "supposed" to change.
- Because the crop is scale-normalised, the resample factor is
  `source face size / canonical crop size`. Close to 1.0 is lossless; a tight
  close-up means a downscale-then-upscale round trip, which destroys exactly the
  high-frequency skin texture you notice when it's missing.
- Head movement changes the warp every frame, so the regenerated patch shifts and
  "swims". A still head is worth more than any setting.

Measured on the 2026-09-19 renders (per-cell high-frequency detail vs. the take):
**38–48%** retained in the mouth/chin core, **70–90%** at the cheeks, ~100%
everywhere else. Localised loss → it is the mask, not the encoder. For the
record: the deliverable is written by `imageio` as `libx264 -crf 13`, and its
low bitrate (1.8 Mbps at 720×1280) is a *symptom* of soft content — x264 does not
spend bits where there is no detail. Do not go looking for an encoder fix.

Secondary loss, unavoidable without patching LatentSync: `util.read_video()`
re-encodes the take with `-r 25 -crf 18` before processing, so the take is always
reduced to 25 fps first.

## Framing

- **Head and shoulders, not a tight close-up.** The face should be small enough
  that LatentSync's scale-normalised crop does not have to shrink it. Tight
  framing is the single most expensive mistake.
- Keep the head in the **upper-middle third**, centred, with headroom.
- **Leave background room** — it costs nothing here and it is what makes the
  office/studio background swap possible later.
- Wider framing also means the regenerated region occupies fewer pixels, so the
  artifact reads as smaller.

## Camera

- **Locked off.** Tripod or a stack of books. No handheld, no digital zoom.
- **Eye level**, lens roughly perpendicular to the face.
- **Focus locked** before recording. Autofocus hunting mid-take ruins it.
- **25 fps minimum** (LatentSync requires exactly 25 after its own conversion);
  shoot 30 or 60 if the camera allows.
- **High shutter (~1/100s or faster)** — motion blur is unrecoverable.

## Light

- **A lot of it.** More light = lower ISO = less sensor noise = dramatically
  easier for the model. This is the cheapest quality win available.
- **Soft key at ~45°**, plus fill so the shadow side still shows detail.
- **Avoid harsh overhead light** — eyebrow and nose shadows get regenerated
  badly.
- **Avoid backlight and blowout on the face.** A bright window behind is fine; a
  blown face is not.
- Neutral white balance; skin that is orange or green under mixed light will be
  reproduced that way.

## Performance

- **Keep the head still.** Talk naturally, but do not turn or tilt the head
  much — the mask moves with the alignment, so head motion makes the patch swim.
- **Keep hands away from the face**; anything crossing the mask region gets
  mangled.
- **30–60 seconds is plenty** of usable footage. The render uses the length of
  the narration, so the take needs to be at least as long as the longest script
  you expect.
- No drastic expression changes to extremes; the model handles normal speech
  best.

## Audio (this is what the voice clone learns from)

- **Quiet room, no music, no reverb.** The cloned voice inherits the recording.
- **Consistent distance from the mic** for the whole take.
- Normal conversational pace — the voice model needs natural range, not a
  monotone.
- If using a phone, record in a soft-furnished room and stay off the speaker.

## Background

- **Best free option:** a real office with floor-to-ceiling windows. No
  compositing, no matting risk.
- **Plain/neutral wall** if we will composite a background later — an even,
  uncluttered background mattes far more cleanly.
- **Green screen** only if a swap is certain: light the screen separately, keep
  the subject 3+ feet off it, and watch for green spill on hair and shoulders —
  spill is the classic tell.

## Layout

Whatever framing you choose, keep it consistent across takes — a library of
clones that match each other cuts together, and one that doesn't, won't.
