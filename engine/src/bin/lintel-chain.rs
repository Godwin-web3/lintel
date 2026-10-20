//! lintel-chain: the on-chain half of a Lintel sale, on Zcash testnet.
//!
//! The two-party signing (shares, nonces, `t`) runs in each party's own
//! browser (lintel-wasm) or process; this tool only touches public data and,
//! for `wallet`/`fund`, the caller's OWN single-sig testnet wallet file.
//! It talks to a lightwalletd server (default https://testnet.zec.rocks:443,
//! override with LINTEL_LWD) and never prints secrets.
//!
//! Every command prints one JSON object on stdout. See docs/onchain.md for the
//! full sale walkthrough.

use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, bail, ensure, Context, Result};
use group::GroupEncoding;
use lintel::chain::{self, JointKeyInfo, NoteRecord, SpendTerms};
use lintel::protocol;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use lintel::lwd::{rpc, Lwd};

// ---------------------------------------------------------------- files

/// A party's OWN single-signature testnet wallet (payer funding source or
/// payout address). SECRET: keep the file local.
#[derive(Serialize, Deserialize)]
struct WalletFile { sk: String }

fn read_json<T: for<'a> Deserialize<'a>>(p: &str) -> Result<T> {
    serde_json::from_slice(&fs::read(p).with_context(|| format!("read {p}"))?).with_context(|| format!("parse {p}"))
}
fn write(p: &str, b: &[u8]) -> Result<()> { fs::write(p, b).with_context(|| format!("write {p}")) }
fn b32(h: &str) -> Result<[u8; 32]> { hex::decode(h)?.try_into().map_err(|_| anyhow!("expected 32 bytes")) }

fn wallet_keys(w: &WalletFile) -> Result<(SpendingKey, FullViewingKey)> {
    let sk = Option::from(SpendingKey::from_bytes(b32(&w.sk)?)).ok_or_else(|| anyhow!("invalid wallet key"))?;
    let fvk = FullViewingKey::from(&sk);
    Ok((sk, fvk))
}

// ---------------------------------------------------------------- args

struct Args(Vec<String>);
impl Args {
    fn get(&self, k: &str) -> Option<String> {
        self.0.iter().position(|a| a == k).and_then(|i| self.0.get(i + 1).cloned())
    }
    fn req(&self, k: &str) -> Result<String> { self.get(k).ok_or_else(|| anyhow!("missing {k}")) }
}

fn print(v: serde_json::Value) { println!("{}", serde_json::to_string_pretty(&v).unwrap()); }

const USAGE: &str = "lintel-chain <command> [options]
  height
  wallet --out w.json                                  new single-sig testnet wallet (secret, local)
  address --wallet w.json                              its Unified Address
  joint --vk-payer H --vk-merchant H --session S --contrib-payer H32 --contrib-merchant H32 --out joint.json
  scan (--txid X | --tx-file tx.hex) (--joint joint.json | --wallet w.json) --out note.json
  build --key (joint.json|w.json) --note note.json --terms terms.json --out spend.pczt
  check --joint joint.json --note note.json --terms terms.json --pczt spend.pczt
  fund --wallet w.json --note src.json --terms terms.json --out fund.tx  (build+sign+prove own spend; does NOT broadcast)
  apply --pczt in.pczt --index I --sig H64 --out out.pczt
  finalize --pczt in.pczt --note note.json --index I --out tx.hex      (witness from chain, prove, verify)
  broadcast --tx tx.hex
  fetch-sig --txid X --r H --rk H --sighash H           completed spendAuthSig from the mined tx";

#[tokio::main]
async fn main() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first().cloned() else { eprintln!("{USAGE}"); std::process::exit(2) };
    let a = Args(argv);
    match cmd.as_str() {
        "height" => {
            let l = Lwd::connect().await?;
            print(json!({ "height": l.latest().await?, "branch": format!("{:08x}", u32::from(chain::branch_for(l.latest().await? + 1))) }));
        }
        "wallet" => {
            let out = a.req("--out")?;
            ensure!(!PathBuf::from(&out).exists(), "{out} exists; refusing to overwrite a wallet");
            let sk = loop {
                let b: [u8; 32] = rand::random();
                if let Some(sk) = Option::<SpendingKey>::from(SpendingKey::from_bytes(b)) { break (sk, b); }
            };
            write(&out, serde_json::to_string(&WalletFile { sk: hex::encode(sk.1) })?.as_bytes())?;
            let fvk = FullViewingKey::from(&sk.0);
            print(json!({ "wallet": out, "address": chain::encode_ua(&fvk.address_at(0u32, Scope::External)) }));
        }
        "address" => {
            let (_, fvk) = wallet_keys(&read_json(&a.req("--wallet")?)?)?;
            print(json!({ "address": chain::encode_ua(&fvk.address_at(0u32, Scope::External)) }));
        }
        "joint" => {
            let vk_p = protocol::parse_point(&a.req("--vk-payer")?).ok_or_else(|| anyhow!("bad --vk-payer"))?;
            let vk_m = protocol::parse_point(&a.req("--vk-merchant")?).ok_or_else(|| anyhow!("bad --vk-merchant"))?;
            let (ak, negate) = protocol::joint_ak(vk_p, vk_m).map_err(|e| anyhow!(e))?;
            let (nk, rivk) = chain::derive_nk_rivk(a.req("--session")?.as_bytes(), &b32(&a.req("--contrib-payer")?)?, &b32(&a.req("--contrib-merchant")?)?);
            let info = JointKeyInfo::new(&ak, nk, rivk);
            let fvk = info.fvk()?;
            write(&a.req("--out")?, serde_json::to_string_pretty(&info)?.as_bytes())?;
            print(json!({ "ak": hex::encode(ak.to_bytes()), "shares_negated": negate,
                "escrow_address": chain::encode_ua(&chain::joint_address(&fvk)), "ufvk": chain::encode_ufvk(&fvk) }));
        }
        "scan" => {
            let l = Lwd::connect().await?;
            // --tx-file: a built but not yet broadcast transaction (e.g. from `fund`)
            let (txid, raw) = match a.get("--tx-file") {
                Some(f) => {
                    let data = hex::decode(fs::read_to_string(&f)?.trim())?;
                    let id = chain::parse_tx(&data, l.latest().await? + 1)?.txid().to_string();
                    (id, rpc::RawTransaction { data, height: 0 })
                }
                None => { let t = a.req("--txid")?; let r = l.tx(&t).await?; (t, r) }
            };
            let mined = raw.height > 0 && raw.height < u32::MAX as u64;
            let height = if mined { raw.height as u32 } else { l.latest().await? + 1 };
            let fvk = match (a.get("--joint"), a.get("--wallet")) {
                (Some(j), _) => read_json::<JointKeyInfo>(&j)?.fvk()?,
                (None, Some(w)) => wallet_keys(&read_json(&w)?)?.1,
                _ => bail!("--joint or --wallet"),
            };
            let found = chain::find_notes(&raw.data, height, &fvk)?;
            let f = found.first().ok_or_else(|| anyhow!("no Ironwood note for this key in {txid}"))?;
            let nf = NoteRecord::from_found(f, &txid, if mined { height } else { 0 });
            write(&a.req("--out")?, serde_json::to_string_pretty(&nf)?.as_bytes())?;
            print(json!({ "txid": txid, "mined_height": raw.height, "value": nf.value, "cmx": nf.cmx, "notes_found": found.len() }));
        }
        "build" => {
            let key = a.req("--key")?;
            let fvk = match read_json::<JointKeyInfo>(&key) { Ok(j) => j.fvk()?, Err(_) => wallet_keys(&read_json(&key)?)?.1 };
            let note = read_json::<NoteRecord>(&a.req("--note")?)?.note()?;
            let terms: SpendTerms = read_json(&a.req("--terms")?)?;
            let p = chain::build_spend(&fvk, &note, &terms)?;
            write(&a.req("--out")?, &chain::pczt_to_bytes(p)?)?;
            print(json!({ "pczt": a.req("--out")?, "txid_preview": "run check" }));
        }
        "check" => {
            let fvk = read_json::<JointKeyInfo>(&a.req("--joint")?)?.fvk()?;
            let note = read_json::<NoteRecord>(&a.req("--note")?)?.note()?;
            let terms: SpendTerms = read_json(&a.req("--terms")?)?;
            let p = chain::pczt_from_bytes(&fs::read(a.req("--pczt")?)?)?;
            let info = chain::check_spend(&p, &fvk, &note, &terms)?;
            print(serde_json::to_value(info)?);
        }
        "fund" => {
            let (sk, fvk) = wallet_keys(&read_json(&a.req("--wallet")?)?)?;
            let nf: NoteRecord = read_json(&a.req("--note")?)?;
            let note = nf.note()?;
            let terms: SpendTerms = read_json(&a.req("--terms")?)?;
            let p = chain::build_spend(&fvk, &note, &terms)?;
            let idx = chain::spend_index(&p, &fvk, &note)?;
            let p = chain::sign_own(p, &sk)?;
            let l = Lwd::connect().await?;
            let (raw, txid) = l.finalize(p, nf.height, &b32(&nf.cmx)?, idx).await?;
            // the escrow note this funding tx creates, so the refund can be signed before broadcast
            write(&a.req("--out")?, hex::encode(&raw).as_bytes())?;
            print(json!({ "tx": a.req("--out")?, "txid": txid, "broadcast": false }));
        }
        "apply" => {
            let p = chain::pczt_from_bytes(&fs::read(a.req("--pczt")?)?)?;
            let sig: [u8; 64] = hex::decode(a.req("--sig")?)?.try_into().map_err(|_| anyhow!("sig must be 64 bytes"))?;
            let p = chain::apply_signature(p, a.req("--index")?.parse()?, sig)?;
            write(&a.req("--out")?, &chain::pczt_to_bytes(p)?)?;
            print(json!({ "pczt": a.req("--out")?, "signature_verified": true }));
        }
        "finalize" => {
            let p = chain::pczt_from_bytes(&fs::read(a.req("--pczt")?)?)?;
            let nf: NoteRecord = read_json(&a.req("--note")?)?;
            let l = Lwd::connect().await?;
            let (raw, txid) = l.finalize(p, nf.height, &b32(&nf.cmx)?, a.req("--index")?.parse()?).await?;
            write(&a.req("--out")?, hex::encode(&raw).as_bytes())?;
            print(json!({ "tx": a.req("--out")?, "txid": txid, "bytes": raw.len() }));
        }
        "broadcast" => {
            let raw = hex::decode(fs::read_to_string(a.req("--tx")?)?.trim())?;
            let l = Lwd::connect().await?;
            let r = l.send(raw).await?;
            print(json!({ "error_code": r.error_code, "message": r.error_message }));
            ensure!(r.error_code == 0, "broadcast rejected");
        }
        "fetch-sig" => {
            let l = Lwd::connect().await?;
            let raw = l.tx(&a.req("--txid")?).await?;
            let sig = protocol::find_signature(&raw.data, &a.req("--r")?, &a.req("--rk")?, &a.req("--sighash")?)
                .ok_or_else(|| anyhow!("no valid signature with this R in the transaction"))?;
            print(json!({ "signature": hex::encode(sig), "mined_height": raw.height }));
        }
        "verify-witness" => {
            // Diagnostic against live data, no keys needed: rebuilds the witness of
            // every Ironwood output of a mined tx from GetTreeState(h-1) + the
            // compact block, and checks the root equals GetTreeState(h).
            let l = Lwd::connect().await?;
            let txid = a.req("--txid")?;
            let raw = l.tx(&txid).await?;
            let h = raw.height as u32;
            let tx = chain::parse_tx(&raw.data, h)?;
            let b = tx.ironwood_bundle().ok_or_else(|| anyhow!("no Ironwood bundle"))?;
            let prev = l.tree(h - 1).await?;
            let cmxs = l.block_cmxs(h).await?;
            let at = l.tree(h).await?;
            let bytes = hex::decode(&at.ironwood_tree)?;
            let t: incrementalmerkletree::frontier::CommitmentTree<orchard::tree::MerkleHashOrchard, 32> =
                zcash_primitives::merkle_tree::read_commitment_tree(&bytes[..])?;
            let root = orchard::Anchor::from(t.root()).to_bytes();
            let mut ok = 0;
            for act in b.actions() {
                let (anchor, path) = chain::witness(&prev.ironwood_tree, &cmxs, &act.cmx().to_bytes())?;
                ensure!(anchor.to_bytes() == root, "root mismatch");
                ensure!(path.root(*act.cmx()).to_bytes() == root, "path does not open to root");
                ok += 1;
            }
            print(json!({ "txid": txid, "height": h, "tx_version": format!("{:?}", tx.version()), "ironwood_actions": b.actions().len(),
                "block_ironwood_commitments": cmxs.len(), "witnesses_verified": ok, "anchor": hex::encode(root),
                "spend_auth_sigs_parsed": b.actions().iter().map(|a| hex::encode(<[u8; 64]>::from(a.authorization()))[..16].to_string()).collect::<Vec<_>>() }));
        }
        _ => { eprintln!("{USAGE}"); std::process::exit(2) }
    }
    Ok(())
}

