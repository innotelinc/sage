#!/usr/bin/env bash
# Download the Kokoro-82M ONNX model and its voice bank (~340 MB total).
# Idempotent: files that already exist are left alone.
set -euo pipefail

DIR="${1:-$(dirname "$0")}"
BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
cd "$DIR"

fetch() {
  local name="$1"
  if [ -s "$name" ]; then
    echo "  $name already present"
  else
    echo "  downloading $name"
    curl -fL --retry 3 --retry-delay 2 -o "$name.part" "$BASE/$name"
    mv "$name.part" "$name"
  fi
}

fetch kokoro-v1.0.onnx
fetch voices-v1.0.bin
ls -lh kokoro-v1.0.onnx voices-v1.0.bin
