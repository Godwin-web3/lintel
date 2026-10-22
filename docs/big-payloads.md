# Big payloads (offer v3)

Lintel listings now hold up to **1,523,681 bytes (about 1.5 MB)**, on-chain or
multi-copy, and the guarantee is unchanged: **the decryption of every
plaintext byte is proven before the buyer pays.** There is no "encrypt the
file under K and prove only K" step; the ciphertext the buyer downloads is
exactly the ciphertext inside the proofs.

| Offer | Used for | Proofs | Max payload |
| --- | --- | --- | --- |
| v1 (`sealed.rs`) | single-copy listings up to 1,953 B | 1 at k = 13 | 1,953 B |
| v2 (`sealed_multi.rs`) | presale copies up to 7,905 B | 1–4 at k = 13 | 7,905 B |
| **v3 (`sealed_big.rs`)** | anything larger, both listing kinds | 1–64 at k = 15 | **1,523,681 B** |

The app picks the version by size, so small listings are unchanged (same
`params.bin`, same pinned digest, same offers).

## What one v3 proof shows

For part `j` of a payload, with public inputs `[T.x, T.y, h_j, off_j, c_{j,0} … c_{j,767}]`:

- `T = [s] G` on the Orchard spend-auth base: the key is the adaptor secret the payment is locked to;
- `(o_0, o_1) = squeeze2(Poseidon-sponge(s, 2^128 + off_j + i + 1))` and
  `c_{2i} = m_{2i} + o_0`, `c_{2i+1} = m_{2i+1} + o_1` for every pair `i` of
  the part's 768 field elements (31 payload bytes each);
- `Poseidon(m_j) = h_j`.

The verifier requires `off_j = 384 · j`, so no two parts share keystream, and
recomputes the listing's content hash from the proven part hashes:
`BLAKE2b-256("lintel-big-v3", 768 ‖ P ‖ h_0 ‖ … ‖ h_{P-1})`. Swapping, dropping
or re-ordering parts, a different `T`, a wrong hash or any changed ciphertext
element fails verification (tests in `engine/src/sealed_big.rs`).

## The three levers that were used

### 1. Bigger parts: k = 15

A part holds 768 field elements (23,808 bytes) at k = 15, against 64 (1,953
bytes) at k = 13. Halo 2 here uses IPA over the Pasta curves, which is
transparent, so a bigger circuit needs only a bigger public parameter file:
`params-big.bin`, 2,097,220 bytes, BLAKE2b (personal `lintel-params-v1`)
`0544c622…e9004e73`, pinned in the WASM like `params.bin`. No ceremony. The app
downloads it only when a big offer is first sealed or verified.

k = 16 and k = 17 were not chosen: proving memory doubles with every step of
k (about 1 GB at k = 15, measured below), and the browser engine is a 32-bit
WASM module (4 GB address space) whose single-threaded prover is already at
about 100 s per k = 15 part. Bigger parts would not prove faster per byte, only
fewer, larger proofs, at twice the memory.

### 2. Rate-2 keystream

v1 and v2 spend one Poseidon permutation per field element of keystream
(`Poseidon(s, i)`, one output word). v3 uses the same sponge (P128Pow5T3,
width 3, rate 2, capacity 1, `ConstantLength<2>` domain) and outputs **both**
rate words of each permutation. Per two payload elements, the circuit now runs
two permutations (one keystream, one for the content hash) instead of three,
so a third fewer rows per byte.

Why this is sound:

- It is ordinary sponge squeezing. The capacity word (one ~255-bit field
  element) is never output, which is the margin P128Pow5T3 is specified with
  for 128-bit security; outputting the full rate is how the sponge is meant to
  be used.
- Every permutation input is distinct: `idx = 2^128 + global pair index + 1`
  is unique per pair, and the verifier pins each part's pair offset. With `s`
  secret, each output word is a pseudorandom field element: the same
  keyed-sponge (PRF) assumption v1 already relies on, now for both rate words.
- The `2^128` tag keeps every v3 input disjoint from v1/v2 inputs (which are
  below `2^64`), so even a secret reused across offer versions would not repeat
  keystream.
- Proof soundness does not depend on the keystream's secrecy at all: both
  squeezed words are constrained by the same Pow5 chip gates, and each
  ciphertext element is tied to them by an addition gate and a copy to the
  public input.
- The off-circuit keystream (`keystream2`) is checked against the library's
  `Poseidon::hash` (word 0 must equal it) in `keystream_word0_is_v1_poseidon_with_tagged_index`,
  and the in-circuit version is checked by `MockProver` at the real size.

### 3. Content-addressed blobs on the relay

A 1 MB v3 offer is about 1.25 MB of ciphertext and proofs. Instead of putting
that in the listing (the relay's JSON bodies are capped at 64 KB, which is what
limited v2 to four parts), each part travels as a **blob**:

```
"LNT3" | n: u32 LE | offset: u64 LE | part hash: 32 B | ciphertext: n × 32 B | proof
```

named by the SHA-256 of its bytes. The listing keeps only a manifest (about
170 bytes per part plus `T` and the content hash; 7 KB for 1 MB):

```json
{ "v": 3, "n": 768, "t_point": "…", "content_hash": "…",
  "parts": [ { "hash": "…", "offset": 0, "blob": "<sha256>", "len": 29104 }, … ] }
```

Relay routes: `PUT /blobs/:sha256` (raw bytes, at most 48 KB, refused with 422
unless the bytes hash to the name; write-once) and `GET /blobs/:sha256`
(immutable, cacheable). Creating a listing or a presale copy with a v3 manifest
fails unless every named blob is already stored, the offsets are `384 · j` and
`n = 768`.

Integrity is checked three times: by the relay on upload, by the buyer's app on
download (`resolveOffer` in `web/app/src/api.js` re-hashes every blob), and by
the WASM engine, which checks each blob's SHA-256 and header against the
manifest before verifying any proof. A swapped or tampered blob is rejected
before payment; a blob that is merely missing stalls the sale like any other
relay failure, it cannot cheat the buyer.

Storage backends follow `RELAY_STORAGE`: files under `BLOB_DIR` (default
`<DATA_FILE dir>/blobs`), an in-memory map, or Upstash (one Redis string per
blob, `SET NX`). `BLOB_QUOTA` caps total bytes (default 2 GB) and `MAX_BLOB`
the size of one blob.

### 4. Parallel parts

`sealed_big::seal_parallel` and `verify_offer_parallel` work on several parts
at once (native only). On this 2-vCPU test machine it does **not** help:
Halo 2's own multicore prover already keeps both cores busy, and two parts in
flight take the same 26.7 s as one after the other while peak memory goes from
1.0 GB to 1.7 GB. It pays off on machines with more cores than one proof uses.
In the browser, parts are proven one per call in the crypto worker (so the UI
shows progress), and the optional threaded build (`LINTEL_THREADS=1`)
parallelises inside each proof; several workers each holding 1 GB of keys was
judged not worth the memory.

## Measurements

All numbers from the sandbox this was built on: 2 vCPU aarch64, 8 GB RAM,
`cargo run --release --example bench_parts` (native, Halo 2 multicore on both
cores) and `node wasm/node-bench-big.mjs` (the browser's single-threaded WASM
build, run in Node 22). Setup = parameter generation + key generation; the app
skips parameter generation by downloading the pinned file.

### Native, one part per circuit size

| Circuit | Payload / proof | Setup | Prove | Verify | Proof | Peak memory |
| --- | --- | --- | --- | --- | --- | --- |
| v1/v2, k = 13, 64 elements | 1,953 B | 6.8 s | 3.30 s | 0.056 s | 4,352 B | 260 MB |
| v2 circuit at k = 14, 256 elements (not shipped) | 7,905 B | 14.0 s | 6.71 s | 0.098 s | 4,416 B | 516 MB |
| **v3, k = 15, 768 elements** | **23,777 B** | 29.1 s | **13.3 s** | **0.19 s** | 4,480 B | **1,028 MB** |

Proving cost per byte: 1.69 ms (v1), 0.56 ms (v3). v3 is three times cheaper
per byte than the old circuit, from fuller circuits and the rate-2 keystream.

### Native, whole payloads (v3)

| Payload | Parts | Prove | Verify | Blobs | Peak memory |
| --- | --- | --- | --- | --- | --- |
| 47,585 B | 2 | 26.6 s (1 part at a time) / 26.7 s (2 in parallel) | 0.37 s | 58,208 B | 1.0 GB / 1.7 GB |
| 1,023,721 B (1 MB) | 43 | BENCH_1MB_PROVE | BENCH_1MB_VERIFY | BENCH_1MB_BLOBS | BENCH_1MB_MEM |

### Browser engine (WASM, single thread)

| Payload | Parts | Keys from `params-big.bin` | Prove | Verify | WASM memory |
| --- | --- | --- | --- | --- | --- |
| 30,000 B | 2 | 42.1 s | 103 s per part (206 s) | 2.9 s | 1,018 MB |
| 1 MB (extrapolated) | 43 | 42 s | about 74 min | about 63 s | about 1 GB |

So: **a 1 MB file proves in about BENCH_1MB_MIN minutes natively on this
2-core machine**; a typical 8-core laptop should be several times faster
(not measured here). In a browser tab without threads the same file takes
over an hour, which is why big payloads are best sealed natively (see
`engine/examples/live_agent_sale.rs` with `LINTEL_PAYLOAD_BYTES`, which seals,
uploads blobs and lists exactly like the app) or with the threaded build.
Buying is cheap everywhere: verification is about 0.2 s per part natively and
1.5 s per part in single-threaded WASM.

## Limits and what is not done

- **Proving time in the browser.** About 100 s per 23.8 KB part single-threaded.
  The threaded build was not benchmarked for v3 here.
- **Blob availability.** Blobs live on the relay. On Render's free plan without
  Upstash the disk is ephemeral, like `data.json`; with Upstash, blobs count
  against the Redis plan's storage. R2 or IPFS backends were not added.
- **Uploads are open.** Anyone can upload a blob that hashes to its name, up
  to `MAX_BLOB` each and `BLOB_QUOTA` in total. Listings can only reference
  stored blobs, but unreferenced blobs are not garbage-collected yet.
- **Not done: "proven core + bulk"** (a proven key plus unproven bulk
  ciphertext for files beyond 1.5 MB). Everything sold today is fully proven.
- **Multi-copy big listings re-prove per copy.** Each copy has its own secret,
  so 10 copies of a 1 MB file means 430 proofs.
