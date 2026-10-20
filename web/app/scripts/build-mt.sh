#!/usr/bin/env bash
# Multithreaded engine: nightly Rust with shared memory, Halo 2 `multicore`
# on wasm-bindgen-rayon. Output goes to public/pkg-mt (served unbundled).
set -euo pipefail
cd "$(dirname "$0")/.."
TC="${LINTEL_NIGHTLY:-nightly}"
rustup toolchain install "$TC" --profile minimal --component rust-src --target wasm32-unknown-unknown
(
  cd ../../wasm
  RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals' \
    rustup run "$TC" wasm-pack build --release --target web --out-dir ../web/app/public/pkg-mt --no-pack \
    -- --features threads -Z build-std=panic_abort,std
)
node scripts/fix-mt.mjs public/pkg-mt
