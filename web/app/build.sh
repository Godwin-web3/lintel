#!/usr/bin/env bash
# Vercel build: compile the Rust engine to WASM, emit the pinned parameter
# file, then build the React app. Set VITE_RELAY_URL in the Vercel project.
#
# Two engines are built:
#   src/pkg        single-threaded (stable Rust), bundled by Vite. Always works.
#   public/pkg-mt  multithreaded (nightly, atomics + wasm-bindgen-rayon), served
#                  as-is at /pkg-mt/ and used only when the page is
#                  cross-origin isolated (COOP/COEP headers in vercel.json).
#                  OPT-IN: built only with LINTEL_THREADS=1 (not yet proven in the
#                  Vercel build image). If it fails, the app ships single-threaded.
#                  LINTEL_NIGHTLY pins the nightly toolchain.
set -euo pipefail
if ! command -v cargo >/dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown
command -v wasm-pack >/dev/null || curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
mkdir -p public  # public/ only holds generated files, so a fresh clone lacks it
npm run wasm
if [ "${LINTEL_THREADS:-0}" = "1" ]; then
  if ! npm run wasm:mt; then
    echo "warning: threaded engine failed to build; shipping single-threaded only" >&2
    rm -rf public/pkg-mt
  fi
fi
npm run build
