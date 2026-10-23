//! The seller agent, end to end and offline: a scripted buyer (the same steps
//! as `advanceBuyer` in web/app/src/onchain.js) against `lintel::agent` through
//! an in-memory relay with the real relay's write-once rules and an in-memory
//! chain that mines real v6 transactions. Funding, the co-signed time-locked
//! refund, the adaptor-signed settlement, proving, and the buyer recovering `t`
//! from the mined settlement and decrypting the goods.
#![cfg(feature = "net")]

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{anyhow, bail, ensure, Result};
use ff::{Field, PrimeField};
use group::GroupEncoding;
use incrementalmerkletree::frontier::CommitmentTree;
use lintel::agent::{self, AgentListing, Chain, MerchantState, Relay, SellerChain, Status};
use lintel::chain::{self, NoteRecord, RefundLock, SpendTerms, TransparentKey, TransparentOut};
use lintel::protocol::{self, parse_scalar, Seller as Payer};
use lintel::sealed;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use orchard::note::{RandomSeed, Rho};
use orchard::tree::MerkleHashOrchard;
use orchard::value::NoteValue;
use orchard::{Note, NoteVersion};
use rand::RngExt;
use serde_json::{json, Value};

const START: u32 = 4_600_000; // NU7 on testnet
const PRICE: &str = "0.006";
const PRICE_ZATS: u64 = 600_000;
const LOCK_VALUE: u64 = 20_000;
const CLAIM_BLOCKS: u32 = 60;

// ---------------------------------------------------------------- in-memory relay

const SELLER_FIELDS: &[&str] = &["merchant_contrib", "merchant_address", "escrow_address", "refund_partial", "settle_terms", "settle_pczt", "settle_txid"];
const BUYER_FIELDS: &[&str] = &["payer_contrib", "payer_pok", "payer_address", "funding_txid", "refund_terms", "refund_pczt", "refund_r_a", "settle_r_a"];

struct MemRelay {
    listing: Mutex<Value>,
    session: Mutex<Value>,
    seller_token: String,
    buyer_token: String,
    /// Fail the next seller post of this field (simulates a crash/lost reply).
    fail_once: Mutex<Option<String>>,
    posts: Mutex<Vec<String>>,
}

impl MemRelay {
    fn new(listing: Value) -> Self {
        Self { listing: Mutex::new(listing), session: Mutex::new(Value::Null), seller_token: "seller-tok".into(),
            buyer_token: "buyer-tok".into(), fail_once: Mutex::new(None), posts: Mutex::new(vec![]) }
    }
    fn open_session(&self, sid: &str, payer_vk: &str) {
        *self.session.lock().unwrap() = json!({ "id": sid, "listing_id": "L1", "mode": "chain", "payer_vk": payer_vk,
            "partial": null, "merchant_pok": null, "presig": null, "signature": null, "chain": {} });
        self.listing.lock().unwrap()["status"] = json!("pending");
    }
    fn ch(&self, k: &str) -> Option<String> { self.session.lock().unwrap()["chain"][k].as_str().map(String::from) }
    fn sess(&self, k: &str) -> Option<String> { self.session.lock().unwrap()[k].as_str().map(String::from) }
    fn write(&self, field: &str, value: &str, token: &str) -> Result<()> {
        let seller = SELLER_FIELDS.contains(&field);
        ensure!(seller || BUYER_FIELDS.contains(&field), "unknown field");
        ensure!(token == if seller { &self.seller_token } else { &self.buyer_token }, "token required");
        let mut s = self.session.lock().unwrap();
        ensure!(s["chain"][field].is_null(), "{field} already set");
        s["chain"][field] = json!(value);
        if field == "settle_txid" { self.listing.lock().unwrap()["status"] = json!("sold"); }
        Ok(())
    }
    fn buyer_post(&self, field: &str, value: &str) { self.write(field, value, &self.buyer_token.clone()).unwrap() }
    fn buyer_presig(&self, presig: &str) {
        let mut s = self.session.lock().unwrap();
        assert!(!s["partial"].is_null() && s["presig"].is_null());
        s["presig"] = json!(presig);
    }
}

impl Relay for MemRelay {
    async fn listing(&self, _lid: &str) -> Result<(Value, Value)> {
        Ok((self.listing.lock().unwrap().clone(), self.session.lock().unwrap().clone()))
    }
    async fn post_chain(&self, sid: &str, field: &str, value: &str, token: &str) -> Result<()> {
        ensure!(self.sess("id").as_deref() == Some(sid), "not found");
        if self.fail_once.lock().unwrap().as_deref() == Some(field) {
            *self.fail_once.lock().unwrap() = None;
            bail!("connection reset");
        }
        self.write(field, value, token)?;
        self.posts.lock().unwrap().push(field.into());
        Ok(())
    }
    async fn post_partial(&self, sid: &str, partial: &str, pok: &str, token: &str) -> Result<()> {
        ensure!(self.sess("id").as_deref() == Some(sid), "not found");
        ensure!(token == self.seller_token, "seller token required");
        let mut s = self.session.lock().unwrap();
        ensure!(s["partial"].is_null(), "partial already set");
        ensure!(!s["chain"]["settle_r_a"].is_null() && !s["chain"]["settle_pczt"].is_null(), "settlement PCZT and nonce first");
        s["partial"] = json!(partial);
        s["merchant_pok"] = json!(pok);
        self.posts.lock().unwrap().push("partial".into());
        Ok(())
    }
}

// ---------------------------------------------------------------- in-memory chain

#[derive(Default)]
struct ChainState { tip: u32, blocks: Vec<(u32, Vec<[u8; 32]>)>, mined: HashMap<String, (Vec<u8>, u32)>, mempool: Vec<(String, Vec<u8>)> }
struct MemChain(Mutex<ChainState>);

fn tree_hex(leaves: &[[u8; 32]]) -> String {
    let mut t: CommitmentTree<MerkleHashOrchard, 32> = CommitmentTree::empty();
    for l in leaves { t.append(MerkleHashOrchard::from_bytes(l).unwrap()).unwrap(); }
    let mut out = Vec::new();
    zcash_primitives::merkle_tree::write_commitment_tree(&t, &mut out).unwrap();
    hex::encode(out)
}
fn tx_cmxs(raw: &[u8]) -> Vec<[u8; 32]> {
    chain::parse_tx(raw, START).unwrap().ironwood_bundle().unwrap().actions().iter().map(|a| a.cmx().to_bytes()).collect()
}

impl MemChain {
    fn new() -> Self { Self(Mutex::new(ChainState { tip: START, ..Default::default() })) }
    fn tip(&self) -> u32 { self.0.lock().unwrap().tip }
    /// Mines a block with these commitments (and the mempool).
    fn mine(&self, extra: &[[u8; 32]]) -> u32 {
        let mut s = self.0.lock().unwrap();
        s.tip += 1;
        let h = s.tip;
        let mut cmxs = extra.to_vec();
        for (txid, raw) in std::mem::take(&mut s.mempool) {
            cmxs.extend(tx_cmxs(&raw));
            s.mined.insert(txid, (raw, h));
        }
        s.blocks.push((h, cmxs));
        h
    }
    fn skip(&self, n: u32) { for _ in 0..n { self.mine(&[]); } }
    fn trees(&self, h: u32) -> (String, Vec<[u8; 32]>, String) {
        let s = self.0.lock().unwrap();
        let before: Vec<[u8; 32]> = s.blocks.iter().filter(|(bh, _)| *bh < h).flat_map(|(_, c)| c.clone()).collect();
        let at: Vec<[u8; 32]> = s.blocks.iter().filter(|(bh, _)| *bh == h).flat_map(|(_, c)| c.clone()).collect();
        let all = [before.clone(), at.clone()].concat();
        (tree_hex(&before), at, tree_hex(&all))
    }
    fn finalize_sync(&self, p: pczt::Pczt, h: u32, cmx: &[u8; 32], idx: usize) -> Result<(Vec<u8>, String)> {
        let (prev, block, at) = self.trees(h);
        chain::finalize_with(p, idx, cmx, &prev, &block, &at)
    }
    fn send_sync(&self, raw: Vec<u8>) -> Result<String> {
        let txid = chain::parse_tx(&raw, START).unwrap().txid().to_string();
        let mut s = self.0.lock().unwrap();
        ensure!(!s.mined.contains_key(&txid) && !s.mempool.iter().any(|(t, _)| *t == txid), "txn-already-known");
        s.mempool.push((txid.clone(), raw));
        Ok(txid)
    }
}

impl Chain for MemChain {
    async fn height(&self) -> Result<u32> { Ok(self.tip()) }
    async fn mined(&self, txid: &str) -> Result<Option<(Vec<u8>, u32)>> { Ok(self.0.lock().unwrap().mined.get(txid).cloned()) }
    async fn known(&self, txid: &str) -> Result<bool> {
        let s = self.0.lock().unwrap();
        Ok(s.mined.contains_key(txid) || s.mempool.iter().any(|(t, _)| t == txid))
    }
    async fn finalize(&self, p: pczt::Pczt, h: u32, cmx: &[u8; 32], idx: usize) -> Result<(Vec<u8>, String)> { self.finalize_sync(p, h, cmx, idx) }
    async fn send(&self, raw: Vec<u8>) -> Result<()> { self.send_sync(raw).map(|_| ()) }
}

// ---------------------------------------------------------------- fixtures

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
        let rseed: [u8; 32] = rng.random();
        let Some(rseed) = Option::from(RandomSeed::from_bytes(rseed, &rho)) else { continue };
        if let Some(n) = Option::from(Note::from_parts(fvk.address_at(0u32, Scope::External), NoteValue::from_raw(value), rho, rseed, NoteVersion::V3)) { return n; }
    }
}
fn cmx(n: &Note) -> [u8; 32] { orchard::note::ExtractedNoteCommitment::from(n.commitment()).to_bytes() }
fn pt_hex(p: &pasta_curves::pallas::Point) -> String { hex::encode(p.to_bytes()) }
fn sc_hex(s: &pasta_curves::pallas::Scalar) -> String { hex::encode(s.to_repr()) }
fn pok_json(p: &protocol::KnowledgeProof) -> String { json!({ "r_point": pt_hex(&p.r_point), "s": sc_hex(&p.s) }).to_string() }

struct World {
    relay: MemRelay,
    chain: MemChain,
    listing: AgentListing,
    offer: sealed::SealedOffer,
    payload: Vec<u8>,
    t: pasta_curves::pallas::Scalar,
    merchant_fvk: FullViewingKey,
}

fn world(payload: &[u8]) -> World {
    let keys = sealed::prove::setup::<{ sealed::CHUNKS }>().unwrap();
    let (t, s) = sealed::new_secret();
    let m = protocol::Buyer::with_secret(t);
    let offer = sealed::seal::<{ sealed::CHUNKS }>(&keys, s, payload).unwrap();
    let (_, merchant_fvk, merchant_ua) = wallet(22);
    let listing = AgentListing {
        v: 1, relay: "mem://".into(), listing_id: "L1".into(), title: "PoC".into(), token: "seller-tok".into(),
        merchant: MerchantState { sk_b: sc_hex(&m.sk_b), secret: sealed::field_hex(&s), negated: false },
        payout_address: merchant_ua, chain: SellerChain::default(),
    };
    let relay = MemRelay::new(json!({ "id": "L1", "price_zec": PRICE, "merchant_vk": pt_hex(&m.vk_b), "t_point": pt_hex(&m.t_point()), "status": "open" }));
    World { relay, chain: MemChain::new(), listing, offer, payload: payload.to_vec(), t, merchant_fvk }
}

async fn step(w: &mut World) -> Result<Status> {
    let mut saves = 0;
    let mut save = |_: &AgentListing| -> Result<()> { saves += 1; Ok(()) };
    agent::advance(&mut w.listing, &w.relay, &w.chain, &mut save).await
}

/// Runs the agent until it is waiting (or errors); returns the last status.
async fn settle_agent(w: &mut World) -> Result<Status> {
    for _ in 0..10 {
        match step(w).await? {
            Status::Acted(_) => continue,
            other => return Ok(other),
        }
    }
    bail!("agent did not settle")
}

/// The buyer, as `advanceBuyer` does it.
struct Buyer {
    payer: Payer,
    negated: bool,
    sid: String,
    sk: SpendingKey,
    fvk: FullViewingKey,
    ua: String,
    tkey: TransparentKey,
    contrib: String,
    src: (Note, u32),
    escrow_value: u64,
    ak: String,
    joint: Option<String>,
    escrow: Option<NoteRecord>,
    fund: Option<(Vec<u8>, String)>,
    e: u32,
    refund_info: Option<chain::SigningInfo>,
    refund_r_a: Option<pasta_curves::pallas::Point>,
    refund_pczt: Option<Vec<u8>>,
    refund_signed: Option<Vec<u8>>,
    settle_info: Option<chain::SigningInfo>,
    settle_r_a: Option<pasta_curves::pallas::Point>,
    presig: Option<protocol::PreSignature>,
}

impl Buyer {
    fn join(w: &World, sid: &str) -> Self {
        let (sk, fvk, ua) = wallet(11);
        // a faucet note, mined
        let src = random_note(&fvk, 2_000_000);
        let h = w.chain.mine(&[cmx(&src)]);
        let payer = Payer::new();
        w.relay.open_session(sid, &pt_hex(&payer.vk_a));
        Buyer { payer, negated: false, sid: sid.into(), sk, fvk, ua, tkey: TransparentKey::random(), contrib: hex::encode(rand::random::<[u8; 32]>()),
            src: (src, h), escrow_value: PRICE_ZATS + 2 * agent::SETTLE_FEE, ak: String::new(), joint: None, escrow: None, fund: None, e: 0,
            refund_info: None, refund_r_a: None, refund_pczt: None, refund_signed: None, settle_info: None, settle_r_a: None, presig: None }
    }
    fn merchant_vk(&self, w: &World) -> pasta_curves::pallas::Point {
        let v = protocol::parse_point(w.relay.listing.lock().unwrap()["merchant_vk"].as_str().unwrap()).unwrap();
        if self.negated { -v } else { v }
    }
    /// B1: bind, prove knowledge, publish contribution and address.
    fn b1(&mut self, w: &World, tamper_pok: bool) {
        let m = self.merchant_vk(w);
        let (ak, neg) = protocol::joint_ak(self.payer.vk_a, m).unwrap();
        if neg { self.payer.negate_share(); self.negated = !self.negated; }
        self.ak = pt_hex(&ak);
        let pok = self.payer.prove_knowledge(self.merchant_vk(w), self.sid.as_bytes());
        let pok = if tamper_pok { protocol::KnowledgeProof { r_point: pok.r_point, s: pok.s + pasta_curves::pallas::Scalar::ONE } } else { pok };
        w.relay.buyer_post("payer_contrib", &self.contrib);
        w.relay.buyer_post("payer_address", &self.ua);
        w.relay.buyer_post("payer_pok", &pok_json(&pok));
    }
    /// B2 + B3: joint key, build/prove funding (not broadcast), refund, ask to co-sign.
    fn b3(&mut self, w: &World, lock_height: Option<u32>) {
        let joint = agent::joint(&self.ak, self.sid.as_bytes(), &self.contrib, &w.relay.ch("merchant_contrib").unwrap()).unwrap();
        let jv: Value = serde_json::from_str(&joint).unwrap();
        assert_eq!(jv["escrow_address"].as_str(), w.relay.ch("escrow_address").as_deref(), "both sides derive the same escrow");
        let jfvk = chain::JointKeyInfo { ak: jv["ak"].as_str().unwrap().into(), nk: jv["nk"].as_str().unwrap().into(), rivk: jv["rivk"].as_str().unwrap().into() }.fvk().unwrap();
        let tip = w.chain.tip();
        self.e = tip + CLAIM_BLOCKS;
        let fund_terms = SpendTerms { kind: "fund".into(), pay_to: jv["escrow_address"].as_str().unwrap().into(), amount: self.escrow_value,
            change_to: Some(self.ua.clone()), target_height: tip + 1, expiry_height: tip + 40, lock: None,
            t_out: Some(TransparentOut { address: self.tkey.address(), value: LOCK_VALUE }) };
        let p = chain::build_spend(&self.fvk, &self.src.0, &fund_terms).unwrap();
        let idx = chain::spend_index(&p, &self.fvk, &self.src.0).unwrap();
        let p = chain::sign_own(p, &self.sk).unwrap();
        let fund = w.chain.finalize_sync(p, self.src.1, &cmx(&self.src.0), idx).unwrap();
        let found = chain::find_notes(&fund.0, tip + 1, &jfvk).unwrap();
        let mut escrow = NoteRecord::from_found(&found[0], &fund.1, 0);
        assert_eq!(escrow.value, self.escrow_value);
        escrow.height = 0;
        let refund_terms = SpendTerms { kind: "refund".into(), pay_to: self.ua.clone(), amount: chain::refund_payout(self.escrow_value), change_to: None,
            target_height: tip + 1, expiry_height: 0, t_out: None,
            lock: Some(RefundLock { txid: fund.1.clone(), vout: 0, value: LOCK_VALUE, address: self.tkey.address(), lock_height: lock_height.unwrap_or(self.e) }) };
        let rp = chain::build_spend(&jfvk, &escrow.note().unwrap(), &refund_terms).unwrap();
        let info = chain::check_spend(&rp, &jfvk, &escrow.note().unwrap(), &refund_terms).unwrap();
        let r_a = self.payer.new_nonce();
        let rp = chain::pczt_to_bytes(rp).unwrap();
        w.relay.buyer_post("refund_terms", &json!({ "terms": refund_terms, "settle_expiry": self.e, "escrow_note": escrow }).to_string());
        w.relay.buyer_post("refund_pczt", &agent::b64(&rp));
        w.relay.buyer_post("refund_r_a", &pt_hex(&r_a));
        self.joint = Some(joint); self.escrow = Some(escrow); self.fund = Some(fund);
        self.refund_info = Some(info); self.refund_r_a = Some(r_a); self.refund_pczt = Some(rp);
    }
    fn jfvk(&self) -> FullViewingKey {
        let jv: Value = serde_json::from_str(self.joint.as_ref().unwrap()).unwrap();
        chain::JointKeyInfo { ak: jv["ak"].as_str().unwrap().into(), nk: jv["nk"].as_str().unwrap().into(), rivk: jv["rivk"].as_str().unwrap().into() }.fvk().unwrap()
    }
    /// B4: complete the refund alone and keep it; then broadcast the funding.
    fn b4(&mut self, w: &World) {
        let rp: Value = serde_json::from_str(&w.relay.ch("refund_partial").unwrap()).unwrap();
        let partial = agent::partial_from(rp["partial"].as_str().unwrap()).unwrap();
        let pok = agent::pok_from(rp["pok"].as_str().unwrap()).unwrap();
        let i = self.refund_info.clone().unwrap();
        let sighash = hex::decode(&i.sighash).unwrap();
        let pre = self.payer.pre_sign(self.merchant_vk(w), &partial, &sighash, self.sid.as_bytes(), &pok, parse_scalar(&i.alpha).unwrap()).unwrap();
        let sig = self.payer.complete_refund(&pre, &partial).unwrap();
        let p = chain::apply_signature(chain::pczt_from_bytes(self.refund_pczt.as_ref().unwrap()).unwrap(), i.action_index, sig).unwrap();
        let p = chain::sign_lock_input(p, &self.tkey).unwrap();
        self.refund_signed = Some(chain::pczt_to_bytes(p).unwrap());
        let (raw, txid) = self.fund.clone().unwrap();
        w.chain.send_sync(raw).unwrap();
        w.relay.buyer_post("funding_txid", &txid);
    }
    /// B6: check the seller's settlement against OUR terms; send a nonce.
    fn b6(&mut self, w: &World) {
        let t: Value = serde_json::from_str(&w.relay.ch("settle_terms").unwrap()).unwrap();
        assert_eq!(t["kind"], "settle");
        assert_eq!(t["pay_to"].as_str(), w.relay.ch("merchant_address").as_deref());
        assert_eq!(t["amount"], PRICE_ZATS);
        assert_eq!(t["change_to"].as_str(), Some(self.ua.as_str()));
        assert_eq!(t["expiry_height"], self.e);
        let terms: SpendTerms = serde_json::from_value(t).unwrap();
        let mut escrow = self.escrow.clone().unwrap();
        escrow.height = w.chain.0.lock().unwrap().mined[&self.fund.as_ref().unwrap().1].1;
        let p = chain::pczt_from_bytes(&agent::unb64(&w.relay.ch("settle_pczt").unwrap()).unwrap()).unwrap();
        let info = chain::check_spend(&p, &self.jfvk(), &escrow.note().unwrap(), &terms).unwrap();
        let r_a = self.payer.new_nonce();
        w.relay.buyer_post("settle_r_a", &pt_hex(&r_a));
        self.settle_info = Some(info); self.settle_r_a = Some(r_a);
    }
    /// B7: pre-sign, locked to T (checked against the listing's T).
    fn b7(&mut self, w: &World) {
        let wire = w.relay.sess("partial").unwrap();
        assert!(protocol::WirePartial::parse(&wire).unwrap().is_masked(), "settlement partial is masked on the relay");
        assert!(agent::partial_from(&wire).is_err(), "a masked partial cannot be read as plain");
        let partial = self.payer.open_partial(&wire, Some(self.merchant_vk(w))).unwrap();
        let t_listing = protocol::parse_point(w.relay.listing.lock().unwrap()["t_point"].as_str().unwrap()).unwrap();
        assert_eq!(partial.t_point, t_listing, "partial is locked to the listing's T");
        let pok = agent::pok_from(&w.relay.sess("merchant_pok").unwrap()).unwrap();
        let i = self.settle_info.clone().unwrap();
        let pre = self.payer.pre_sign(self.merchant_vk(w), &partial, &hex::decode(&i.sighash).unwrap(), self.sid.as_bytes(), &pok, parse_scalar(&i.alpha).unwrap()).unwrap();
        assert_eq!(pre.vk_hex, i.rk);
        w.relay.buyer_presig(&serde_json::to_string(&pre).unwrap());
        self.presig = Some(pre);
    }
    /// B8: t from the MINED settlement; decrypt.
    fn b8(&self, w: &World) -> Vec<u8> {
        let txid = w.relay.ch("settle_txid").unwrap();
        assert_eq!(txid, self.settle_info.as_ref().unwrap().txid);
        let (raw, _) = w.chain.0.lock().unwrap().mined[&txid].clone();
        let pre = self.presig.as_ref().unwrap();
        let sig = protocol::find_signature(&raw, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex).unwrap();
        // the buyer's own copy of the partial, unmasked with its key share alone
        let partial = self.payer.open_partial(&w.relay.sess("partial").unwrap(), None).unwrap();
        let t = protocol::extract_t(parse_scalar(&hex::encode(&sig[32..])).unwrap(), parse_scalar(&pre.s_a_hex).unwrap(), partial.s_b);
        sealed::open(t, &w.offer).unwrap()
    }
}

fn waiting(s: &Status) -> bool { matches!(s, Status::Waiting(_)) }

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn agent_sells_on_chain_with_the_seller_offline() {
    let mut w = world(b"PoC: reentrancy in Vault.withdraw() lets anyone drain");
    assert!(waiting(&step(&mut w).await.unwrap()), "no buyer yet");
    agent::check_listing_matches(&w.listing, &w.relay.listing.lock().unwrap()).unwrap();

    let mut b = Buyer::join(&w, "S1");
    assert!(waiting(&step(&mut w).await.unwrap()), "waits for the key proof");
    b.b1(&w, false);
    // S1
    assert!(waiting(&settle_agent(&mut w).await.unwrap()));
    assert!(w.relay.ch("escrow_address").is_some() && w.relay.ch("merchant_contrib").is_some());
    assert_eq!(w.relay.ch("merchant_address").as_deref(), Some(w.listing.payout_address.as_str()));

    b.b3(&w, None);
    // S2: refund co-signed, valid only after E
    assert!(waiting(&settle_agent(&mut w).await.unwrap()));
    assert_eq!(w.listing.chain.e, Some(b.e));
    b.b4(&w);
    assert!(waiting(&step(&mut w).await.unwrap()), "funding not mined yet");
    w.chain.mine(&[]);

    // S3 (with a lost reply on settle_pczt: the agent must republish the SAME pczt)
    *w.relay.fail_once.lock().unwrap() = Some("settle_pczt".into());
    assert!(step(&mut w).await.is_err());
    let built = w.listing.chain.settle_pczt.clone().unwrap();
    w.chain.skip(3); // tip moves; a rebuild would change target_height
    assert!(matches!(step(&mut w).await.unwrap(), Status::Acted(_)));
    assert_eq!(w.relay.ch("settle_pczt").unwrap(), built);
    assert_eq!(w.listing.chain.settle_pczt.as_deref(), Some(built.as_str()));

    b.b6(&w);
    // S4
    assert!(waiting(&settle_agent(&mut w).await.unwrap()));
    b.b7(&w);
    // S5: broadcast reveals t
    assert!(waiting(&settle_agent(&mut w).await.unwrap()), "broadcast, not mined yet");
    let settle_txid = w.relay.ch("settle_txid").unwrap();
    assert_eq!(w.relay.listing.lock().unwrap()["status"], "sold");
    let h = w.chain.mine(&[]);
    assert_eq!(step(&mut w).await.unwrap(), Status::Sold(h));
    assert_eq!(step(&mut w).await.unwrap(), Status::Sold(h), "sold is final");

    // seller paid the price at the payout address; buyer decrypts the goods
    let (raw, _) = w.chain.0.lock().unwrap().mined[&settle_txid].clone();
    assert!(chain::find_notes(&raw, h, &w.merchant_fvk).unwrap().iter().any(|n| n.note.value().inner() == PRICE_ZATS));
    assert_eq!(b.b8(&w), w.payload);

    // An outside observer with the whole relay record (every session field,
    // as an unauthenticated read used to return it) and the mined settlement
    // cannot compute t: s - s_a - (anything public) is not t.
    let sess = w.relay.session.lock().unwrap().clone();
    let pre: protocol::PreSignature = serde_json::from_str(sess["presig"].as_str().unwrap()).unwrap();
    let sig = protocol::find_signature(&raw, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex).unwrap();
    let s = parse_scalar(&hex::encode(&sig[32..])).unwrap();
    let s_a = parse_scalar(&pre.s_a_hex).unwrap();
    let wire: Value = serde_json::from_str(sess["partial"].as_str().unwrap()).unwrap();
    assert!(wire.get("s_b").is_none(), "no s_b in the clear on the relay");
    let enc_sb = parse_scalar(wire["enc_sb"].as_str().unwrap()).unwrap();
    for guess in [s - s_a - enc_sb, s - s_a, s - enc_sb, s] {
        assert_ne!(guess, w.t, "observer recovered t from relay + chain data");
        assert!(sealed::open(guess, &w.offer).map_or(true, |p| p != w.payload), "observer decrypted the goods");
    }
    // the refund partial (T = identity) is the only plain one, and gives nothing
    let rp: Value = serde_json::from_str(sess["chain"]["refund_partial"].as_str().unwrap()).unwrap();
    let refund_partial = agent::partial_from(rp["partial"].as_str().unwrap()).unwrap();
    assert_ne!(s - s_a - refund_partial.s_b, w.t);

    // the buyer's refund (held since before funding) is a valid tx too, locked past E
    let refund = chain::pczt_from_bytes(b.refund_signed.as_ref().unwrap()).unwrap();
    let fund_h = w.chain.0.lock().unwrap().mined[&b.fund.as_ref().unwrap().1].1;
    let esc = b.escrow.clone().unwrap();
    let (refund_raw, _) = w.chain.finalize_sync(refund, fund_h, &hex::decode(&esc.cmx).unwrap().try_into().unwrap(), b.refund_info.as_ref().unwrap().action_index).unwrap();
    let rtx = chain::parse_tx(&refund_raw, START).unwrap();
    assert!(!chain::is_final(&rtx, b.e) && chain::is_final(&rtx, b.e + 1));
    // every relay write the agent made was a seller field, each once
    let posts = w.relay.posts.lock().unwrap().clone();
    let mut uniq = posts.clone(); uniq.sort(); uniq.dedup();
    assert_eq!(uniq.len(), posts.len(), "no field posted twice: {posts:?}");
}

#[tokio::test]
async fn agent_refuses_a_rogue_buyer_key() {
    let mut w = world(b"x");
    let mut b = Buyer::join(&w, "S1");
    b.b1(&w, true);
    let e = step(&mut w).await.unwrap_err();
    assert!(format!("{e:#}").contains("rogue key"), "{e:#}");
    assert!(w.relay.posts.lock().unwrap().is_empty(), "nothing published");
}

#[tokio::test]
async fn agent_refuses_a_refund_unlocked_before_the_claim_window_ends() {
    let mut w = world(b"x");
    let mut b = Buyer::join(&w, "S1");
    b.b1(&w, false);
    settle_agent(&mut w).await.unwrap();
    let early = w.chain.tip() + CLAIM_BLOCKS - 1;
    b.b3(&w, Some(early));
    assert!(step(&mut w).await.is_err());
    assert!(w.relay.ch("refund_partial").is_none(), "refund not co-signed");
}

#[tokio::test]
async fn agent_does_not_settle_near_the_end_of_the_claim_window() {
    let mut w = world(b"x");
    let mut b = Buyer::join(&w, "S1");
    b.b1(&w, false);
    settle_agent(&mut w).await.unwrap();
    b.b3(&w, None);
    settle_agent(&mut w).await.unwrap();
    b.b4(&w);
    w.chain.mine(&[]);
    // funding mined, but the agent was "offline" until close to E
    let left = b.e - w.chain.tip();
    w.chain.skip(left - agent::SAFETY_BLOCKS);
    let e = step(&mut w).await.unwrap_err();
    assert!(format!("{e:#}").contains("too close"), "{e:#}");
    assert!(w.relay.ch("settle_pczt").is_none());
}

#[tokio::test]
async fn handoff_and_listing_checks() {
    let w = world(b"x");
    // wrong T is refused
    let mut other = w.listing.clone();
    let (_, s2) = sealed::new_secret();
    other.merchant.secret = sealed::field_hex(&s2);
    assert!(agent::check_listing_matches(&other, &w.relay.listing.lock().unwrap()).is_err());
    // a handoff file as the app writes it
    let h: agent::Handoff = serde_json::from_value(json!({
        "kind": "lintel-agent-handoff", "v": 1, "relay": "https://relay.example/", "listing_id": "L1", "title": "PoC",
        "token": "seller-tok", "state": serde_json::to_string(&w.listing.merchant).unwrap(), "payout_address": w.listing.payout_address,
        "chain": { "sid": "S9", "contrib": "00", "E": 123, "settleTxid": null, "paidNote": 5 },
    })).unwrap();
    let l = h.into_listing().unwrap();
    assert_eq!(l.relay, "https://relay.example");
    assert_eq!(l.chain.e, Some(123));
    assert_eq!(l.chain.sid.as_deref(), Some("S9"));
    let bad: agent::Handoff = serde_json::from_value(json!({ "kind": "x", "v": 1, "relay": "r", "listing_id": "L1", "token": "t",
        "state": "{}", "payout_address": "" })).unwrap();
    assert!(bad.into_listing().is_err());
    let _ = anyhow!("");
}
