#!/usr/bin/env bash
# Build whisper.cpp + download base.en model.
# Run after `npm install` if first launch of the Electron app fails to
# auto-build/auto-download (common in Electron contexts where shelljs
# can't find the system node binary).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WCPP="$ROOT/node_modules/nodejs-whisper/cpp/whisper.cpp"
MODEL="${SCRIPTER_WHISPER_MODEL:-base.en}"

if [ ! -d "$WCPP" ]; then
  echo "nodejs-whisper not installed. Run: npm install"
  exit 1
fi

cd "$WCPP"

if [ ! -f "models/ggml-${MODEL}.bin" ]; then
  echo "[1/2] Downloading model: $MODEL"
  bash ./models/download-ggml-model.sh "$MODEL"
else
  echo "[1/2] Model present: ggml-${MODEL}.bin"
fi

if [ ! -x "build/bin/whisper-cli" ]; then
  if ! command -v cmake >/dev/null 2>&1; then
    echo "cmake not found. Install: brew install cmake  (mac)  or  apt install cmake  (linux)"
    exit 1
  fi
  EXTRA_FLAGS=""
  if [ "$(uname)" = "Darwin" ]; then
    EXTRA_FLAGS="-DGGML_METAL=ON"
  fi
  echo "[2/2] Building whisper.cpp ($EXTRA_FLAGS)"
  cmake -B build $EXTRA_FLAGS
  cmake --build build --config Release -j
else
  echo "[2/2] whisper-cli binary present"
fi

echo "Done. Smoke test:"
./build/bin/whisper-cli -m "models/ggml-${MODEL}.bin" -f samples/jfk.mp3 -nt -np
