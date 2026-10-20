# Lintel

Conditional settlement on Zcash using two-party adaptor signatures.

## Flow

`R = R_a + R_b + T`, `rk = vk_a + vk_b + α·G`, `c = H(R ‖ rk ‖ sighash)`.

1. Seller generates a single-use nonce and publishes only `R_a`.
2. Buyer computes `s_b = r_b + c·sk_b` from `R_a` (never sees `r_a`).
3. Seller checks the buyer's knowledge proof and `s_b·G == R_b + c·vk_b`, then sends `s_a`.
4. Buyer recomputes `R = R_a + R_b + T`, checks `vk_hex` against `rk`, and verifies `s_a` before completing.
5. Seller extracts `t = s − s_a − s_b` without learning `sk_b`. On chain, it reads `s` from the mined transaction.

## Sealed goods (pay to decrypt)

`engine/src/sealed.rs` makes "paying reveals the key" mean "paying unlocks the promised content".

The party holding `t` (it completes the signature and gets paid) encrypts a payload and proves in Halo 2, before any money moves:

- `T = [t]·G` on the Orchard spend-auth base: the same `T` the adaptor signature is locked to.
- `c_i = m_i + Poseidon(t, i+1)`: the ciphertext is the plaintext under a keystream from `t`.
- `Poseidon(m) = h`: the plaintext matches a content hash the payer already agreed on.

Public inputs: `[T.x, T.y, h, c_0..c_{N-1}]`. The payer runs `verify_offer` against the `T` from the session, then pre-signs. When the signature lands, it runs `extract_t` and `open` to decrypt.

- Payload: up to 1,953 bytes per proof (64 chunks of 31 bytes, chunk 0 = length).
- Larger payloads (`sealed_multi.rs`): up to 4 proofs bound to the same `t`, with a public keystream offset per part, 7,905 bytes, same pinned parameters.
- Multi-copy, seller-offline sales (`presale.rs`): a fresh `t`, key share and pre-committed nonce per copy; see [docs/relay-perf.md](docs/relay-perf.md).
- Proof: about 4.3 KB. Proving takes about 3.3 s on a laptop-class CPU, with no trusted setup (IPA).
- `t` is sampled below the Pallas base modulus (`sealed::new_secret`) so it works both as a scalar and as a field element.
- Limit: this proves the content matches `h`. The payer still has to know which `h` it wants, e.g. a hash published or attested out of band.

```bash
cargo run --release --bin lintel-cli -- sealed-demo "your secret payload"
# {"offer_verified":true,"paid_ok":true,"decrypted_ok":true,"proof_bytes":4352,...}
```

## On-chain settlement (Zcash testnet)

Full design and evidence: [docs/onchain.md](docs/onchain.md).

The escrow is a real **Ironwood** note on testnet (NU7, v6 transactions). Its spend validating key is the two-party
adaptor key, so `ak = vk_payer + vk_merchant`. The signatures sign the real PCZT sighash with the PCZT's `alpha`.
The payer recovers `t` from the mined transaction, and a refund is co-signed before the escrow is funded.

| Testnet | txid | Height |
| --- | --- | --- |
| Sale 1 funding → escrow | `da340dee5bb4a8ec11872d184c884b38aabfba3060a68e76d17df32628d6cf91` | 4,521,270 |
| Sale 1 adaptor-signed settlement (t extracted from chain, content decrypted) | `8b4ada0992642b2a71649e08c8de8d0b00cdf90a46a2794d4e09ca7999a3c0a8` | 4,521,277 |
| Sale 2 funding → escrow | `f11c111d89e870b69ade0478f7331f0e8131bac7c596846a8327832a16a235e4` | 4,521,282 |
| Sale 2 refund (pre-signed before funding, payer alone) | `633ac619a5305b961d0d3187f26cc61f6b9211a49b3bb787a30d044aee6a3f03` | 4,521,289 |
| Browser sale funding → escrow (both sides in the web app) | `75053762c15aea7b27fad758928fc3009ca86d5ee3a10e35b17162914c302534` | 4,522,583 |
| Browser sale settlement (buyer's browser extracted t from chain, decrypted) | `c51697ebe0767395dee5fc54f246eccf53dc2e071f5690808ec77776939b2b67` | 4,522,588 |

```bash
cd engine
cargo test --release --features chain --test settlement      # offline: fund, refund, settle, prove, verify, extract t
cargo build --release --features net --bin lintel-chain --example testnet_sale
```

## Web app

`web/` is a browser marketplace for sealed goods: sell, verify, buy, unlock.
The engine runs in the browser through `wasm/` (`lintel-wasm`), so signing
shares, the unlock secret and plaintext never leave the user's device; a small
relay (`web/relay`) carries only public data. See [web/README.md](web/README.md).

## Reproduce

```bash
cd engine
cargo test --lib protocol::tests
cargo test --lib disclosure::tests
cargo test --release --lib sealed::tests
cargo run --bin lintel-cli -- demo
```

## What is verified

- Nonce is generated inside the seller and consumed on use.
- Buyer computes its partial from `R_a` alone.
- `verify_presig` recomputes `R` and checks `vk_hex` against `rk`.
- Seller proves knowledge of `sk_a`; proofs use a separate domain.
- Completed signature verifies under `rk`.
- Seller extracts `t` without `sk_b`.
- MinValue circuit: `C = Poseidon(value, blind, txid_lo, txid_hi)` computed in-circuit; public inputs `[min, txid_lo, txid_hi, C]`; running sum starts from a fixed constant 0, 64-bit range check on `value - min`.
- Real Halo 2 prove/verify (IPA over Pasta) in `disclosure::prove`.
- Sealed goods: wrong content hash, tampered ciphertext, and a key not bound to `T` all fail; the end-to-end test pays, extracts `t`, and decrypts.
- Peer-supplied hex is parsed with `parse_scalar`/`parse_point`; malformed input returns an error, never panics.

## Not yet done

- **Browser on-chain flow covers single-copy listings only.** Multi-copy presale listings still settle off-chain
  (no ZEC moves).
- **The seller must be online** when a buyer starts an on-chain purchase: the seller's open app co-signs the
  refund before the buyer funds, and later broadcasts the settlement. There is no background seller agent for
  on-chain sales.
- **The device wallet is minimal:** it knows only notes scanned in by txid, marks a note spent only when this
  device funds an escrow with it, and does not detect spends made elsewhere or pick up change/payout/refund notes
  automatically. The signed refund lives only in that browser's localStorage.
- **Production build of the on-chain engine is unverified.** `web/app/build.sh` needs a wasm32-capable clang for
  `secp256k1-sys`; if that build fails the app ships a stub and the on-chain panels report the engine as
  unavailable.
- Testnet only. Details: [docs/onchain.md](docs/onchain.md#remaining-gaps).
