//! In-browser on-chain settlement (feature `chain`): the same
//! `lintel::chain` code the `lintel-chain` CLI runs, compiled to WASM.
//!
//! Zcash testnet, NU7, Ironwood pool, v6 transactions, PCZTs. The browser
//! builds, checks, signs, witnesses and proves transactions itself; it only
//! needs public chain data (heights, commitment trees, block commitments,
//! raw transactions) and a way to broadcast, which the relay proxies from
//! lightwalletd. Nothing here talks to the network.
//!
//! Secrets handled here and never returned except to the caller's own
//! device storage: Ironwood spending keys (`sk`), transparent keys (`tsk`).
//! Everything else crossing this boundary is public between the two parties.

use anyhow::{anyhow, ensure, Context, Result};
use lintel::chain::{self, JointKeyInfo, NoteRecord, SpendTerms, TransparentKey};
use lintel::payin;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::prelude::*;

type R<T> = Result<T, JsError>;
fn e(x: anyhow::Error) -> JsError { JsError::new(&format!("{x:#}")) }

/// Which viewing key a call acts for: the payer's own single-signature
/// wallet, or the two-party escrow (joint) key.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum KeyRef {
    Own { sk: String },
    Joint { ak: String, nk: String, rivk: String },
}

fn spending_key(sk_hex: &str) -> Result<SpendingKey> {
    let b: [u8; 32] = hex::decode(sk_hex).context("sk hex")?.try_into().map_err(|_| anyhow!("sk must be 32 bytes"))?;
    Option::from(SpendingKey::from_bytes(b)).ok_or_else(|| anyhow!("invalid spending key"))
}
fn fvk_of(key: &str) -> Result<FullViewingKey> {
    match serde_json::from_str::<KeyRef>(key).context("key json")? {
        KeyRef::Own { sk } => Ok(FullViewingKey::from(&spending_key(&sk)?)),
        KeyRef::Joint { ak, nk, rivk } => JointKeyInfo { ak, nk, rivk }.fvk(),
    }
}
fn terms(j: &str) -> Result<SpendTerms> { serde_json::from_str(j).context("terms json") }
fn note(j: &str) -> Result<NoteRecord> { serde_json::from_str(j).context("note json") }
fn h32(h: &str) -> Result<[u8; 32]> { hex::decode(h)?.try_into().map_err(|_| anyhow!("expected 32 bytes")) }

// ------------------------------------------------------------ pure (testable) layer

pub fn new_spending_key() -> Result<String> {
    loop {
        let b: [u8; 32] = rand::random();
        if let Some(sk) = Option::<SpendingKey>::from(SpendingKey::from_bytes(b)) {
            let fvk = FullViewingKey::from(&sk);
            return Ok(json!({ "sk": hex::encode(b), "address": chain::encode_ua(&fvk.address_at(0u32, Scope::External)) }).to_string());
        }
    }
}
pub fn address_of(sk_hex: &str) -> Result<String> {
    Ok(chain::encode_ua(&FullViewingKey::from(&spending_key(sk_hex)?).address_at(0u32, Scope::External)))
}
pub fn new_transparent_key() -> Result<String> {
    let k = TransparentKey::random();
    Ok(json!({ "tsk": hex::encode(k.to_bytes()), "address": k.address() }).to_string())
}
pub fn transparent_address(tsk_hex: &str) -> Result<String> { Ok(TransparentKey::from_bytes(h32(tsk_hex)?)?.address()) }

/// Joint escrow key from `ak` (from `bindJoint`, ỹ = 0), the session id and
/// both 32-byte contributions. Returns the key handle plus its address.
pub fn joint(ak_hex: &str, session: &[u8], contrib_payer: &str, contrib_merchant: &str) -> Result<String> {
    let (nk, rivk) = chain::derive_nk_rivk(session, &h32(contrib_payer)?, &h32(contrib_merchant)?);
    let info = JointKeyInfo { ak: ak_hex.into(), nk: hex::encode(nk), rivk: hex::encode(rivk) };
    let fvk = info.fvk()?;
    ensure!(fvk.to_bytes()[..32] == h32(ak_hex)?, "escrow key does not use the agreed ak");
    Ok(json!({
        "kind": "joint", "ak": info.ak, "nk": info.nk, "rivk": info.rivk,
        "escrow_address": chain::encode_ua(&chain::joint_address(&fvk)),
        // raw 43-byte address, to compare with an escrow NoteRecord's `recipient`
        "escrow_raw": hex::encode(chain::joint_address(&fvk).to_raw_address_bytes()),
        "ufvk": chain::encode_ufvk(&fvk),
    }).to_string())
}

/// Notes in `raw` (hex) paid to `key`, as `NoteRecord`s (public to the owners).
pub fn find_notes(key: &str, raw_hex: &str, height: u32, txid: &str) -> Result<String> {
    let raw = hex::decode(raw_hex).context("tx hex")?;
    let fvk = fvk_of(key)?;
    let found = chain::find_notes(&raw, height, &fvk)?;
    let recs: Vec<NoteRecord> = found.iter().map(|f| NoteRecord::from_found(f, txid, height)).collect();
    Ok(serde_json::to_string(&recs)?)
}

pub fn build_spend(key: &str, note_json: &str, terms_json: &str) -> Result<Vec<u8>> {
    let fvk = fvk_of(key)?;
    let n = note(note_json)?.note()?;
    chain::pczt_to_bytes(chain::build_spend(&fvk, &n, &terms(terms_json)?)?)
}

/// What to sign, from THIS party's own check of the PCZT against the terms
/// it agreed to. Never take sighash/alpha from the counterparty.
pub fn check_spend(pczt: &[u8], key: &str, note_json: &str, terms_json: &str) -> Result<String> {
    let fvk = fvk_of(key)?;
    let n = note(note_json)?.note()?;
    let info = chain::check_spend(&chain::pczt_from_bytes(pczt)?, &fvk, &n, &terms(terms_json)?)?;
    Ok(serde_json::to_string(&info)?)
}

pub fn check_refund_window(terms_json: &str, settle_expiry: u32) -> Result<()> { chain::check_refund_window(&terms(terms_json)?, settle_expiry) }

pub fn apply_signature(pczt: &[u8], action_index: usize, sig_hex: &str) -> Result<Vec<u8>> {
    let sig: [u8; 64] = hex::decode(sig_hex)?.try_into().map_err(|_| anyhow!("signature must be 64 bytes"))?;
    chain::pczt_to_bytes(chain::apply_signature(chain::pczt_from_bytes(pczt)?, action_index, sig)?)
}

pub fn sign_own(pczt: &[u8], sk_hex: &str) -> Result<Vec<u8>> {
    chain::pczt_to_bytes(chain::sign_own(chain::pczt_from_bytes(pczt)?, &spending_key(sk_hex)?)?)
}
pub fn spend_index(pczt: &[u8], key: &str, note_json: &str) -> Result<usize> {
    let fvk = fvk_of(key)?;
    chain::spend_index(&chain::pczt_from_bytes(pczt)?, &fvk, &note(note_json)?.note()?)
}
pub fn sign_lock_input(pczt: &[u8], tsk_hex: &str) -> Result<Vec<u8>> {
    chain::pczt_to_bytes(chain::sign_lock_input(chain::pczt_from_bytes(pczt)?, &TransparentKey::from_bytes(h32(tsk_hex)?)?)?)
}
pub fn txid(pczt: &[u8]) -> Result<String> { chain::txid(&chain::pczt_from_bytes(pczt)?) }

/// Witness (from public tree data), proof, full verification, extraction.
/// `cmxs_json`: JSON array of the note block's Ironwood commitments (hex).
pub fn finalize(pczt: &[u8], action_index: usize, cmx_hex: &str, prev_tree_hex: &str, cmxs_json: &str, at_tree_hex: &str) -> Result<String> {
    let cmxs: Vec<String> = serde_json::from_str(cmxs_json).context("cmxs json")?;
    let cmxs = cmxs.iter().map(|c| h32(c)).collect::<Result<Vec<_>>>()?;
    let (raw, txid) = chain::finalize_with(chain::pczt_from_bytes(pczt)?, action_index, &h32(cmx_hex)?, prev_tree_hex, &cmxs, at_tree_hex)?;
    Ok(json!({ "raw": hex::encode(raw), "txid": txid }).to_string())
}

/// Consensus finality (zcashd `IsFinalTx`) of a raw transaction at `height`.
pub fn is_final_at(raw_hex: &str, parse_height: u32, height: u32) -> Result<bool> {
    let tx = chain::parse_tx(&hex::decode(raw_hex)?, parse_height)?;
    Ok(chain::is_final(&*tx, height))
}


// ------------------------------------------------------------ pay from another wallet (pay-in wallet)

/// A fresh per-purchase pay-in wallet: one Ironwood key and one transparent
/// key (both SECRET, device-local), the UA an external wallet pays (Orchard
/// receiver -> Ironwood note, P2PKH receiver -> transparent coin), the
/// Orchard-only UA (refund / change target) and the bare t-address.
pub fn payin_new() -> Result<String> {
    let w: serde_json::Value = serde_json::from_str(&new_spending_key()?)?;
    let sk = w["sk"].as_str().unwrap().to_string();
    let tk = TransparentKey::random();
    let addr = FullViewingKey::from(&spending_key(&sk)?).address_at(0u32, Scope::External);
    Ok(json!({ "sk": sk, "tsk": hex::encode(tk.to_bytes()), "payment_ua": payin::payment_ua(&addr, &tk.pubkey_hash()),
        "orchard_ua": w["address"], "taddr": tk.address() }).to_string())
}
/// Nullifier of a note owned by `key` (to see it spent in a later block's compact actions).
pub fn note_nullifier(key: &str, note_json: &str) -> Result<String> {
    Ok(hex::encode(note(note_json)?.note()?.nullifier(&fvk_of(key)?).to_bytes()))
}
pub fn zip321(address: &str, zats: u64, message: &str) -> String { payin::zip321_uri(address, zats, Some(message)) }
pub fn utxo_from_tx(raw_hex: &str, height: u32, txid: &str, vout: u32, taddr: &str) -> Result<String> {
    Ok(serde_json::to_string(&payin::utxo_from_tx(&hex::decode(raw_hex).context("tx hex")?, height, txid, vout, taddr)?)?)
}
pub fn utxos_in_tx(raw_hex: &str, height: u32, taddr: &str) -> Result<String> {
    Ok(serde_json::to_string(&payin::utxos_in_tx(&hex::decode(raw_hex).context("tx hex")?, height, taddr)?)?)
}
/// Indices of compact Ironwood actions (`[{nf,cmx,epk,ct}]`) paying `sk`'s address.
pub fn scan_compact(sk_hex: &str, acts_json: &str) -> Result<String> {
    let acts: Vec<payin::CompactAct> = serde_json::from_str(acts_json).context("compact actions json")?;
    Ok(serde_json::to_string(&payin::scan_compact(&FullViewingKey::from(&spending_key(sk_hex)?), &acts)?)?)
}
pub fn payin_select(notes_json: &str, utxos_json: &str, outputs_json: &str) -> Result<String> {
    let notes: Vec<NoteRecord> = serde_json::from_str(notes_json).context("notes json")?;
    let utxos: Vec<payin::Utxo> = serde_json::from_str(utxos_json).context("utxos json")?;
    let outs: Vec<payin::PayOut> = serde_json::from_str(outputs_json).context("outputs json")?;
    let (note, utxos) = payin::select(&notes, &utxos, &outs)?;
    Ok(json!({ "note": note, "utxos": utxos }).to_string())
}
pub fn payin_balance(plan_json: &str) -> Result<String> {
    let (input, fee, change) = payin::plan_balance(&serde_json::from_str(plan_json).context("plan json")?)?;
    Ok(json!({ "input": input, "fee": fee, "change": change }).to_string())
}
/// Builds, signs, proves and fully verifies a pay-in transaction (funding an
/// escrow, or sweeping the pay-in wallet out). Returns `{raw, txid, fee, change}`.
pub fn payin_build(sk_hex: &str, tsk_hex: &str, plan_json: &str, anchor_json: &str) -> Result<String> {
    let plan: payin::PayinPlan = serde_json::from_str(plan_json).context("plan json")?;
    let anchor: payin::AnchorData = serde_json::from_str(anchor_json).context("anchor json")?;
    Ok(serde_json::to_string(&payin::build(&spending_key(sk_hex)?, &TransparentKey::from_bytes(h32(tsk_hex)?)?, &plan, &anchor)?)?)
}

// ------------------------------------------------------------ wasm exports

#[wasm_bindgen(js_name = chainNewSpendingKey)]
pub fn w_new_spending_key() -> R<String> { new_spending_key().map_err(e) }
#[wasm_bindgen(js_name = chainAddress)]
pub fn w_address(sk: &str) -> R<String> { address_of(sk).map_err(e) }
#[wasm_bindgen(js_name = chainNewTransparentKey)]
pub fn w_new_tkey() -> R<String> { new_transparent_key().map_err(e) }
#[wasm_bindgen(js_name = chainTAddress)]
pub fn w_taddr(tsk: &str) -> R<String> { transparent_address(tsk).map_err(e) }
#[wasm_bindgen(js_name = chainJoint)]
pub fn w_joint(ak: &str, session: &[u8], contrib_payer: &str, contrib_merchant: &str) -> R<String> { joint(ak, session, contrib_payer, contrib_merchant).map_err(e) }
#[wasm_bindgen(js_name = chainFindNotes)]
pub fn w_find_notes(key: &str, raw: &str, height: u32, txid: &str) -> R<String> { find_notes(key, raw, height, txid).map_err(e) }
#[wasm_bindgen(js_name = chainBuildSpend)]
pub fn w_build_spend(key: &str, note: &str, terms: &str) -> R<Vec<u8>> { build_spend(key, note, terms).map_err(e) }
#[wasm_bindgen(js_name = chainCheckSpend)]
pub fn w_check_spend(pczt: &[u8], key: &str, note: &str, terms: &str) -> R<String> { check_spend(pczt, key, note, terms).map_err(e) }
#[wasm_bindgen(js_name = chainCheckRefundWindow)]
pub fn w_check_refund_window(terms: &str, settle_expiry: u32) -> R<()> { check_refund_window(terms, settle_expiry).map_err(e) }
#[wasm_bindgen(js_name = chainApplySignature)]
pub fn w_apply_signature(pczt: &[u8], idx: usize, sig: &str) -> R<Vec<u8>> { apply_signature(pczt, idx, sig).map_err(e) }
#[wasm_bindgen(js_name = chainSignOwn)]
pub fn w_sign_own(pczt: &[u8], sk: &str) -> R<Vec<u8>> { sign_own(pczt, sk).map_err(e) }
#[wasm_bindgen(js_name = chainSpendIndex)]
pub fn w_spend_index(pczt: &[u8], key: &str, note: &str) -> R<usize> { spend_index(pczt, key, note).map_err(e) }
#[wasm_bindgen(js_name = chainSignLockInput)]
pub fn w_sign_lock_input(pczt: &[u8], tsk: &str) -> R<Vec<u8>> { sign_lock_input(pczt, tsk).map_err(e) }
#[wasm_bindgen(js_name = chainTxid)]
pub fn w_txid(pczt: &[u8]) -> R<String> { txid(pczt).map_err(e) }
#[wasm_bindgen(js_name = chainFinalize)]
pub fn w_finalize(pczt: &[u8], idx: usize, cmx: &str, prev_tree: &str, cmxs: &str, at_tree: &str) -> R<String> { finalize(pczt, idx, cmx, prev_tree, cmxs, at_tree).map_err(e) }
#[wasm_bindgen(js_name = chainIsFinalAt)]
pub fn w_is_final_at(raw: &str, parse_height: u32, height: u32) -> R<bool> { is_final_at(raw, parse_height, height).map_err(e) }
#[wasm_bindgen(js_name = chainRefundPayout)]
pub fn w_refund_payout(note_value: f64) -> f64 { chain::refund_payout(note_value as u64) as f64 }
#[wasm_bindgen(js_name = chainFee)]
pub fn w_fee(ironwood_actions: usize, t_in: usize, t_out: usize) -> f64 { chain::zip317_fee(ironwood_actions, t_in, t_out) as f64 }
#[wasm_bindgen(js_name = chainLockUtxoValue)]
pub fn w_lock_value() -> f64 { chain::LOCK_UTXO_VALUE as f64 }
#[wasm_bindgen(js_name = chainPayinNew)]
pub fn w_payin_new() -> R<String> { payin_new().map_err(e) }
#[wasm_bindgen(js_name = chainZip321)]
pub fn w_zip321(address: &str, zats: f64, message: &str) -> String { zip321(address, zats as u64, message) }
#[wasm_bindgen(js_name = chainNoteNullifier)]
pub fn w_note_nullifier(key: &str, note: &str) -> R<String> { note_nullifier(key, note).map_err(e) }
#[wasm_bindgen(js_name = chainPayinFee)]
pub fn w_payin_fee(notes: usize, utxos: usize, ironwood_outputs: usize, t_outputs: usize) -> f64 { payin::plan_fee(notes, utxos, ironwood_outputs, t_outputs) as f64 }
#[wasm_bindgen(js_name = chainPayinAmount)]
pub fn w_payin_amount(escrow: f64) -> f64 { payin::payin_amount(escrow as u64) as f64 }
#[wasm_bindgen(js_name = chainUtxoFromTx)]
pub fn w_utxo_from_tx(raw: &str, height: u32, txid: &str, vout: u32, taddr: &str) -> R<String> { utxo_from_tx(raw, height, txid, vout, taddr).map_err(e) }
#[wasm_bindgen(js_name = chainUtxosInTx)]
pub fn w_utxos_in_tx(raw: &str, height: u32, taddr: &str) -> R<String> { utxos_in_tx(raw, height, taddr).map_err(e) }
#[wasm_bindgen(js_name = chainScanCompact)]
pub fn w_scan_compact(sk: &str, acts: &str) -> R<String> { scan_compact(sk, acts).map_err(e) }
#[wasm_bindgen(js_name = chainPayinSelect)]
pub fn w_payin_select(notes: &str, utxos: &str, outputs: &str) -> R<String> { payin_select(notes, utxos, outputs).map_err(e) }
#[wasm_bindgen(js_name = chainPayinBalance)]
pub fn w_payin_balance(plan: &str) -> R<String> { payin_balance(plan).map_err(e) }
#[wasm_bindgen(js_name = chainPayinBuild)]
pub fn w_payin_build(sk: &str, tsk: &str, plan: &str, anchor: &str) -> R<String> { payin_build(sk, tsk, plan, anchor).map_err(e) }
/// Builds the Ironwood proving key now (slow, ~seconds) so the first proof does not.
#[wasm_bindgen(js_name = chainWarmUp)]
pub fn w_warm_up() {
    let _ = zcash_primitives::transaction::builder::cached_orchard_proving_key(orchard::circuit::OrchardCircuitVersion::PostNu6_3);
}

#[cfg(test)]
mod tests {
    //! The whole browser settlement through this module and the Merchant /
    //! Payer bindings, offline: funding (payer wallet -> escrow), v2
    //! time-locked refund co-signed before funding, adaptor-signed settlement,
    //! proving + full verification, and `t` recovered from the raw settlement.
    use super::*;
    use crate::{content_hash, Merchant, Payer};
    use ff::{Field, PrimeField};
    use incrementalmerkletree::frontier::CommitmentTree;
    use orchard::note::{RandomSeed, Rho};
    use orchard::tree::MerkleHashOrchard;
    use orchard::value::NoteValue;
    use orchard::{Note, NoteVersion};
    use rand::RngExt;
    use serde_json::Value;

    const TARGET: u32 = 4_600_000;

    fn tree_hex(leaves: &[String]) -> String {
        if leaves.is_empty() { return String::new(); }
        let mut t: CommitmentTree<MerkleHashOrchard, 32> = CommitmentTree::empty();
        for l in leaves { t.append(MerkleHashOrchard::from_bytes(&h32(l).unwrap()).unwrap()).unwrap(); }
        let mut out = Vec::new();
        zcash_primitives::merkle_tree::write_commitment_tree(&t, &mut out).unwrap();
        hex::encode(out)
    }
    fn tx_cmxs(raw_hex: &str) -> Vec<String> {
        let tx = chain::parse_tx(&hex::decode(raw_hex).unwrap(), TARGET).unwrap();
        tx.ironwood_bundle().unwrap().actions().iter().map(|a| hex::encode(a.cmx().to_bytes())).collect()
    }
    fn source_note(sk_hex: &str, value: u64) -> NoteRecord {
        let fvk = FullViewingKey::from(&spending_key(sk_hex).unwrap());
        let mut rng = rand::rng();
        loop {
            let Some(rho) = Option::<Rho>::from(Rho::from_bytes(&pasta_curves::pallas::Base::random(&mut rng).to_repr())) else { continue };
            let Some(rseed) = Option::<RandomSeed>::from(RandomSeed::from_bytes(rng.random(), &rho)) else { continue };
            let addr = fvk.address_at(0u32, Scope::External);
            if let Some(n) = Option::<Note>::from(Note::from_parts(addr, NoteValue::from_raw(value), rho, rseed, NoteVersion::V3)) {
                let cmx = orchard::note::ExtractedNoteCommitment::from(n.commitment()).to_bytes();
                return NoteRecord { txid: "00".repeat(32), height: TARGET - 5, action_index: 0, cmx: hex::encode(cmx),
                    recipient: hex::encode(addr.to_raw_address_bytes()), value, rho: hex::encode(rho.to_bytes()), rseed: hex::encode(rseed.as_bytes()) };
            }
        }
    }
    fn v(s: &str) -> Value { serde_json::from_str(s).unwrap() }

    #[test]
    fn browser_settlement_and_time_locked_refund_offline() {
        let payload = b"sealed finding settled on chain from the browser";
        let mut merchant = Merchant::new();
        let mut payer = Payer::new();
        let offer = merchant.seal(payload).unwrap();
        let t_point = payer.verify_offer(&offer, &content_hash(payload).unwrap()).unwrap();
        let (m_vk, p_vk) = (merchant.verification_key(), payer.verification_key());
        let ak_p = v(&payer.bind_joint(&m_vk).unwrap());
        let ak_m = v(&merchant.bind_joint(&p_vk).unwrap());
        assert_eq!(ak_p, ak_m);
        let ak = ak_p["ak"].as_str().unwrap().to_string();
        let session = b"sess-onchain-1";
        let pok_p = payer.prove_knowledge(&m_vk, session).unwrap();
        assert!(merchant.verify_payer_knowledge(&p_vk, &pok_p, session).unwrap());
        let (cp, cm) = (hex::encode([3u8; 32]), hex::encode([4u8; 32]));
        let jp = joint(&ak, session, &cp, &cm).unwrap();
        let jm = joint(&ak, session, &cp, &cm).unwrap();
        assert_eq!(jp, jm, "both sides derive the same escrow key from public data");
        let escrow_ua = v(&jp)["escrow_address"].as_str().unwrap().to_string();

        // wallets (device-local secrets)
        let pw = v(&new_spending_key().unwrap());
        let psk = pw["sk"].as_str().unwrap().to_string();
        let payer_ua = pw["address"].as_str().unwrap().to_string();
        assert_eq!(address_of(&psk).unwrap(), payer_ua);
        let mw = v(&new_spending_key().unwrap());
        let merchant_ua = mw["address"].as_str().unwrap().to_string();
        let merchant_own = json!({ "kind": "own", "sk": mw["sk"] }).to_string();
        let tk = v(&new_transparent_key().unwrap());
        let tsk = tk["tsk"].as_str().unwrap().to_string();
        let taddr = tk["address"].as_str().unwrap().to_string();
        assert_eq!(transparent_address(&tsk).unwrap(), taddr);

        // ---- funding (built + proven, not broadcast)
        let own = json!({ "kind": "own", "sk": psk }).to_string();
        let src = source_note(&psk, 1_000_000);
        let src_json = serde_json::to_string(&src).unwrap();
        const PRICE: u64 = 200_000;
        let escrow_value = PRICE + 20_000;
        let settle_expiry = TARGET + 60;
        let fund_terms = json!({ "kind": "fund", "pay_to": escrow_ua, "amount": escrow_value, "change_to": payer_ua,
            "target_height": TARGET, "expiry_height": TARGET + 40, "t_out": { "address": taddr, "value": chain::LOCK_UTXO_VALUE } }).to_string();
        let fp = build_spend(&own, &src_json, &fund_terms).unwrap();
        let idx = spend_index(&fp, &own, &src_json).unwrap();
        let fp = sign_own(&fp, &psk).unwrap();
        let fund = v(&finalize(&fp, idx, &src.cmx, "", &serde_json::to_string(&vec![src.cmx.clone()]).unwrap(), &tree_hex(&[src.cmx.clone()])).unwrap());
        let (fund_raw, fund_txid) = (fund["raw"].as_str().unwrap().to_string(), fund["txid"].as_str().unwrap().to_string());
        let escrow: Vec<Value> = serde_json::from_str(&find_notes(&jp, &fund_raw, TARGET, &fund_txid).unwrap()).unwrap();
        assert_eq!(escrow.len(), 1);
        assert_eq!(escrow[0]["value"].as_u64().unwrap(), escrow_value);
        let escrow_json = escrow[0].to_string();

        // ---- v2 refund, co-signed before funding is broadcast
        let refund_terms = json!({ "kind": "refund", "pay_to": payer_ua, "amount": chain::refund_payout(escrow_value), "change_to": null,
            "target_height": TARGET, "expiry_height": 0,
            "lock": { "txid": fund_txid, "vout": 0, "value": chain::LOCK_UTXO_VALUE, "address": taddr, "lock_height": settle_expiry } }).to_string();
        check_refund_window(&refund_terms, settle_expiry).unwrap(); // merchant rule H >= E
        assert!(check_refund_window(&refund_terms, settle_expiry + 1).is_err());
        let rp = build_spend(&jp, &escrow_json, &refund_terms).unwrap();
        let ri_p = v(&check_spend(&rp, &jp, &escrow_json, &refund_terms).unwrap());
        let ri_m = v(&check_spend(&rp, &jm, &escrow_json, &refund_terms).unwrap());
        assert_eq!(ri_p, ri_m);
        let (rsh, ral) = (ri_p["sighash"].as_str().unwrap(), ri_p["alpha"].as_str().unwrap());
        let r_a = payer.nonce();
        // reload the payer mid-flow (on-chain sales span blocks)
        let mut payer = Payer::from_state(&payer.export_state()).unwrap();
        let rpart = merchant.refund_partial(&r_a, &p_vk, ral, &hex::decode(rsh).unwrap()).unwrap();
        let mpok = merchant.prove_knowledge(&p_vk, session).unwrap();
        let rsig = payer.refund_sign(&m_vk, &rpart, &hex::decode(rsh).unwrap(), session, &mpok, ral).unwrap();
        let rp = apply_signature(&rp, ri_p["action_index"].as_u64().unwrap() as usize, &rsig).unwrap();
        let rp = sign_lock_input(&rp, &tsk).unwrap();
        let fcmx = tx_cmxs(&fund_raw);
        let refund = v(&finalize(&rp, ri_p["action_index"].as_u64().unwrap() as usize, escrow[0]["cmx"].as_str().unwrap(),
            &tree_hex(&[src.cmx.clone()]), &serde_json::to_string(&fcmx).unwrap(),
            &tree_hex(&[vec![src.cmx.clone()], fcmx.clone()].concat())).unwrap());
        let rraw = refund["raw"].as_str().unwrap();
        assert_eq!(refund["txid"], ri_p["txid"]);
        assert!(!is_final_at(rraw, TARGET, settle_expiry).unwrap(), "refund invalid through the claim window");
        assert!(is_final_at(rraw, TARGET, settle_expiry + 1).unwrap(), "refund valid after it");

        // ---- settlement: merchant builds; both check; two-party adaptor signature
        let settle_terms = json!({ "kind": "settle", "pay_to": merchant_ua, "amount": PRICE, "change_to": payer_ua,
            "target_height": TARGET + 2, "expiry_height": settle_expiry }).to_string();
        let sp = build_spend(&jm, &escrow_json, &settle_terms).unwrap();
        let si_p = v(&check_spend(&sp, &jp, &escrow_json, &settle_terms).unwrap());
        let si_m = v(&check_spend(&sp, &jm, &escrow_json, &settle_terms).unwrap());
        assert_eq!(si_p, si_m);
        let wrong = settle_terms.replace(&PRICE.to_string(), &(PRICE + 1).to_string());
        assert!(check_spend(&sp, &jp, &escrow_json, &wrong).is_err(), "payer refuses other amounts");
        let (ssh, sal) = (hex::decode(si_p["sighash"].as_str().unwrap()).unwrap(), si_p["alpha"].as_str().unwrap());
        let r_a = payer.nonce();
        let mut payer = Payer::from_state(&payer.export_state()).unwrap();
        let part = merchant.partial(&r_a, &p_vk, sal, &ssh).unwrap();
        let mpok = merchant.prove_knowledge(&p_vk, session).unwrap();
        let pre = payer.pre_sign(&m_vk, &part, &ssh, session, &mpok, sal, &t_point).unwrap();
        assert_eq!(v(&pre)["vk_hex"], si_p["rk"], "joint key is bound to the escrow note's rk");
        assert!(merchant.verify_presig(&pre, &r_a, &part, &p_vk, sal).unwrap());
        let sig = merchant.complete(&pre, &part).unwrap();
        let ai = si_m["action_index"].as_u64().unwrap() as usize;
        let sp = apply_signature(&sp, ai, &sig).unwrap();
        let settled = v(&finalize(&sp, ai, escrow[0]["cmx"].as_str().unwrap(), &tree_hex(&[src.cmx.clone()]),
            &serde_json::to_string(&fcmx).unwrap(), &tree_hex(&[vec![src.cmx.clone()], fcmx.clone()].concat())).unwrap());
        assert_eq!(settled["txid"], si_p["txid"]);
        let sraw = hex::decode(settled["raw"].as_str().unwrap()).unwrap();
        // payer: t from the raw settlement only
        assert_eq!(payer.unlock_from_tx(&sraw, &pre, &part, &offer).unwrap(), payload.to_vec());
        // merchant got paid exactly the price
        let got: Vec<Value> = serde_json::from_str(&find_notes(&merchant_own, settled["raw"].as_str().unwrap(), TARGET, "x").unwrap()).unwrap();
        assert_eq!(got.iter().map(|n| n["value"].as_u64().unwrap()).sum::<u64>(), PRICE);
    }

    #[test]
    fn payin_bindings_detect_and_fund_offline() {
        // pay-in wallet + ZIP 321 request
        let p = v(&payin_new().unwrap());
        let (psk, ptsk, taddr, orchard_ua) = (p["sk"].as_str().unwrap(), p["tsk"].as_str().unwrap(), p["taddr"].as_str().unwrap(), p["orchard_ua"].as_str().unwrap());
        assert_eq!(transparent_address(ptsk).unwrap(), taddr);
        let escrow_value = 220_000u64;
        let need = payin::payin_amount(escrow_value);
        let uri = zip321(p["payment_ua"].as_str().unwrap(), need, "Lintel escrow");
        assert!(uri.starts_with("zcash:utest1") && uri.contains("amount=0.00255&"), "{uri}");

        // an external wallet pays the transparent receiver, and another payment pays the Orchard receiver
        let ext = v(&new_spending_key().unwrap());
        let (esk, eua) = (ext["sk"].as_str().unwrap(), ext["address"].as_str().unwrap());
        let src = source_note(esk, 3_000_000);
        let anchor = json!({ "prev_tree": "", "block_cmxs": [src.cmx], "at_tree": tree_hex(&[src.cmx.clone()]) }).to_string();
        let plan = |to: &str| json!({ "note": src, "utxos": [], "outputs": [{ "to": to, "value": need }], "change_to": eua,
            "target_height": TARGET, "expiry_height": TARGET + 20 }).to_string();
        let tk = v(&new_transparent_key().unwrap());
        let pay_t = v(&payin_build(esk, tk["tsk"].as_str().unwrap(), &plan(taddr), &anchor).unwrap());
        let pay_z = v(&payin_build(esk, tk["tsk"].as_str().unwrap(), &plan(orchard_ua), &anchor).unwrap());
        let (raw_t, txid_t) = (pay_t["raw"].as_str().unwrap(), pay_t["txid"].as_str().unwrap());

        // detection
        let coins: Vec<Value> = serde_json::from_str(&utxos_in_tx(raw_t, TARGET, taddr).unwrap()).unwrap();
        assert_eq!(coins.len(), 1);
        assert_eq!(coins[0]["value"].as_u64().unwrap(), need);
        assert_eq!(v(&utxo_from_tx(raw_t, TARGET, txid_t, coins[0]["vout"].as_u64().unwrap() as u32, taddr).unwrap()), coins[0]);
        let compact = |raw: &str| -> String {
            let tx = chain::parse_tx(&hex::decode(raw).unwrap(), TARGET).unwrap();
            serde_json::to_string(&tx.ironwood_bundle().unwrap().actions().iter().map(|a| json!({
                "nf": hex::encode(a.nullifier().to_bytes()), "cmx": hex::encode(a.cmx().to_bytes()),
                "epk": hex::encode(a.encrypted_note().epk_bytes), "ct": hex::encode(&a.encrypted_note().enc_ciphertext.as_ref()[..52]) })).collect::<Vec<_>>()).unwrap()
        };
        assert_eq!(v(&scan_compact(psk, &compact(raw_t)).unwrap()), json!([]));
        let hits = v(&scan_compact(psk, &compact(pay_z["raw"].as_str().unwrap())).unwrap());
        assert_eq!(hits.as_array().unwrap().len(), 1);

        // fund an escrow from the coin: escrow note + lock coin at vout 0
        let mut merchant = Merchant::new();
        let mut payer = Payer::new();
        let ak = v(&payer.bind_joint(&merchant.verification_key()).unwrap())["ak"].as_str().unwrap().to_string();
        let _ = merchant.bind_joint(&payer.verification_key()).unwrap();
        let j = joint(&ak, b"payin", &hex::encode([1u8; 32]), &hex::encode([2u8; 32])).unwrap();
        let outs = json!([{ "to": v(&j)["escrow_address"], "value": escrow_value }, { "to": taddr, "value": chain::LOCK_UTXO_VALUE }]).to_string();
        let sel = v(&payin_select("[]", &serde_json::to_string(&coins).unwrap(), &outs).unwrap());
        let fplan = json!({ "note": sel["note"], "utxos": sel["utxos"], "outputs": serde_json::from_str::<Value>(&outs).unwrap(),
            "change_to": orchard_ua, "target_height": TARGET + 1, "expiry_height": TARGET + 40 }).to_string();
        assert_eq!(v(&payin_balance(&fplan).unwrap()), json!({ "input": need, "fee": 15_000, "change": 0 }));
        let all: Vec<String> = [vec![src.cmx.clone()], tx_cmxs(raw_t)].concat();
        let fund = v(&payin_build(psk, ptsk, &fplan, &json!({ "at_tree": tree_hex(&all) }).to_string()).unwrap());
        let fraw = fund["raw"].as_str().unwrap();
        let esc: Vec<Value> = serde_json::from_str(&find_notes(&j, fraw, TARGET, fund["txid"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(esc[0]["value"].as_u64().unwrap(), escrow_value);
        assert_eq!(v(&utxo_from_tx(fraw, TARGET, fund["txid"].as_str().unwrap(), 0, taddr).unwrap())["value"].as_u64().unwrap(), chain::LOCK_UTXO_VALUE);
    }
}
