#!/bin/sh
# Renders .github/social-preview.svg to a 1280x640 PNG (requires rsvg-convert, from librsvg).
set -e
cd "$(dirname "$0")/.."
rsvg-convert -w 1280 -h 640 .github/social-preview.svg -o .github/social-preview.png
