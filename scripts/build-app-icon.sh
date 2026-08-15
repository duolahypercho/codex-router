#!/bin/sh
set -eu

# Rebuild the macOS icon set from apps/macos/ModelRouterTray/Resources/AppIcon.svg.
#
# The .icns it produces is committed, so a normal tray build never runs this
# script and never needs a rasterizer. Run it only after editing the SVG, and
# commit the regenerated .icns alongside it.
#
# `sips` is the rasterizer because it is part of macOS: adding librsvg or
# ImageMagick would make the icon unbuildable on a clean machine for the sake
# of one asset. Each size is rasterized from the vector rather than downsampled
# from 1024, so the 16 px and 32 px faces keep their stroke weight instead of
# turning into grey mush.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_svg="$repo_dir/apps/macos/ModelRouterTray/Resources/AppIcon.svg"
output_icns=${1:-"$repo_dir/apps/macos/ModelRouterTray/Resources/AppIcon.icns"}

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'codex-router: the icon set is built with macOS sips/iconutil.\n' >&2
  exit 1
fi
if [ ! -f "$source_svg" ]; then
  printf 'codex-router: missing icon source %s\n' "$source_svg" >&2
  exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/model-router-icon.XXXXXX")
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT HUP INT TERM

iconset="$work_dir/AppIcon.iconset"
mkdir -p "$iconset"

render() {
  size=$1
  name=$2
  # sips writes CoreSVG parser chatter to stderr even on success; it is not a
  # failure signal, so judge the run by whether the PNG appeared.
  sips -s format png -z "$size" "$size" "$source_svg" \
    --out "$iconset/$name" >/dev/null 2>&1 || true
  if [ ! -s "$iconset/$name" ]; then
    printf 'codex-router: sips could not rasterize %s at %spx.\n' "$source_svg" "$size" >&2
    exit 1
  fi
}

# The exact face list iconutil expects. A missing face is not an error to
# iconutil -- it just ships an icon that degrades to a blurry upscale in
# whichever view wanted that size.
render 16 icon_16x16.png
render 32 icon_16x16@2x.png
render 32 icon_32x32.png
render 64 icon_32x32@2x.png
render 128 icon_128x128.png
render 256 icon_128x128@2x.png
render 256 icon_256x256.png
render 512 icon_256x256@2x.png
render 512 icon_512x512.png
render 1024 icon_512x512@2x.png

mkdir -p "$(dirname "$output_icns")"
iconutil --convert icns --output "$output_icns" "$iconset"

printf '%s\n' "$output_icns"
