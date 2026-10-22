//! Funding an escrow from ANY external testnet wallet ("pay from another wallet").
//!
//! The escrow cannot be paid directly by an external wallet: the buyer's
//! time-locked refund is pre-signed over the exact escrow note (its `rho` and
//! `rseed`, which only the transaction's builder knows), and the funding
//! transaction must also create the buyer's 20,000-zat transparent lock coin
//! at `vout 0`. So the buyer's app opens a fresh per-purchase **pay-in
//! wallet** (one Ironwood spending key + one transparent key, kept on the
//! device like the device wallet), asks the external wallet for a plain
//! ZIP 321 payment to it, detects the payment, and then builds the funding
//! and the refund itself exactly as before.
//!
//! Which receivers external wallets can pay on today's testnet (NU6.3/NU7):
//!
//! * **Orchard-protocol receiver.** Receivers are scoped to the Orchard
//!   protocol, not to a pool (ZIP 326), and after NU6.3 no value may enter the
//!   Orchard pool (ZIP 258), so an NU6.3-aware wallet pays an Orchard receiver
//!   with an **Ironwood** note. The pay-in wallet spends that note directly.
//! * **Transparent P2PKH receiver.** Every wallet can pay it (including
//!   transparent-only wallets and nodes whose shielded support lags NU6.3).
//!   The pay-in wallet spends the coin(s) directly as transparent inputs of
//!   the funding transaction. No separate sweep transaction is needed: v6
//!   txids exclude transparent signatures (ZIP 244), so the funding txid, the
//!   escrow note and the refund are all fixed before the coins are signed.
//!
//! One payment request (a Unified Address carrying both receivers, plus the
//! bare t-address for wallets that cannot read UAs) asks for the same amount
//! whichever receiver the wallet picks: the funding fee is 15,000 zats in
//! both shapes (2 Ironwood actions + 1 transparent logical action).
//!
//! Funding transactions here are built with the standard
//! `zcash_primitives` [`Builder`] (transparent inputs need it; the
//! `DeferredPcztBuilder` used for escrow spends takes none), with the
//! Ironwood anchor fixed at build time: the note's own block root when an
//! Ironwood note is spent, else the current tip's root.

use anyhow::{anyhow, bail, ensure, Context, Result};
use incrementalmerkletree::frontier::CommitmentTree;
use orchard::keys::{FullViewingKey, PreparedIncomingViewingKey, Scope, SpendingKey};
use orchard::note::ExtractedNoteCommitment;
use orchard::note_encryption::{CompactAction, IronwoodDomain};
use orchard::tree::MerkleHashOrchard;
use orchard::{Address, Anchor};
use pczt::roles::creator::Creator;
use pczt::roles::io_finalizer::IoFinalizer;
use pczt::roles::signer::Signer;
use serde::{Deserialize, Serialize};
use zcash_address::unified::{self, Encoding};
use zcash_primitives::transaction::builder::{BuildConfig, Builder, BundlePadding};
use zcash_protocol::consensus::{BlockHeight, NetworkType};
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::TransparentAddress;
use zcash_transparent::bundle::{OutPoint, TxOut};

use crate::chain::{self, NoteRecord, TransparentKey, NETWORK};

/// Fee of a funding transaction built from the pay-in wallet with ONE input
/// (one Ironwood note, or one P2PKH coin): 2 Ironwood actions (escrow +
/// change/padding) + 1 transparent logical action (the lock output, or the
/// coin in and the lock out) = 15,000 zats. Same as the device-wallet funding.
pub const PAYIN_FUND_FEE: u64 = 15_000;

/// Amount a pay-in request asks for: the escrow, the lock coin and the
/// funding fee. Paid exactly, the funding has no change.
pub fn payin_amount(escrow_value: u64) -> u64 { escrow_value + chain::LOCK_UTXO_VALUE + PAYIN_FUND_FEE }

// ---------------------------------------------------------------- addresses and ZIP 321

/// Testnet Unified Address with an Orchard-protocol receiver (paid as an
/// Ironwood note by NU6.3 wallets) AND a P2PKH receiver (for wallets that
/// can only pay transparent). Wallets pick the most preferred receiver they
/// support (ZIP 316).
pub fn payment_ua(addr: &Address, pkh: &[u8; 20]) -> String {
    let ua = unified::Address::try_from_items(
        unified::Revision::R0,
        vec![
            unified::Uitem::Data(unified::Receiver::Orchard(addr.to_raw_address_bytes())),
            unified::Uitem::Data(unified::Receiver::P2pkh(*pkh)),
        ],
    ).expect("Orchard + P2PKH is a valid UA");
    ua.encode(&NetworkType::Test)
}

/// Receivers of a testnet address as an external wallet sees them: a UA's
/// Orchard and P2PKH receivers, or a bare `tm…` P2PKH address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receivers { pub orchard: Option<[u8; 43]>, pub p2pkh: Option<[u8; 20]> }

pub fn receivers(s: &str) -> Result<Receivers> {
    if s.starts_with("tm") { return Ok(Receivers { orchard: None, p2pkh: Some(chain::decode_taddr(s)?) }); }
    let (net, _, ua) = unified::Address::decode(s).map_err(|e| anyhow!("address: {e}"))?;
    ensure!(net == NetworkType::Test, "not a testnet address");
    let mut r = Receivers { orchard: None, p2pkh: None };
    for item in unified::Container::items(&ua) {
        match item {
            unified::Receiver::Orchard(b) => r.orchard = Some(b),
            unified::Receiver::P2pkh(h) => r.p2pkh = Some(h),
            _ => {}
        }
    }
    ensure!(r.orchard.is_some() || r.p2pkh.is_some(), "address has no Orchard or P2PKH receiver");
    Ok(r)
}

/// `zcash:<address>?amount=<ZEC>&message=<text>` (ZIP 321). The amount is
/// written in decimal ZEC with at most 8 fraction digits, exactly.
pub fn zip321_uri(address: &str, zats: u64, message: Option<&str>) -> String {
    let mut u = format!("zcash:{address}?amount={}", zec_decimal(zats));
    if let Some(m) = message.filter(|m| !m.is_empty()) { u.push_str("&message="); u.push_str(&pct(m)); }
    u
}

/// Minimal ZIP 321 parser for a single-payment URI: address and amount (zats).
pub fn parse_zip321(uri: &str) -> Result<(String, u64)> {
    let rest = uri.strip_prefix("zcash:").ok_or_else(|| anyhow!("not a zcash: URI"))?;
    let (addr, query) = rest.split_once('?').unwrap_or((rest, ""));
    ensure!(!addr.is_empty(), "URI has no address");
    let mut amount = None;
    for kv in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = kv.split_once('=').ok_or_else(|| anyhow!("bad URI parameter {kv}"))?;
        ensure!(!k.contains('.'), "multi-payment URIs are not supported here");
        if k == "amount" { amount = Some(parse_zec(v)?); }
    }
    Ok((addr.to_string(), amount.ok_or_else(|| anyhow!("URI has no amount"))?))
}

pub fn zec_decimal(z: u64) -> String {
    let (i, f) = (z / 100_000_000, z % 100_000_000);
    if f == 0 { return i.to_string(); }
    format!("{i}.{}", format!("{f:08}").trim_end_matches('0'))
}
pub fn parse_zec(s: &str) -> Result<u64> {
    let (i, f) = s.split_once('.').unwrap_or((s, ""));
    ensure!(!i.is_empty() && i.len() <= 8 && i.bytes().all(|b| b.is_ascii_digit()), "bad amount {s}");
    ensure!(f.len() <= 8 && f.bytes().all(|b| b.is_ascii_digit()), "bad amount {s}");
    Ok(i.parse::<u64>()? * 100_000_000 + if f.is_empty() { 0 } else { format!("{f:0<8}").parse::<u64>()? })
}
fn pct(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// ---------------------------------------------------------------- detection

/// A transparent coin paid to the pay-in wallet, checked against the raw
/// transaction (never taken on a server's word).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Utxo { pub txid: String, pub vout: u32, pub value: u64, pub height: u32, pub address: String }

/// Reads output `vout` of `raw` and returns it as a coin of `taddr`. Fails if
/// the output does not exist or does not pay `taddr` (P2PKH).
pub fn utxo_from_tx(raw: &[u8], height: u32, txid: &str, vout: u32, taddr: &str) -> Result<Utxo> {
    let tx = chain::parse_tx(raw, height)?;
    ensure!(tx.txid().to_string() == txid, "transaction bytes do not match txid {txid}");
    let b = tx.transparent_bundle().ok_or_else(|| anyhow!("transaction has no transparent outputs"))?;
    let o = b.vout.get(vout as usize).ok_or_else(|| anyhow!("no output {vout}"))?;
    let want = chain::decode_taddr(taddr)?;
    ensure!(o.recipient_address() == Some(TransparentAddress::PublicKeyHash(want)), "output {vout} does not pay {taddr}");
    Ok(Utxo { txid: txid.into(), vout, value: u64::from(o.value()), height, address: taddr.into() })
}

/// Every transparent output of `raw` paying `taddr`.
pub fn utxos_in_tx(raw: &[u8], height: u32, taddr: &str) -> Result<Vec<Utxo>> {
    let tx = chain::parse_tx(raw, height)?;
    let txid = tx.txid().to_string();
    let want = TransparentAddress::PublicKeyHash(chain::decode_taddr(taddr)?);
    let Some(b) = tx.transparent_bundle() else { return Ok(vec![]) };
    Ok(b.vout.iter().enumerate().filter(|(_, o)| o.recipient_address() == Some(want))
        .map(|(i, o)| Utxo { txid: txid.clone(), vout: i as u32, value: u64::from(o.value()), height, address: taddr.into() }).collect())
}

/// One Ironwood action of a lightwalletd compact block.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CompactAct { pub nf: String, pub cmx: String, pub epk: String, pub ct: String }

/// Trial-decrypts compact Ironwood actions with `fvk`'s external IVK and
/// returns the indices that pay it. A hit only says "fetch this transaction";
/// the note is then read from the full transaction with `chain::find_notes`.
pub fn scan_compact(fvk: &FullViewingKey, acts: &[CompactAct]) -> Result<Vec<usize>> {
    let ivk = PreparedIncomingViewingKey::new(&fvk.to_ivk(Scope::External));
    let mut hits = Vec::new();
    for (i, a) in acts.iter().enumerate() {
        let nf = Option::from(orchard::note::Nullifier::from_bytes(&h32(&a.nf)?)).ok_or_else(|| anyhow!("bad nullifier"))?;
        let cmx = Option::from(ExtractedNoteCommitment::from_bytes(&h32(&a.cmx)?)).ok_or_else(|| anyhow!("bad cmx"))?;
        let ct: [u8; orchard::note_encryption::COMPACT_NOTE_SIZE] = hex::decode(&a.ct)?.try_into().map_err(|_| anyhow!("compact ciphertext must be {} bytes", orchard::note_encryption::COMPACT_NOTE_SIZE))?;
        let ca = CompactAction::from_parts(nf, cmx, h32(&a.epk)?.into(), ct.into());
        if zcash_note_encryption::try_compact_note_decryption(&IronwoodDomain::for_compact_action(&ca), &ivk, &ca).is_some() {
            hits.push(i);
        }
    }
    Ok(hits)
}

fn h32(h: &str) -> Result<[u8; 32]> { hex::decode(h)?.try_into().map_err(|_| anyhow!("expected 32 bytes")) }

// ---------------------------------------------------------------- building

/// Public chain data that fixes the Ironwood anchor (and, when an Ironwood
/// note is spent, its witness). Same shapes as `chain::finalize_with`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AnchorData {
    /// Note spent: `GetTreeState(h-1)` Ironwood tree, the block's commitments
    /// and `GetTreeState(h)` (h = the note's height). No note: only
    /// `at_tree` = the tip's Ironwood tree.
    #[serde(default)] pub prev_tree: String,
    #[serde(default)] pub block_cmxs: Vec<String>,
    pub at_tree: String,
}

/// Where a pay-in transaction sends value. `to` is a testnet UA (its Orchard
/// receiver gets an Ironwood note) or a `tm…` address (P2PKH output).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PayOut { pub to: String, pub value: u64 }

/// What a pay-in transaction does. Transparent outputs keep their order (the
/// first one is `vout 0`: the refund's lock coin when funding an escrow).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PayinPlan {
    /// At most one Ironwood note of the pay-in wallet.
    #[serde(default)] pub note: Option<NoteRecord>,
    /// Coins of the pay-in wallet's transparent key.
    #[serde(default)] pub utxos: Vec<Utxo>,
    pub outputs: Vec<PayOut>,
    /// Ironwood change goes here (a UA). `None`: the outputs must take
    /// everything but the fee (a sweep), else the build fails.
    pub change_to: Option<String>,
    pub target_height: u32,
    pub expiry_height: u32,
}

/// A built, signed, proven and fully verified transaction.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BuiltTx { pub raw: String, pub txid: String, pub fee: u64, pub change: u64 }

/// ZIP 317 fee for a pay-in transaction's shape.
pub fn plan_fee(n_notes: usize, n_utxos: usize, ironwood_outputs: usize, t_outputs: usize) -> u64 {
    let ir = n_notes.max(ironwood_outputs);
    let ir = if ir == 0 { 0 } else { ir.max(2) }; // a present bundle is padded to 2 actions
    chain::zip317_fee(ir, n_utxos, t_outputs)
}

/// Splits `outputs` into Ironwood (UA) and transparent outputs, in order.
fn split_outputs(outputs: &[PayOut]) -> Result<(Vec<(Address, u64)>, Vec<([u8; 20], u64)>)> {
    let (mut ir, mut t) = (Vec::new(), Vec::new());
    for o in outputs {
        ensure!(o.value > 0, "zero-value output");
        if o.to.starts_with("tm") { t.push((chain::decode_taddr(&o.to)?, o.value)); }
        else { ir.push((chain::decode_ua(&o.to)?, o.value)); }
    }
    Ok((ir, t))
}

/// Value in, fee and change of a plan (no keys needed): what the UI shows
/// before building, and what `build` enforces.
pub fn plan_balance(plan: &PayinPlan) -> Result<(u64, u64, u64)> {
    let (ir, t) = split_outputs(&plan.outputs)?;
    let n_notes = plan.note.is_some() as usize;
    let input: u64 = plan.note.as_ref().map_or(0, |n| n.value) + plan.utxos.iter().map(|u| u.value).sum::<u64>();
    let out: u64 = plan.outputs.iter().map(|o| o.value).sum();
    // with change: one more Ironwood output
    let fee_change = plan_fee(n_notes, plan.utxos.len(), ir.len() + 1, t.len());
    let fee_exact = plan_fee(n_notes, plan.utxos.len(), ir.len(), t.len());
    if plan.change_to.is_some() && input > out + fee_change {
        return Ok((input, fee_change, input - out - fee_change));
    }
    ensure!(input >= out + fee_exact, "inputs {input} zats do not cover outputs {out} + fee {fee_exact}");
    ensure!(input == out + fee_exact, "inputs exceed outputs + fee by {} zats and there is no change address", input - out - fee_exact);
    Ok((input, fee_exact, 0))
}

/// Builds, signs (Ironwood spend with `sk`, every coin with `tsk`), proves,
/// fully verifies and extracts a pay-in transaction.
pub fn build(sk: &SpendingKey, tsk: &TransparentKey, plan: &PayinPlan, anchor: &AnchorData) -> Result<BuiltTx> {
    ensure!(plan.note.is_some() || !plan.utxos.is_empty(), "nothing to spend");
    let fvk = FullViewingKey::from(sk);
    let (ir_outs, t_outs) = split_outputs(&plan.outputs)?;
    let (_, fee, change) = plan_balance(plan)?;
    let change_to = if change > 0 { Some(chain::decode_ua(plan.change_to.as_deref().unwrap())?) } else { None };

    // anchor (+ witness when a note is spent), cross-checked against the node's root
    let note = plan.note.as_ref().map(|r| r.note().map(|n| (r, n))).transpose()?;
    let (anchor_v, path) = match &note {
        Some((rec, _)) => {
            ensure!(rec.height > 0, "the Ironwood note is not mined yet");
            let cmxs = anchor.block_cmxs.iter().map(|c| h32(c)).collect::<Result<Vec<_>>>()?;
            let (a, p) = chain::witness(&anchor.prev_tree, &cmxs, &h32(&rec.cmx)?)?;
            ensure!(tree_root(&anchor.at_tree)? == a.to_bytes(), "witness root does not match the chain's Ironwood root");
            (a, Some(p))
        }
        None => {
            let root = tree_root(&anchor.at_tree)?;
            (Option::from(Anchor::from_bytes(root)).ok_or_else(|| anyhow!("bad anchor"))?, None)
        }
    };

    let mut b = Builder::new(NETWORK, BlockHeight::from_u32(plan.target_height), BuildConfig::Standard {
        sapling_anchor: None, orchard_anchor: None, ironwood_anchor: Some(anchor_v),
        orchard_padding: BundlePadding::DEFAULT, ironwood_padding: BundlePadding::DEFAULT,
    }).with_expiry_height(BlockHeight::from_u32(plan.expiry_height));
    if let (Some((_, n)), Some(p)) = (&note, path) {
        b.add_ironwood_spend::<std::convert::Infallible>(fvk.clone(), *n, p).map_err(|e| anyhow!("ironwood spend: {e:?}"))?;
    }
    let pk = secp256k1::PublicKey::from_secret_key(&tsk.0);
    let own = TransparentAddress::PublicKeyHash(tsk.pubkey_hash());
    for u in &plan.utxos {
        ensure!(chain::decode_taddr(&u.address)? == tsk.pubkey_hash(), "coin {}:{} is not the pay-in wallet's", u.txid, u.vout);
        let mut h = hex::decode(&u.txid).context("txid hex")?;
        h.reverse();
        let coin = TxOut::new(zat(u.value)?, own.script().into());
        b.add_transparent_p2pkh_input(pk, OutPoint::new(h.try_into().map_err(|_| anyhow!("txid length"))?, u.vout), coin)
            .map_err(|e| anyhow!("transparent input: {e:?}"))?;
    }
    for (a, v) in &ir_outs {
        b.add_ironwood_output::<std::convert::Infallible>(None, *a, zat(*v)?, MemoBytes::empty()).map_err(|e| anyhow!("output: {e:?}"))?;
    }
    if let Some(c) = change_to {
        b.add_ironwood_output::<std::convert::Infallible>(None, c, zat(change)?, MemoBytes::empty()).map_err(|e| anyhow!("change: {e:?}"))?;
    }
    for (h, v) in &t_outs {
        b.add_transparent_output(&TransparentAddress::PublicKeyHash(*h), zat(*v)?).map_err(|e| anyhow!("transparent output: {e:?}"))?;
    }
    let res = b.build_for_pczt(rand::rng(), &FixedFee(zat(fee)?)).map_err(|e| anyhow!("build: {e:?}"))?;
    let pczt = Creator::build_from_parts(res.pczt_parts).ok_or_else(|| anyhow!("unsupported tx version"))?;
    let pczt = IoFinalizer::new(pczt).finalize_io(rand::rng()).map_err(|e| anyhow!("io finalize: {e:?}"))?;
    let pczt = if note.is_some() { chain::sign_own(pczt, sk)? } else { pczt };
    let mut s = Signer::new(pczt).map_err(|e| anyhow!("signer: {e:?}"))?;
    for i in 0..plan.utxos.len() {
        s.sign_transparent(i, &tsk.0).map_err(|e| anyhow!("transparent sign {i}: {e:?}"))?;
    }
    let (raw, txid) = chain::prove_and_extract(s.finish())?;
    // the extracted transaction pays exactly what the plan says
    let tx = chain::parse_tx(&raw, plan.target_height)?;
    let tb = tx.transparent_bundle();
    ensure!(tb.map_or(0, |b| b.vout.len()) == t_outs.len() && tb.map_or(0, |b| b.vin.len()) == plan.utxos.len(), "transparent shape changed");
    if let Some(tb) = tb {
        for (o, (h, v)) in tb.vout.iter().zip(&t_outs) {
            ensure!(o.recipient_address() == Some(TransparentAddress::PublicKeyHash(*h)) && u64::from(o.value()) == *v, "transparent output order or value changed");
        }
    }
    Ok(BuiltTx { raw: hex::encode(raw), txid, fee, change })
}

struct FixedFee(Zatoshis);
impl zcash_primitives::transaction::fees::FeeRule for FixedFee {
    type Error = std::convert::Infallible;
    fn fee_required<P: zcash_protocol::consensus::Parameters>(
        &self, _: &P, _: BlockHeight,
        _: impl IntoIterator<Item = zcash_primitives::transaction::fees::transparent::InputSize>,
        _: impl IntoIterator<Item = usize>, _: usize, _: usize, _: usize, _: usize,
    ) -> Result<Zatoshis, Self::Error> { Ok(self.0) }
}

fn zat(v: u64) -> Result<Zatoshis> { Zatoshis::from_u64(v).map_err(|_| anyhow!("invalid amount {v}")) }

/// Root of an Ironwood tree in lightwalletd's legacy `CommitmentTree` hex.
pub fn tree_root(tree_hex: &str) -> Result<[u8; 32]> {
    let t: CommitmentTree<MerkleHashOrchard, 32> = if tree_hex.is_empty() { CommitmentTree::empty() } else {
        zcash_primitives::merkle_tree::read_commitment_tree(&hex::decode(tree_hex).context("tree hex")?[..]).context("read tree")?
    };
    Ok(Anchor::from(t.root()).to_bytes())
}

/// Chooses what to spend for a payment of `need` zats (outputs + fee are
/// recomputed by `plan_balance`): every coin, plus the smallest single
/// Ironwood note that makes up the rest (spending one note keeps one anchor).
/// Fails with what is missing when the wallet cannot cover it.
pub fn select(notes: &[NoteRecord], utxos: &[Utxo], outputs: &[PayOut]) -> Result<(Option<NoteRecord>, Vec<Utxo>)> {
    let out: u64 = outputs.iter().map(|o| o.value).sum();
    let (ir, t) = split_outputs(outputs)?;
    let coins: u64 = utxos.iter().map(|u| u.value).sum();
    // coins alone (change as an Ironwood output)
    if !utxos.is_empty() && coins >= out + plan_fee(0, utxos.len(), ir.len() + 1, t.len()) {
        return Ok((None, utxos.to_vec()));
    }
    // notes alone (smallest note that covers it), then note + all coins
    let mut ns: Vec<&NoteRecord> = notes.iter().filter(|n| n.height > 0).collect();
    ns.sort_by_key(|n| n.value);
    if let Some(n) = ns.iter().find(|n| n.value >= out + plan_fee(1, 0, ir.len() + 1, t.len())) { return Ok((Some((*n).clone()), vec![])); }
    if let Some(n) = ns.iter().find(|n| n.value + coins >= out + plan_fee(1, utxos.len(), ir.len() + 1, t.len())) { return Ok((Some((*n).clone()), utxos.to_vec())); }
    let best = ns.last().map_or(0, |n| n.value) + coins;
    bail!("the pay-in wallet holds {best} usable zats; {} more are needed (outputs {out} + fee)",
        (out + plan_fee(ns.last().is_some() as usize, utxos.len(), ir.len() + 1, t.len())).saturating_sub(best))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip321_round_trip_and_amounts() {
        assert_eq!(zec_decimal(2_075_000), "0.02075");
        assert_eq!(zec_decimal(100_000_000), "1");
        assert_eq!(zec_decimal(1), "0.00000001");
        assert_eq!(parse_zec("0.02075").unwrap(), 2_075_000);
        assert_eq!(parse_zec("1").unwrap(), 100_000_000);
        assert!(parse_zec("0.000000001").is_err());
        assert!(parse_zec("1e3").is_err());
        let u = zip321_uri("utest1abc", 2_075_000, Some("Lintel escrow #1"));
        assert_eq!(u, "zcash:utest1abc?amount=0.02075&message=Lintel%20escrow%20%231");
        assert_eq!(parse_zip321(&u).unwrap(), ("utest1abc".into(), 2_075_000));
        assert!(parse_zip321("zcash:x?address.1=y&amount=1").is_err());
    }

    #[test]
    fn payment_ua_carries_both_receivers() {
        let sk = loop { if let Some(k) = Option::<SpendingKey>::from(SpendingKey::from_bytes(rand::random())) { break k; } };
        let a = FullViewingKey::from(&sk).address_at(0u32, Scope::External);
        let tk = TransparentKey::random();
        let ua = payment_ua(&a, &tk.pubkey_hash());
        assert!(ua.starts_with("utest1"));
        let r = receivers(&ua).unwrap();
        assert_eq!(r.orchard, Some(a.to_raw_address_bytes()));
        assert_eq!(r.p2pkh, Some(tk.pubkey_hash()));
        // the escrow code reads the Orchard receiver from it
        assert_eq!(chain::decode_ua(&ua).unwrap().to_raw_address_bytes(), a.to_raw_address_bytes());
        assert_eq!(receivers(&tk.address()).unwrap(), Receivers { orchard: None, p2pkh: Some(tk.pubkey_hash()) });
    }
}
