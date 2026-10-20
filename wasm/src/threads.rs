//! Multithreaded proving (feature `threads`): Halo 2's `multicore` feature on
//! a rayon pool backed by Web Workers and shared WebAssembly memory.
//!
//! Needs a nightly build with `+atomics,+bulk-memory` and `-Z build-std`, and a
//! cross-origin-isolated page (COOP/COEP) so `SharedArrayBuffer` exists. The
//! app calls `initThreadPool(n)` once, then every proof uses all threads. The
//! single-threaded build (default features) is the fallback.

pub use wasm_bindgen_rayon::init_thread_pool;
