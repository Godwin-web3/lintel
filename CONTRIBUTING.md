# Contributing to Lintel

Thanks for helping. Lintel is small and security-sensitive, so we keep changes focused and well tested.

## Layout

| Path | What |
| --- | --- |
| `engine/` | Rust crate: protocol, circuits, chain, CLIs |
| `wasm/` | Browser build of the engine |
| `web/relay/` | Public-data relay (Node) |
| `web/app/` | React + Vite app (landing, marketplace, docs) |
| `docs/` | Documentation, rendered on GitHub and at `/docs` in the app |
| `brand/` | Brand kit: logos, fonts, tokens, guidelines |

## Develop

```sh
# engine
cd engine && cargo test --release
# relay
cd web/relay && node --test
# app (needs a relay on :8787)
cd web/app && npm ci && npm run dev
```

The full app build (`web/app/build.sh`) compiles the WASM engines and proving parameters; see [Self-hosting](docs/self-hosting.md) for the environment variables.

## Pull requests

- One topic per PR, with a short description of what changed and why.
- Add or update tests. Anything touching signatures, circuits or transaction building needs a test that fails without the change.
- Never log or transmit secrets. Keys, shares, nonces, `t` and plaintext stay on the user's device.
- UI changes follow the brand kit in `brand/` (tokens, type, one amber action per screen). Fonts are self-hosted; the CSP blocks CDNs.
- Security issues go to [SECURITY.md](SECURITY.md), not public issues.

## License

By contributing, you agree that your contributions are dual licensed under MIT and Apache-2.0, as described in the [README](README.md#license).

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
