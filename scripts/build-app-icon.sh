#!/bin/sh
set -eu

# Rebuild every desktop icon from
# apps/macos/ModelRouterTray/Resources/AppIcon.svg.
#
# The generated assets are committed, so a normal tray build never runs this
# script and never needs a rasterizer. Run it only after editing the SVG, and
# commit the regenerated native and Control Center icons alongside it.
#
# `sips` is the rasterizer because it is part of macOS: adding librsvg or
# ImageMagick would make the icon unbuildable on a clean machine for the sake
# of one asset. Each size is rasterized from the vector rather than downsampled
# from 1024, so the 16 px and 32 px faces keep their stroke weight instead of
# turning into grey mush.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_svg="$repo_dir/apps/macos/ModelRouterTray/Resources/AppIcon.svg"
# The menu-bar glyph shares its vector with the Swift status item; the Electron
# tray on macOS needs it as a template PNG pair (18pt, and 36px at 2x).
mark_svg="$repo_dir/apps/macos/ModelRouterTray/Sources/Resources/RouterMark.svg"
output_icns=${1:-"$repo_dir/apps/macos/ModelRouterTray/Resources/AppIcon.icns"}
control_center_assets="$repo_dir/apps/control-center/assets"

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

render_svg_to() {
  svg=$1
  size=$2
  destination=$3
  sips -s format png -z "$size" "$size" "$svg" \
    --out "$destination" >/dev/null 2>&1 || true
  if [ ! -s "$destination" ]; then
    printf 'codex-router: sips could not rasterize %s at %spx.\n' "$svg" "$size" >&2
    exit 1
  fi
}

render_to() {
  render_svg_to "$source_svg" "$1" "$2"
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

mkdir -p "$control_center_assets"
render_to 32 "$control_center_assets/32x32.png"
render_to 128 "$control_center_assets/128x128.png"
render_to 256 "$control_center_assets/128x128@2x.png"
render_to 512 "$control_center_assets/icon.png"
render_svg_to "$mark_svg" 18 "$control_center_assets/trayTemplate.png"
render_svg_to "$mark_svg" 36 "$control_center_assets/trayTemplate@2x.png"

ico_dir="$work_dir/ControlCenter.iconset"
mkdir -p "$ico_dir"
for size in 16 24 32 48 64 256; do
  face="$ico_dir/icon_${size}.png"
  render_to "$size" "$face"
done
# PNG payloads inside ICO keep their alpha channel and let Windows select the
# native face instead of repeatedly scaling one large bitmap.
node "$repo_dir/scripts/build-ico.mjs" "$control_center_assets/icon.ico" \
  "$ico_dir/icon_16.png" \
  "$ico_dir/icon_24.png" \
  "$ico_dir/icon_32.png" \
  "$ico_dir/icon_48.png" \
  "$ico_dir/icon_64.png" \
  "$ico_dir/icon_256.png"

printf '%s\n' "$output_icns"
printf '%s\n' "$control_center_assets/icon.png"
printf '%s\n' "$control_center_assets/trayTemplate.png"
printf '%s\n' "$control_center_assets/icon.ico"
