#!/usr/bin/env bash
# Composite a talking-head avatar onto an EXISTING video (training content,
# screen recording, slide deck) — the "add a presenter bubble to footage we
# already have" job.
#
#   ./overlay.sh base.mp4 avatar.mp4 out.mp4 [options]
#
# Options (env vars):
#   POSITION   br | bl | tr | tl          (default br — bottom right)
#   SIZE       avatar height as % of base height   (default 26)
#   SHAPE      circle | rounded | square   (default circle)
#   AUDIO      replace | duck | mix        (default replace)
#                replace = drop the base audio, use the narration only
#                duck    = keep base audio, drop it under the narration
#                mix     = straight mix, no ducking
#   MARGIN     px from the edge            (default 40)
#   FADE       fade in/out seconds         (default 0.5)
#
# The avatar shows only while the narration runs, then fades out; the base
# video continues to its own full length. That matters for training content,
# where narration rarely matches the footage length exactly.
set -euo pipefail

BASE="${1:?usage: overlay.sh <base.mp4> <avatar.mp4> <out.mp4>}"
AVATAR="${2:?usage: overlay.sh <base.mp4> <avatar.mp4> <out.mp4>}"
OUT="${3:?usage: overlay.sh <base.mp4> <avatar.mp4> <out.mp4>}"

POSITION="${POSITION:-br}"
SIZE="${SIZE:-26}"
SHAPE="${SHAPE:-circle}"
AUDIO="${AUDIO:-replace}"
MARGIN="${MARGIN:-40}"
FADE="${FADE:-0.5}"

dur(){ ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
BASE_DUR=$(dur "$BASE")
AV_DUR=$(dur "$AVATAR")

# Avatar height as a fraction of the base height; width follows the source AR.
H="ih*${SIZE}/100"

case "$POSITION" in
  br) XY="W-w-${MARGIN}:H-h-${MARGIN}" ;;
  bl) XY="${MARGIN}:H-h-${MARGIN}" ;;
  tr) XY="W-w-${MARGIN}:${MARGIN}" ;;
  tl) XY="${MARGIN}:${MARGIN}" ;;
  *)  echo "unknown POSITION: $POSITION" >&2; exit 1 ;;
esac

# Mask the avatar. geq builds the alpha channel directly — no external asset,
# so this runs anywhere ffmpeg does.
case "$SHAPE" in
  circle)
    MASK="crop=ih:ih,scale=-2:${H},format=rgba,\
geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-(W/2),Y-(H/2)),W/2),255,0)'" ;;
  rounded)
    MASK="scale=-2:${H},format=rgba,\
geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(hypot(max(0,abs(X-W/2)-(W/2-40)),max(0,abs(Y-H/2)-(H/2-40))),40),0,255)'" ;;
  square)
    MASK="scale=-2:${H},format=rgba" ;;
  *) echo "unknown SHAPE: $SHAPE" >&2; exit 1 ;;
esac

# Fade the avatar in at the start and out as the narration ends.
FADE_OUT_AT=$(python3 -c "print(max(0, $AV_DUR - $FADE))")
AV_CHAIN="${MASK},fade=t=in:st=0:d=${FADE}:alpha=1,fade=t=out:st=${FADE_OUT_AT}:d=${FADE}:alpha=1"

case "$AUDIO" in
  replace) AMAP=(-map "1:a:0") ; AFILTER=() ;;
  mix)     AFILTER=(-filter_complex_script /dev/null) ; AMAP=() ;;  # replaced below
  duck)    AMAP=() ; AFILTER=() ;;
  *) echo "unknown AUDIO: $AUDIO" >&2; exit 1 ;;
esac

echo "base   : ${BASE_DUR}s"
echo "avatar : ${AV_DUR}s  (${SHAPE}, ${SIZE}% height, ${POSITION})"
echo "audio  : ${AUDIO}"

if [ "$AUDIO" = "replace" ]; then
  ffmpeg -y -loglevel error \
    -i "$BASE" -i "$AVATAR" \
    -filter_complex "[1:v]${AV_CHAIN}[av];[0:v][av]overlay=${XY}:shortest=0[v]" \
    -map "[v]" -map 1:a:0 \
    -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 160k -movflags +faststart "$OUT"
else
  # duck: base audio drops to 20% while narration plays, recovers after.
  # mix:  straight sum.
  if [ "$AUDIO" = "duck" ]; then
    AMIX="[0:a]volume='if(lt(t,${AV_DUR}),0.2,1)':eval=frame[bg];[bg][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]"
  else
    AMIX="[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]"
  fi
  ffmpeg -y -loglevel error \
    -i "$BASE" -i "$AVATAR" \
    -filter_complex "[1:v]${AV_CHAIN}[av];[0:v][av]overlay=${XY}:shortest=0[v];${AMIX}" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 160k -movflags +faststart "$OUT"
fi

echo "wrote  : $OUT ($(du -h "$OUT" | cut -f1), $(dur "$OUT")s)"
