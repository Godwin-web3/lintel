#!/usr/bin/env bash
# Multithreaded engine (optional): nightly Rust with shared memory, Halo 2
# `multicore` on wasm-bindgen-rayon. Output goes to public/pkg-mt (served
# unbundled at /pkg-mt/). The wasm-bindgen-rayon recipe:
#   * nightly + `-Z build-std=panic_abort,std` (std must be rebuilt with atomics)
#   * +atomics,+bulk-memory,+mutable-globals
#   * imported *shared* memory with a maximum, and the TLS exports that
#     wasm-bindgen needs to give each worker thread its own stack/TLS.
#     Without --shared-memory/--import-memory the module's memory is not a
#     SharedArrayBuffer and posting it to the pool workers fails with
#     "DataCloneError: Memory could not be cloned".
#   * plain `cargo build` + `wasm-bindgen --target web` (wasm-pack's wasm-opt
#     step rejects the threads feature on some versions).
# Env: LINTEL_NIGHTLY (toolchain, default nightly).
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD"
OUT="$APP/public/pkg-mt"
TC="${LINTEL_NIGHTLY:-nightly}"
rustup toolchain install "$TC" --profile minimal --component rust-src --target wasm32-unknown-unknown

# wasm-bindgen CLI must match the wasm-bindgen crate version in wasm/Cargo.lock.
WBG_VER=$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/,""); print; exit}' ../../wasm/Cargo.lock)
WBG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/lintel/wasm-bindgen-$WBG_VER"
WBG="$WBG_DIR/wasm-bindgen"
if command -v wasm-bindgen >/dev/null && [ "$(wasm-bindgen --version | awk '{print $2}')" = "$WBG_VER" ]; then
  WBG=$(command -v wasm-bindgen)
elif [ ! -x "$WBG" ]; then
  case "$(uname -m)" in x86_64) ARCH=x86_64-unknown-linux-musl ;; aarch64|arm64) ARCH=aarch64-unknown-linux-gnu ;; *) ARCH= ;; esac
  mkdir -p "$WBG_DIR"
  if [ -n "$ARCH" ] && curl -sSfL "https://github.com/rustwasm/wasm-bindgen/releases/download/$WBG_VER/wasm-bindgen-$WBG_VER-$ARCH.tar.gz" \
      | tar -xz -C "$WBG_DIR" --strip-components=1; then :
  else
    cargo install wasm-bindgen-cli --version "$WBG_VER" --locked --root "$WBG_DIR/root"
    ln -sf "$WBG_DIR/root/bin/wasm-bindgen" "$WBG"
  fi
fi

TARGET_DIR="${CARGO_TARGET_DIR:-$APP/../../wasm/target}/mt"  # separate dir: different RUSTFLAGS
(
  cd ../../wasm
  RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=4294967296 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base' \
    CARGO_TARGET_DIR="$TARGET_DIR" \
    rustup run "$TC" cargo build --release --target wasm32-unknown-unknown --features threads -Z build-std=panic_abort,std
)
rm -rf "$OUT"
"$WBG" --target web --out-dir "$OUT" "$TARGET_DIR/wasm32-unknown-unknown/release/lintel_wasm.wasm"
# Optional size/speed pass (~4.2 MB -> ~1.7 MB). Skipped when wasm-opt is absent.
WOPT=$(command -v wasm-opt || ls "$HOME"/.cache/.wasm-pack/wasm-opt-*/bin/wasm-opt 2>/dev/null | head -1 || true)
if [ -n "$WOPT" ]; then
  "$WOPT" "$OUT/lintel_wasm_bg.wasm" -O --enable-threads --enable-bulk-memory --enable-mutable-globals \
    --enable-sign-ext --enable-nontrapping-float-to-int -o "$OUT/lintel_wasm_bg.opt.wasm" \
    && mv "$OUT/lintel_wasm_bg.opt.wasm" "$OUT/lintel_wasm_bg.wasm" \
    || { echo "warning: wasm-opt failed on the threaded engine; shipping it unoptimized" >&2; rm -f "$OUT/lintel_wasm_bg.opt.wasm"; }
fi
node scripts/fix-mt.mjs "$OUT"
