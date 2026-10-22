# Relay persistence, seller-offline sales, multi-copy listings, threaded proving

Branch `app-relay-perf`. Scope: `web/relay`, the seller/presale side of
`web/app`, two new engine modules (`presale.rs`, `sealed_multi.rs`) and their
WASM bindings (`wasm/src/v2.rs`, `wasm/src/threads.rs`). `protocol.rs`,
`sealed.rs` and the v1 buy flow are untouched apart from one-line module
registrations, so on-chain settlement work on v1 sessions merges cleanly.

## A. Persistent relay storage (free hosting)

`web/relay/storage.js`, zero dependencies, selected by `RELAY_STORAGE`:

| value | what | when |
| --- | --- | --- |
| `file` (default) | JSON snapshot at `DATA_FILE` | local dev; Render free (ephemeral) |
| `memory` | nothing persisted | tests |
| `upstash` | Upstash Redis REST API | Render free with persistence |

`upstash` is chosen automatically when `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` are both set. Records live in one Redis hash per
collection (`lintel:listings`, `lintel:sessions`, `lintel:orders`; prefix via
`UPSTASH_PREFIX`). The relay keeps its working set in memory, loads it at boot,
and writes behind in batched `/pipeline` calls (≤512 KB each), sending only
records whose JSON changed since the last confirmed write (so legacy `save()`
calls cost one command per changed record, not a full dump). Failed writes are
retried with backoff (1 s → 30 s); SIGTERM flushes before exit. Logs never
include record contents or the token.

Assumes a single relay instance (true for Render free). Why Upstash: plain
HTTPS + bearer token, so no driver dependency; Neon/Supabase need a driver or a
less stable HTTP SQL endpoint for the same result.

**What you set up (no account was created for you):**

1. Sign up at https://console.upstash.com (free plan), *Create Database* →
   Redis, any region near Render's (e.g. us-east-1 / Oregon to match your
   Render region), free tier.
2. On the database page, open the **REST API** section and copy
   `UPSTASH_REDIS_REST_URL` (https://…upstash.io) and
   `UPSTASH_REDIS_REST_TOKEN`.
3. Render dashboard → `lintel-relay` → Environment → add both variables
   (`render.yaml` declares them with `sync: false`, so a Blueprint sync prompts
   for them). Redeploy. The boot log says `storage: upstash`.

Free tier limits worth knowing: 256 MB data, 500K commands/month. A v2 listing
with 10 two-part copies is roughly 260 KB.

## B. Seller offline

**Verdict:** a sale cannot *complete* with no holder of the unlock secret online,
and nothing here hands that secret to a third party. Completion is
`s = s_a + s_b + t`; whoever computes `s` knows `t`. So a seller-side service
holding `t`, or the relay, would be the only "fully offline" designs, and both
violate "t never reaches the relay". What *can* be removed is every round trip
before completion, which is what the presale protocol does.

**Presale protocol (`engine/src/presale.rs`)**, MuSig2-style preprocessing made
safe by single use:

* At listing time, for each copy *i*, the seller samples a fresh key share
  `sk_i`, nonce `r_i` and adaptor secret `t_i`, and publishes
  `(vk_i, R_i, T_i, PoK_i, offer_i)`. `PoK_i` binds `vk_i` to `R_i` and `T_i`.
* A buyer arrives while the seller is offline, verifies `PoK_i` and the offer
  proof, and pre-signs immediately:
  `R = R_a + R_i + T_i`, `rk = vk_a + vk_i + αG`, `c = H(R, rk, sighash)`,
  `s_a = r_a + c(sk_a + α)`. It also sends a PoK of `sk_a` (bound to the
  copy and to its DH point) and an ephemeral DH point `E = eG`. `sk_a` and
  `r_a` are dropped right away; the buyer keeps only `e`.
* Next time the seller's app runs (any page, any tab), one step per order:
  check the buyer PoK and `s_a`, then `s_b = r_i + c·sk_i`,
  `s = s_a + s_b + t_i`, publish `s` and `enc_sb = s_b + H(sk_i·E, …)`.
* The buyer unmasks `s_b` with `e·vk_i`, checks `s_b·G = R_i + c·vk_i`,
  extracts `t_i = s − s_a − s_b`, checks `t_i·G = T_i`, decrypts.

Why the pre-committed nonce is safe here: each `(sk_i, r_i)` signs at most once.
One response `r_i + c·sk_i` with uniform `r_i` hides `sk_i` perfectly, and with
one session per key there are no concurrent sessions for a ROS/Wagner attack.
The seller cannot adapt `vk_i`, `R_i` or `T_i` to the buyer (they were fixed
first), so there is no rogue-key/rogue-nonce angle against the buyer either.
`reusing_a_unit_nonce_would_leak_the_key_share` is a test showing why single use
matters.

Single use in the app (`web/app/src/presale.js`): the completion is computed in
the worker, then the `used` marker and the completion are written to
localStorage in one synchronous write, and only then sent (a completion that
was computed but not persisted was never released, so it reveals nothing). Retries re-send the
stored completion byte-for-byte; a unit used by one order never signs another.
Passes run under `navigator.locks` so two tabs cannot race. The relay also
rejects a new unit that repeats an `R`, key or `T` of the same listing.

Hardening from the review of this branch:

* The buyer's device-local `keep` now holds the DH secret *and* a BLAKE2b
  digest of exactly the unit it verified (keys, points, PoK, offer with
  proofs). `buyerUnlock` refuses a unit that differs, so a relay re-serving the
  copy with another offer at unlock time cannot make the buyer decrypt
  unverified ciphertext (e2e: `v2_swapped_offer_unlocked: false`). Legacy keeps
  (bare secret) still unlock, without that check.
* `verify_order` rejects an identity DH point (it would make the pad, and so
  `s_b` and `t_i`, computable from the relay's view), identity buyer key and
  identity buyer nonce; `verify_pok` rejects identity `vk_i`, `R_i`, `T_i`.

What the relay stores per sale: `s_a`, `s`, `enc_sb` (and public points). It
cannot derive `t_i` (`relay_view_does_not_reveal_t`). This also fixes a v1
property: on v1 the relay's public session holds `s_a`, `s_b` and `s`, so anyone
reading it can compute `t` and open the offer after the sale.

UX: buyers see "waiting for the seller's device" and can close the tab; their
purchase resumes from localStorage. Sellers' sales complete in a background
agent on every page (polls every 5 s and on tab focus), not only on "My sales".
Remaining limit: the seller must open the app at some point after an order. A
service worker cannot do this reliably (Periodic Background Sync needs an
installed PWA and is Chromium-only and throttled), so it is not attempted.

## C. Multiple sales per listing

Reusing `t` across buyers leaks it: anyone with a pre-signature and the
completed signature recovers `t`, and the shared ciphertext with it. Presale
listings instead carry up to 20 copies (10 from the Sell form), each with its
own `t_i`, its own ciphertext and its own Halo 2 proof(s), sealed at listing
time; "Add copies" seals more later (the seller re-attaches the content, which
is checked against the listing's content hash and never stored). One copy's
`t_i` opens only that copy (`units_are_independent_so_one_sale_does_not_unlock_another`,
and the e2e cross-unlock check).

Cost: one proof per copy per part, paid by the seller up front (see D for
timings). Relay storage ~13 KB per part per copy.

Seller can refuse an invalid order (bad pre-signature/PoK) before signing
anything; the copy reopens. Orders are otherwise final once placed (a buyer
cannot cancel, so a copy is never re-offered after its nonce may have been
used).

## D. Multithreaded browser proving

* `wasm` feature `threads` = `lintel/multicore` (Halo 2 `maybe-rayon` →
  rayon) + `wasm-bindgen-rayon`. `web/app/scripts/build-mt.sh` follows the
  wasm-bindgen-rayon recipe: nightly, `-Z build-std=panic_abort,std`,
  `RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals
  -C link-arg=--shared-memory -C link-arg=--import-memory
  -C link-arg=--max-memory=4294967296 -C link-arg=--export=__wasm_init_tls
  -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align
  -C link-arg=--export=__tls_base'`, plain `cargo build`, then
  `wasm-bindgen --target web` (CLI pinned to the crate version in
  `wasm/Cargo.lock`, fetched as a release binary or `cargo install`ed), then
  an optional `wasm-opt -O --enable-threads …` pass (4.2 MB → 1.7 MB).
* **The earlier failure** ("DataCloneError: Memory could not be cloned", then
  single-thread fallback) came from building with `+atomics` but without the
  linker flags: the module owned a plain, non-shared memory, which cannot be
  posted to the pool workers. With `--shared-memory --import-memory` the JS
  glue creates `WebAssembly.Memory({ shared: true, maximum })` and hands it to
  every worker; the TLS exports let each worker get its own stack and TLS.
  It also used `wasm-pack`, whose bundled `wasm-opt` step is skipped now.
* Output is served unbundled from `/pkg-mt/`; `scripts/fix-mt.mjs` rewrites
  wasm-bindgen-rayon's directory import so no bundler is needed.
* The crypto worker loads it only if `crossOriginIsolated` and
  `SharedArrayBuffer` exist and `/pkg-mt/` loads, then calls
  `initThreadPool(n)` *inside the worker* (default `min(cores, 8)`);
  otherwise the bundled single-threaded engine runs exactly as before.
  `?threads=0` forces single thread, `?threads=N` sets the pool size.
* `vercel.json` adds `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Checked: relay fetches are
  CORS requests, which COEP allows (the relay also sends
  `Cross-Origin-Resource-Policy: cross-origin`); the app loads no other
  cross-origin resources; CSP needs no change (`/pkg-mt/*` is `'self'`, the
  pool workers are same-origin module workers under `worker-src 'self' blob:`,
  `'wasm-unsafe-eval'` was already there). COOP breaks `window.opener` links,
  which the app does not use.
* `build.sh` builds the threaded engine only when `LINTEL_THREADS=1` is set
  (opt-in until it is verified in the Vercel build image), after the normal
  one, and continues single-threaded if it fails. The default
  `npm run wasm` build and its output are unchanged.

### Prove times

Headless Chromium (Debian `chromium`, Playwright), `web/app/scripts/bench.mjs`
against the built app served with the `vercel.json` headers
(`crossOriginIsolated: true`), 2-vCPU aarch64 sandbox, 2 runs each. "Seal" is
the whole Sell-form step for one copy (Halo 2 proof(s) + publish), as the app
reports it.

| engine | boot (keys from pinned params) | seal, 1,000 B (1 proof) | seal, 3,000 B (2 proofs) |
| --- | --- | --- | --- |
| single thread (`?threads=0`) | 12.2 s | 28.0 s, 27.8 s | 55.5 s, 55.5 s |
| threaded, 2 workers (auto) | 7.6 s | 15.1 s, 14.9 s | 29.9 s, 29.9 s |
| speed-up | 1.6× | 1.87× | 1.86× |

Near-linear on 2 cores. Pools larger than 2 were not measured (the machine
had 2 cores); more cores should help further but scaling is unverified (the
pool is capped at 8).

## E. Payloads larger than 1,953 bytes

Done without touching the pinned parameters. `engine/src/sealed_multi.rs`
proves a payload in up to 4 parts of 64 chunks with the same `k = 13`, so
`params.bin` (524,356 bytes, BLAKE2b `f1a631a8…53b97db2`) and its pin are
unchanged; only the verifying key changes, and every party derives it from
the pinned params and the circuit code. Each part proves `T = [s]G` for the
same `s`, its plaintext hash, and `c = m + Poseidon(s, off + i + 1)` with the
offset as a public input; verifiers require `off_j = 64·j`, so parts never
share keystream. The listing's content hash is the part hash for one part
(identical to v1's) and BLAKE2b("lintel-mpart-v1", P ‖ h_0 ‖ …) for more.

Max payload: 7,905 bytes (4 parts). The limit is the relay body size (each part
adds ~13 KB to a copy's offer). A new, larger pinned params file (k = 14) would
allow one proof per ~4 KB but doubles the download and proving memory, so it
was not done.

**Superseded for payloads above 7,905 bytes (offer v3).** Big payloads now use
768-element parts at k = 15 with a rate-2 keystream and a second pinned file
(`params-big.bin`), and their ciphertext and proofs move to content-addressed
relay blobs, so the relay body cap no longer limits the payload: up to
1,523,681 bytes. v1/v2 offers below that are unchanged. See
[Big payloads](big-payloads.md).
