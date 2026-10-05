#!/usr/bin/env bash
# Ship worker files to the pod's repo (github.com/10ashis41/presence-worker) SAFELY.
#
# Why this exists: the same files live in two places — this directory (~/avatar-presenter/
# worker, the copy that gets edited) and the presence-worker checkout that actually gets
# pushed to the pod. They were synced with a bare `cp`, and the two had drifted: the
# checkout had an EchoMimic install step that this directory did not, so the `cp` silently
# deleted it. The pod then booted a script that installed everything EXCEPT the thing being
# tested, and the failure looked like an install problem rather than a sync problem.
#
# So: `cp` is not enough. This script copies, then proves the two are identical, then greps
# for the markers that must exist in the file the pod will run, and refuses to push if any
# are missing. A marker check is crude, but it is exactly the check that would have caught
# the bug — the section had a unique label ("6b/7") and it simply was not there.
#
# Usage:  bash push_worker.sh "commit message"
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${WORKER_REPO:-/tmp/pw-push}"
FILES=(setup_pod.sh install_echomimic.sh em_driver.py run_worker.py tts_chatterbox.py
       watermark.sh download_weights.py Dockerfile README.md)

# Markers that MUST be present in the file the pod executes. Each one is a feature whose
# silent absence costs a boot cycle (10-30 min) and a confusing failure.
declare -A REQUIRED=(
  [setup_pod.sh]="6b/7 INSTALL_ECHOMIMIC INSTALL_MUSETALK FREE_SPACE PIP_CACHE_DIR HF_HOME EM_PYTHON EM_VENV EM_REPO probe_torch /opt/pip-cache"
  [run_worker.py]="render_generate /work?v=3 voice_ref echomimic EM_PYTHON EM_PARTIAL PYTORCH_CUDA_ALLOC_CONF"
  [install_echomimic.sh]="NOT ENOUGH DISK FREE_SPACE wav2vec2-base-960h ensure_venv EM_VENV tf-keras Wan2.1-Fun-V1.1-1.3B-InP/diffusion_pytorch_model.safetensors nvidia-cudnn-cu12 conv3d"
  [em_driver.py]="TF_USE_LEGACY_KERAS EM_STEPS EM_GUIDANCE ANCHOR FACE_ANCHOR set_visible_devices"
)

# Cross-file couplings: two files that must agree on a value, where a mismatch is silent.
# Adding EM_VENV/EM_PYTHON to the marker list above would not have caught the case that bit
# us — both files mentioned the venv, they just disagreed on WHERE it is. So check the shared
# literal in both places explicitly.
declare -A COUPLED=(
  ["/opt/emvenv"]="setup_pod.sh install_echomimic.sh"
  # tf-keras is useless without the flag that routes tensorflow.keras to it, and the flag is
  # useless without the package. Either one alone still dies at retina-face import.
  ["TF_USE_LEGACY_KERAS"]="install_echomimic.sh em_driver.py"
)

if [ ! -d "$DEST/.git" ]; then
  echo "FATAL: $DEST is not a git checkout of presence-worker (set WORKER_REPO)" >&2
  exit 1
fi

echo "== syncing $SRC -> $DEST =="
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/$f"
done

echo "== what this sync will overwrite (source -> checkout) =="
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  if cmp -s "$SRC/$f" "$DEST/$f"; then echo "  same      $f"
  else echo "  OVERWRITE $f"; fi
done

echo "== proving the copies are identical =="
drift=0
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  if ! diff -q "$SRC/$f" "$DEST/$f" >/dev/null; then
    echo "  DRIFT: $f differs after cp" >&2
    drift=1
  fi
done
if [ "$drift" != 0 ]; then
  echo "FATAL: files differ — refusing to push an unverifiable tree." >&2
  exit 1
fi
echo "  all identical"

echo "== marker check on what the pod will actually run =="
missing=0
for f in "${!REQUIRED[@]}"; do
  for m in ${REQUIRED[$f]}; do
    if ! grep -qF -- "$m" "$DEST/$f"; then
      echo "  MISSING in $f: $m" >&2
      missing=1
    fi
  done
done
if [ "$missing" != 0 ]; then
  echo "FATAL: a required section is absent from the file the pod executes." >&2
  echo "       (This is exactly how the EchoMimic install step was lost: it existed in" >&2
  echo "        one copy of setup_pod.sh only, and a plain cp overwrote it.)" >&2
  exit 1
fi
echo "  every required marker present"

echo "== cross-file couplings =="
for literal in "${!COUPLED[@]}"; do
  for f in ${COUPLED[$literal]}; do
    if ! grep -qF -- "$literal" "$DEST/$f"; then
      echo "  MISMATCH: '$literal' is not in $f, but the two files must agree on it" >&2
      missing=1
    fi
  done
done
if [ "$missing" != 0 ]; then
  echo "FATAL: files that must agree on a value disagree — the pod would look for the" >&2
  echo "       right thing in the wrong place, and report it as 'not installed'." >&2
  exit 1
fi
echo "  couplings agree"

echo "== syntax =="
( cd "$DEST" && bash -n setup_pod.sh && bash -n install_echomimic.sh \
  && python3 -m py_compile run_worker.py em_driver.py ) || exit 1
echo "  ok"

if [ -z "${1:-}" ]; then
  echo "== synced + verified (no commit message given, not committing) =="
  exit 0
fi

cd "$DEST"
git add -A
git -c user.name="Eric Tucker" -c user.email="10ashis@gmail.com" commit -q -F - <<MSG
$1

2026-09-19
MSG
git push -q origin main || exit 1
echo "== pushed: $(git rev-parse --short HEAD) =="
