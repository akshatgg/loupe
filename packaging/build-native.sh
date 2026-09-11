#!/usr/bin/env bash
# Builds Loupe's Swift helpers (bin/sources, capture, inputtap, render) as
# universal binaries -- Apple Silicon and Intel in one file each -- so the
# same bin/ serves both the arm64 and the x64 app. Built for plain arm64
# only, the Intel DMG would install fine and then fail to record anything.
#
# macOS 14 is the floor: Capture.swift reads SCContentFilter.pointPixelScale,
# which ScreenCaptureKit only has from Sonoma on. electron-builder.config.js
# stamps the same minimum into the app, and the Homebrew cask declares it.
#
#   npm run build:native
set -euo pipefail
cd "$(dirname "$0")/.."

MIN_MACOS=14.0
OUT=bin
WORK=.build-native
mkdir -p "$OUT" "$WORK"

build() { # build <name> <source> [extra swiftc flags...]
  local name=$1 src=$2
  shift 2
  for arch in arm64 x86_64; do
    swiftc -O -target "$arch-apple-macos$MIN_MACOS" "$@" "$src" -o "$WORK/$name-$arch"
  done
  lipo -create "$WORK/$name-arm64" "$WORK/$name-x86_64" -output "$OUT/$name"
  echo "  $OUT/$name: $(lipo -archs "$OUT/$name")"
}

build sources src/native/Sources.swift -parse-as-library
build capture src/native/Capture.swift -parse-as-library
build inputtap src/native/InputTap.swift
build render src/native/Render.swift -parse-as-library
