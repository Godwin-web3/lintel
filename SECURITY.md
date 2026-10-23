# Security policy

Lintel moves value, so we take reports seriously.

## Status

Lintel runs on **Zcash testnet only** and has **not been audited**. Don't use it with real funds.

## Reporting a vulnerability

Email **godwinxbt@gmail.com** with the subject `Lintel security`. Please include:

- what an attacker can do and under which role (buyer, seller, relay operator, network observer);
- steps or a proof of concept;
- the commit you tested.

Please don't open a public issue for anything that could let someone take funds, learn a secret (`t`, key shares, plaintext) or break the soundness of a proof. We'll acknowledge within 72 hours, agree a disclosure timeline with you, and credit you in the changelog unless you'd rather we didn't.

## In scope

- The engine (`engine/`) and its WASM build (`wasm/`): adaptor signatures, key setup, Halo 2 circuits, verifiable encryption, settlement and refund construction.
- The relay (`web/relay/`): authentication of session writes, data exposure, denial of service beyond its documented limits.
- The app (`web/app/`): key or secret leakage, CSP bypass, anything that makes a user sign or pay for something other than what the UI shows.

Known limits are listed in [docs/security-model.md](docs/security-model.md); reports that extend them are welcome.

## Secret scanner false positives

These are public and hold no secrets:

- `web/app/public/params.bin`, `web/app/public/params-big.bin`: Halo 2 public parameters, pinned by digest
- `docs/testnet/*.json`: testnet transaction ids, heights and public listing data
- long `0x…` or 64-character hex strings that are transaction ids or public points

Allowlist: [`.gitleaks.toml`](.gitleaks.toml). If a scanner flags something that is a real key (a device dump, a wallet file, a seed), treat it as leaked: rotate it and purge it from history. Device dumps match `*.SECRET.*` and are git-ignored.

