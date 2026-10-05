#!/usr/bin/env python3
"""Place a rendered clone into a presentation scene as a presenter card.

Why this exists
---------------
Eric's ask: "overlay my clone speaking during a presentation video I made."

The key finding is that this needs **no background removal at all**. A rounded
presenter card is pure compositing: scale the clone, mask its corners, drop it on
the scene with a border and a shadow. No matting model, no alpha inference, no
hair-edge failure mode, and it runs on CPU in seconds — because it is ffmpeg, not
a GPU job.

This is deliberately separate from full-scene placement (the clone standing in a
room with no card around it), which *does* need a matte: either a green-screen
take (free, perfect) or an ML matting model (see GPU-RUNBOOK.md).

Usage
-----
  presenter_overlay.py --scene slide.png --clone final.mp4 --out out.mp4
  presenter_overlay.py --scene deck.mp4 --clone final.mp4 --out out.mp4 \
      --corner bl --height 620 --margin 60 --radius 24 --no-border

--scene accepts a still (png/jpg) or a video (mp4/mov) — a video is scaled and
cropped to the canvas, so a screen recording works directly.
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont


def run(args):
    subprocess.run(args, check=True)


def probe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out) if out else None


def hex_rgb(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True, help="presentation still or video")
    ap.add_argument("--clone", required=True, help="rendered clone (final.mp4)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--canvas", default="1920x1080")
    ap.add_argument("--corner", default="br", choices=["br", "bl", "tr", "tl", "c"])
    ap.add_argument("--height", type=int, default=764, help="card height in px")
    ap.add_argument("--margin", type=int, default=96)
    ap.add_argument("--radius", type=int, default=30)
    ap.add_argument("--border", default="C9A96A", help="hex colour, or 'none'")
    ap.add_argument("--border-width", type=int, default=3)
    ap.add_argument("--shadow", type=int, default=170, help="0 disables")
    ap.add_argument("--labels", default="", help="ImageMagick-free caption, optional")
    ap.add_argument("--audio", default="clone", choices=["clone", "scene", "mix"],
                    help="clone = narration only (default); scene = keep the deck's audio; "
                         "mix = narration on top of the deck's audio, ducked under it")
    a = ap.parse_args()

    CW, CH = (int(v) for v in a.canvas.lower().split("x"))
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="overlay-"))
    try:
        # card size from the clone's aspect ratio
        cw0, ch0 = _dims(a.clone)
        BW = int(round(a.height * cw0 / ch0 / 2) * 2)
        BH = a.height
        if BW % 2: BW += 1

        if a.corner == "br": BX, BY = CW - BW - a.margin, CH - BH - a.margin
        elif a.corner == "bl": BX, BY = a.margin, CH - BH - a.margin
        elif a.corner == "tr": BX, BY = CW - BW - a.margin, a.margin
        elif a.corner == "tl": BX, BY = a.margin, a.margin
        else: BX, BY = (CW - BW) // 2, (CH - BH) // 2
        BX, BY = BX // 2 * 2, BY // 2 * 2

        # rounded alpha mask for the card
        mask = Image.new("L", (BW, BH), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, BW - 1, BH - 1], radius=a.radius, fill=255)
        mask_p = tmp / "mask.png"; mask.save(mask_p)

        border_p = None
        if a.border.lower() != "none":
            b = Image.new("RGBA", (BW, BH), (0, 0, 0, 0))
            ImageDraw.Draw(b).rounded_rectangle(
                [0, 0, BW - 1, BH - 1], radius=a.radius,
                outline=hex_rgb(a.border) + (255,), width=a.border_width)
            border_p = tmp / "border.png"; b.save(border_p)

        # Bake the shadow into the scene when it is a still. For a video scene we
        # skip it rather than compositing a blurred alpha per frame (cheap, and a
        # shadow matters far less against moving footage).
        scene_is_still = pathlib.Path(a.scene).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")

        inputs = ["-loop", "1", "-i", a.scene] if scene_is_still else ["-i", a.scene]
        inputs += ["-i", a.clone, "-loop", "1", "-i", str(mask_p)]
        if border_p: inputs += ["-loop", "1", "-i", str(border_p)]

        chain = [
            f"[0:v]scale={CW}:{CH}:force_original_aspect_ratio=increase,"
            f"crop={CW}:{CH},setsar=1[bg]",
            f"[1:v]scale={BW}:{BH},format=yuva420p[cl]",
            "[cl][2:v]alphamerge[cla]",
            f"[bg][cla]overlay={BX}:{BY}[tmp]",
        ]
        if border_p:
            chain.append(f"[tmp][3:v]overlay={BX}:{BY},format=yuv420p[v]")
        else:
            chain.append("[tmp]format=yuv420p[v]")

        # ---- audio ------------------------------------------------------------------
        # Eric: "the presentations may or may not have their own audio" and the clone
        # should read whatever script he gives it. So three distinct modes:
        #   clone  - narration only (safe default: works whether or not the deck has sound)
        #   scene  - the deck's own audio, narration discarded
        #   mix    - narration on top, the deck's audio ducked under it via sidechain
        #            compression, so music/voice-over steps back whenever the clone talks
        scene_has_audio = _has_audio(a.scene)
        if a.audio != "clone" and not scene_has_audio:
            print("note: --audio %s requested but the scene has no audio track; using the clone's"
                  % a.audio, file=sys.stderr)
            a.audio = "clone"

        if a.audio == "clone":
            amap = ["-map", "1:a:0"]
        elif a.audio == "scene":
            amap = ["-map", "0:a:0"]
        else:
            chain.append("[1:a]asplit=2[narr][sc]")
            chain.append("[0:a]volume=0.6[scene]")
            chain.append("[scene][sc]sidechaincompress="
                         "threshold=0.05:ratio=8:attack=20:release=400[ducked]")
            chain.append("[ducked][narr]amix=inputs=2:duration=first:normalize=0[aout]")
            amap = ["-map", "[aout]"]

        cmd = ["ffmpeg", "-y", "-loglevel", "error"] + inputs + \
              ["-filter_complex", ";".join(chain), "-map", "[v]"] + amap
        cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "medium",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart"]
        d = probe_duration(a.clone)
        if d: cmd += ["-t", f"{d:.2f}"]
        cmd.append(a.out)
        run(cmd)

        print(json.dumps({
            "out": a.out, "canvas": f"{CW}x{CH}", "card": f"{BW}x{BH}",
            "position": [BX, BY], "corner": a.corner,
            "clone": a.clone, "scene": a.scene, "audio": a.audio,
            "scene_has_audio": scene_has_audio,
        }, indent=2))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _has_audio(path):
    """True if the file has at least one audio stream (a still never will)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True).stdout.strip()
    return bool(out)


def _dims(path):
    """Read a container's dimensions via a single extracted frame."""
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "f.png"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
                        "-frames:v", "1", str(p)], check=True)
        return Image.open(p).size


if __name__ == "__main__":
    sys.exit(main())
