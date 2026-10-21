#!/usr/bin/env bash
# Turns the demo recording (pnpm -C apps/web demo:record) into docs/media: demo.gif, the host
# and guest side by side (at most 5 MB), and the screenshots (at most 300 KB each). Needs ffmpeg.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW="$ROOT/apps/web/test-results/demo"
MEDIA="$ROOT/docs/media"
GIF_BUDGET=$((5 * 1024 * 1024))
PNG_BUDGET=$((300 * 1024))
SPEED="${SPEED:-1.25}" # faster than real time, so the waits for the agent are shorter

command -v ffmpeg >/dev/null || { echo "demo-gif: needs ffmpeg" >&2; exit 1; }
for f in host.webm guest.webm; do
  [ -f "$RAW/$f" ] || { echo "demo-gif: no $RAW/$f; run pnpm -C apps/web demo:record first" >&2; exit 1; }
done
mkdir -p "$MEDIA"
size() { wc -c <"$1" | tr -d ' '; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Smaller and choppier until it fits: each window's width, then frames a second.
made=""
for width in 640 560 480; do
  for fps in 8 6 5; do
    graph="[0:v]setpts=PTS/$SPEED,fps=$fps,scale=$width:-2:flags=lanczos[h];"
    graph+="[1:v]setpts=PTS/$SPEED,fps=$fps,scale=$width:-2:flags=lanczos[g];"
    graph+="[h][g]hstack=inputs=2:shortest=1,split[a][b];"
    graph+="[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
    ffmpeg -loglevel error -y -i "$RAW/host.webm" -i "$RAW/guest.webm" -filter_complex "$graph" -loop 0 "$work/demo.gif"
    bytes="$(size "$work/demo.gif")"
    echo "demo.gif at ${width}px a window, $fps fps: $((bytes / 1024)) KB"
    if [ "$bytes" -le "$GIF_BUDGET" ]; then
      made=yes
      break 2
    fi
  done
done
[ -n "$made" ] || { echo "demo-gif: demo.gif doesn't fit in 5 MB even at its smallest" >&2; exit 1; }
mv "$work/demo.gif" "$MEDIA/demo.gif"

# Screenshots: 256 colours, then smaller until each fits.
for shot in "$RAW"/shots/*.png; do
  [ -e "$shot" ] || { echo "demo-gif: no screenshots in $RAW/shots" >&2; exit 1; }
  name="$(basename "$shot")"
  fitted=""
  for width in 1280 1024 800; do
    ffmpeg -loglevel error -y -i "$shot" \
      -vf "scale=$width:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=none" \
      "$work/$name"
    bytes="$(size "$work/$name")"
    if [ "$bytes" -le "$PNG_BUDGET" ]; then
      echo "$name at ${width}px: $((bytes / 1024)) KB"
      mv "$work/$name" "$MEDIA/$name"
      fitted=yes
      break
    fi
  done
  [ -n "$fitted" ] || { echo "demo-gif: $name doesn't fit in 300 KB" >&2; exit 1; }
done
echo "Wrote $MEDIA"
