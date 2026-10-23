#!/usr/bin/env bash
# Builds the two WASM engines and the pinned proving parameters into this
# package (wasm/core, wasm/chain, params/). Same sources and flags as the app
# (web/app/package.json "wasm" and "wasm:chain"). Needs Rust (stable),
# wasm32-unknown-unknown, wasm-pack, and for the chain engine a C compiler
# that targets wasm32 (clang).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT/wasm"
wasm-pack build --release --target web --out-dir "$HERE/wasm/core" --out-name lintel_wasm
if [ "${LINTEL_CHAIN:-1}" = "1" ]; then
  command -v clang >/dev/null && export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-clang}"
  wasm-pack build --release --target web --out-dir "$HERE/wasm/chain" --out-name lintel_chain -- --features chain
fi
# wasm-pack writes its own package.json and a catch-all .gitignore; the SDK
# ships the files directly, so drop them.
rm -f "$HERE"/wasm/*/package.json "$HERE"/wasm/*/.gitignore "$HERE"/wasm/*/README.md
mkdir -p "$HERE/params"
cd "$ROOT/engine"
cargo run --release --no-default-features --example dump_params -- "$HERE/params/params.bin"
cargo run --release --no-default-features --example dump_params -- "$HERE/params/params-big.bin" big
echo "built: $(ls "$HERE"/wasm/* "$HERE"/params | tr '\n' ' ')"
