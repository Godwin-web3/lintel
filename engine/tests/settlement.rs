//! End-to-end settlement on real Zcash v6 transactions, offline.
//!
//! Funding tx (payer wallet -> joint escrow address), a pre-signed refund,
//! the adaptor-signed settlement, proving, full consensus-style verification
//! by the PCZT extractor, and `t` recovered from the serialized settlement
//! transaction to decrypt the sealed goods. Only the network is missing:
//! `lintel-chain` does the same steps against lightwalletd.
#![cfg(feature = "chain")]

use ff::{Field, PrimeField};
use group::GroupEncoding;
use lintel::chain::{self, JointKeyInfo, RefundLock, SpendTerms, TransparentKey, TransparentOut};
use lintel::protocol::{self, parse_scalar, Buyer as Merchant, Seller as Payer};
use lintel::sealed;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use orchard::note::{RandomSeed, Rho};
use orchard::tree::MerkleHashOrchard;
use orchard::value::NoteValue;
use orchard::{Note, NoteVersion};
use incrementalmerkletree::frontier::CommitmentTree;
use rand::RngExt;
use zcash_primitives::transaction::sighash::SignableInput;
use zcash_primitives::transaction::sighash_v6::v6_signature_hash;
use zcash_primitives::transaction::txid::TxIdDigester;
use zcash_primitives::transaction::TransactionData;

const TARGET: u32 = 4_600_000; // NU7 on testnet (branch 0x77190ad9)

fn wallet(seed: u8) -> (SpendingKey, FullViewingKey, String) {
    let sk = SpendingKey::from_bytes([seed; 32]).unwrap();
    let fvk = FullViewingKey::from(&sk);
    let ua = chain::encode_ua(&fvk.address_at(0u32, Scope::External));
    (sk, fvk, ua)
}

fn random_note(fvk: &FullViewingKey, value: u64) -> Note {
    let mut rng = rand::rng();
    loop {
        let rho = Option::from(Rho::from_bytes(&pasta_curves::pallas::Base::random(&mut rng).to_repr()));
        let Some(rho) = rho else { continue };
        let rseed: [u8; 32] = rng.random();
        let Some(rseed) = Option::from(RandomSeed::from_bytes(rseed, &rho)) else { continue };
        let addr = fvk.address_at(0u32, Scope::External);
        if let Some(n) = Option::from(Note::from_parts(addr, NoteValue::from_raw(value), rho, rseed, NoteVersion::V3)) {
            return n;
        }
    }
}

fn cmx(n: &Note) -> [u8; 32] { orchard::note::ExtractedNoteCommitment::from(n.commitment()).to_bytes() }

/// Ironwood note commitments of a raw transaction, in order.
fn tx_cmxs(raw: &[u8]) -> Vec<[u8; 32]> {
    let tx = chain::parse_tx(raw, TARGET).unwrap();
    tx.ironwood_bundle().unwrap().actions().iter().map(|a| a.cmx().to_bytes()).collect()
}

fn tree_hex(leaves: &[[u8; 32]]) -> String {
    let mut t: CommitmentTree<MerkleHashOrchard, 32> = CommitmentTree::empty();
    for l in leaves { t.append(MerkleHashOrchard::from_bytes(l).unwrap()).unwrap(); }
    let mut out = Vec::new();
    zcash_primitives::merkle_tree::write_commitment_tree(&t, &mut out).unwrap();
    hex::encode(out)
}

/// Shielded sighash of the PCZT's transaction with its lock time replaced and
/// (optionally) its transparent bundle dropped: what the joint signature
/// would have to cover if the payer stripped the lock.
fn sighash_with(p: &pczt::Pczt, lock_time: u32, keep_transparent: bool) -> String {
    let mut t = None;
    let e = p.clone().into_effects().unwrap()
        .map_bundles::<pczt::EffectsOnly>(|tb| { t = tb; None }, |s| s, |o| o);
    let d: TransactionData<pczt::EffectsOnly> = TransactionData::from_parts_v6(
        e.consensus_branch_id(), lock_time, e.expiry_height(),
        if keep_transparent { t } else { None },
        None, e.orchard_bundle().cloned(), e.ironwood_bundle().cloned(),
    );
    let parts = d.digest(TxIdDigester);
    hex::encode(v6_signature_hash(&d, &SignableInput::Shielded, &parts).as_ref())
}

#[test]
fn testnet_v6_settlement_and_refund_end_to_end() {
    // ---- parties and the sealed goods
    let payload = b"PoC: reentrancy in Vault.withdraw() lets anyone drain";
    let keys = sealed::prove::setup::<{ sealed::CHUNKS }>().unwrap();
    let (t, t_base) = sealed::new_secret();
    let mut merchant = Merchant::with_secret(t);
    let mut payer = Payer::new();
    let offer = sealed::seal::<{ sealed::CHUNKS }>(&keys, t_base, payload).unwrap();
    let h = sealed::content_hash_bytes::<{ sealed::CHUNKS }>(payload).unwrap();
    assert!(sealed::verify_offer(&keys, &offer, &merchant.t_point(), h));

    // ---- joint key = escrow note's ak
    let (ak, neg) = protocol::joint_ak(payer.vk_a, merchant.vk_b).unwrap();
    if neg { payer.negate_share(); merchant.negate_share(); }
    assert_eq!(ak, payer.vk_a + merchant.vk_b);
    let session = b"listing-7";
    let (nk, rivk) = chain::derive_nk_rivk(session, &[1u8; 32], &[2u8; 32]);
    let info = JointKeyInfo::new(&ak, nk, rivk);
    let joint = info.fvk().unwrap();
    let escrow_ua = chain::encode_ua(&chain::joint_address(&joint));
    assert!(escrow_ua.starts_with("utest1"));
    assert!(chain::encode_ufvk(&joint).starts_with("uviewtest"));
    // the FVK's ak is exactly the two-party key
    assert_eq!(&joint.to_bytes()[..32], ak.to_bytes().as_slice());

    let (payer_sk, payer_fvk, payer_ua) = wallet(11);
    let (_m_sk, merchant_fvk, merchant_ua) = wallet(22);
    let payer_tkey = TransparentKey::from_bytes([7u8; 32]).unwrap();
    let payer_taddr = payer_tkey.address();
    assert!(payer_taddr.starts_with("tm"));
    assert_eq!(chain::decode_taddr(&payer_taddr).unwrap(), payer_tkey.pubkey_hash());
    // claim window: the settlement expires at SETTLE_EXPIRY; the refund is
    // locked until LOCK (first valid height LOCK + 1).
    const SETTLE_EXPIRY: u32 = TARGET + 100;
    const LOCK: u32 = SETTLE_EXPIRY;

    // ---- funding tx: payer's own note -> escrow (built, proven, NOT yet broadcast)
    let source = random_note(&payer_fvk, 2_000_000);
    let fund_terms = SpendTerms {
        kind: "fund".into(), pay_to: escrow_ua.clone(), amount: 1_000_000,
        change_to: Some(payer_ua.clone()), target_height: TARGET, expiry_height: TARGET + 40,
        lock: None,
        // the payer's lock UTXO for the refund, created by the funding tx itself
        t_out: Some(TransparentOut { address: payer_taddr.clone(), value: chain::LOCK_UTXO_VALUE }),
    };
    let fund = chain::build_spend(&payer_fvk, &source, &fund_terms).unwrap();
    let fund_idx = chain::spend_index(&fund, &payer_fvk, &source).unwrap();
    let fund = chain::sign_own(fund, &payer_sk).unwrap();
    let older: Vec<[u8; 32]> = (0..5).map(|_| cmx(&random_note(&merchant_fvk, 1))).collect();
    let prev_tree = tree_hex(&older);
    let (anchor0, path0) = chain::witness(&prev_tree, &[cmx(&source)], &cmx(&source)).unwrap();
    let fund = chain::install_witness(fund, fund_idx, anchor0, path0).unwrap();
    let (fund_raw, fund_txid) = chain::prove_and_extract(fund).unwrap();

    // escrow note as either party finds it with the joint key
    let found = chain::find_notes(&fund_raw, TARGET, &joint).unwrap();
    assert_eq!(found.len(), 1);
    let escrow = found[0].note;
    assert_eq!(escrow.value().inner(), 1_000_000);
    // ... and the payer's change is visible to the payer only
    assert_eq!(chain::find_notes(&fund_raw, TARGET, &payer_fvk).unwrap().len(), 1);
    assert!(chain::find_notes(&fund_raw, TARGET, &merchant_fvk).unwrap().is_empty());
    // ... and it pays the lock UTXO to the payer's t-address at vout 0
    let fund_tx = chain::parse_tx(&fund_raw, TARGET).unwrap();
    let fund_vout = &fund_tx.transparent_bundle().unwrap().vout;
    assert_eq!(fund_vout.len(), 1);
    assert_eq!(u64::from(fund_vout[0].value()), chain::LOCK_UTXO_VALUE);
    assert_eq!(chain::find_notes(&fund_raw, TARGET, &payer_fvk).unwrap()[0].note.value().inner(), 2_000_000 - 1_000_000 - 15_000 - chain::LOCK_UTXO_VALUE);

    // ---- refund, co-signed BEFORE the funding tx is broadcast (anchor deferred)
    // v1 (shielded-only) refund: no lock possible, valid at every height -> refused.
    let unlocked_terms = SpendTerms {
        kind: "refund".into(), pay_to: payer_ua.clone(), amount: chain::max_payout(escrow.value().inner()),
        change_to: None, target_height: TARGET, expiry_height: 0, lock: None, t_out: None,
    };
    let unlocked = chain::build_spend(&joint, &escrow, &unlocked_terms).unwrap();
    assert!(chain::is_final(&unlocked.clone().into_effects().unwrap(), TARGET), "the v1 refund is final immediately (the race)");
    assert!(chain::check_spend(&unlocked, &joint, &escrow, &unlocked_terms).is_err(), "unlocked refund refused");

    // v2: the refund also spends the payer's lock UTXO, sequence non-final, nLockTime = LOCK
    let refund_terms = SpendTerms {
        kind: "refund".into(), pay_to: payer_ua.clone(), amount: chain::refund_payout(escrow.value().inner()),
        change_to: None, target_height: TARGET, expiry_height: 0, t_out: None,
        lock: Some(RefundLock { txid: fund_txid.clone(), vout: 0, value: chain::LOCK_UTXO_VALUE, address: payer_taddr.clone(), lock_height: LOCK }),
    };
    // merchant: the lock must start after the claim window ends
    chain::check_refund_window(&refund_terms, SETTLE_EXPIRY).unwrap();
    let mut early = refund_terms.clone(); early.lock.as_mut().unwrap().lock_height = SETTLE_EXPIRY - 1;
    assert!(chain::check_refund_window(&early, SETTLE_EXPIRY).is_err());
    assert!(chain::check_refund_window(&unlocked_terms, SETTLE_EXPIRY).is_err());
    let refund = chain::build_spend(&joint, &escrow, &refund_terms).unwrap();
    // a PCZT that differs from the agreed lock is refused by the co-signer
    let mut other = refund_terms.clone(); other.lock.as_mut().unwrap().lock_height = LOCK - 50;
    assert!(chain::check_spend(&refund, &joint, &escrow, &other).is_err());
    let lowered = chain::build_spend(&joint, &escrow, &other).unwrap();
    assert!(chain::check_spend(&lowered, &joint, &escrow, &refund_terms).is_err());
    assert!(!chain::is_final(&refund.clone().into_effects().unwrap(), TARGET));
    let r_info_payer = chain::check_spend(&refund, &joint, &escrow, &refund_terms).unwrap();
    let r_info_merchant = chain::check_spend(&refund, &joint, &escrow, &refund_terms).unwrap();
    assert_eq!(r_info_payer.sighash, r_info_merchant.sighash);
    let r_sighash = hex::decode(&r_info_payer.sighash).unwrap();
    let r_alpha = parse_scalar(&r_info_payer.alpha).unwrap();
    let r_a = payer.new_nonce();
    let r_partial = merchant.refund_partial(r_a, payer.vk_a, r_alpha, &r_sighash);
    let pok_m = merchant.prove_knowledge(payer.vk_a, session);
    let r_pre = payer.pre_sign(merchant.vk_b, &r_partial, &r_sighash, session, &pok_m, r_alpha).unwrap();
    assert_eq!(r_pre.vk_hex, r_info_payer.rk, "protocol rk == PCZT rk");
    let r_sig = payer.complete_refund(&r_pre, &r_partial).unwrap();
    // the joint signature commits to the lock: stripping it changes the message
    assert_eq!(sighash_with(&refund, LOCK, true), r_info_payer.sighash);
    assert_ne!(sighash_with(&refund, 0, true), r_info_payer.sighash, "lock time is signed");
    assert_ne!(sighash_with(&refund, 0, false), r_info_payer.sighash, "lock input is signed");
    let refund = chain::apply_signature(refund, r_info_payer.action_index, r_sig).unwrap();
    // the payer signs its own lock input (any time before broadcast)
    let refund = chain::sign_lock_input(refund, &payer_tkey).unwrap();
    // the payer now holds a fully signed refund; it needs only a witness to broadcast.

    // ---- funding "mined": block = [funding tx's commitments]
    let block = tx_cmxs(&fund_raw);
    let prev_tree2 = tree_hex(&[older.clone(), vec![cmx(&source)]].concat());
    let (anchor, path) = chain::witness(&prev_tree2, &block, &found[0].cmx).unwrap();

    // ---- settlement: price to merchant, change to payer, claim expiry
    let terms = SpendTerms {
        kind: "settle".into(), pay_to: merchant_ua.clone(), amount: 600_000,
        change_to: Some(payer_ua.clone()), target_height: TARGET, expiry_height: SETTLE_EXPIRY,
        lock: None, t_out: None,
    };
    let settle = chain::build_spend(&joint, &escrow, &terms).unwrap(); // merchant builds
    let bytes = chain::pczt_to_bytes(settle).unwrap(); // ... and sends the PCZT to the payer
    let settle = chain::pczt_from_bytes(&bytes).unwrap();
    let info_p = chain::check_spend(&settle, &joint, &escrow, &terms).unwrap();
    let info_m = chain::check_spend(&settle, &joint, &escrow, &terms).unwrap();
    assert_eq!((info_p.sighash.clone(), info_p.alpha.clone(), info_p.txid.clone()), (info_m.sighash, info_m.alpha, info_m.txid));
    // wrong terms are refused
    let mut bad = terms.clone(); bad.amount = 700_000;
    assert!(chain::check_spend(&settle, &joint, &escrow, &bad).is_err());
    let mut bad = terms.clone(); bad.pay_to = payer_ua.clone();
    assert!(chain::check_spend(&settle, &joint, &escrow, &bad).is_err());

    let sighash = hex::decode(&info_p.sighash).unwrap();
    let alpha = parse_scalar(&info_p.alpha).unwrap();
    let r_a = payer.new_nonce();
    let partial = merchant.partial(r_a, payer.vk_a, alpha, &sighash);
    let pok_m = merchant.prove_knowledge(payer.vk_a, session);
    let pre = payer.pre_sign(merchant.vk_b, &partial, &sighash, session, &pok_m, alpha).unwrap();
    assert!(merchant.verify_presig(&pre, r_a, partial.r_b, payer.vk_a, alpha));
    assert_eq!(pre.vk_hex, info_p.rk);

    // the pre-signature alone does not authorize the spend
    let mut presig_only = [0u8; 64];
    presig_only[..32].copy_from_slice(&hex::decode(&pre.r_hex).unwrap());
    presig_only[32..].copy_from_slice(&(parse_scalar(&pre.s_a_hex).unwrap() + partial.s_b).to_repr());
    assert!(chain::apply_signature(chain::pczt_from_bytes(&bytes).unwrap(), info_p.action_index, presig_only).is_err());

    // merchant completes (reveals t), applies, proves, broadcasts
    let sig = merchant.complete(&pre, &partial).unwrap();
    let settle = chain::apply_signature(settle, info_p.action_index, sig).unwrap();
    let settle = chain::install_witness(settle, info_p.action_index, anchor, path.clone()).unwrap();
    let (raw, txid) = chain::prove_and_extract(settle).unwrap();
    assert_eq!(txid, info_p.txid, "txid known before signing (v6)");
    assert!(chain::find_notes(&raw, TARGET, &merchant_fvk).unwrap().iter().any(|n| n.note.value().inner() == 600_000));

    // ---- payer: t from the transaction bytes alone
    let on_chain = protocol::find_signature(&raw, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex).unwrap();
    assert_eq!(chain::spend_auth_sig_for_rk(&raw, TARGET, &info_p.rk).unwrap(), Some(on_chain));
    let s = parse_scalar(&hex::encode(&on_chain[32..])).unwrap();
    let t_rec = protocol::extract_t(s, parse_scalar(&pre.s_a_hex).unwrap(), partial.s_b);
    assert_eq!(t_rec, t);
    assert_eq!(sealed::open(t_rec, &offer).unwrap(), payload.to_vec());

    // ---- the refund is also a valid transaction (it would conflict with the
    // settlement: same escrow nullifier), so funds are never stuck.
    let refund = chain::install_witness(refund, r_info_payer.action_index, anchor, path).unwrap();
    let (refund_raw, refund_txid) = chain::prove_and_extract(refund).unwrap();
    assert_eq!(refund_txid, r_info_payer.txid);
    let nf = |raw: &[u8]| -> Vec<[u8; 32]> { chain::parse_tx(raw, TARGET).unwrap().ironwood_bundle().unwrap().actions().iter().map(|a| a.nullifier().to_bytes()).collect() };
    let esc_nf = escrow.nullifier(&joint).to_bytes();
    assert!(nf(&raw).contains(&esc_nf) && nf(&refund_raw).contains(&esc_nf));
    let refunds = chain::find_notes(&refund_raw, TARGET, &payer_fvk).unwrap();
    assert_eq!(refunds[0].note.value().inner(), 985_000);

    // ---- consensus finality: the refund cannot be mined before LOCK + 1,
    // and the settlement cannot be mined after SETTLE_EXPIRY <= LOCK.
    let refund_tx = chain::parse_tx(&refund_raw, TARGET).unwrap();
    let settle_tx = chain::parse_tx(&raw, TARGET).unwrap();
    assert_eq!(refund_tx.lock_time(), LOCK);
    let tb = refund_tx.transparent_bundle().unwrap();
    assert_eq!(tb.vin.len(), 1);
    assert_eq!(tb.vin[0].sequence(), chain::LOCK_SEQUENCE);
    assert_eq!(tb.vin[0].prevout().n(), 0);
    assert_eq!(u64::from(tb.vout[0].value()), chain::LOCK_UTXO_VALUE, "lock coin returned");
    assert!(!chain::is_final(&refund_tx, TARGET), "refund invalid while the claim window is open");
    assert!(!chain::is_final(&refund_tx, LOCK), "refund invalid at the lock height");
    assert!(chain::is_final(&refund_tx, LOCK + 1), "refund valid after the lock");
    assert_eq!(u32::from(settle_tx.expiry_height()), SETTLE_EXPIRY);
    assert!(chain::is_final(&settle_tx, TARGET));
    for h in TARGET..LOCK + 10 {
        let settle_ok = chain::is_final(&settle_tx, h) && h <= SETTLE_EXPIRY;
        let refund_ok = chain::is_final(&refund_tx, h);
        assert!(!(settle_ok && refund_ok), "settlement and refund both valid at {h}");
    }
    assert_eq!(fund_txid.len(), 64);
}
