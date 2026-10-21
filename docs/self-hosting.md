# Self-hosting

You can run your own relay and app. Self-hosting removes trust in the public deployment: you serve the code you've read, and your relay sees your escrows rather than ours.

## Relay (Render + Upstash)

The repo ships a Render blueprint, `render.yaml`, for a free web service rooted at `web/relay` (`node server.js`, health check `/health`).

1. Create a free Redis database at [Upstash](https://console.upstash.com) and copy its REST URL and token.
2. In Render, create a Blueprint from your fork. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the dashboard (never commit them).
3. Set `ALLOWED_ORIGINS` in `render.yaml` to your app's origin. **A Blueprint sync re-applies the value in `render.yaml`**, so change it there, not only in the dashboard.
4. Check the log for `lintel relay on :10000 (storage: upstash)`, then `curl https://<your-relay>/health`.

Without Upstash, the relay falls back to a JSON file, which is wiped on every redeploy on Render's free plan.

### Relay environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port (Render sets it) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | — | Use Upstash storage when both are set |
| `UPSTASH_PREFIX` | `lintel` | Key prefix in Redis |
| `RELAY_STORAGE` | auto | Force `file` or `upstash` |
| `DATA_FILE` | `./data.json` | File storage path |
| `MAX_LISTINGS` | `5000` | Listing cap |
| `MAX_UNITS` | `20` | Copies per presale listing |
| `LINTEL_LWD` | `https://testnet.zec.rocks:443` | lightwalletd endpoint for the chain proxy |

Run locally: `cd web/relay && node server.js`, tests with `node --test`.

## App (Vercel)

1. Import the repo into Vercel with **root directory `web/app`**. `vercel.json` runs `build.sh`, which builds the WASM engines and `params.bin`, then the Vite app.
2. Set `VITE_RELAY_URL` to your relay URL.
3. Deploy. `vercel.json` sets the COOP/COEP and CSP headers the app needs; keep them.

### Build environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_RELAY_URL` | — | Relay base URL (required) |
| `LINTEL_CHAIN` | `1` | Build the on-chain engine; `0` skips it (on-chain settlement then shows as unavailable) |
| `LINTEL_THREADS` | `0` | `1` builds the multithreaded prover (nightly toolchain, shared memory) |
| `LINTEL_NIGHTLY` | `nightly` | Nightly toolchain for the threaded build |

Local development: `cd web/app && npm ci && npm run dev`, with a relay on `http://localhost:8787`.

## Fonts and CSP

The CSP blocks external font and script hosts, so the brand fonts (Geist, Geist Mono, Instrument Serif) are self-hosted under `web/app/public/fonts`. Don't add CDN links.
