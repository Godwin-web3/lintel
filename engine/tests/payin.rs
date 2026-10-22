//! "Pay from another wallet", offline, on real v6 transactions.
//!
//! An external wallet pays a ZIP 321 request to a per-purchase pay-in wallet,
//! either to its transparent (P2PKH) receiver or to its Orchard-protocol
//! receiver (an Ironwood note). The app detects the payment from public data,
//! funds the escrow from it (escrow note + the refund's lock coin at vout 0),
//! the time-locked refund is co-signed BEFORE the funding would be broadcast,
//! the adaptor-signed settlement completes and reveals `t`, and whatever the
//! pay-in wallet holds afterwards (refund, lock coin) can be swept out.
//! Every transaction is proven and fully verified by the PCZT extractor.
#![cfg(feature = "chain")]

use ff::{Field, PrimeField};
use incrementalmerkletree::frontier::CommitmentTree;
use lintel::chain::{self, JointKeyInfo, NoteRecord, RefundLock, SpendTerms, TransparentKey};
use lintel::payin::{self, AnchorData, CompactAct, PayOut, PayinPlan, Utxo};
use lintel::protocol::{self, parse_scalar, Buyer as Merchant, Seller as Payer};
use lintel::sealed;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use orchard::note::{RandomSeed, Rho};
use orchard::tree::MerkleHashOrchard;
use orchard::value::NoteValue;
use orchard::{Note, NoteVersion};
use rand::RngExt;

const TARGET: u32 = 4_600_000;

fn wallet(seed: u8) -> (SpendingKey, FullViewingKey, String) {
    let sk = SpendingKey::from_bytes([seed; 32]).unwrap();
    let fvk = FullViewingKey::from(&sk);
    let ua = chain::encode_ua(&fvk.address_at(0u32, Scope::External));
    (sk, fvk, ua)
}
fn random_note(fvk: &FullViewingKey, value: u64) -> Note {
    let mut rng = rand::rng();
    loop {
        let Some(rho) = Option::from(Rho::from_bytes(&pasta_curves::pallas::Base::random(&mut rng).to_repr())) else { continue };
        let Some(rseed) = Option::from(RandomSeed::from_bytes(rng.random(), &rho)) else { continue };
        if let Some(n) = Option::from(Note::from_parts(fvk.address_at(0u32, Scope::External), NoteValue::from_raw(value), rho, rseed, NoteVersion::V3)) { return n; }
    }
}
fn cmx(n: &Note) -> [u8; 32] { orchard::note::ExtractedNoteCommitment::from(n.commitment()).to_bytes() }
fn record(n: &Note, height: u32) -> NoteRecord {
    NoteRecord { txid: "11".repeat(32), height, action_index: 0, cmx: hex::encode(cmx(n)),
        recipient: hex::encode(n.recipient().to_raw_address_bytes()), value: n.value().inner(),
        rho: hex::encode(n.rho().to_bytes()), rseed: hex::encode(n.rseed().as_bytes()) }
}
fn tree_hex(leaves: &[[u8; 32]]) -> String {
    if leaves.is_empty() { return String::new(); }
    let mut t: CommitmentTree<MerkleHashOrchard, 32> = CommitmentTree::empty();
    for l in leaves { t.append(MerkleHashOrchard::from_bytes(l).unwrap()).unwrap(); }
    let mut out = Vec::new();
    zcash_primitives::merkle_tree::write_commitment_tree(&t, &mut out).unwrap();
    hex::encode(out)
}
fn tx_cmxs(raw: &[u8]) -> Vec<[u8; 32]> {
    chain::parse_tx(raw, TARGET).unwrap().ironwood_bundle().map_or(vec![], |b| b.actions().iter().map(|a| a.cmx().to_bytes()).collect())
}
/// Anchor data for spending a note mined in a block made of `block` on top of `before`.
fn anchor_for(before: &[[u8; 32]], block: &[[u8; 32]]) -> AnchorData {
    AnchorData { prev_tree: tree_hex(before), block_cmxs: block.iter().map(hex::encode).collect(), at_tree: tree_hex(&[before, block].concat()) }
}
fn tip_anchor(all: &[[u8; 32]]) -> AnchorData { AnchorData { at_tree: tree_hex(all), ..Default::default() } }
/// Compact actions of a raw tx, as lightwalletd serves them.
fn compact(raw: &[u8]) -> Vec<CompactAct> {
    let tx = chain::parse_tx(raw, TARGET).unwrap();
    tx.ironwood_bundle().unwrap().actions().iter().map(|a| {
        let enc = a.encrypted_note();
        CompactAct { nf: hex::encode(a.nullifier().to_bytes()), cmx: hex::encode(a.cmx().to_bytes()),
            epk: hex::encode(enc.epk_bytes), ct: hex::encode(&enc.enc_ciphertext.as_ref()[..52]) }
    }).collect()
}

/// The two-party escrow for one sale.
struct Sale { payer: Payer, merchant: Merchant, joint: orchard::keys::FullViewingKey, escrow_ua: String, offer: sealed::SealedOffer, t: pasta_curves::pallas::Scalar, payload: Vec<u8> }
fn sale(session: &[u8]) -> Sale {
    let payload = b"sealed finding paid from another wallet".to_vec();
    let keys = sealed::prove::setup::<{ sealed::CHUNKS }>().unwrap();
    let (t, t_base) = sealed::new_secret();
    let mut merchant = Merchant::with_secret(t);
    let mut payer = Payer::new();
    let offer = sealed::seal::<{ sealed::CHUNKS }>(&keys, t_base, &payload).unwrap();
    let (ak, neg) = protocol::joint_ak(payer.vk_a, merchant.vk_b).unwrap();
    if neg { payer.negate_share(); merchant.negate_share(); }
    let (nk, rivk) = chain::derive_nk_rivk(session, &[5u8; 32], &[6u8; 32]);
    let joint = JointKeyInfo::new(&ak, nk, rivk).fvk().unwrap();
    let escrow_ua = chain::encode_ua(&chain::joint_address(&joint));
    Sale { payer, merchant, joint, escrow_ua, offer, t, payload }
}

const PRICE: u64 = 2_000_000;
const ESCROW: u64 = PRICE + 20_000; // escrowFor(price) in the app
const LOCK: u32 = TARGET + 60;

#[test]
fn transparent_payment_funds_escrow_refund_presigned_settles_and_sweeps() {
    // ---- the pay-in wallet (device-local keys) and its payment request
    let (pin_sk, pin_fvk, pin_ua) = wallet(44);
    let pin_t = TransparentKey::from_bytes([9u8; 32]).unwrap();
    let taddr = pin_t.address();
    let request_ua = payin::payment_ua(&pin_fvk.address_at(0u32, Scope::External), &pin_t.pubkey_hash());
    let need = payin::payin_amount(ESCROW);
    assert_eq!(need, ESCROW + 20_000 + 15_000);
    let uri = payin::zip321_uri(&request_ua, need, Some("Lintel escrow"));

    // ---- an external wallet reads the URI and pays the P2PKH receiver (a
    // transparent-only wallet would). It is a separate key, unknown to the app.
    let (ext_sk, ext_fvk, ext_ua) = wallet(33);
    let ext_note = random_note(&ext_fvk, 5_000_000);
    let (addr, amount) = payin::parse_zip321(&uri).unwrap();
    assert_eq!(amount, need);
    let recv = payin::receivers(&addr).unwrap();
    let pay_to_t = chain::encode_taddr(&recv.p2pkh.unwrap());
    assert_eq!(pay_to_t, taddr);
    let older: Vec<[u8; 32]> = (0..4).map(|_| cmx(&random_note(&ext_fvk, 1))).collect();
    let pay = payin::build(&ext_sk, &TransparentKey::random(), &PayinPlan {
        note: Some(record(&ext_note, TARGET - 10)), utxos: vec![],
        outputs: vec![PayOut { to: pay_to_t.clone(), value: amount }], change_to: Some(ext_ua.clone()),
        target_height: TARGET - 5, expiry_height: TARGET + 20,
    }, &anchor_for(&older, &[cmx(&ext_note)])).unwrap();
    let pay_raw = hex::decode(&pay.raw).unwrap();
    assert_eq!(pay.fee, 15_000); // 1 spend, 1 change (2 actions) + 1 transparent output
    let chain_after_pay: Vec<[u8; 32]> = [older.clone(), vec![cmx(&ext_note)], tx_cmxs(&pay_raw)].concat();

    // ---- detection: the coin as read from the raw transaction, not a server's word
    let found = payin::utxos_in_tx(&pay_raw, TARGET - 5, &taddr).unwrap();
    assert_eq!(found.len(), 1);
    let utxo = payin::utxo_from_tx(&pay_raw, TARGET - 5, &pay.txid, found[0].vout, &taddr).unwrap();
    assert_eq!(utxo, found[0]);
    assert_eq!(utxo.value, need);
    assert!(payin::utxo_from_tx(&pay_raw, TARGET - 5, &pay.txid, found[0].vout, &TransparentKey::random().address()).is_err(), "wrong owner");
    assert!(payin::utxo_from_tx(&pay_raw, TARGET - 5, &"00".repeat(32), found[0].vout, &taddr).is_err(), "bytes must match the txid");
    // no shielded note for the pay-in wallet in this payment
    assert!(payin::scan_compact(&pin_fvk, &compact(&pay_raw)).unwrap().is_empty());

    // ---- funding straight from the coin: escrow note + lock coin at vout 0, no sweep tx
    let mut s = sale(b"payin-t");
    let outputs = vec![PayOut { to: s.escrow_ua.clone(), value: ESCROW }, PayOut { to: taddr.clone(), value: chain::LOCK_UTXO_VALUE }];
    let (note_sel, coins) = payin::select(&[], &[utxo.clone()], &outputs).unwrap();
    assert!(note_sel.is_none() && coins.len() == 1);
    let fund_plan = PayinPlan { note: None, utxos: coins, outputs, change_to: Some(pin_ua.clone()), target_height: TARGET, expiry_height: TARGET + 40 };
    assert_eq!(payin::plan_balance(&fund_plan).unwrap(), (need, 15_000, 0), "paid exactly: no change");
    let fund = payin::build(&pin_sk, &pin_t, &fund_plan, &tip_anchor(&chain_after_pay)).unwrap();
    let fund_raw = hex::decode(&fund.raw).unwrap();
    let ftx = chain::parse_tx(&fund_raw, TARGET).unwrap();
    let tb = ftx.transparent_bundle().unwrap();
    assert_eq!(tb.vin.len(), 1);
    assert_eq!(tb.vout.len(), 1);
    assert_eq!(u64::from(tb.vout[0].value()), chain::LOCK_UTXO_VALUE);
    assert_eq!(payin::utxo_from_tx(&fund_raw, TARGET, &fund.txid, 0, &taddr).unwrap().value, chain::LOCK_UTXO_VALUE, "lock coin at vout 0");
    let esc = chain::find_notes(&fund_raw, TARGET, &s.joint).unwrap();
    assert_eq!(esc.len(), 1);
    let escrow = esc[0].note;
    assert_eq!(escrow.value().inner(), ESCROW);
    assert!(chain::find_notes(&fund_raw, TARGET, &pin_fvk).unwrap().is_empty(), "exact payment: no change note");

    // ---- refund co-signed BEFORE funding is broadcast; refund + lock coin return to the pay-in wallet
    let refund_terms = SpendTerms { kind: "refund".into(), pay_to: pin_ua.clone(), amount: chain::refund_payout(ESCROW), change_to: None,
        target_height: TARGET, expiry_height: 0, t_out: None,
        lock: Some(RefundLock { txid: fund.txid.clone(), vout: 0, value: chain::LOCK_UTXO_VALUE, address: taddr.clone(), lock_height: LOCK }) };
    chain::check_refund_window(&refund_terms, LOCK).unwrap();
    let refund = chain::build_spend(&s.joint, &escrow, &refund_terms).unwrap();
    let ri = chain::check_spend(&refund, &s.joint, &escrow, &refund_terms).unwrap(); // both parties run this
    let (rsh, ral) = (hex::decode(&ri.sighash).unwrap(), parse_scalar(&ri.alpha).unwrap());
    let r_a = s.payer.new_nonce();
    let rpart = s.merchant.refund_partial(r_a, s.payer.vk_a, ral, &rsh);
    let mpok = s.merchant.prove_knowledge(s.payer.vk_a, b"payin-t");
    let rpre = s.payer.pre_sign(s.merchant.vk_b, &rpart, &rsh, b"payin-t", &mpok, ral).unwrap();
    let rsig = s.payer.complete_refund(&rpre, &rpart).unwrap();
    let refund = chain::apply_signature(refund, ri.action_index, rsig).unwrap();
    let refund = chain::sign_lock_input(refund, &pin_t).unwrap();

    // ---- funding mined in the next block: settlement (adaptor-signed), t from the raw tx
    let block = tx_cmxs(&fund_raw);
    let (anchor, path) = chain::witness(&tree_hex(&chain_after_pay), &block, &esc[0].cmx).unwrap();
    let (_m_sk, m_fvk, m_ua) = wallet(55);
    let terms = SpendTerms { kind: "settle".into(), pay_to: m_ua, amount: PRICE, change_to: Some(pin_ua.clone()),
        target_height: TARGET + 2, expiry_height: LOCK, lock: None, t_out: None };
    let settle = chain::build_spend(&s.joint, &escrow, &terms).unwrap();
    let si = chain::check_spend(&settle, &s.joint, &escrow, &terms).unwrap();
    let (sh, al) = (hex::decode(&si.sighash).unwrap(), parse_scalar(&si.alpha).unwrap());
    let r_a = s.payer.new_nonce();
    let part = s.merchant.partial(r_a, s.payer.vk_a, al, &sh);
    let mpok = s.merchant.prove_knowledge(s.payer.vk_a, b"payin-t");
    let pre = s.payer.pre_sign(s.merchant.vk_b, &part, &sh, b"payin-t", &mpok, al).unwrap();
    let sig = s.merchant.complete(&pre, &part).unwrap();
    let settle = chain::install_witness(chain::apply_signature(settle, si.action_index, sig).unwrap(), si.action_index, anchor, path.clone()).unwrap();
    let (sraw, stxid) = chain::prove_and_extract(settle).unwrap();
    assert_eq!(stxid, si.txid);
    assert_eq!(chain::find_notes(&sraw, TARGET, &m_fvk).unwrap()[0].note.value().inner(), PRICE);
    let on_chain = protocol::find_signature(&sraw, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex).unwrap();
    let t_rec = protocol::extract_t(parse_scalar(&hex::encode(&on_chain[32..])).unwrap(), parse_scalar(&pre.s_a_hex).unwrap(), part.s_b);
    assert_eq!(t_rec, s.t);
    assert_eq!(sealed::open(t_rec, &s.offer).unwrap(), s.payload);
    // settlement change (escrow - price - fee) lands in the pay-in wallet
    assert_eq!(chain::find_notes(&sraw, TARGET, &pin_fvk).unwrap()[0].note.value().inner(), ESCROW - PRICE - 10_000);

    // ---- the other branch: the refund is a valid tx too (time-locked), paying the pay-in wallet
    let refund = chain::install_witness(refund, ri.action_index, anchor, path).unwrap();
    let (rraw, rtxid) = chain::prove_and_extract(refund).unwrap();
    assert_eq!(rtxid, ri.txid);
    let rtx = chain::parse_tx(&rraw, TARGET).unwrap();
    assert!(!chain::is_final(&rtx, LOCK) && chain::is_final(&rtx, LOCK + 1));
    let rnote = &chain::find_notes(&rraw, TARGET, &pin_fvk).unwrap()[0];
    assert_eq!(rnote.note.value().inner(), chain::refund_payout(ESCROW));
    let lock_back = payin::utxo_from_tx(&rraw, TARGET, &rtxid, 0, &taddr).unwrap();
    assert_eq!(lock_back.value, chain::LOCK_UTXO_VALUE);

    // ---- recovery: sweep everything the pay-in wallet holds (refund note + lock coin) to the buyer's own wallet
    let before_refund: Vec<[u8; 32]> = [chain_after_pay.clone(), block.clone()].concat();
    let rcmxs = tx_cmxs(&rraw);
    let mut rrec = NoteRecord::from_found(rnote, &rtxid, LOCK + 1);
    rrec.height = LOCK + 1;
    let total = rrec.value + lock_back.value;
    let fee = payin::plan_fee(1, 1, 1, 0);
    assert_eq!(fee, 15_000);
    let sweep_plan = PayinPlan { note: Some(rrec), utxos: vec![lock_back], outputs: vec![PayOut { to: ext_ua.clone(), value: total - fee }],
        change_to: None, target_height: LOCK + 2, expiry_height: LOCK + 40 };
    let sw = payin::build(&pin_sk, &pin_t, &sweep_plan, &anchor_for(&before_refund, &rcmxs)).unwrap();
    let got = chain::find_notes(&hex::decode(&sw.raw).unwrap(), TARGET, &ext_fvk).unwrap();
    assert_eq!(got.iter().map(|n| n.note.value().inner()).sum::<u64>(), total - fee);
    // a sweep that does not take everything (and has no change address) is refused
    let mut short = sweep_plan.clone(); short.outputs[0].value -= 1;
    assert!(payin::plan_balance(&short).is_err());
}

#[test]
fn shielded_payment_is_found_by_compact_scan_and_funds_escrow() {
    let (pin_sk, pin_fvk, pin_ua) = wallet(66);
    let pin_t = TransparentKey::from_bytes([8u8; 32]).unwrap();
    let request_ua = payin::payment_ua(&pin_fvk.address_at(0u32, Scope::External), &pin_t.pubkey_hash());
    let need = payin::payin_amount(ESCROW);

    // an NU6.3 wallet pays the Orchard-protocol receiver: an Ironwood note
    let (ext_sk, ext_fvk, ext_ua) = wallet(77);
    let ext_note = random_note(&ext_fvk, 3_000_000);
    let older: Vec<[u8; 32]> = (0..3).map(|_| cmx(&random_note(&ext_fvk, 1))).collect();
    let (addr, amount) = payin::parse_zip321(&payin::zip321_uri(&request_ua, need, None)).unwrap();
    let orchard_recv = orchard::Address::from_raw_address_bytes(&payin::receivers(&addr).unwrap().orchard.unwrap()).unwrap();
    let pay = payin::build(&ext_sk, &TransparentKey::random(), &PayinPlan {
        note: Some(record(&ext_note, TARGET - 10)), utxos: vec![],
        outputs: vec![PayOut { to: chain::encode_ua(&orchard_recv), value: amount }], change_to: Some(ext_ua),
        target_height: TARGET - 5, expiry_height: TARGET + 20,
    }, &anchor_for(&older, &[cmx(&ext_note)])).unwrap();
    assert_eq!(pay.fee, 10_000);
    let pay_raw = hex::decode(&pay.raw).unwrap();
    assert!(chain::parse_tx(&pay_raw, TARGET).unwrap().transparent_bundle().is_none(), "fully shielded payment");

    // detection: compact trial decryption hits exactly the pay-in output; the full tx gives the note
    let acts = compact(&pay_raw);
    let hits = payin::scan_compact(&pin_fvk, &acts).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(payin::scan_compact(&wallet(99).1, &acts).unwrap().is_empty(), "other keys see nothing");
    let found = chain::find_notes(&pay_raw, TARGET - 5, &pin_fvk).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].action_index, hits[0]);
    let pay_block = tx_cmxs(&pay_raw);
    let before: Vec<[u8; 32]> = [older.clone(), vec![cmx(&ext_note)]].concat();
    let rec = NoteRecord::from_found(&found[0], &pay.txid, TARGET - 5);
    assert_eq!(rec.value, need);
    assert!(payin::utxos_in_tx(&pay_raw, TARGET - 5, &pin_t.address()).unwrap().is_empty());

    // funding from the note: same 15,000-zat fee, no change when paid exactly
    let s = sale(b"payin-z");
    let outputs = vec![PayOut { to: s.escrow_ua.clone(), value: ESCROW }, PayOut { to: pin_t.address(), value: chain::LOCK_UTXO_VALUE }];
    let (n, coins) = payin::select(&[rec.clone()], &[], &outputs).unwrap();
    assert_eq!(n.as_ref(), Some(&rec));
    assert!(coins.is_empty());
    let plan = PayinPlan { note: n, utxos: coins, outputs, change_to: Some(pin_ua), target_height: TARGET, expiry_height: TARGET + 40 };
    assert_eq!(payin::plan_balance(&plan).unwrap(), (need, 15_000, 0));
    // a wrong witness source is refused before proving
    let mut bad = anchor_for(&before, &pay_block); bad.at_tree = tree_hex(&older);
    assert!(payin::build(&pin_sk, &pin_t, &plan, &bad).is_err());
    let fund = payin::build(&pin_sk, &pin_t, &plan, &anchor_for(&before, &pay_block)).unwrap();
    let fund_raw = hex::decode(&fund.raw).unwrap();
    assert_eq!(chain::find_notes(&fund_raw, TARGET, &s.joint).unwrap()[0].note.value().inner(), ESCROW);
    assert_eq!(payin::utxo_from_tx(&fund_raw, TARGET, &fund.txid, 0, &pin_t.address()).unwrap().value, chain::LOCK_UTXO_VALUE);
}

#[test]
fn split_and_short_payments() {
    let (_, pin_fvk, pin_ua) = wallet(12);
    let t = TransparentKey::from_bytes([3u8; 32]).unwrap();
    let outs = vec![PayOut { to: pin_ua.clone(), value: ESCROW }, PayOut { to: t.address(), value: chain::LOCK_UTXO_VALUE }];
    let need = payin::payin_amount(ESCROW);
    let coin = |v: u64, i: u32| Utxo { txid: format!("{:064x}", i), vout: 0, value: v, height: TARGET, address: t.address() };
    // two transparent payments that add up: both coins; fee grows with the second input
    let (n, c) = payin::select(&[], &[coin(need / 2, 1), coin(need / 2 + 5_000, 2)], &outs).unwrap();
    assert!(n.is_none() && c.len() == 2);
    let plan = PayinPlan { note: None, utxos: c, outputs: outs.clone(), change_to: Some(pin_ua.clone()), target_height: TARGET, expiry_height: TARGET + 40 };
    assert_eq!(payin::plan_balance(&plan).unwrap().1, 20_000);
    // short: says how much is missing
    let e = payin::select(&[], &[coin(need - 1, 1)], &outs).unwrap_err().to_string();
    assert!(e.contains("more are needed"), "{e}");
    // a note + a coin together
    let rec = record(&random_note(&pin_fvk, need / 2), TARGET);
    let (n, c) = payin::select(&[rec.clone()], &[coin(need / 2 + 10_000, 3)], &outs).unwrap();
    assert_eq!(n, Some(rec));
    assert_eq!(c.len(), 1);
    // overpaid with no change address is refused (never burn the excess as fee)
    let plan = PayinPlan { note: None, utxos: vec![coin(need + 1, 4)], outputs: outs, change_to: None, target_height: TARGET, expiry_height: TARGET + 40 };
    assert!(payin::plan_balance(&plan).is_err());
}
