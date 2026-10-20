//! Live testnet sale: fund escrow -> pre-signed refund -> adaptor-signed
//! settlement -> payer extracts `t` from the mined transaction and decrypts.
//!
//! DEMO HARNESS: both parties run in this one process so the whole sale can
//! be reproduced with one command, but they only exchange public messages
//! (vk shares, nonce points, partials, pre-signatures, PCZT bytes). In the
//! product each side runs in its own browser (lintel-wasm) with lintel-chain
//! for the chain steps. Nothing secret (shares, t, plaintext) is printed.
//!
//!   cargo run --release --features net --example testnet_sale -- <dir> [settle|refund]
//!
//! <dir> must hold `payer-wallet.json` (from `lintel-chain wallet`) and
//! `payer-source-note.json` (from `lintel-chain scan --wallet ...`) for a
//! funded Ironwood note. Writes `evidence-<mode>.json` and
//! `payer-change-note.json` (the next run's source note). Creates
//! `payer-tkey.json` (the payer's transparent key for the refund's lock
//! input) on first use. Both modes also try the refund before its lock height
//! and record the node's rejection (v2 time lock).

use std::fs;

use anyhow::{anyhow, ensure, Result};
use group::GroupEncoding;
use lintel::chain::{self, JointKeyInfo, NoteRecord, RefundLock, SpendTerms, TransparentKey, TransparentOut};
use lintel::lwd::Lwd;
use lintel::protocol::{self, parse_scalar, Buyer as Merchant, Seller as Payer};
use lintel::sealed;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use serde_json::json;

const ESCROW: u64 = 3_000_000; // 0.03 TAZ
const PRICE: u64 = 2_000_000; // 0.02 TAZ

fn log(step: &str, v: serde_json::Value) { eprintln!("[{step}] {v}"); }

/// One two-party signing run over a PCZT both sides checked. `refund`
/// selects the refund session (T = identity, payer completes alone).
fn sign(payer: &mut Payer, merchant: &Merchant, info: &chain::SigningInfo, session: &[u8], refund: bool) -> Result<([u8; 64], protocol::PreSignature, protocol::BuyerPartial)> {
    let sighash = hex::decode(&info.sighash)?;
    let alpha = parse_scalar(&info.alpha).ok_or_else(|| anyhow!("alpha"))?;
    let r_a = payer.new_nonce(); // payer -> merchant: R_a
    let partial = if refund { merchant.refund_partial(r_a, payer.vk_a, alpha, &sighash) } else { merchant.partial(r_a, payer.vk_a, alpha, &sighash) };
    let pok = merchant.prove_knowledge(payer.vk_a, session); // merchant -> payer: partial + PoK
    let pre = payer.pre_sign(merchant.vk_b, &partial, &sighash, session, &pok, alpha).map_err(|e| anyhow!(e))?; // payer -> merchant
    ensure!(pre.vk_hex == info.rk, "protocol rk differs from the PCZT's rk");
    let sig = if refund {
        payer.complete_refund(&pre, &partial).ok_or_else(|| anyhow!("refund completion failed"))?
    } else {
        ensure!(merchant.verify_presig(&pre, r_a, partial.r_b, payer.vk_a, alpha), "bad presig");
        merchant.complete(&pre, &partial).ok_or_else(|| anyhow!("complete failed"))?
    };
    Ok((sig, pre, partial))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = args.first().cloned().ok_or_else(|| anyhow!("usage: testnet_sale <dir> [settle|refund]"))?;
    let mode = args.get(1).cloned().unwrap_or_else(|| "settle".into());
    let rd = |f: &str| fs::read(format!("{dir}/{f}"));
    let wr = |f: &str, b: &[u8]| fs::write(format!("{dir}/{f}"), b);

    let l = Lwd::connect().await?;
    let w: serde_json::Value = serde_json::from_slice(&rd("payer-wallet.json")?)?;
    let payer_sk = Option::<SpendingKey>::from(SpendingKey::from_bytes(hex::decode(w["sk"].as_str().unwrap())?.try_into().unwrap())).unwrap();
    let payer_fvk = FullViewingKey::from(&payer_sk);
    let payer_ua = chain::encode_ua(&payer_fvk.address_at(0u32, Scope::External));
    let tkey_path = format!("{dir}/payer-tkey.json");
    let payer_tkey = match fs::read(&tkey_path) {
        Ok(b) => {
            let v: serde_json::Value = serde_json::from_slice(&b)?;
            TransparentKey::from_bytes(hex::decode(v["tsk"].as_str().unwrap())?.try_into().unwrap())?
        }
        Err(_) => {
            let k = TransparentKey::random();
            fs::write(&tkey_path, serde_json::to_string(&json!({ "tsk": hex::encode(k.to_bytes()) }))?)?;
            k
        }
    };
    let payer_taddr = payer_tkey.address();
    let merchant_payout = SpendingKey::from_bytes(rand::random()).into_option().ok_or_else(|| anyhow!("retry"))?;
    let merchant_ua = chain::encode_ua(&FullViewingKey::from(&merchant_payout).address_at(0u32, Scope::External));

    // source note, waiting for it to be mined if needed
    let mut src: NoteRecord = serde_json::from_slice(&rd("payer-source-note.json")?)?;
    if src.height == 0 {
        let (_, h) = l.wait_mined(&src.txid, 1800).await?;
        src.height = h;
    }
    log("source", json!({ "txid": src.txid, "height": src.height, "value": src.value }));

    // ---- sealed goods (merchant) + offer check (payer)
    let payload = format!("Lintel testnet {mode} demo: sealed finding #{}", hex::encode(rand::random::<[u8; 4]>()));
    let keys = sealed::prove::setup::<{ sealed::CHUNKS }>().map_err(|e| anyhow!("{e:?}"))?;
    let (t, t_base) = sealed::new_secret();
    let mut merchant = Merchant::with_secret(t);
    let mut payer = Payer::new();
    let offer = sealed::seal::<{ sealed::CHUNKS }>(&keys, t_base, payload.as_bytes()).map_err(|e| anyhow!(e))?;
    let h = sealed::content_hash_bytes::<{ sealed::CHUNKS }>(payload.as_bytes()).unwrap();
    ensure!(sealed::verify_offer(&keys, &offer, &merchant.t_point(), h), "offer");

    // ---- joint escrow key
    let (ak, neg) = protocol::joint_ak(payer.vk_a, merchant.vk_b).map_err(|e| anyhow!(e))?;
    if neg { payer.negate_share(); merchant.negate_share(); }
    let session = format!("lintel-testnet-{}", hex::encode(rand::random::<[u8; 6]>()));
    // rogue-key check, both directions, BEFORE any funds move
    let pok_p = payer.prove_knowledge(merchant.vk_b, session.as_bytes());
    ensure!(protocol::verify_knowledge(payer.vk_a, &pok_p, payer.vk_a, merchant.vk_b, session.as_bytes()), "payer PoK");
    let pok_m = merchant.prove_knowledge(payer.vk_a, session.as_bytes());
    ensure!(protocol::verify_knowledge(merchant.vk_b, &pok_m, payer.vk_a, merchant.vk_b, session.as_bytes()), "merchant PoK");
    let (nk, rivk) = chain::derive_nk_rivk(session.as_bytes(), &rand::random(), &rand::random());
    let joint = JointKeyInfo::new(&ak, nk, rivk).fvk()?;
    let escrow_ua = chain::encode_ua(&chain::joint_address(&joint));
    log("joint", json!({ "ak": hex::encode(ak.to_bytes()), "escrow_address": escrow_ua }));

    // ---- funding tx (payer), built and proven but NOT broadcast yet
    let tip = l.latest().await?;
    // Claim window, fixed before funding: the settlement expires at
    // SETTLE_EXPIRY and the refund is locked until LOCK (= SETTLE_EXPIRY).
    let settle_expiry = if mode == "refund" { tip + 10 } else { tip + 40 };
    let lock_height = settle_expiry;
    let fund_terms = SpendTerms { kind: "fund".into(), pay_to: escrow_ua.clone(), amount: ESCROW, change_to: Some(payer_ua.clone()), target_height: tip + 1, expiry_height: tip + 40,
        lock: None, t_out: Some(TransparentOut { address: payer_taddr.clone(), value: chain::LOCK_UTXO_VALUE }) };
    let src_note = src.note()?;
    let p = chain::build_spend(&payer_fvk, &src_note, &fund_terms)?;
    let idx = chain::spend_index(&p, &payer_fvk, &src_note)?;
    let p = chain::sign_own(p, &payer_sk)?;
    let (fund_raw, fund_txid) = l.finalize(p, src.height, &hex::decode(&src.cmx)?.try_into().unwrap(), idx).await?;
    let escrow = chain::find_notes(&fund_raw, tip + 1, &joint)?.into_iter().next().ok_or_else(|| anyhow!("no escrow note"))?;
    log("fund-built", json!({ "txid": fund_txid, "escrow_value": escrow.note.value().inner() }));

    // ---- refund co-signed BEFORE funding is broadcast (v6: anchor deferred)
    let refund_terms = SpendTerms { kind: "refund".into(), pay_to: payer_ua.clone(), amount: chain::refund_payout(ESCROW), change_to: None, target_height: tip + 1, expiry_height: 0,
        t_out: None, lock: Some(RefundLock { txid: fund_txid.clone(), vout: 0, value: chain::LOCK_UTXO_VALUE, address: payer_taddr.clone(), lock_height }) };
    chain::check_refund_window(&refund_terms, settle_expiry)?; // merchant
    let refund = chain::build_spend(&joint, &escrow.note, &refund_terms)?;
    let r_info = chain::check_spend(&refund, &joint, &escrow.note, &refund_terms)?; // payer
    let r_info_m = chain::check_spend(&refund, &joint, &escrow.note, &refund_terms)?; // merchant
    ensure!(r_info.sighash == r_info_m.sighash);
    let (r_sig, _, _) = sign(&mut payer, &merchant, &r_info, session.as_bytes(), true)?;
    let refund = chain::apply_signature(refund, r_info.action_index, r_sig)?;
    let refund = chain::sign_lock_input(refund, &payer_tkey)?; // payer's own lock coin
    wr("refund-signed.pczt", &chain::pczt_to_bytes(refund)?)?;
    log("refund-presigned", json!({ "txid": r_info.txid, "sighash": r_info.sighash, "rk": r_info.rk }));

    // ---- broadcast funding, wait for it
    let r = l.send(fund_raw.clone()).await?;
    ensure!(r.error_code == 0, "funding broadcast rejected: {}", r.error_message);
    let (_, fund_h) = l.wait_mined(&fund_txid, 1800).await?;
    let escrow_rec = NoteRecord::from_found(&escrow, &fund_txid, fund_h);
    wr("escrow-note.json", serde_json::to_string_pretty(&escrow_rec)?.as_bytes())?;
    if let Some(c) = chain::find_notes(&fund_raw, fund_h, &payer_fvk)?.into_iter().next() {
        wr("payer-change-note.json", serde_json::to_string_pretty(&NoteRecord::from_found(&c, &fund_txid, fund_h))?.as_bytes())?;
    }
    log("fund-mined", json!({ "txid": fund_txid, "height": fund_h }));

    let escrow_cmx: [u8; 32] = escrow.cmx;
    let mut evidence = json!({
        "network": "testnet", "branch": format!("{:08x}", u32::from(chain::branch_for(fund_h))), "pool": "Ironwood", "tx_version": "v6",
        "escrow_address": escrow_ua, "joint_ak": hex::encode(ak.to_bytes()),
        "funding": { "txid": fund_txid, "height": fund_h, "escrow_value": ESCROW },
        "refund_presigned_before_funding": { "txid": r_info.txid, "sighash": r_info.sighash, "rk": r_info.rk,
            "lock_input": format!("{fund_txid}:0"), "lock_address": payer_taddr, "n_lock_time": lock_height, "n_sequence": format!("{:08x}", chain::LOCK_SEQUENCE) },
        "claim_window": { "settlement_expiry_height": settle_expiry, "refund_first_valid_height": lock_height + 1 },
    });

    // ---- the race attempt: broadcast the refund while the claim window is open.
    // v2: consensus rejects it as non-final.
    let refund_raw = {
        let p = chain::pczt_from_bytes(&rd("refund-signed.pczt")?)?;
        l.finalize(p, fund_h, &escrow.cmx, r_info.action_index).await?.0
    };
    let tip_now = l.latest().await?;
    ensure!(tip_now < lock_height, "lock already passed; cannot show the early rejection");
    let early = l.send(refund_raw.clone()).await?;
    log("refund-early", json!({ "tip": tip_now, "error_code": early.error_code, "message": early.error_message }));
    ensure!(early.error_code != 0, "SECURITY: refund accepted before its lock height");
    evidence["refund_before_lock"] = json!({ "tip": tip_now, "accepted": false, "error_code": early.error_code, "message": early.error_message });

    if mode == "refund" {
        // merchant "disappears": payer finalizes and broadcasts the refund alone
        // wait until the next block is above the lock height
        loop {
            let t = l.latest().await?;
            if t >= lock_height { break; }
            log("waiting", json!({ "tip": t, "lock_height": lock_height }));
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
        let txid = r_info.txid.clone();
        let r = l.send(refund_raw).await?;
        ensure!(r.error_code == 0, "refund broadcast rejected: {}", r.error_message);
        let (_, h) = l.wait_mined(&txid, 1800).await?;
        log("refund-mined", json!({ "txid": txid, "height": h }));
        ensure!(h > lock_height);
        evidence["refund"] = json!({ "txid": txid, "height": h, "value_returned": chain::refund_payout(ESCROW), "lock_coin_returned": chain::LOCK_UTXO_VALUE });
    } else {
        // ---- settlement: merchant builds, both check, two-party adaptor signature
        let tip = l.latest().await?;
        ensure!(tip + 10 < settle_expiry, "too close to the end of the claim window");
        let terms = SpendTerms { kind: "settle".into(), pay_to: merchant_ua.clone(), amount: PRICE, change_to: Some(payer_ua.clone()), target_height: tip + 1, expiry_height: settle_expiry, lock: None, t_out: None };
        let pczt_bytes = chain::pczt_to_bytes(chain::build_spend(&joint, &escrow.note, &terms)?)?;
        let info = chain::check_spend(&chain::pczt_from_bytes(&pczt_bytes)?, &joint, &escrow.note, &terms)?; // payer
        let info_m = chain::check_spend(&chain::pczt_from_bytes(&pczt_bytes)?, &joint, &escrow.note, &terms)?; // merchant
        ensure!(info.sighash == info_m.sighash && info.alpha == info_m.alpha);
        let (sig, pre, partial) = sign(&mut payer, &merchant, &info, session.as_bytes(), false)?;
        // merchant: apply (reddsa-verified), witness, prove, broadcast
        let p = chain::apply_signature(chain::pczt_from_bytes(&pczt_bytes)?, info.action_index, sig)?;
        let (raw, txid) = l.finalize(p, fund_h, &escrow_cmx, info.action_index).await?;
        ensure!(txid == info.txid);
        let r = l.send(raw).await?;
        ensure!(r.error_code == 0, "settlement broadcast rejected: {}", r.error_message);
        let (_, h) = l.wait_mined(&txid, 1800).await?;
        log("settle-mined", json!({ "txid": txid, "height": h }));

        // ---- payer: everything from chain, nothing from the merchant
        let mined = l.tx(&txid).await?;
        let on_chain = protocol::find_signature(&mined.data, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex).ok_or_else(|| anyhow!("signature not found on chain"))?;
        let s = parse_scalar(&hex::encode(&on_chain[32..])).unwrap();
        let t_rec = protocol::extract_t(s, parse_scalar(&pre.s_a_hex).unwrap(), partial.s_b);
        let opened = sealed::open(t_rec, &offer).ok_or_else(|| anyhow!("decrypt failed"))?;
        let ok = opened == payload.as_bytes() && t_rec == t;
        ensure!(ok, "decryption mismatch");
        let merchant_got = chain::find_notes(&mined.data, h, &FullViewingKey::from(&merchant_payout))?.iter().map(|n| n.note.value().inner()).sum::<u64>();
        log("unlocked", json!({ "t_recovered_from_chain": true, "decrypted_matches_content_hash": true }));
        evidence["settlement"] = json!({ "txid": txid, "height": h, "sighash": info.sighash, "rk": info.rk, "alpha_from_pczt": true,
            "expiry_height": terms.expiry_height, "merchant_received": merchant_got, "t_recovered_from_mined_tx": true, "decrypted_ok": true });
        evidence["refund_presigned_before_funding"]["status"] = json!("now conflicts with the settlement (same escrow nullifier); never broadcast");
    }
    wr(&format!("evidence-{mode}.json"), serde_json::to_string_pretty(&evidence)?.as_bytes())?;
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}
