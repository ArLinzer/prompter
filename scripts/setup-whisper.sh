#!/usr/bin/env bash
# Build whisper.cpp + download a Whisper model.
#
# Run after `npm install` if the first launch of the Electron app fails to
# auto-build/auto-download (common in Electron contexts where shelljs
# can't find the system node binary).
#
# On macOS, prefer building with Metal acceleration off the system metallib
# (GGML_METAL_EMBED_LIBRARY=OFF). Apple's runtime Metal shader compiler often
# rejects whisper.cpp's embedded library with errors like
# "unknown type name 'block_q4_0'"; the prebuilt external metallib avoids
# that. Requires the Metal Toolchain (Xcode 26+ ships it as a separately
# installable component; this script triggers the download if needed).

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
  echo "[1/3] Downloading model: $MODEL"
  bash ./models/download-ggml-model.sh "$MODEL"
else
  echo "[1/3] Model present: ggml-${MODEL}.bin"
fi

EXTRA_FLAGS=""

if [ "$(uname)" = "Darwin" ]; then
  echo "[2/3] Checking Metal Toolchain (macOS)"
  if ! xcrun -find metallib >/dev/null 2>&1; then
    if command -v xcodebuild >/dev/null 2>&1; then
      echo "      metallib missing. Downloading Metal Toolchain (~700MB) via xcodebuild..."
      xcodebuild -downloadComponent MetalToolchain || {
        echo "      ⚠ metallib install failed. Will fall back to Accelerate/BLAS (slower but still works)."
        EXTRA_FLAGS=""
      }
    else
      echo "      ⚠ xcodebuild not found. Skipping Metal — install full Xcode for GPU acceleration."
    fi
  fi
  if xcrun -find metallib >/dev/null 2>&1; then
    EXTRA_FLAGS="-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=OFF"
    echo "      ✓ Metal toolchain found, building with Metal acceleration."
  else
    echo "      Building CPU-only (Accelerate framework on Apple Silicon)."
  fi
else
  echo "[2/3] Non-macOS — CPU build."
fi

if [ ! -x "build/bin/whisper-cli" ] || [ ! -f "build/bin/default.metallib" ] && [ -n "$EXTRA_FLAGS" ]; then
  if ! command -v cmake >/dev/null 2>&1; then
    echo "cmake not found. Install: brew install cmake  (mac)  or  apt install cmake  (linux)"
    exit 1
  fi
  echo "[3/3] Building whisper.cpp ($EXTRA_FLAGS)"
  rm -rf build
  cmake -B build $EXTRA_FLAGS
  cmake --build build --config Release -j
else
  echo "[3/3] whisper-cli binary present"
fi

echo "Done. Smoke test:"
./build/bin/whisper-cli -m "models/ggml-${MODEL}.bin" -f samples/jfk.mp3 -nt -np
