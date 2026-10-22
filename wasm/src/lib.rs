//! Browser bindings for Lintel.
//!
//! Roles, named for the app:
//! * `Merchant` sells sealed content. It holds the adaptor secret `t`,
//!   completes the signature and gets paid (`protocol::Buyer` in the engine).
//! * `Payer` buys. It pre-signs locked to `T` and extracts `t` from the final
//!   signature to decrypt (`protocol::Seller` in the engine).
//!
//! Every value crossing this boundary is hex or JSON. Secret values (`t`,
//! signing keys, nonces, plaintext) stay inside these objects or the caller's
//! device; nothing here talks to the network.

use ff::PrimeField;
use group::GroupEncoding;
use lintel::protocol::{self, parse_point, parse_scalar, BuyerPartial, KnowledgeProof, PreSignature};
use lintel::sealed::{self, prove::Keys, SealedOffer, SealedOfferWire, CHUNKS};
use pasta_curves::pallas::{Point, Scalar};
use serde::{Deserialize, Serialize};
use std::cell::OnceCell;
use wasm_bindgen::prelude::*;

type R<T> = Result<T, JsError>;

fn err(msg: &str) -> JsError { JsError::new(msg) }
fn pt_hex(p: &Point) -> String { hex::encode(p.to_bytes()) }
fn sc_hex(s: &Scalar) -> String { hex::encode(s.to_repr()) }
fn pt(h: &str, what: &str) -> R<Point> { parse_point(h).ok_or_else(|| err(&format!("invalid {what}"))) }
fn sc(h: &str, what: &str) -> R<Scalar> { parse_scalar(h).ok_or_else(|| err(&format!("invalid {what}"))) }
fn bytes(h: &str, what: &str) -> R<Vec<u8>> { hex::decode(h).map_err(|_| err(&format!("invalid {what}"))) }

thread_local! {
    static KEYS: OnceCell<Keys<CHUNKS>> = const { OnceCell::new() };
}

fn with_keys<T>(f: impl FnOnce(&Keys<CHUNKS>) -> T) -> R<T> {
    KEYS.with(|cell| {
        if cell.get().is_none() {
            let k = sealed::prove::setup::<CHUNKS>().map_err(|_| err("proving key setup failed"))?;
            let _ = cell.set(k);
        }
        Ok(f(cell.get().unwrap()))
    })
}

#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// Builds the proving/verifying keys now (a few seconds), so the first
/// seal or verify does not stall.
#[wasm_bindgen(js_name = warmUp)]
pub fn warm_up() -> R<()> { with_keys(|_| ()) }

/// BLAKE2b-256 (personal "lintel-params-v1") of the published parameter
/// file `params.bin`. Regenerate with `cargo run --release --example dump_params`.
const PINNED_PARAMS: &str = "f1a631a8b9c33f8ce09c5d7534783e282adcc945d08a24d7e96d58b153b97db2";

/// Builds the keys from the published parameter file (fetched by the app),
/// skipping the slowest setup step. Rejects any file whose digest differs.
#[wasm_bindgen(js_name = warmUpWithParams)]
pub fn warm_up_with_params(bytes: &[u8]) -> R<()> {
    let mut pinned = [0u8; 32];
    hex::decode_to_slice(PINNED_PARAMS, &mut pinned).map_err(|_| err("bad pin"))?;
    KEYS.with(|cell| {
        if cell.get().is_none() {
            let k = sealed::prove::setup_from_params::<CHUNKS>(bytes, &pinned).map_err(err)?;
            let _ = cell.set(k);
        }
        Ok(())
    })
}

/// Largest payload one offer can carry, in bytes.
#[wasm_bindgen(js_name = maxPayloadBytes)]
pub fn max_payload_bytes() -> usize { (CHUNKS - 1) * sealed::BYTES_PER_CHUNK }

/// Content hash the payer should expect, as hex.
#[wasm_bindgen(js_name = contentHash)]
pub fn content_hash(payload: &[u8]) -> R<String> {
    sealed::content_hash_bytes::<CHUNKS>(payload)
        .map(|h| sealed::field_hex(&h))
        .ok_or_else(|| err("payload too large"))
}

// ---------- wire types ----------

#[derive(Serialize, Deserialize)]
struct MerchantState { sk_b: String, secret: String, #[serde(default)] negated: bool }
#[derive(Serialize, Deserialize)]
struct PayerState { sk_a: String, pending_r_a: Option<String>, negated: bool }
#[derive(Serialize, Deserialize)]
struct PokWire { r_point: String, s: String }
#[derive(Serialize, Deserialize)]
struct PartialWire { r_b: String, s_b: String, t_point: String }

fn pok_to(p: &KnowledgeProof) -> String {
    serde_json::to_string(&PokWire { r_point: pt_hex(&p.r_point), s: sc_hex(&p.s) }).unwrap()
}
fn pok_from(j: &str) -> R<KnowledgeProof> {
    let w: PokWire = serde_json::from_str(j).map_err(|_| err("invalid proof json"))?;
    Ok(KnowledgeProof { r_point: pt(&w.r_point, "proof point")?, s: sc(&w.s, "proof scalar")? })
}
fn partial_to(p: &BuyerPartial) -> String {
    serde_json::to_string(&PartialWire { r_b: pt_hex(&p.r_b), s_b: sc_hex(&p.s_b), t_point: pt_hex(&p.t_point) }).unwrap()
}
fn partial_from(j: &str) -> R<BuyerPartial> {
    let w: PartialWire = serde_json::from_str(j).map_err(|_| err("invalid partial json"))?;
    Ok(BuyerPartial { r_b: pt(&w.r_b, "R_b")?, s_b: sc(&w.s_b, "s_b")?, t_point: pt(&w.t_point, "T")? })
}
fn presig_from(j: &str) -> R<PreSignature> {
    serde_json::from_str(j).map_err(|_| err("invalid pre-signature json"))
}
fn offer_from(j: &str) -> R<SealedOffer> {
    let w: SealedOfferWire = serde_json::from_str(j).map_err(|_| err("invalid offer json"))?;
    SealedOffer::from_wire(&w).ok_or_else(|| err("malformed offer"))
}

// ---------- merchant (sells, holds t) ----------

#[wasm_bindgen]
pub struct Merchant {
    inner: protocol::Buyer,
    secret: pasta_curves::pallas::Base,
    /// Both shares were negated to give the joint key ỹ = 0 (see `bindJoint`).
    negated: bool,
}

/// Peer key as used after `bindJoint`: callers keep passing the key the peer
/// originally published; it is negated here when the shares were.
fn peer_key(h: &str, what: &str, negated: bool) -> R<Point> {
    let p = pt(h, what)?;
    Ok(if negated { -p } else { p })
}

#[derive(Serialize)]
struct JointWire { ak: String, negated: bool }

#[wasm_bindgen]
impl Merchant {
    /// Fresh merchant with a new adaptor secret.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Merchant {
        let (t, s) = sealed::new_secret();
        Merchant { inner: protocol::Buyer::with_secret(t), secret: s, negated: false }
    }

    /// Device-local backup of this merchant (signing share and adaptor
    /// secret). SECRET: store only on the seller's device, never upload.
    #[wasm_bindgen(js_name = exportState)]
    pub fn export_state(&self) -> String {
        serde_json::to_string(&MerchantState { sk_b: sc_hex(&self.inner.sk_b), secret: sealed::field_hex(&self.secret), negated: self.negated }).unwrap()
    }

    /// Restores a merchant saved with `exportState`.
    #[wasm_bindgen(js_name = fromState)]
    pub fn from_state(json: &str) -> R<Merchant> {
        let w: MerchantState = serde_json::from_str(json).map_err(|_| err("invalid merchant state"))?;
        let sk_b = sc(&w.sk_b, "signing share")?;
        let secret = sealed::parse_field(&w.secret).ok_or_else(|| err("invalid secret"))?;
        Ok(Merchant { inner: protocol::Buyer::from_parts(sk_b, sealed::scalar_from_base(secret)), secret, negated: w.negated })
    }

    /// Adaptor point T, hex. Public.
    #[wasm_bindgen(js_name = tPoint)]
    pub fn t_point(&self) -> String { pt_hex(&self.inner.t_point()) }

    /// Verification key share, hex. Public.
    #[wasm_bindgen(js_name = verificationKey)]
    pub fn verification_key(&self) -> String { pt_hex(&self.inner.vk_b) }

    /// Encrypts `payload` under t and proves it. Returns offer JSON (public).
    pub fn seal(&self, payload: &[u8]) -> R<String> {
        let offer = with_keys(|k| sealed::seal::<CHUNKS>(k, self.secret, payload))?.map_err(err)?;
        Ok(serde_json::to_string(&offer.to_wire()).unwrap())
    }

    /// Seals a payload of any size up to `maxPayloadBig()` as offer v3 under
    /// this listing's adaptor secret, one proof per `provePart` call.
    #[wasm_bindgen(js_name = bigSealer)]
    pub fn big_sealer(&self, payload: &[u8]) -> R<big::BigSealer> { big::BigSealer::from_secret(self.secret, payload) }

    /// Proof of knowledge of the key share, bound to both keys and the session.
    #[wasm_bindgen(js_name = proveKnowledge)]
    pub fn prove_knowledge(&self, payer_vk: &str, session: &[u8]) -> R<String> {
        Ok(pok_to(&self.inner.prove_knowledge(peer_key(payer_vk, "payer key", self.negated)?, session)))
    }

    /// Binds this merchant to the on-chain escrow key `ak = vk_payer + vk_merchant`
    /// (the spend validating key of the escrow note). Negates this share if
    /// the sum has ỹ = 1; the payer does the same on its side. Idempotent.
    /// Pass the payer key as published. Returns `{ak, negated}`.
    #[wasm_bindgen(js_name = bindJoint)]
    pub fn bind_joint(&mut self, payer_vk: &str) -> R<String> {
        let p = peer_key(payer_vk, "payer key", self.negated)?;
        let (ak, neg) = protocol::joint_ak(p, self.inner.vk_b).map_err(err)?;
        if neg { self.inner.negate_share(); self.negated = !self.negated; }
        Ok(serde_json::to_string(&JointWire { ak: pt_hex(&ak), negated: self.negated }).unwrap())
    }

    /// Checks the payer's proof of knowledge of its key share (bound to both
    /// keys and the session). Do this before the escrow is funded: it rules
    /// out a rogue payer key chosen to make the joint key the payer's alone.
    #[wasm_bindgen(js_name = verifyPayerKnowledge)]
    pub fn verify_payer_knowledge(&self, payer_vk: &str, pok: &str, session: &[u8]) -> R<bool> {
        let p = peer_key(payer_vk, "payer key", self.negated)?;
        Ok(protocol::verify_knowledge(p, &pok_from(pok)?, p, self.inner.vk_b, session))
    }

    /// Partial signature over `sighash` given the payer's nonce point.
    pub fn partial(&self, payer_nonce: &str, payer_vk: &str, alpha: &str, sighash: &[u8]) -> R<String> {
        let p = self.inner.partial(pt(payer_nonce, "nonce")?, peer_key(payer_vk, "payer key", self.negated)?, sc(alpha, "alpha")?, sighash);
        Ok(partial_to(&p))
    }

    /// Partial for the REFUND transaction (adaptor secret fixed to zero): the
    /// payer can complete the refund signature with it alone. Give it before
    /// the payer broadcasts the funding transaction.
    #[wasm_bindgen(js_name = refundPartial)]
    pub fn refund_partial(&self, payer_nonce: &str, payer_vk: &str, alpha: &str, sighash: &[u8]) -> R<String> {
        let p = self.inner.refund_partial(pt(payer_nonce, "nonce")?, peer_key(payer_vk, "payer key", self.negated)?, sc(alpha, "alpha")?, sighash);
        Ok(partial_to(&p))
    }

    /// Checks the payer's pre-signature before completing.
    #[wasm_bindgen(js_name = verifyPresig)]
    pub fn verify_presig(&self, presig: &str, payer_nonce: &str, partial: &str, payer_vk: &str, alpha: &str) -> R<bool> {
        let p = partial_from(partial)?;
        Ok(self.inner.verify_presig(&presig_from(presig)?, pt(payer_nonce, "nonce")?, p.r_b, peer_key(payer_vk, "payer key", self.negated)?, sc(alpha, "alpha")?))
    }

    /// Completes the signature (64 bytes, hex). Broadcasting it reveals t.
    pub fn complete(&self, presig: &str, partial: &str) -> R<String> {
        let pre = presig_from(presig)?;
        let sig = self.inner.complete(&pre, &partial_from(partial)?).ok_or_else(|| err("complete failed"))?;
        if !self.inner.verify_completed(&pre, &sig) { return Err(err("completed signature does not verify")); }
        Ok(hex::encode(sig))
    }
}

impl Default for Merchant { fn default() -> Self { Self::new() } }

// ---------- payer (buys, extracts t) ----------

#[wasm_bindgen]
pub struct Payer { inner: protocol::Seller, negated: bool }

#[wasm_bindgen]
impl Payer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Payer { Payer { inner: protocol::Seller::new(), negated: false } }

    /// SECRET device-local backup (signing share, pending nonce, negation),
    /// for on-chain sales that span reloads. Never upload. Save it again after
    /// every `nonce()`/`preSign()`/`refundSign()` so a used nonce is never restored.
    #[wasm_bindgen(js_name = exportState)]
    pub fn export_state(&self) -> String {
        let (sk, pending) = self.inner.to_parts();
        serde_json::to_string(&PayerState { sk_a: sc_hex(&sk), pending_r_a: pending.map(|r| sc_hex(&r)), negated: self.negated }).unwrap()
    }

    #[wasm_bindgen(js_name = fromState)]
    pub fn from_state(json: &str) -> R<Payer> {
        let w: PayerState = serde_json::from_str(json).map_err(|_| err("invalid payer state"))?;
        let pending = match w.pending_r_a { Some(h) => Some(sc(&h, "nonce")?), None => None };
        Ok(Payer { inner: protocol::Seller::from_parts(sc(&w.sk_a, "signing share")?, pending), negated: w.negated })
    }

    /// Binds to the escrow key (see `Merchant::bindJoint`). Pass the
    /// merchant key as published. Returns `{ak, negated}`.
    #[wasm_bindgen(js_name = bindJoint)]
    pub fn bind_joint(&mut self, merchant_vk: &str) -> R<String> {
        let m = peer_key(merchant_vk, "merchant key", self.negated)?;
        let (ak, neg) = protocol::joint_ak(self.inner.vk_a, m).map_err(err)?;
        if neg { self.inner.negate_share(); self.negated = !self.negated; }
        Ok(serde_json::to_string(&JointWire { ak: pt_hex(&ak), negated: self.negated }).unwrap())
    }

    #[wasm_bindgen(js_name = verificationKey)]
    pub fn verification_key(&self) -> String { pt_hex(&self.inner.vk_a) }

    /// Verifies a sealed offer against the content hash the payer expects.
    /// Returns T (hex) on success, so the session can be pinned to it.
    #[wasm_bindgen(js_name = verifyOffer)]
    pub fn verify_offer(&self, offer: &str, expected_hash: &str) -> R<String> {
        if let Some(o) = big::parse(offer) {
            let o = o?;
            big::verify(&o, &o.t_point, expected_hash)?;
            return Ok(pt_hex(&o.t_point));
        }
        let o = offer_from(offer)?;
        let h = sealed::parse_field(expected_hash).ok_or_else(|| err("invalid content hash"))?;
        if !with_keys(|k| sealed::verify_offer(k, &o, &o.t_point, h))? {
            return Err(err("offer proof does not verify"));
        }
        Ok(pt_hex(&o.t_point))
    }

    #[wasm_bindgen(js_name = proveKnowledge)]
    pub fn prove_knowledge(&self, merchant_vk: &str, session: &[u8]) -> R<String> {
        Ok(pok_to(&self.inner.prove_knowledge(peer_key(merchant_vk, "merchant key", self.negated)?, session)))
    }

    /// Single-use nonce point R_a, hex.
    pub fn nonce(&mut self) -> String { pt_hex(&self.inner.new_nonce()) }

    /// Pre-signs locked to the merchant's T. Refuses unless the partial's T
    /// equals `verified_t` (the T returned by `verifyOffer`).
    #[wasm_bindgen(js_name = preSign)]
    pub fn pre_sign(&mut self, merchant_vk: &str, partial: &str, sighash: &[u8], session: &[u8], merchant_pok: &str, alpha: &str, verified_t: &str) -> R<String> {
        let p = partial_from(partial)?;
        if p.t_point.to_bytes() != pt(verified_t, "T")?.to_bytes() {
            return Err(err("partial is locked to a different T than the verified offer"));
        }
        let pre = self.inner
            .pre_sign(peer_key(merchant_vk, "merchant key", self.negated)?, &p, sighash, session, &pok_from(merchant_pok)?, sc(alpha, "alpha")?)
            .map_err(err)?;
        Ok(serde_json::to_string(&pre).unwrap())
    }

    /// Signs the REFUND transaction with the merchant's refund partial and
    /// returns the complete 64-byte signature (hex). Needs a fresh `nonce()`
    /// first. Do this before broadcasting the funding transaction.
    #[wasm_bindgen(js_name = refundSign)]
    pub fn refund_sign(&mut self, merchant_vk: &str, partial: &str, sighash: &[u8], session: &[u8], merchant_pok: &str, alpha: &str) -> R<String> {
        let p = partial_from(partial)?;
        let pre = self.inner
            .pre_sign(peer_key(merchant_vk, "merchant key", self.negated)?, &p, sighash, session, &pok_from(merchant_pok)?, sc(alpha, "alpha")?)
            .map_err(err)?;
        let sig = self.inner.complete_refund(&pre, &p).ok_or_else(|| err("refund partial is invalid or locked to a secret"))?;
        Ok(hex::encode(sig))
    }

    /// Recovers t from the MINED settlement transaction (raw bytes, from any
    /// untrusted source) and decrypts the offer. The signature is located by
    /// the pre-agreed nonce commitment R and verified under rk and the sighash
    /// this payer signed, so neither the relay nor the merchant is trusted.
    #[wasm_bindgen(js_name = unlockFromTx)]
    pub fn unlock_from_tx(&self, raw_tx: &[u8], presig: &str, partial: &str, offer: &str) -> R<Vec<u8>> {
        let pre = presig_from(presig)?;
        let sig = protocol::find_signature(raw_tx, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex)
            .ok_or_else(|| err("the settlement signature is not in this transaction"))?;
        self.unlock(&hex::encode(sig), presig, partial, offer)
    }

    /// Recovers t from the final on-chain signature and decrypts the offer.
    pub fn unlock(&self, signature: &str, presig: &str, partial: &str, offer: &str) -> R<Vec<u8>> {
        let sig: [u8; 64] = bytes(signature, "signature")?.try_into().map_err(|_| err("signature must be 64 bytes"))?;
        let pre = presig_from(presig)?;
        if !protocol::verify_sig(&pre.vk_hex, &pre.sighash_hex, &sig) {
            return Err(err("signature does not verify"));
        }
        let s = parse_scalar(&hex::encode(&sig[32..])).ok_or_else(|| err("invalid s"))?;
        let s_a = sc(&pre.s_a_hex, "s_a")?;
        let t = protocol::extract_t(s, s_a, partial_from(partial)?.s_b);
        if let Some(o) = big::parse(offer) { return big::open(t, &o?); }
        sealed::open(t, &offer_from(offer)?).ok_or_else(|| err("decryption failed"))
    }
}

impl Default for Payer { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_flow_through_bindings() {
        let payload = b"0-day: signature malleability in claim()";
        let merchant = Merchant::from_state(&Merchant::new().export_state()).unwrap();
        let mut payer = Payer::new();

        let offer = merchant.seal(payload).unwrap();
        let t = payer.verify_offer(&offer, &content_hash(payload).unwrap()).unwrap();
        assert_eq!(t, merchant.t_point());

        let session = b"listing-42";
        let sighash = b"sighash";
        let alpha = sc_hex(&Scalar::from(9u64));
        let r_a = payer.nonce();
        let partial = merchant.partial(&r_a, &payer.verification_key(), &alpha, sighash).unwrap();
        let pok_m = merchant.prove_knowledge(&payer.verification_key(), session).unwrap();
        let pre = payer.pre_sign(&merchant.verification_key(), &partial, sighash, session, &pok_m, &alpha, &t).unwrap();
        assert!(merchant.verify_presig(&pre, &r_a, &partial, &payer.verification_key(), &alpha).unwrap());
        let sig = merchant.complete(&pre, &partial).unwrap();
        assert_eq!(payer.unlock(&sig, &pre, &partial, &offer).unwrap(), payload.to_vec());
    }
}

#[cfg(test)]
mod onchain_tests {
    use super::*;

    #[test]
    fn joint_binding_refund_and_unlock_from_tx_bytes() {
        let payload = b"sealed for the chain";
        let mut merchant = Merchant::from_state(&Merchant::new().export_state()).unwrap();
        let mut payer = Payer::new();
        let (m_vk, p_vk) = (merchant.verification_key(), payer.verification_key());
        let a = payer.bind_joint(&m_vk).unwrap();
        let b = merchant.bind_joint(&p_vk).unwrap();
        assert_eq!(a, b);
        assert_eq!(payer.bind_joint(&m_vk).unwrap(), a, "idempotent");
        // negation survives export/restore
        let mut merchant = Merchant::from_state(&merchant.export_state()).unwrap();
        assert_eq!(merchant.bind_joint(&p_vk).unwrap(), b);
        let ak: serde_json::Value = serde_json::from_str(&a).unwrap();
        let ak_bytes = hex::decode(ak["ak"].as_str().unwrap()).unwrap();
        assert_eq!(ak_bytes[31] & 0x80, 0);

        let offer = merchant.seal(payload).unwrap();
        let t = payer.verify_offer(&offer, &content_hash(payload).unwrap()).unwrap();
        let session = b"listing-onchain";
        let alpha = sc_hex(&Scalar::from(11u64));

        // rogue-key checks before funding: both proofs of knowledge
        let pok_p = payer.prove_knowledge(&m_vk, session).unwrap();
        assert!(merchant.verify_payer_knowledge(&p_vk, &pok_p, session).unwrap());
        assert!(!merchant.verify_payer_knowledge(&p_vk, &pok_p, b"other-session").unwrap());

        // refund first (before funding)
        let r_a = payer.nonce();
        let rp = merchant.refund_partial(&r_a, &p_vk, &alpha, b"refund-sighash").unwrap();
        let pok = merchant.prove_knowledge(&p_vk, session).unwrap();
        let rsig = payer.refund_sign(&m_vk, &rp, b"refund-sighash", session, &pok, &alpha).unwrap();
        let rk = (parse_point(ak["ak"].as_str().unwrap()).unwrap() + Point::from_bytes(&lintel::protocol::ORCHARD_BASEPOINT).unwrap() * Scalar::from(11u64)).to_bytes();
        assert!(protocol::verify_sig(&hex::encode(rk), &hex::encode(b"refund-sighash"), &hex::decode(&rsig).unwrap().try_into().unwrap()));
        // (a partial locked to T is refused as a refund: engine test
        // protocol::refund_completes_without_counterparty_and_rejects_locked_partial;
        // error paths build a JsError, which only works on wasm32.)

        // settlement
        let r_a = payer.nonce();
        let partial = merchant.partial(&r_a, &p_vk, &alpha, b"settle-sighash").unwrap();
        let pok = merchant.prove_knowledge(&p_vk, session).unwrap();
        let pre = payer.pre_sign(&m_vk, &partial, b"settle-sighash", session, &pok, &alpha, &t).unwrap();
        assert!(merchant.verify_presig(&pre, &r_a, &partial, &p_vk, &alpha).unwrap());
        let sig = merchant.complete(&pre, &partial).unwrap();
        let pre_v: serde_json::Value = serde_json::from_str(&pre).unwrap();
        assert_eq!(pre_v["vk_hex"].as_str().unwrap(), hex::encode(rk));
        // fake "transaction": the signature embedded among other bytes
        let mut tx = vec![0x55u8; 300];
        tx.extend_from_slice(&hex::decode(&sig).unwrap());
        tx.extend_from_slice(&[0xaa; 100]);
        assert_eq!(payer.unlock_from_tx(&tx, &pre, &partial, &offer).unwrap(), payload.to_vec());
    }
}

#[cfg(test)]
mod params_tests {
    #[test]
    fn pinned_params_match_and_tampering_is_rejected() {
        let mut b = lintel::sealed::prove::params_bytes::<{ lintel::sealed::CHUNKS }>();
        let mut pin = [0u8; 32];
        hex::decode_to_slice(super::PINNED_PARAMS, &mut pin).unwrap();
        assert_eq!(lintel::sealed::prove::params_digest(&b), pin);
        let n = b.len() - 7; b[n] ^= 1;
        assert!(lintel::sealed::prove::setup_from_params::<{ lintel::sealed::CHUNKS }>(&b, &pin).is_err());
    }
}

mod v2;
pub mod big;
#[cfg(feature = "chain")]
pub mod chain;
#[cfg(feature = "threads")]
pub mod threads;
