//! On-chain settlement on Zcash testnet (NU6.3+/NU7, Ironwood pool, v6 PCZTs).
//!
//! What this module binds together:
//!
//! * **Joint key = note key.** The two adaptor-signature shares sum to the
//!   spend validating key `ak` of an Orchard-protocol full viewing key
//!   `(ak, nk, rivk)`. Funds sent to that FVK's address can only be spent with
//!   a RedPallas signature under `rk = ak + [alpha]G`, i.e. by both parties.
//! * **Real sighash and alpha.** The settlement (and refund) transactions are
//!   built as PCZTs; the shielded sighash and the action's `alpha` are read
//!   from the PCZT, and the completed adaptor signature is applied with
//!   `pczt::roles::signer::Signer::apply_ironwood_signature`, which verifies
//!   it with `reddsa` against the action's `rk`.
//! * **Deferred anchors (ZIP 374).** v6 transactions keep the anchor and the
//!   Merkle witnesses out of the txid/sighash, so both the settlement and the
//!   refund can be signed before the funding note is even mined; the witness
//!   is installed only by whoever proves and broadcasts.
//! * **Extraction from chain.** The payer recovers `t` from the mined
//!   transaction bytes (`protocol::find_signature`), never from the relay.
//!
//! Nothing here handles signing shares or `t`; those stay in `protocol` and in
//! the parties' own processes.

use anyhow::{anyhow, bail, ensure, Context, Result};
use ff::PrimeField;
use group::GroupEncoding;
use incrementalmerkletree::frontier::CommitmentTree;
use incrementalmerkletree::witness::IncrementalWitness;
use orchard::keys::{FullViewingKey, PreparedIncomingViewingKey, Scope};
use orchard::note_encryption::IronwoodDomain;
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::{Address, Anchor, Note, NoteVersion};
use orchard::note::{RandomSeed, Rho};
use orchard::value::NoteValue;
use pasta_curves::pallas::{Point, Scalar};
use pczt::roles::creator::Creator;
use pczt::roles::io_finalizer::IoFinalizer;
use pczt::roles::prover::Prover;
use pczt::roles::signer::Signer;
use pczt::roles::spend_finalizer::SpendFinalizer;
use pczt::roles::tx_extractor::TransactionExtractor;
use pczt::roles::updater::Updater;
use pczt::roles::verifier::Verifier;
use pczt::Pczt;
use serde::{Deserialize, Serialize};
use zcash_address::unified::{self, Encoding};
use zcash_primitives::transaction::builder::{BundlePadding, DeferredPcztBuilder};
use zcash_primitives::transaction::fees::zip317;
use zcash_primitives::transaction::txid::{to_txid, TxIdDigester};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkType, TEST_NETWORK};
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;

/// The network Lintel settles on.
pub const NETWORK: zcash_protocol::consensus::TestNetwork = TEST_NETWORK;

fn rng() -> rand::rngs::ThreadRng { rand::rng() }

// ---------------------------------------------------------------- joint key

/// Public description of the joint (escrow) key. Every field is public to the
/// two parties; none of it can spend. `nk`/`rivk` only affect nullifiers and
/// address derivation (privacy), never who can authorize a spend.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct JointKeyInfo {
    /// `ak`, 32 bytes hex (ỹ = 0).
    pub ak: String,
    /// `nk`, 32 bytes hex (Pallas base field).
    pub nk: String,
    /// `rivk`, 32 bytes hex (Pallas scalar).
    pub rivk: String,
}

/// Derives `nk` and `rivk` from both parties' 32-byte contributions and the
/// session id. Each party picks its contribution at random and publishes it;
/// neither can force a chosen value without the other's input, and in any
/// case a bad `nk`/`rivk` cannot move funds (only `ak` authorizes spends).
pub fn derive_nk_rivk(session: &[u8], contrib_payer: &[u8; 32], contrib_merchant: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let h = |tag: &[u8]| {
        let out = blake2b_simd::Params::new().hash_length(64).personal(b"Lintel_JointFVK_")
            .to_state().update(tag).update(session).update(contrib_payer).update(contrib_merchant).finalize();
        let arr: [u8; 64] = out.as_bytes().try_into().unwrap();
        arr
    };
    let nk = <pasta_curves::pallas::Base as ff::FromUniformBytes<64>>::from_uniform_bytes(&h(b"nk"));
    let rivk = <Scalar as ff::FromUniformBytes<64>>::from_uniform_bytes(&h(b"rivk"));
    (nk.to_repr(), rivk.to_repr())
}

impl JointKeyInfo {
    pub fn new(ak: &Point, nk: [u8; 32], rivk: [u8; 32]) -> Self {
        Self { ak: hex::encode(ak.to_bytes()), nk: hex::encode(nk), rivk: hex::encode(rivk) }
    }
    /// The joint full viewing key. Fails if `ak` has ỹ = 1 (see
    /// `protocol::joint_ak`) or the key is otherwise invalid.
    pub fn fvk(&self) -> Result<FullViewingKey> {
        let mut raw = [0u8; 96];
        hex::decode_to_slice(&self.ak, &mut raw[..32]).context("ak hex")?;
        hex::decode_to_slice(&self.nk, &mut raw[32..64]).context("nk hex")?;
        hex::decode_to_slice(&self.rivk, &mut raw[64..]).context("rivk hex")?;
        FullViewingKey::from_bytes(&raw).ok_or_else(|| anyhow!("invalid joint full viewing key (ak must have ỹ = 0)"))
    }
}

/// External address 0 of the joint FVK: where the payer funds the escrow.
pub fn joint_address(fvk: &FullViewingKey) -> Address { fvk.address_at(0u32, Scope::External) }

/// Unified Address (testnet, Orchard-protocol receiver) for an address.
pub fn encode_ua(addr: &Address) -> String {
    let ua = unified::Address::try_from_items(
        unified::Revision::R0,
        vec![unified::Uitem::Data(unified::Receiver::Orchard(addr.to_raw_address_bytes()))],
    ).expect("a single Orchard receiver is a valid UA");
    ua.encode(&NetworkType::Test)
}

/// Unified Full Viewing Key (testnet) so either party can watch the escrow
/// with a standard view-only wallet.
pub fn encode_ufvk(fvk: &FullViewingKey) -> String {
    let ufvk = unified::Ufvk::try_from_items(
        unified::Revision::R0,
        vec![unified::Uitem::Data(unified::Fvk::Orchard(fvk.to_bytes()))],
    ).expect("a single Orchard FVK is a valid UFVK");
    ufvk.encode(&NetworkType::Test)
}

/// Parses a testnet Unified Address and returns its Orchard-protocol receiver.
pub fn decode_ua(s: &str) -> Result<Address> {
    let (net, _, ua) = unified::Address::decode(s).map_err(|e| anyhow!("address: {e}"))?;
    ensure!(net == NetworkType::Test, "address is not a testnet address");
    for r in unified::Container::items(&ua) {
        if let unified::Receiver::Orchard(b) = r {
            return Option::from(Address::from_raw_address_bytes(&b)).ok_or_else(|| anyhow!("invalid Orchard receiver"));
        }
    }
    bail!("address has no Orchard receiver")
}

// ---------------------------------------------------------------- notes

/// An escrow note found on chain (or built locally in tests).
#[derive(Clone, Debug)]
pub struct FoundNote {
    pub note: Note,
    /// Index of the action that created it within the Ironwood bundle.
    pub action_index: usize,
    /// Extracted note commitment, for locating it in the commitment tree.
    pub cmx: [u8; 32],
}

/// Branch for a raw transaction mined (or to be mined) at `height`.
pub fn branch_for(height: u32) -> BranchId { BranchId::for_height(&NETWORK, BlockHeight::from_u32(height)) }

/// Parses a raw v5/v6 transaction.
pub fn parse_tx(raw: &[u8], height: u32) -> Result<Transaction> {
    Transaction::read(raw, branch_for(height)).context("parse transaction")
}

/// Trial-decrypts every Ironwood output of `raw` with the joint key and
/// returns the escrow notes paid to it.
pub fn find_notes(raw: &[u8], height: u32, fvk: &FullViewingKey) -> Result<Vec<FoundNote>> {
    let tx = parse_tx(raw, height)?;
    let mut found = Vec::new();
    let Some(bundle) = tx.ironwood_bundle() else { return Ok(found) };
    let ivk = PreparedIncomingViewingKey::new(&fvk.to_ivk(Scope::External));
    for (i, act) in bundle.actions().iter().enumerate() {
        let domain = IronwoodDomain::for_action(act);
        if let Some((note, _, _)) = zcash_note_encryption::try_note_decryption(&domain, &ivk, act) {
            found.push(FoundNote { note, action_index: i, cmx: act.cmx().to_bytes() });
        }
    }
    Ok(found)
}

// ---------------------------------------------------------------- PCZTs

/// What a spend of the escrow note must do. Both parties derive the PCZT's
/// meaning from this and refuse to sign anything else.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SpendTerms {
    /// `settle` (pay the merchant) or `refund` (return to the payer).
    pub kind: String,
    /// Main recipient UA and amount (zatoshis).
    pub pay_to: String,
    pub amount: u64,
    /// Where the remainder goes after the fee (payer's UA). Omitted when the
    /// main output takes everything.
    pub change_to: Option<String>,
    /// Height the transaction is built for (sets the consensus branch).
    pub target_height: u32,
    /// Last height the transaction may be mined at (0 = no expiry). The
    /// signatures commit to it.
    pub expiry_height: u32,
}

/// What the signers need from a PCZT, all public.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SigningInfo {
    /// Shielded sighash (hex): the message the two-party signature signs.
    pub sighash: String,
    /// `alpha` of the escrow spend (hex scalar).
    pub alpha: String,
    /// `rk = ak + [alpha]G` (hex), equal to the protocol's `vk_hex`.
    pub rk: String,
    /// Ironwood action index of the escrow spend.
    pub action_index: usize,
    /// Transaction id (display order hex). v6 txids exclude anchors and
    /// signatures, so it is final before signing.
    pub txid: String,
    pub fee: u64,
}

/// Builds the unsigned, unproven PCZT spending `note` according to `terms`,
/// with its anchor and witness deferred (ZIP 374).
pub fn build_spend(fvk: &FullViewingKey, note: &Note, terms: &SpendTerms) -> Result<Pczt> {
    let fee_rule = zip317::FeeRule::standard();
    let pay_to = decode_ua(&terms.pay_to)?;
    let change_to = terms.change_to.as_deref().map(decode_ua).transpose()?;
    let value = note.value().inner();

    let new_builder = || -> Result<DeferredPcztBuilder<_>> {
        let b = DeferredPcztBuilder::new::<std::convert::Infallible>(
            NETWORK, BlockHeight::from_u32(terms.target_height), BundlePadding::UNPADDED, BundlePadding::DEFAULT,
        ).map_err(|e| anyhow!("builder: {e:?}"))?;
        Ok(b.with_expiry_height(BlockHeight::from_u32(terms.expiry_height)))
    };
    let mut b = new_builder()?;
    b.add_ironwood_spend::<std::convert::Infallible>(fvk.clone(), *note).map_err(|e| anyhow!("spend: {e:?}"))?;
    b.add_ironwood_output::<std::convert::Infallible>(None, pay_to, zat(terms.amount)?, MemoBytes::empty())
        .map_err(|e| anyhow!("output: {e:?}"))?;
    if let Some(c) = change_to {
        // A change output adds no action (the spend's action carries an
        // output anyway), so the fee is the same with or without it.
        let fee = b.get_fee(&fee_rule).map_err(|e| anyhow!("fee: {e:?}"))?.into_u64();
        let change = value.checked_sub(terms.amount).and_then(|v| v.checked_sub(fee))
            .ok_or_else(|| anyhow!("note value {value} < amount {} + fee {fee}", terms.amount))?;
        if change > 0 {
            b.add_ironwood_output::<std::convert::Infallible>(None, c, zat(change)?, MemoBytes::empty())
                .map_err(|e| anyhow!("change: {e:?}"))?;
        }
    }
    let res = b.build_for_pczt(rng(), &fee_rule).map_err(|e| anyhow!("build: {e:?}"))?;
    let pczt = Creator::build_from_parts(res.pczt_parts).ok_or_else(|| anyhow!("unsupported tx version"))?;
    IoFinalizer::new(pczt).finalize_io(rng()).map_err(|e| anyhow!("io finalize: {e:?}"))
}

fn zat(v: u64) -> Result<Zatoshis> { Zatoshis::from_u64(v).map_err(|_| anyhow!("invalid amount {v}")) }

/// Largest amount `pay_to` can receive from `note_value` when it takes
/// everything (refunds): note value minus the ZIP 317 fee for one spend.
pub fn max_payout(note_value: u64) -> u64 {
    // one Ironwood spend + one output, padded to 2 actions => 2 logical actions,
    // ZIP 317 minimum is 2 * 5000 zats.
    note_value.saturating_sub(10_000)
}

/// Checks a PCZT against the agreed terms and returns what to sign. Called
/// independently by BOTH parties on the same PCZT bytes; a party signs only
/// the `sighash`/`alpha` returned here, never values sent by the other side.
///
/// Verifies: no transparent/Sapling/Orchard-pool data; expiry height and
/// consensus branch as agreed; the escrow note (found on chain with the
/// joint key) is spent exactly once, with its nullifier and `rk` derived
/// from the joint FVK; every other spend carries value 0 (padding); every
/// action's value commitment and output note commitment match its stated
/// values; value-carrying outputs pay exactly `amount` to `pay_to` and the
/// remainder to `change_to`; the fee is the ZIP 317 fee (10,000 zats for
/// this two-action shape).
pub fn check_spend(pczt: &Pczt, fvk: &FullViewingKey, escrow: &Note, terms: &SpendTerms) -> Result<SigningInfo> {
    use pczt::roles::verifier::OrchardError as VE;
    let pay_to = decode_ua(&terms.pay_to)?.to_raw_address_bytes();
    let change_to = terms.change_to.as_deref().map(decode_ua).transpose()?.map(|a| a.to_raw_address_bytes());
    ensure!(*pczt.global().expiry_height() == terms.expiry_height, "expiry height differs from the agreed terms");
    ensure!(*pczt.global().consensus_branch_id() == u32::from(branch_for(terms.target_height)), "consensus branch differs");
    ensure!(!pczt.has_data_in_pool(zcash_protocol::PoolType::TRANSPARENT), "unexpected transparent data");
    ensure!(!pczt.has_data_in_pool(zcash_protocol::PoolType::SAPLING), "unexpected Sapling data");
    ensure!(!pczt.has_data_in_pool(zcash_protocol::PoolType::ORCHARD), "unexpected Orchard-pool data");
    let escrow_nf = escrow.nullifier(fvk).to_bytes();

    let mut escrow_index = None;
    let mut alpha = None;
    let mut rk = None;
    let (mut paid, mut change, mut outs) = (0u64, 0u64, 0u64);
    let custom = |m: String| VE::Custom(anyhow!(m));
    Verifier::new(pczt.clone())
        .with_ironwood::<anyhow::Error, _>(|bundle| {
            for (i, a) in bundle.actions().iter().enumerate() {
                let sp = a.spend();
                a.verify_cv_net().map_err(VE::Verify)?;
                a.output().verify_note_commitment(sp).map_err(VE::Verify)?;
                if sp.nullifier().to_bytes() == escrow_nf {
                    if escrow_index.is_some() { return Err(custom(format!("escrow spent twice (action {i})"))); }
                    sp.verify_nullifier(Some(fvk)).map_err(VE::Verify)?;
                    sp.verify_rk(Some(fvk)).map_err(VE::Verify)?;
                    if sp.value().map(|v| v.inner()) != Some(escrow.value().inner()) {
                        return Err(custom("escrow spend value differs from the note".into()));
                    }
                    escrow_index = Some(i);
                    alpha = *sp.alpha();
                    rk = Some(<[u8; 32]>::from(sp.rk().clone()));
                } else if sp.value().map(|v| v.inner()) != Some(0) {
                    return Err(custom(format!("action {i} spends a value-carrying note that is not the escrow")));
                }
                let out = a.output();
                let v = out.value().map(|v| v.inner()).ok_or_else(|| custom(format!("output {i} value redacted")))?;
                if v == 0 { continue; }
                let r = out.recipient().ok_or_else(|| custom(format!("output {i} recipient redacted")))?.to_raw_address_bytes();
                outs += v;
                if r == pay_to && paid == 0 { paid = v; }
                else if Some(r) == change_to && change == 0 { change = v; }
                else { return Err(custom(format!("output {i} pays an unexpected recipient"))); }
            }
            Ok(())
        })
        .map_err(|e| anyhow!("pczt verification failed: {e:?}"))?;

    let index = escrow_index.ok_or_else(|| anyhow!("the escrow note is not spent"))?;
    let alpha = alpha.ok_or_else(|| anyhow!("escrow spend has no alpha"))?;
    ensure!(paid == terms.amount, "pays {paid} instead of the agreed {}", terms.amount);
    let fee = escrow.value().inner().checked_sub(outs).ok_or_else(|| anyhow!("outputs exceed input"))?;
    ensure!(fee == 10_000, "fee {fee} is not the ZIP 317 fee for this shape (10000)");

    let signer = Signer::new(pczt.clone()).map_err(|e| anyhow!("signer: {e:?}"))?;
    Ok(SigningInfo {
        sighash: hex::encode(signer.shielded_sighash()),
        alpha: hex::encode(alpha.to_repr()),
        rk: hex::encode(rk.unwrap()),
        action_index: index,
        txid: txid(pczt)?,
        fee,
    })
}

/// Transaction id of the PCZT's transaction (display hex). For v6 it is
/// independent of anchors, proofs and signatures.
pub fn txid(pczt: &Pczt) -> Result<String> {
    let data = pczt.clone().into_effects().map_err(|e| anyhow!("effects: {e:?}"))?;
    let digests = data.digest(TxIdDigester);
    Ok(to_txid(data.version(), data.consensus_branch_id(), &digests).to_string())
}

/// Applies a completed two-party signature to the escrow spend. The pczt
/// Signer verifies it (reddsa) under the action's `rk` and the sighash.
pub fn apply_signature(pczt: Pczt, action_index: usize, sig: [u8; 64]) -> Result<Pczt> {
    let mut s = Signer::new(pczt).map_err(|e| anyhow!("signer: {e:?}"))?;
    s.apply_ironwood_signature(action_index, orchard::primitives::redpallas::Signature::from(sig))
        .map_err(|e| anyhow!("signature rejected: {e:?}"))?;
    Ok(s.finish())
}

/// Computes the anchor and Merkle path for `target_cmx`, given the Ironwood
/// commitment tree as of the end of the block BEFORE the funding block (the
/// legacy `CommitmentTree` encoding lightwalletd's `GetTreeState` returns,
/// hex) and every Ironwood note commitment of the funding block in order.
/// The anchor is the tree root at the end of the funding block.
pub fn witness(prev_tree_hex: &str, block_cmxs: &[[u8; 32]], target_cmx: &[u8; 32]) -> Result<(Anchor, MerklePath)> {
    let mut tree: CommitmentTree<MerkleHashOrchard, 32> = if prev_tree_hex.is_empty() {
        CommitmentTree::empty()
    } else {
        let bytes = hex::decode(prev_tree_hex).context("tree hex")?;
        zcash_primitives::merkle_tree::read_commitment_tree(&bytes[..]).context("read tree")?
    };
    let mut wit: Option<IncrementalWitness<MerkleHashOrchard, 32>> = None;
    for cmx in block_cmxs {
        let node = Option::from(MerkleHashOrchard::from_bytes(cmx)).ok_or_else(|| anyhow!("bad cmx"))?;
        match wit.as_mut() {
            Some(w) => w.append(node).map_err(|_| anyhow!("tree full"))?,
            None => {
                tree.append(node).map_err(|_| anyhow!("tree full"))?;
                if cmx == target_cmx {
                    wit = Some(IncrementalWitness::from_tree(tree.clone()).ok_or_else(|| anyhow!("empty tree"))?);
                }
            }
        }
    }
    let w = wit.ok_or_else(|| anyhow!("escrow note commitment not in the block"))?;
    let path = w.path().ok_or_else(|| anyhow!("no path"))?;
    let anchor = Anchor::from(w.root());
    Ok((anchor, MerklePath::from(path)))
}

/// Installs the anchor and the escrow spend's witness (Updater role).
pub fn install_witness(pczt: Pczt, action_index: usize, anchor: Anchor, path: MerklePath) -> Result<Pczt> {
    let p = Updater::new(pczt)
        .set_ironwood_anchor(anchor).map_err(|e| anyhow!("anchor: {e:?}"))?
        .set_ironwood_spend_witnesses([(action_index, path)]).map_err(|e| anyhow!("witness: {e:?}"))?
        .finish();
    Ok(p)
}

/// Proves (Ironwood circuit), finalizes and extracts the transaction. The
/// extractor fully verifies proofs, spend-auth and binding signatures before
/// returning. Returns `(raw tx bytes, txid)`.
pub fn prove_and_extract(pczt: Pczt) -> Result<(Vec<u8>, String)> {
    let pk = zcash_primitives::transaction::builder::cached_orchard_proving_key(
        orchard::circuit::OrchardCircuitVersion::PostNu6_3,
    );
    let mut prover = Prover::new(pczt);
    if prover.requires_ironwood_proof() {
        prover = prover.create_ironwood_proof(rng(), pk).map_err(|e| anyhow!("prove: {e:?}"))?;
    }
    let pczt = prover.finish();
    let pczt = SpendFinalizer::new(pczt).finalize_spends().map_err(|e| anyhow!("finalize: {e:?}"))?;
    let vk = pk.verifying_key();
    let tx = TransactionExtractor::new(pczt).with_orchard(&vk).extract(rng())
        .map_err(|e| anyhow!("extract/verify: {e:?}"))?;
    let mut raw = Vec::new();
    tx.write(&mut raw)?;
    Ok((raw, tx.txid().to_string()))
}

/// Reads the escrow spend's signature from a parsed transaction by `rk`.
pub fn spend_auth_sig_for_rk(raw: &[u8], height: u32, rk_hex: &str) -> Result<Option<[u8; 64]>> {
    let tx = parse_tx(raw, height)?;
    let Some(bundle) = tx.ironwood_bundle() else { return Ok(None) };
    for a in bundle.actions() {
        if hex::encode(<[u8; 32]>::from(a.rk())) == rk_hex {
            return Ok(Some(<[u8; 64]>::from(a.authorization())));
        }
    }
    Ok(None)
}

pub fn pczt_from_bytes(b: &[u8]) -> Result<Pczt> { Pczt::parse(b).map_err(|e| anyhow!("pczt parse: {e:?}")) }
pub fn pczt_to_bytes(p: Pczt) -> Result<Vec<u8>> { p.serialize().map_err(|e| anyhow!("pczt serialize: {e:?}")) }

/// Signs every Ironwood spend owned by `sk` (a party's own single-sig wallet,
/// e.g. the payer funding the escrow). Spends it does not own are skipped.
pub fn sign_own(pczt: Pczt, sk: &orchard::keys::SpendingKey) -> Result<Pczt> {
    let ask = orchard::keys::SpendAuthorizingKey::from(sk);
    let n = pczt.ironwood().actions().len();
    let mut s = Signer::new(pczt).map_err(|e| anyhow!("signer: {e:?}"))?;
    let mut signed = 0;
    for i in 0..n {
        if s.sign_ironwood(rng(), i, &ask).is_ok() { signed += 1; }
    }
    ensure!(signed > 0, "no spend in this PCZT belongs to the key");
    Ok(s.finish())
}

/// Index of the Ironwood action spending `note` (by nullifier).
pub fn spend_index(pczt: &Pczt, fvk: &FullViewingKey, note: &Note) -> Result<usize> {
    let nf = note.nullifier(fvk).to_bytes();
    pczt.ironwood().actions().iter().position(|a| a.spend().nullifier() == &nf)
        .ok_or_else(|| anyhow!("note not spent by this PCZT"))
}

// ---------------------------------------------------------------- note records

fn b32h(h: &str) -> Result<[u8; 32]> { hex::decode(h)?.try_into().map_err(|_| anyhow!("expected 32 bytes")) }

/// An escrow (or wallet) note as found on chain. Public to its two owners.
#[derive(Serialize, Deserialize, Clone)]
pub struct NoteRecord { pub txid: String, pub height: u32, pub action_index: usize, pub cmx: String, pub recipient: String, pub value: u64, pub rho: String, pub rseed: String }

impl NoteRecord {
    pub fn from_found(f: &FoundNote, txid: &str, height: u32) -> Self {
        let n = &f.note;
        NoteRecord {
            txid: txid.into(), height, action_index: f.action_index, cmx: hex::encode(f.cmx),
            recipient: hex::encode(n.recipient().to_raw_address_bytes()), value: n.value().inner(),
            rho: hex::encode(n.rho().to_bytes()), rseed: hex::encode(n.rseed().as_bytes()),
        }
    }
    pub fn note(&self) -> Result<Note> {
        let rb: [u8; 43] = hex::decode(&self.recipient)?.try_into().map_err(|_| anyhow!("recipient length"))?;
        let addr = Option::<Address>::from(Address::from_raw_address_bytes(&rb)).ok_or_else(|| anyhow!("bad recipient"))?;
        let rho = Option::<Rho>::from(Rho::from_bytes(&b32h(&self.rho)?)).ok_or_else(|| anyhow!("bad rho"))?;
        let rseed = Option::<RandomSeed>::from(RandomSeed::from_bytes(b32h(&self.rseed)?, &rho)).ok_or_else(|| anyhow!("bad rseed"))?;
        let n = Option::<Note>::from(Note::from_parts(addr, NoteValue::from_raw(self.value), rho, rseed, NoteVersion::V3)).ok_or_else(|| anyhow!("bad note"))?;
        let cmx = orchard::note::ExtractedNoteCommitment::from(n.commitment()).to_bytes();
        ensure!(hex::encode(cmx) == self.cmx, "note fields do not match its commitment");
        Ok(n)
    }
}

