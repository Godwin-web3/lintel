# Proven claims (predicates)

A sealed offer proves that the ciphertext decrypts, under the secret behind
`T`, to content with hash `h`. That tells the buyer the file is the one the
listing names, but not what is in it. **Proven claims** add public statements
about the content, such as "starts with `%PDF`", "between 10,000 and 15,000
bytes long" or "the 20 bytes at offset 64 equal `0x5aa5…`". They are proven
inside the same Halo 2 proof as the decryption, over the same plaintext, so
they hold for exactly the bytes the buyer unlocks.

> Status: length bounds, magic prefix and bytes-at-offset are implemented in
> the engine, the WASM verifier, the relay and the app. Signed attestations and
> dataset predicates below are design sketches.

## How it fits the sealing proof

A v3 part proof (`engine/src/sealed_big.rs`, see [Big payloads](big-payloads.md))
already assigns the part's 768 plaintext field elements `m_0 … m_767` to
circuit cells, decrypts the ciphertext into them and hashes them. A
**predicate** (`engine/src/predicate.rs`, trait `Predicate`) adds constraints
over those **same cells**:

```
PartCircuit<N, P: Predicate = HashOnly>
  configure:  base columns and gates, then P::configure(...)
  synthesize: T = [s]G, c = m + keystream, Poseidon(m) = h, then P::synthesize(m, ...)
  instance:   [T.x, T.y, h, off, c_0 … c_767, P's public parameters …]
```

- Each predicate is its own circuit and has its own verifying key. All of
  them share `params-big.bin` (IPA parameters are per circuit size, not per
  circuit), so there is no new download and no ceremony.
- A predicate's parameters are public inputs appended after the ciphertext.
  Changing a claim on the wire changes the instance, and the proof no longer
  verifies.
- `HashOnly` adds nothing. A `PartCircuit<N, HashOnly>` is constraint for
  constraint the circuit every existing v3 offer was proven with: the
  verifying key digest is pinned in a test (`hash_only_vk_is_unchanged`, and
  `cca8d7d2…` for the shipped size from `engine/examples/vk_digest.rs`, the same
  on `main` before this change). Old offers (v1, v2, v3 without claims) verify
  unchanged.

## The `Format` predicate

One circuit covers three kinds of claim:

| Claim (`id`) | Wire form | Buyer sees |
| --- | --- | --- |
| Length bounds (`length`) | `{"id":"length","min":10000,"max":15000}` | Length between 10,000 and 15,000 bytes |
| Magic prefix (`prefix`) | `{"id":"prefix","hex":"25504446"}` | Starts with "%PDF" |
| Bytes at offset (`bytes_at`) | `{"id":"bytes_at","offset":64,"hex":"5aa5…"}` | Bytes at offset 64 equal 0x5aa5… |

An offer may carry one length claim and up to two byte claims (1 to 32 bytes
each). All are proven in part 0, so byte claims must lie in the first 23,777
payload bytes. Claims the seller did not make get vacuous parameters (length
`0 … 2^40 − 1`, all-zero byte masks), so one verifying key serves every
combination and the verifier rebuilds the parameters deterministically from
the wire.

Constraints, per part-0 proof:

1. **Select.** For each byte window, a public chunk index `w`. One row per
   chunk computes `eq_i = 1 − (i − w)·inv_i` with `(i − w)·eq_i = 0`, so
   `eq_i = [i = w]`, and running sums pick `m_w` and `m_{w+1}`. The verifier
   checks `w ≤ N − 2`, so exactly one row matches.
2. **Decompose.** Each selected chunk is split into 31 bytes, each
   range-checked to 8 bits with the circuit's existing 10-bit lookup table, and
   recomposed by Horner's rule to equal the chunk. 31 bytes are below
   `2^248 < p`, so the decomposition is unique.
3. **Compare.** For each of the 62 window bytes, public `mask_q` and
   `value_q` with `mask_q · (b_q − value_q) = 0`.
4. **Length.** `d1 = len − min`, `d2 = max − len` and `d3 = len − end` are
   each range-checked below `2^40`, where `len = m_0` (the length word
   `sealed::pack` writes) and `end` is the largest claimed byte end. With
   `max < 2^40` this gives `min ≤ len ≤ max` and `len ≥ end` over the
   integers. The `end` check stops a byte claim from pointing past the real
   payload into zero padding.

Public parameters (253 field elements): `min, max, end`, then per window
`w, mask[62], value[62]`.

The verifier also refuses: unknown claim ids or extra fields, more than one
length claim or two byte claims, `min > max`, `max ≥ 2^40`, a length bound
above the offer's capacity, and byte claims outside part 0.

### Circuit size

Every new gadget lives in advice columns the Poseidon chip does not use
(columns 0 to 4 and the range-check column), so the extra rows (two 769-row
multiplexers, four 32-row recompositions, 124 byte checks, three 40-bit checks)
pack beside the Poseidon rows. **The circuit stays at k = 15** with the same
`params-big.bin`, checked at full size with `MockProver` in
`format_predicate_real_size_mock`. It adds one fixed column and three
selectors, and no new lookup argument.

### Cost

Measured with `cargo run --release --example bench_parts -- claims 768`: one
23,777-byte part, hash-only and with all three claims, alternating in the same
process on the same 2 vCPU aarch64 machine.

| | Hash only | With claims (`Format`) |
| --- | --- | --- |
| Prove one part | see table below | see table below |
| Verify one part | 0.19 s | 0.19 s |
| Proof | 4,480 bytes | 4,544 bytes |
| Key generation | (29 s with parameters) | 16.6 s extra, once, from the same parameters |

PROVE_TABLE

Only part 0 carries claims; parts 1 and up are unchanged hash-only proofs.
One cost does change in the app: claims need offer v3, so a short file with
claims pays for one big-part proof (13 s natively, about 100 s in a
single-threaded tab) instead of a small v1/v2 proof.

## Where claims travel

- **Engine.** `Sealer::with_claims` checks every claim against the payload
  before proving (a false claim fails early with a clear error),
  `seal_with` proves part 0 with `Format`, and `verify_offer_with` checks part 0
  against the claims. `verify_offer` without claim keys rejects an offer that
  has claims, rather than ignoring them.
- **Manifest.** `BigOfferWire.predicates`, omitted when empty, so manifests
  without claims are byte-for-byte what they were.
- **Relay.** Shape checks only (`checkPredicates` in `web/relay/server.js`):
  1 to 3 claims, known ids, no extra fields, hex up to 32 bytes, length bounds
  below `2^40`, claims only on v3 offers. Changing or stripping claims on the
  relay cannot make a false claim verify: part 0's proof would fail.
- **WASM.** `BigSealer` and `Merchant.bigSealer` take an optional claims JSON;
  `checkClaims(claims, payload)` validates and previews for the seller;
  `offerClaims(offer)` returns `[{ claim, text }]` for the buyer. Claim keys are
  derived from `params-big.bin` the first time a claim is sealed or verified.
- **App.** The Sell form has an optional "Proven claims" section with a live
  preview. A listing with claims is sealed as offer v3 (on-chain and presale
  copies alike). The buyer's listing page shows "Also proven about that
  content" with the plain-English claims, only after the proof verified. Every
  presale copy carries the same claims; since they are proven about content
  with the listing's hash, they hold for any copy that verifies.

## Next: signed attestations (design sketch)

Claim: "the content contains a valid signature by public key `PK` over the
rest of the content" (a triager, auditor or data provider vouches for it).

- **Scheme.** RedPallas/Schnorr over the Pallas curve with the circuit's own
  fixed base, so the existing ECC chip (`EccChip<Bases>`, already in the part
  circuit for `T = [s]G`) does the group work. In-circuit hashing is Poseidon,
  so the signature uses a Poseidon challenge: `c = Poseidon(R.x, R.y, PK.x,
  PK.y, msg_digest)`, `msg_digest` the part's content hash over the signed
  range. A BLAKE2b challenge (standard RedPallas) would cost far more rows,
  so this is a Lintel-specific attestation key, not a Zcash spend key.
- **Where the signature lives.** In a fixed trailer of the plaintext (for
  example the last 3 chunks of part 0: `R` compressed, `s`), so the bytes the
  buyer unlocks contain the attestation and can be re-checked outside the
  circuit.
- **Constraints.** Decompose the trailer chunks into `R` and `s` (reuse the
  byte decomposition); check `[s]G = R + [c]PK` with one variable-base
  multiplication (`PK` is a public input, a non-fixed base) and one
  fixed-base multiplication; constrain `msg_digest` to the hash of the signed
  chunks (Poseidon over the same cells).
- **Cost and size.** One variable-base scalar multiplication is about 2,000
  rows across all ten advice columns, the fixed-base one about 1,700. The
  shipped part at k = 15 has little free room in the Poseidon columns, so the
  signed range is limited to part 0 minus the trailer and the circuit may need
  either fewer chunks in part 0 for signed offers, or k = 16 (a new
  parameter file). That tradeoff should be measured before choosing.
- **Public inputs.** `PK.x, PK.y`, the signed range. The app shows
  "Signed by key `ab12…`" with an optional name from a key registry.

## Next: dataset predicates (design sketch)

Claim: "the content is a dataset of `N` records with Merkle root `R`, and
every record's field `f` lies in `[lo, hi]`".

- **Layout.** Fixed-size records packed into chunks (one record per one or
  two chunks), so record `i` is at a known cell. The record count is a public
  input, checked against the length word like the `Format` length check.
- **Merkle root.** A Poseidon Merkle tree over record hashes inside the
  circuit. Per part, the circuit computes the subtree root of its records and
  exposes it as a public input. The verifier combines the per-part roots
  natively (BLAKE2b or Poseidon) into the dataset root `R`, the same way the v3
  content hash aggregates per-part hashes. That keeps each part's circuit the
  same size.
- **Per-record range checks.** Reuse the `Format` byte decomposition to
  extract field `f` and the 40-bit range check from the length gadget (or the
  64-bit one from `disclosure.rs`) for `lo ≤ f ≤ hi`. Every record needs its
  own check, so cost is linear in records per part; with small records this
  competes with the Poseidon rows and fewer chunks per part may be needed.
- **Buyer sees.** "Dataset of 1,200 records, Merkle root `9f3c…`, every
  `price` between 0 and 10,000". The root lets a buyer check later records or
  proofs of inclusion against what they paid for.

## Limits

- Claims are proven about part 0 only. Byte claims past the first 23,777
  bytes, more than two byte claims or claims longer than 32 bytes are not
  supported yet.
- Claims are public. A prefix or field claim reveals those bytes.
- A claim says what the bytes are, not that they are useful: "starts with
  `%PDF`" does not mean the PDF is the report the buyer wants.
