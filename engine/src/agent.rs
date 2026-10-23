//! Seller agent: runs the seller's side of an on-chain sale without a browser.
//!
//! This is the same state machine as `advanceSeller` in `web/app/src/onchain.js`
//! (steps S1 to S5), on the engine directly instead of through WASM, so a
//! seller can close the app and let a process they run (a laptop, a VPS, a
//! Raspberry Pi) finish the sale. Every check the browser makes is made here,
//! in the same order:
//!
//! * S1: the buyer's proof of knowledge of its key share is verified before
//!   anything else (rogue-key check), then the escrow key is bound and announced.
//! * S2: the time-locked refund is co-signed only if the escrow note pays the
//!   joint address, covers price + fee, refunds to the buyer's announced
//!   address, the claim window is long enough, and the refund's lock starts
//!   after the claim window ends. The signed message comes from this agent's
//!   OWN check of the PCZT, never from the counterparty.
//! * S3: the settlement is built only after the funding is mined and contains
//!   the agreed escrow note, and not within [`SAFETY_BLOCKS`] of the expiry.
//! * S4: the partial signature signs this agent's own sighash and alpha.
//! * S5: the buyer's pre-signature is verified before completing; the
//!   completed signature is verified; the finalized txid must equal the one
//!   checked in S3. Broadcasting reveals `t`: that is the sale.
//!
//! Differences from the browser, all on the safe side:
//! * Each write-once relay field is posted only if it is still missing, and
//!   anything already built is reused, so a crash between two posts never
//!   leaves a field unpublished or publishes two different values.
//! * State is saved to disk before anything that depends on it is published.
//! * If the relay replaced the session (a stale, unfunded one), the agent's
//!   per-session state is reset instead of carried over.
//!
//! What the agent holds: the merchant signing share and the adaptor secret
//! `t` for each delegated listing, and the relay seller token. It never holds
//! a wallet spending key: payouts go to an address the seller chose.
//! Whoever runs the agent can complete the sale, so run it on a machine you
//! control.
//!
//! Networking is abstracted behind [`Relay`] and [`Chain`] so the whole flow
//! is testable offline (`tests/agent.rs`).

use anyhow::{anyhow, bail, ensure, Context, Result};
use ff::PrimeField;
use group::GroupEncoding;
use pasta_curves::pallas::{Point, Scalar};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::chain::{self, JointKeyInfo, NoteRecord, SigningInfo, SpendTerms};
use crate::protocol::{self, BuyerPartial, KnowledgeProof, PreSignature, WirePartial};
use crate::sealed;

/// Same constants as `web/app/src/onchain.js`.
pub const SETTLE_FEE: u64 = 10_000; // zip317_fee(2, 0, 0)
/// The agent refuses to build or broadcast the settlement within this many
/// blocks of the claim window's end.
pub const SAFETY_BLOCKS: u32 = 10;

// ---------------------------------------------------------------- wire formats (match wasm/src/lib.rs)

fn pt_hex(p: &Point) -> String { hex::encode(p.to_bytes()) }
fn sc_hex(s: &Scalar) -> String { hex::encode(s.to_repr()) }
fn pt(h: &str, what: &str) -> Result<Point> { protocol::parse_point(h).ok_or_else(|| anyhow!("invalid {what}")) }
fn sc(h: &str, what: &str) -> Result<Scalar> { protocol::parse_scalar(h).ok_or_else(|| anyhow!("invalid {what}")) }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MerchantState { pub sk_b: String, pub secret: String, #[serde(default)] pub negated: bool }
#[derive(Serialize, Deserialize)]
struct PokWire { r_point: String, s: String }

fn pok_to(p: &KnowledgeProof) -> String {
    serde_json::to_string(&PokWire { r_point: pt_hex(&p.r_point), s: sc_hex(&p.s) }).unwrap()
}
pub fn pok_from(j: &str) -> Result<KnowledgeProof> {
    let w: PokWire = serde_json::from_str(j).context("invalid proof json")?;
    Ok(KnowledgeProof { r_point: pt(&w.r_point, "proof point")?, s: sc(&w.s, "proof scalar")? })
}
/// Parses a partial whose `s_b` is in the clear (v1: the refund partial).
/// A masked (v2) settlement partial is refused here: open it with the key
/// share it is masked to (`protocol::Seller::open_partial` for the payer).
pub fn partial_from(j: &str) -> Result<BuyerPartial> {
    match WirePartial::parse(j).map_err(|e| anyhow!(e))? {
        WirePartial::Plain(p) => Ok(p),
        WirePartial::Masked { .. } => bail!("masked partial: only the payer or the merchant can open it"),
    }
}

// ---------------------------------------------------------------- merchant (port of the wasm `Merchant`)

/// The seller's signing share and adaptor secret. SECRET.
pub struct Merchant { inner: protocol::Buyer, secret: pasta_curves::pallas::Base, negated: bool }

impl Merchant {
    pub fn from_state(w: &MerchantState) -> Result<Self> {
        let sk_b = sc(&w.sk_b, "signing share")?;
        let secret = sealed::parse_field(&w.secret).ok_or_else(|| anyhow!("invalid secret"))?;
        Ok(Self { inner: protocol::Buyer::from_parts(sk_b, sealed::scalar_from_base(secret)), secret, negated: w.negated })
    }
    pub fn export_state(&self) -> MerchantState {
        MerchantState { sk_b: sc_hex(&self.inner.sk_b), secret: sealed::field_hex(&self.secret), negated: self.negated }
    }
    pub fn t_point(&self) -> Point { self.inner.t_point() }
    pub fn verification_key(&self) -> Point { self.inner.vk_b }
    fn peer(&self, h: &str) -> Result<Point> {
        let p = pt(h, "payer key")?;
        Ok(if self.negated { -p } else { p })
    }
    /// Binds to `ak = vk_payer + vk_merchant` (ỹ = 0), negating this share if
    /// needed. Idempotent. Returns `ak` hex.
    pub fn bind_joint(&mut self, payer_vk: &str) -> Result<String> {
        let p = self.peer(payer_vk)?;
        let (ak, neg) = protocol::joint_ak(p, self.inner.vk_b).map_err(|e| anyhow!(e))?;
        if neg { self.inner.negate_share(); self.negated = !self.negated; }
        Ok(pt_hex(&ak))
    }
    pub fn verify_payer_knowledge(&self, payer_vk: &str, pok: &str, session: &[u8]) -> Result<bool> {
        let p = self.peer(payer_vk)?;
        Ok(protocol::verify_knowledge(p, &pok_from(pok)?, p, self.inner.vk_b, session))
    }
    fn prove_knowledge(&self, payer_vk: &str, session: &[u8]) -> Result<String> {
        Ok(pok_to(&self.inner.prove_knowledge(self.peer(payer_vk)?, session)))
    }
    /// `{partial, pok}` for the refund (adaptor secret zero).
    pub fn refund_partial(&self, r_a: &str, payer_vk: &str, alpha: &str, sighash: &[u8], session: &[u8]) -> Result<(String, String)> {
        let p = self.inner.refund_partial(pt(r_a, "nonce")?, self.peer(payer_vk)?, sc(alpha, "alpha")?, sighash);
        // T is the identity here, so s_b in the clear reveals nothing.
        Ok((protocol::partial_to_plain_json(&p), self.prove_knowledge(payer_vk, session)?))
    }
    /// `{partial, pok}` for the settlement (locked to T). The partial is the
    /// masked v2 wire format: `s_b` is readable only by the payer (and this
    /// merchant), so the relay record plus the mined `s` do not give `t`.
    pub fn respond(&self, r_a: &str, payer_vk: &str, alpha: &str, sighash: &[u8], session: &[u8]) -> Result<(String, String)> {
        let vk_a = self.peer(payer_vk)?;
        let p = self.inner.partial(pt(r_a, "nonce")?, vk_a, sc(alpha, "alpha")?, sighash);
        let wire = self.inner.masked_partial_json(&p, vk_a).map_err(|e| anyhow!(e))?;
        Ok((wire, self.prove_knowledge(payer_vk, session)?))
    }
    /// Verifies the buyer's pre-signature, completes it, verifies the result.
    /// The returned signature reveals `t` once published.
    pub fn complete(&self, presig: &str, r_a: &str, partial: &str, payer_vk: &str, alpha: &str) -> Result<[u8; 64]> {
        let pre: PreSignature = serde_json::from_str(presig).context("invalid pre-signature json")?;
        if let WirePartial::Masked { vk_a, .. } = WirePartial::parse(partial).map_err(|e| anyhow!(e))? {
            let p = self.peer(payer_vk)?;
            ensure!(vk_a == p || vk_a == -p, "partial is masked to a different payer key");
        }
        let part = self.inner.open_partial(partial).map_err(|e| anyhow!(e))?;
        ensure!(
            self.inner.verify_presig(&pre, pt(r_a, "nonce")?, part.r_b, self.peer(payer_vk)?, sc(alpha, "alpha")?),
            "buyer pre-signature is invalid"
        );
        let sig = self.inner.complete(&pre, &part).ok_or_else(|| anyhow!("complete failed"))?;
        ensure!(self.inner.verify_completed(&pre, &sig), "completed signature does not verify");
        Ok(sig)
    }
}

// ---------------------------------------------------------------- persisted state

/// Per-session chain state. Field names match the browser's
/// `selling[lid].chain` object so a handoff can carry a sale in progress.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SellerChain {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub sid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub contrib: Option<String>,
    /// Joint key handle, as JSON text (same as the browser's `chainJoint` output).
    #[serde(default, skip_serializing_if = "Option::is_none")] pub joint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub ak: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub payout: Option<String>,
    #[serde(default, rename = "E", skip_serializing_if = "Option::is_none")] pub e: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub escrow: Option<NoteRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub refund_txid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub settle_terms: Option<SpendTerms>,
    /// Unsigned settlement PCZT, base64 (as the browser stores it).
    #[serde(default, skip_serializing_if = "Option::is_none")] pub settle_pczt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub settle_info: Option<SigningInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub settle_txid: Option<String>,
    /// Height the settlement was mined at (agent only; the sale is finished).
    #[serde(default, skip_serializing_if = "Option::is_none")] pub sold_height: Option<u32>,
}

/// One delegated listing, as stored in the agent's directory. SECRET.
#[derive(Serialize, Deserialize, Clone)]
pub struct AgentListing {
    pub v: u32,
    pub relay: String,
    pub listing_id: String,
    pub title: String,
    /// Relay seller token (authenticates the seller's writes).
    pub token: String,
    pub merchant: MerchantState,
    /// Where the settlement pays the price (the seller's Unified Address).
    pub payout_address: String,
    #[serde(default)]
    pub chain: SellerChain,
}

/// The file the app's "Hand off to agent" button downloads. SECRET.
#[derive(Deserialize)]
pub struct Handoff {
    pub kind: String,
    pub v: u32,
    pub relay: String,
    pub listing_id: String,
    #[serde(default)]
    pub title: String,
    pub token: String,
    /// Merchant state exactly as the app stores it (`exportState` JSON text).
    pub state: String,
    pub payout_address: String,
    #[serde(default)]
    pub chain: Option<SellerChain>,
}

impl Handoff {
    pub fn into_listing(self) -> Result<AgentListing> {
        ensure!(self.kind == "lintel-agent-handoff", "not a Lintel agent handoff file");
        ensure!(self.v == 1, "unsupported handoff version {}", self.v);
        let merchant: MerchantState = serde_json::from_str(&self.state).context("merchant state")?;
        Merchant::from_state(&merchant)?;
        chain::decode_ua(&self.payout_address).context("payout address")?;
        Ok(AgentListing {
            v: 1, relay: self.relay.trim_end_matches('/').to_string(), listing_id: self.listing_id, title: self.title,
            token: self.token, merchant, payout_address: self.payout_address, chain: self.chain.unwrap_or_default(),
        })
    }
}

/// Checks the delegated secrets belong to the listing the relay publishes:
/// `T = [t]G` and the merchant key (either sign, after a joint-key negation).
pub fn check_listing_matches(l: &AgentListing, listing: &Value) -> Result<()> {
    let m = Merchant::from_state(&l.merchant)?;
    let t = listing["t_point"].as_str().ok_or_else(|| anyhow!("listing has no t_point (presale listings are not supported)"))?;
    ensure!(pt(t, "listing T")? == m.t_point(), "this handoff's adaptor secret does not match the listing's T");
    let vk = pt(listing["merchant_vk"].as_str().unwrap_or_default(), "listing merchant key")?;
    let mine = m.verification_key();
    ensure!(vk == mine || vk == -mine, "this handoff's signing share does not match the listing's merchant key");
    Ok(())
}

// ---------------------------------------------------------------- I/O abstractions

/// The relay's seller-side API.
#[allow(async_fn_in_trait)]
pub trait Relay {
    /// `GET /listings/:id` -> `(listing, session or null)`.
    async fn listing(&self, lid: &str) -> Result<(Value, Value)>;
    /// `POST /sessions/:sid/chain/:field` with `{value}`.
    async fn post_chain(&self, sid: &str, field: &str, value: &str, token: &str) -> Result<()>;
    /// `POST /sessions/:sid/partial` with `{partial, merchant_pok}`.
    async fn post_partial(&self, sid: &str, partial: &str, pok: &str, token: &str) -> Result<()>;
}

/// Public chain data and broadcast.
#[allow(async_fn_in_trait)]
pub trait Chain {
    async fn height(&self) -> Result<u32>;
    /// `(raw tx, height)` once mined, `None` while unknown or in the mempool.
    async fn mined(&self, txid: &str) -> Result<Option<(Vec<u8>, u32)>>;
    /// Whether the node knows `txid` at all (mined or in the mempool).
    async fn known(&self, txid: &str) -> Result<bool>;
    /// Witness from public data, prove, verify: `(raw tx, txid)`.
    async fn finalize(&self, pczt: pczt::Pczt, note_height: u32, cmx: &[u8; 32], action_index: usize) -> Result<(Vec<u8>, String)>;
    /// `Ok(())` if accepted, `Err` with the node's message otherwise.
    async fn send(&self, raw: Vec<u8>) -> Result<()>;
}

// ---------------------------------------------------------------- helpers

/// "0.02" ZEC -> 2000000 zats, exactly (same rule as `zats` in onchain.js).
pub fn zats(zec: &str) -> Result<u64> {
    let s = zec.trim();
    let (w, f) = s.split_once('.').unwrap_or((s, ""));
    ensure!(!w.is_empty() && w.len() <= 8 && w.bytes().all(|b| b.is_ascii_digit()), "bad amount {zec}");
    ensure!(f.len() <= 8 && f.bytes().all(|b| b.is_ascii_digit()) && !(s.contains('.') && f.is_empty()), "bad amount {zec}");
    let frac = format!("{f:0<8}");
    Ok(w.parse::<u64>()? * 100_000_000 + frac.parse::<u64>()?)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (what the browser's `btoa` produces).
pub fn b64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() { out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char) } else { out.push('=') }
        }
    }
    out
}

pub fn unb64(s: &str) -> Result<Vec<u8>> {
    let s = s.trim().as_bytes();
    ensure!(s.len() % 4 == 0, "bad base64 length");
    let val = |b: u8| -> Result<u32> { B64.iter().position(|x| *x == b).map(|p| p as u32).ok_or_else(|| anyhow!("bad base64")) };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for (ci, c) in s.chunks(4).enumerate() {
        let last = ci == s.len() / 4 - 1;
        let pad = c.iter().rev().take_while(|b| **b == b'=').count();
        ensure!(pad <= 2 && (pad == 0 || last), "bad base64 padding");
        let mut n = 0u32;
        for (i, b) in c.iter().enumerate() { n |= if i < 4 - pad { val(*b)? } else { 0 } << (18 - 6 * i) }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Ok(out)
}

fn h32(h: &str) -> Result<[u8; 32]> { hex::decode(h)?.try_into().map_err(|_| anyhow!("expected 32 bytes")) }

/// Joint escrow key from `ak`, the session id and both contributions; same
/// JSON as the wasm `chainJoint` (so it is interchangeable with the app's).
pub fn joint(ak_hex: &str, session: &[u8], contrib_payer: &str, contrib_merchant: &str) -> Result<String> {
    let (nk, rivk) = chain::derive_nk_rivk(session, &h32(contrib_payer)?, &h32(contrib_merchant)?);
    let info = JointKeyInfo { ak: ak_hex.into(), nk: hex::encode(nk), rivk: hex::encode(rivk) };
    let fvk = info.fvk()?;
    ensure!(fvk.to_bytes()[..32] == h32(ak_hex)?, "escrow key does not use the agreed ak");
    Ok(json!({
        "kind": "joint", "ak": info.ak, "nk": info.nk, "rivk": info.rivk,
        "escrow_address": chain::encode_ua(&chain::joint_address(&fvk)),
        "escrow_raw": hex::encode(chain::joint_address(&fvk).to_raw_address_bytes()),
        "ufvk": chain::encode_ufvk(&fvk),
    }).to_string())
}

fn joint_fvk(joint_json: &str) -> Result<orchard::keys::FullViewingKey> {
    let v: Value = serde_json::from_str(joint_json).context("joint json")?;
    let s = |k: &str| v[k].as_str().map(String::from).ok_or_else(|| anyhow!("joint json: missing {k}"));
    JointKeyInfo { ak: s("ak")?, nk: s("nk")?, rivk: s("rivk")? }.fvk()
}

fn get_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> { v.get(k).and_then(Value::as_str) }

// ---------------------------------------------------------------- the state machine

/// What one call to [`advance`] did or is waiting for.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Nothing to do yet; the string says what the agent is waiting for.
    Waiting(String),
    /// A step was taken.
    Acted(String),
    /// The sale is finished (settlement mined at this height).
    Sold(u32),
}

/// Advances one delegated listing by at most one step. `save` persists the
/// listing (it is called before any value that depends on new local state is
/// published). Errors leave the state as saved; the next call retries.
pub async fn advance<R: Relay, C: Chain>(
    l: &mut AgentListing,
    relay: &R,
    chain: &C,
    save: &mut impl FnMut(&AgentListing) -> Result<()>,
) -> Result<Status> {
    if let Some(h) = l.chain.sold_height { return Ok(Status::Sold(h)); }
    let (listing, session) = relay.listing(&l.listing_id).await?;
    if session.is_null() { return Ok(Status::Waiting("no buyer yet".into())); }
    if get_str(&session, "mode") != Some("chain") {
        return Ok(Status::Waiting("this sale is off-chain (relay mode); the agent only settles on-chain sales".into()));
    }
    let sid = get_str(&session, "id").ok_or_else(|| anyhow!("session without id"))?.to_string();
    let payer_vk = get_str(&session, "payer_vk").ok_or_else(|| anyhow!("session without payer_vk"))?.to_string();
    let ch = session.get("chain").cloned().unwrap_or(Value::Null);
    let f = |k: &str| get_str(&ch, k).map(String::from);
    let sess = sid.as_bytes();

    // A different session than the one our per-session state is for: the relay
    // only replaces unfunded sessions, so start that session from scratch.
    if l.chain.sid.as_deref().is_some_and(|s| s != sid) {
        ensure!(l.chain.settle_txid.is_none(), "relay replaced a session this agent already settled");
        l.chain = SellerChain::default();
        save(l)?;
    }

    let mut m = Merchant::from_state(&l.merchant)?;

    // S1: rogue-key check BEFORE anything else, then bind and announce the escrow.
    if f("merchant_contrib").is_none() || f("merchant_address").is_none() || f("escrow_address").is_none() {
        let (Some(pok), Some(payer_contrib), Some(_)) = (f("payer_pok"), f("payer_contrib"), f("payer_address")) else {
            return Ok(Status::Waiting("buyer joined; waiting for their key proof".into()));
        };
        let ak = m.bind_joint(&payer_vk)?;
        if m.export_state() != l.merchant { l.merchant = m.export_state(); save(l)?; }
        ensure!(m.verify_payer_knowledge(&payer_vk, &pok, sess)?, "buyer key proof is invalid (possible rogue key): not proceeding");
        // Reuse a contribution already published (or saved) for this session.
        let contrib = f("merchant_contrib").or(l.chain.contrib.clone())
            .unwrap_or_else(|| hex::encode(rand::random::<[u8; 32]>()));
        let joint_json = joint(&ak, sess, &payer_contrib, &contrib)?;
        let escrow_address = get_str(&serde_json::from_str::<Value>(&joint_json)?, "escrow_address").unwrap().to_string();
        let payout = f("merchant_address").or(l.chain.payout.clone()).unwrap_or_else(|| l.payout_address.clone());
        if let Some(a) = f("escrow_address") { ensure!(a == escrow_address, "relay shows an escrow address this agent did not derive"); }
        l.chain.sid = Some(sid.clone());
        l.chain.contrib = Some(contrib.clone());
        l.chain.joint = Some(joint_json);
        l.chain.ak = Some(ak);
        l.chain.payout = Some(payout.clone());
        save(l)?;
        if f("merchant_contrib").is_none() { relay.post_chain(&sid, "merchant_contrib", &contrib, &l.token).await?; }
        if f("merchant_address").is_none() { relay.post_chain(&sid, "merchant_address", &payout, &l.token).await?; }
        if f("escrow_address").is_none() { relay.post_chain(&sid, "escrow_address", &escrow_address, &l.token).await?; }
        return Ok(Status::Acted("escrow key bound (buyer proof checked); escrow address announced".into()));
    }
    let joint_json = l.chain.joint.clone().ok_or_else(|| anyhow!("escrow was bound by another device; this agent has no joint key for it"))?;
    ensure!(l.chain.sid.as_deref() == Some(sid.as_str()), "local escrow state is for another session");
    let jfvk = joint_fvk(&joint_json)?;
    let jv: Value = serde_json::from_str(&joint_json)?;
    let price = zats(get_str(&listing, "price_zec").ok_or_else(|| anyhow!("listing has no price"))?)?;

    // S2: co-sign the time-locked refund, before the buyer funds (lock >= E).
    if f("refund_partial").is_none() {
        let (Some(rt), Some(rp), Some(r_a)) = (f("refund_terms"), f("refund_pczt"), f("refund_r_a")) else {
            return Ok(Status::Waiting("waiting for the buyer to build the funding and refund".into()));
        };
        #[derive(Deserialize)]
        struct RefundTerms { terms: SpendTerms, settle_expiry: u32, escrow_note: NoteRecord }
        let RefundTerms { terms, settle_expiry: e, escrow_note: note } = serde_json::from_str(&rt).context("refund_terms")?;
        let tip = chain.height().await?;
        ensure!(Some(note.recipient.as_str()) == get_str(&jv, "escrow_raw"), "escrow note is not paid to the joint escrow address");
        ensure!(note.value >= price + SETTLE_FEE, "escrow note is smaller than price + fee");
        ensure!(e >= tip + 2 * SAFETY_BLOCKS, "claim window too short (expires at {e}, tip {tip})");
        ensure!(Some(terms.pay_to.as_str()) == get_str(&ch, "payer_address"), "refund must go to the buyer's announced address");
        chain::check_refund_window(&terms, e)?;
        let info = chain::check_spend(&chain::pczt_from_bytes(&unb64(&rp)?)?, &jfvk, &note.note()?, &terms)?;
        let (partial, pok) = m.refund_partial(&r_a, &payer_vk, &info.alpha, &hex::decode(&info.sighash)?, sess)?;
        l.chain.e = Some(e);
        l.chain.escrow = Some(note);
        l.chain.refund_txid = Some(info.txid.clone());
        save(l)?;
        relay.post_chain(&sid, "refund_partial", &json!({ "partial": partial, "pok": pok }).to_string(), &l.token).await?;
        return Ok(Status::Acted(format!("refund co-signed (valid only after block {e}); waiting for the buyer to fund")));
    }
    let e = l.chain.e.ok_or_else(|| anyhow!("refund was co-signed by another device; this agent has no claim-window state"))?;

    // S3: funding mined -> build the settlement (not within SAFETY_BLOCKS of E).
    if f("settle_pczt").is_none() || f("settle_terms").is_none() {
        if l.chain.settle_pczt.is_none() {
            let Some(funding) = f("funding_txid") else { return Ok(Status::Waiting("waiting for the buyer to broadcast the funding".into())) };
            let Some((raw, height)) = chain.mined(&funding).await? else {
                return Ok(Status::Waiting(format!("funding {}… seen; waiting for it to be mined", &funding[..12.min(funding.len())])));
            };
            let agreed = l.chain.escrow.clone().ok_or_else(|| anyhow!("no agreed escrow note"))?;
            let found = chain::find_notes(&raw, height, &jfvk)?;
            let escrow = found.iter().map(|n| NoteRecord::from_found(n, &funding, height)).find(|n| n.cmx == agreed.cmx)
                .ok_or_else(|| anyhow!("mined funding does not contain the agreed escrow note"))?;
            let tip = chain.height().await?;
            ensure!(tip + SAFETY_BLOCKS < e, "too close to the end of the claim window (tip {tip}, expiry {e}): not settling; the buyer can refund after {e}");
            let terms = SpendTerms {
                kind: "settle".into(), pay_to: l.chain.payout.clone().unwrap_or_else(|| l.payout_address.clone()), amount: price,
                change_to: f("payer_address"), target_height: tip + 1, expiry_height: e, lock: None, t_out: None,
            };
            let p = chain::build_spend(&jfvk, &escrow.note()?, &terms)?;
            let bytes = chain::pczt_to_bytes(p)?;
            let info = chain::check_spend(&chain::pczt_from_bytes(&bytes)?, &jfvk, &escrow.note()?, &terms)?;
            l.chain.escrow = Some(escrow);
            l.chain.settle_terms = Some(terms);
            l.chain.settle_pczt = Some(b64(&bytes));
            l.chain.settle_info = Some(info);
            save(l)?;
        }
        // Publish exactly what was saved (never rebuild after a partial publish).
        let terms = serde_json::to_string(l.chain.settle_terms.as_ref().unwrap())?;
        if f("settle_terms").is_none() { relay.post_chain(&sid, "settle_terms", &terms, &l.token).await?; }
        if f("settle_pczt").is_none() { relay.post_chain(&sid, "settle_pczt", l.chain.settle_pczt.as_ref().unwrap(), &l.token).await?; }
        let t = l.chain.settle_terms.as_ref().unwrap();
        return Ok(Status::Acted(format!("settlement built (pays {} zats to the payout address, expires at {})", t.amount, t.expiry_height)));
    }
    let info = l.chain.settle_info.clone().ok_or_else(|| anyhow!("settlement was built by another device; this agent cannot sign it"))?;
    // The relay must show the settlement we built.
    ensure!(f("settle_pczt") == l.chain.settle_pczt, "relay shows a settlement PCZT this agent did not build");

    // S4: partial signature over OUR OWN check's sighash and alpha.
    let partial_v = session.get("partial").and_then(Value::as_str).map(String::from);
    if partial_v.is_none() {
        let Some(r_a) = f("settle_r_a") else { return Ok(Status::Waiting("waiting for the buyer to check the settlement".into())) };
        let (partial, pok) = m.respond(&r_a, &payer_vk, &info.alpha, &hex::decode(&info.sighash)?, sess)?;
        relay.post_partial(&sid, &partial, &pok, &l.token).await?;
        return Ok(Status::Acted("partial signature sent; waiting for the buyer's pre-signature".into()));
    }

    // S5: complete, prove, broadcast. Broadcasting reveals t (that is the sale).
    if f("settle_txid").is_none() {
        if l.chain.settle_txid.is_none() {
            let Some(presig) = session.get("presig").and_then(Value::as_str) else {
                return Ok(Status::Waiting("waiting for the buyer's pre-signature".into()));
            };
            let r_a = f("settle_r_a").ok_or_else(|| anyhow!("missing settle_r_a"))?;
            let tip = chain.height().await?;
            ensure!(tip + 1 <= e, "claim window closed: the settlement can no longer be mined");
            let sig = m.complete(presig, &r_a, partial_v.as_ref().unwrap(), &payer_vk, &info.alpha)?;
            let p = chain::apply_signature(chain::pczt_from_bytes(&unb64(l.chain.settle_pczt.as_ref().unwrap())?)?, info.action_index, sig)?;
            let escrow = l.chain.escrow.clone().ok_or_else(|| anyhow!("no escrow note"))?;
            ensure!(escrow.height > 0, "escrow note is not mined yet");
            let (raw, txid) = chain.finalize(p, escrow.height, &h32(&escrow.cmx)?, info.action_index).await?;
            ensure!(txid == info.txid, "settlement txid changed");
            if let Err(err) = chain.send(raw).await {
                // retry after a lost reply: fine if the node already has it
                ensure!(chain.known(&txid).await.unwrap_or(false), "node rejected the settlement: {err:#}");
            }
            l.chain.settle_txid = Some(txid);
            save(l)?;
        }
        let txid = l.chain.settle_txid.clone().unwrap();
        relay.post_chain(&sid, "settle_txid", &txid, &l.token).await?;
        return Ok(Status::Acted(format!("settlement broadcast: {txid}")));
    }
    let txid = f("settle_txid").unwrap();
    if l.chain.settle_txid.as_deref().is_some_and(|t| t != txid) { bail!("relay shows a different settlement txid than this agent broadcast"); }
    match chain.mined(&txid).await? {
        None => Ok(Status::Waiting(format!("settlement {}… broadcast; waiting for it to be mined", &txid[..12.min(txid.len())]))),
        Some((_, h)) => {
            l.chain.sold_height = Some(h);
            save(l)?;
            Ok(Status::Sold(h))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zats_matches_the_app() {
        assert_eq!(zats("0.02").unwrap(), 2_000_000);
        assert_eq!(zats("1").unwrap(), 100_000_000);
        assert_eq!(zats(" 0.00000001 ").unwrap(), 1);
        assert_eq!(zats("12345678.12345678").unwrap(), 1_234_567_812_345_678);
        for bad in ["", ".5", "1.", "1.123456789", "123456789", "-1", "1e3", "0x1"] { assert!(zats(bad).is_err(), "{bad}"); }
    }

    #[test]
    fn base64_round_trip() {
        for n in 0..40 {
            let d: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(unb64(&b64(&d)).unwrap(), d);
        }
        assert_eq!(b64(b"Man"), "TWFu");
        assert_eq!(b64(b"Ma"), "TWE=");
        assert_eq!(b64(b"M"), "TQ==");
        assert!(unb64("TQ=").is_err());
        assert!(unb64("T=Q=").is_err());
    }

    #[test]
    fn merchant_state_round_trip_and_negation() {
        let (t, s) = sealed::new_secret();
        let b = protocol::Buyer::with_secret(t);
        let st = MerchantState { sk_b: sc_hex(&b.sk_b), secret: sealed::field_hex(&s), negated: false };
        let mut m = Merchant::from_state(&st).unwrap();
        assert_eq!(m.export_state(), st);
        assert_eq!(m.t_point(), b.t_point());
        let payer = protocol::Seller::new();
        let ak1 = m.bind_joint(&pt_hex(&payer.vk_a)).unwrap();
        // idempotent, and survives export/restore
        assert_eq!(m.bind_joint(&pt_hex(&payer.vk_a)).unwrap(), ak1);
        let mut m2 = Merchant::from_state(&m.export_state()).unwrap();
        assert_eq!(m2.bind_joint(&pt_hex(&payer.vk_a)).unwrap(), ak1);
    }
}
