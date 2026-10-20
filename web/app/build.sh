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
# On-chain engine (src/pkg-chain): lintel::chain compiled to WASM, loaded only
# when a user opens the on-chain flow. secp256k1-sys needs a C compiler that
# targets wasm32 (clang); the Vercel image may lack it, so try to install it.
# If this build fails the app still ships: a stub makes the on-chain panels
# say the engine is unavailable. LINTEL_CHAIN=0 skips it.
if [ "${LINTEL_CHAIN:-1}" = "1" ]; then
  if ! command -v clang >/dev/null; then
    (command -v dnf >/dev/null && dnf install -y -q clang lld llvm) || (command -v apt-get >/dev/null && apt-get install -y -q clang lld llvm) || true
  fi
  if command -v clang >/dev/null; then
    export CC_wasm32_unknown_unknown=clang
    command -v llvm-ar >/dev/null && export AR_wasm32_unknown_unknown=llvm-ar
  fi
  if ! npm run wasm:chain; then
    echo "warning: on-chain engine failed to build; shipping without it" >&2
    LINTEL_CHAIN=0
  fi
fi
if [ "${LINTEL_CHAIN:-1}" != "1" ] || [ ! -f src/pkg-chain/lintel_chain.js ]; then
  mkdir -p src/pkg-chain
  printf "export default async function init() { throw new Error('on-chain engine not included in this build'); }\n" > src/pkg-chain/lintel_chain.js
fi
if [ "${LINTEL_THREADS:-0}" = "1" ]; then
  if ! npm run wasm:mt; then
    echo "warning: threaded engine failed to build; shipping single-threaded only" >&2
    rm -rf public/pkg-mt
  fi
fi
npm run build
