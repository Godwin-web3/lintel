#!/usr/bin/env bash
# Vercel build: compile the Rust engine to WASM, emit the pinned parameter
# file, then build the React app. Set VITE_RELAY_URL in the Vercel project.
set -euo pipefail
if ! command -v cargo >/dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown
command -v wasm-pack >/dev/null || curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
npm run wasm
npm run build
