# Production gate

What has to be true before Lintel handles real money on Zcash mainnet. Today none of the gates below is passed: Lintel is testnet software, and **mainnet is not planned until testnet is solid and the code has been reviewed**. This page exists so that the bar is written down before anyone is tempted to skip it.

> **Status: testnet only, unaudited.** Do not use Lintel with real funds.

## Where things stand

| Gate | State |
| --- | --- |
| Testnet runs of every flow, mined and recorded | Done for single-copy sales, refunds, pay from another wallet and the seller agent ([evidence](testnet-evidence.md)). Multi-copy listings are off-chain only. |
| Open issues from testers that touch funds or secrets | Tracked in GitHub issues; testing has just opened ([testers](https://lintel-godwin-web3s-projects.vercel.app/testers)) |
| Internal review | Not started |
| Public remediation log | Not started |
| External audit | Not started |
| Mainnet caps and kill switch | Not designed |
| Mainnet deployment | Not planned |

## The gates, in order

### 1. Testnet is solid

- Every on-chain flow (sale, refund, pay from another wallet, seller agent) has a recent mined run on the current code, recorded in `docs/testnet/*.json`.
- Known gaps that can lose funds or leak secrets are closed or explicitly accepted with a reason: refund kept only in browser storage, the post-sale confidentiality limit described in the [Threat model](threat-model.md#after-the-sale), the relay's view of escrows.
- Multi-copy listings either settle on chain or are clearly labelled as off-chain only, as they are today.
- Tester reports that touch funds or secrets are fixed and released.

### 2. Internal review

- A written review of the engine (`engine/`: adaptor signatures, key setup, circuits, PCZT checks, refund construction), the WASM bindings (`wasm/`), the relay (`web/relay/`) and the app (`web/app/`), against the [Threat model](threat-model.md).
- Circuit review: every public input is constrained, part offsets and counts are pinned by the verifier, and `MockProver` and real prove/verify tests cover each circuit at its shipped size.
- Each finding gets a severity and an owner.

### 3. Remediation log

- A public file in the repository listing every finding, its severity, the fix (commit or PR) and how the fix was verified (test, live run).
- Nothing rated critical or high stays open.

### 4. External audit

- An independent audit of the circuits and the settlement protocol, with the report published.
- Its findings go into the same remediation log.

### 5. Caps and controls for a first mainnet release

- A per-listing price cap and a cap on open escrow value, enforced by the app and the seller agent, set low enough that a bug cannot hurt much.
- Proving parameters pinned by digest (already true on testnet: `params.bin` and `params-big.bin`).
- Refund backup that survives clearing browser storage.
- A documented way to stop new listings on the public relay without touching open escrows; refunds only need the chain, so they keep working.
- Release notes that say plainly what is and is not covered.

### 6. Mainnet

Only after gates 1 to 5. Until then the answer to "is this on mainnet?" is no.

## What Lintel will not do to get there faster

- No custodial shortcut: the relay never holds keys, signing shares, `t` or plaintext, and a hosted service will not hold them either.
- No unproven bulk: every byte sold is proven, or the listing is refused.
- No trusted setup: Halo 2 with IPA over the Pasta curves stays.

Status of each feature: [What ships when](what-ships-when.md). Security policy and reporting: [SECURITY.md](../SECURITY.md).
