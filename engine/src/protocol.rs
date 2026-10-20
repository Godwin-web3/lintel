//! Lintel two-party adaptor.
//! Nonce is generated inside Seller and is single-use.
//! Buyer computes s_b from R_a (never sees r_a).
//! verify_presig recomputes R and checks vk_hex against rk.

use pasta_curves::pallas::{Point, Scalar};
use group::GroupEncoding;
use ff::{Field, PrimeField, FromUniformBytes};
use rand::rng;
use blake2b_simd::Params;
use serde::{Serialize, Deserialize};

pub const ORCHARD_BASEPOINT: [u8; 32] = [
    99, 201, 117, 184, 132, 114, 26, 141, 12, 161, 112, 123, 227, 12, 127, 12, 95, 68, 95, 62, 124,
    24, 141, 59, 6, 214, 241, 40, 179, 35, 85, 183,
];

fn challenge(r: &[u8; 32], vk: &[u8; 32], msg: &[u8]) -> Scalar {
    let h = Params::new().hash_length(64).personal(b"Zcash_RedPallasH")
        .to_state().update(r).update(vk).update(msg).finalize();
    let arr: [u8; 64] = h.as_bytes().try_into().unwrap();
    <Scalar as FromUniformBytes<64>>::from_uniform_bytes(&arr)
}
fn pok_challenge(r: &[u8; 32], vk: &[u8; 32], label: &[u8]) -> Scalar {
    let h = Params::new().hash_length(64).personal(b"Lintel_PoK_v1")
        .to_state().update(r).update(vk).update(label).finalize();
    let arr: [u8; 64] = h.as_bytes().try_into().unwrap();
    <Scalar as FromUniformBytes<64>>::from_uniform_bytes(&arr)
}
fn base() -> Point { Point::from_bytes(&ORCHARD_BASEPOINT).unwrap() } // constant, always valid

fn bytes32(hex_str: &str) -> Option<[u8; 32]> {
    hex::decode(hex_str).ok()?.try_into().ok()
}
/// Parses a canonical scalar from untrusted hex. Never panics.
pub fn parse_scalar(hex_str: &str) -> Option<Scalar> {
    Option::from(Scalar::from_repr(bytes32(hex_str)?))
}
/// Parses a valid curve point from untrusted hex. Never panics.
pub fn parse_point(hex_str: &str) -> Option<Point> {
    Option::from(Point::from_bytes(&bytes32(hex_str)?))
}
fn session_label(a: Point, b: Point, session: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&a.to_bytes());
    v.extend_from_slice(&b.to_bytes());
    v.extend_from_slice(session);
    v
}

pub struct Seller { sk_a: Scalar, pub vk_a: Point, pending_r_a: Option<Scalar> }
pub struct Buyer { pub sk_b: Scalar, pub vk_b: Point, pub t: Scalar }

#[derive(Clone, Debug)]
pub struct KnowledgeProof { pub r_point: Point, pub s: Scalar }
#[derive(Clone, Debug)]
pub struct BuyerPartial { pub r_b: Point, pub s_b: Scalar, pub t_point: Point }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PreSignature {
    pub r_hex: String,
    pub s_a_hex: String,
    pub vk_hex: String,
    pub sighash_hex: String,
}

impl Seller {
    pub fn new() -> Self {
        let mut rng = rng();
        let sk_a = Scalar::random(&mut rng);
        Self { sk_a, vk_a: base() * sk_a, pending_r_a: None }
    }
    pub fn prove_knowledge(&self, vk_b: Point, session: &[u8]) -> KnowledgeProof {
        let mut rng = rng();
        let k = Scalar::random(&mut rng);
        let r_point = base() * k;
        let label = session_label(self.vk_a, vk_b, session);
        let c = pok_challenge(&r_point.to_bytes(), &self.vk_a.to_bytes(), &label);
        KnowledgeProof { r_point, s: k + c * self.sk_a }
    }
    pub fn new_nonce(&mut self) -> Point {
        let mut rng = rng();
        let r_a = Scalar::random(&mut rng);
        self.pending_r_a = Some(r_a);
        base() * r_a
    }
    pub fn pre_sign(&mut self, vk_b: Point, partial: &BuyerPartial, sighash: &[u8], session: &[u8], pok: &KnowledgeProof, alpha: Scalar) -> Result<PreSignature, &'static str> {
        if !verify_knowledge(vk_b, pok, self.vk_a, vk_b, session) {
            return Err("buyer proof failed");
        }
        let r_a = self.pending_r_a.take().ok_or("no nonce")?;
        let r_joint = base() * r_a + partial.r_b + partial.t_point;
        let rk = self.vk_a + vk_b + base() * alpha;
        let rp = r_joint.to_bytes();
        let c = challenge(&rp, &rk.to_bytes(), sighash);
        if base() * partial.s_b != partial.r_b + vk_b * c {
            return Err("invalid buyer partial");
        }
        let s_a = r_a + c * (self.sk_a + alpha);
        Ok(PreSignature {
            r_hex: hex::encode(rp),
            s_a_hex: hex::encode(s_a.to_repr()),
            vk_hex: hex::encode(rk.to_bytes()),
            sighash_hex: hex::encode(sighash),
        })
    }
}

impl Buyer {
    pub fn new() -> Self {
        let mut rng = rng();
        let sk_b = Scalar::random(&mut rng);
        let t = Scalar::random(&mut rng);
        Self { sk_b, vk_b: base() * sk_b, t }
    }
    /// Uses a chosen adaptor secret, e.g. one from `sealed::new_secret`.
    pub fn with_secret(t: Scalar) -> Self {
        let mut rng = rng();
        let sk_b = Scalar::random(&mut rng);
        Self { sk_b, vk_b: base() * sk_b, t }
    }
    /// Rebuilds a party from a saved signing share and adaptor secret.
    pub fn from_parts(sk_b: Scalar, t: Scalar) -> Self { Self { sk_b, vk_b: base() * sk_b, t } }
    pub fn t_point(&self) -> Point { base() * self.t }
    pub fn prove_knowledge(&self, vk_a: Point, session: &[u8]) -> KnowledgeProof {
        let mut rng = rng();
        let k = Scalar::random(&mut rng);
        let r_point = base() * k;
        let label = session_label(vk_a, self.vk_b, session);
        let c = pok_challenge(&r_point.to_bytes(), &self.vk_b.to_bytes(), &label);
        KnowledgeProof { r_point, s: k + c * self.sk_b }
    }
    pub fn partial(&self, r_a_point: Point, vk_a: Point, alpha: Scalar, sighash: &[u8]) -> BuyerPartial {
        let mut rng = rng();
        let r_b = Scalar::random(&mut rng);
        let r_b_point = base() * r_b;
        let r_joint = r_a_point + r_b_point + self.t_point();
        let rk = vk_a + self.vk_b + base() * alpha;
        let c = challenge(&r_joint.to_bytes(), &rk.to_bytes(), sighash);
        BuyerPartial { r_b: r_b_point, s_b: r_b + c * self.sk_b, t_point: self.t_point() }
    }
    /// Recomputes R = R_a + R_b + T and checks vk_hex against rk.
    pub fn verify_presig(&self, pre: &PreSignature, r_a_point: Point, r_b_point: Point, vk_a: Point, alpha: Scalar) -> bool {
        let (Some(s_a), Some(r_arr), Some(vk_arr), Ok(msg)) = (
            parse_scalar(&pre.s_a_hex),
            bytes32(&pre.r_hex),
            bytes32(&pre.vk_hex),
            hex::decode(&pre.sighash_hex),
        ) else { return false };
        let rk = vk_a + self.vk_b + base() * alpha;
        let r_expected = r_a_point + r_b_point + self.t_point();
        if r_arr != r_expected.to_bytes() { return false; }
        if vk_arr != rk.to_bytes() { return false; }
        let c = challenge(&r_arr, &vk_arr, &msg);
        base() * s_a == r_a_point + (vk_a + base() * alpha) * c
    }
    pub fn complete(&self, pre: &PreSignature, partial: &BuyerPartial) -> Option<[u8; 64]> {
        let s_a = parse_scalar(&pre.s_a_hex)?;
        let r_bytes = bytes32(&pre.r_hex)?;
        let s = s_a + partial.s_b + self.t;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&r_bytes);
        sig[32..].copy_from_slice(s.to_repr().as_ref());
        Some(sig)
    }
    pub fn verify_completed(&self, pre: &PreSignature, sig: &[u8; 64]) -> bool {
        verify_sig(&pre.vk_hex, &pre.sighash_hex, sig)
    }
}

/// Verifies a RedPallas-style signature from untrusted inputs. Never panics.
pub fn verify_sig(rk_hex: &str, sighash_hex: &str, sig: &[u8; 64]) -> bool {
    let mut rp_bytes = [0u8; 32];
    rp_bytes.copy_from_slice(&sig[..32]);
    let mut s_bytes = [0u8; 32];
    s_bytes.copy_from_slice(&sig[32..]);
    let (Some(rp), Some(s), Some(rk), Ok(msg)) = (
        Option::<Point>::from(Point::from_bytes(&rp_bytes)),
        Option::<Scalar>::from(Scalar::from_repr(s_bytes)),
        parse_point(rk_hex),
        hex::decode(sighash_hex),
    ) else { return false };
    let c = challenge(&rp.to_bytes(), &rk.to_bytes(), &msg);
    base() * s == rp + rk * c
}

pub fn extract_t(s: Scalar, s_a: Scalar, s_b: Scalar) -> Scalar { s - s_a - s_b }

/// Joint Orchard/Ironwood spend validating key `ak` for two shares.
///
/// Orchard requires `ak` to have ỹ = 0 (sign bit of the encoding clear). If
/// `vk_a + vk_b` has ỹ = 1, the joint key is its negation and BOTH parties
/// must negate their shares (`negate_share`), which keeps `ak = vk_a + vk_b`.
/// Returns `(ak, must_negate)`. Each party computes this independently from
/// the two public shares, so no extra round is needed.
pub fn joint_ak(vk_a: Point, vk_b: Point) -> Result<(Point, bool), &'static str> {
    let sum = vk_a + vk_b;
    if bool::from(group::Group::is_identity(&sum)) { return Err("joint key is the identity"); }
    let neg = sum.to_bytes()[31] & 0x80 != 0;
    Ok((if neg { -sum } else { sum }, neg))
}

impl Seller {
    /// Negates this signing share (see [`joint_ak`]).
    pub fn negate_share(&mut self) { self.sk_a = -self.sk_a; self.vk_a = -self.vk_a; }

    /// Completes a refund signature. The refund session is the normal
    /// protocol run with the other party's adaptor secret fixed to zero
    /// (`T` = identity, see [`Buyer::refund_partial`]), so once this party
    /// holds the counterparty's partial it needs nobody else to finish:
    /// `s = s_a + s_b`. Refuses a partial that is locked to a non-zero `T`.
    pub fn complete_refund(&self, pre: &PreSignature, partial: &BuyerPartial) -> Option<[u8; 64]> {
        if !bool::from(group::Group::is_identity(&partial.t_point)) { return None; }
        let s_a = parse_scalar(&pre.s_a_hex)?;
        let r_bytes = bytes32(&pre.r_hex)?;
        let s = s_a + partial.s_b;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&r_bytes);
        sig[32..].copy_from_slice(s.to_repr().as_ref());
        if !verify_sig(&pre.vk_hex, &pre.sighash_hex, &sig) { return None; }
        Some(sig)
    }
}

impl Buyer {
    /// Negates this signing share (see [`joint_ak`]).
    pub fn negate_share(&mut self) { self.sk_b = -self.sk_b; self.vk_b = -self.vk_b; }

    /// Partial signature for the refund transaction: same key share, adaptor
    /// secret fixed to zero, so the counterparty can complete it alone.
    pub fn refund_partial(&self, r_a_point: Point, vk_a: Point, alpha: Scalar, sighash: &[u8]) -> BuyerPartial {
        Buyer { sk_b: self.sk_b, vk_b: self.vk_b, t: Scalar::ZERO }.partial(r_a_point, vk_a, alpha, sighash)
    }
}

/// Finds the completed signature `(R, s)` inside serialized transaction bytes
/// by locating the 32-byte nonce commitment `R`, which both parties know in
/// advance (`pre.r_hex`), and checks it verifies under `rk_hex`/`sighash_hex`.
/// Works on any encoding that stores `R ‖ s` contiguously (RedPallas
/// spendAuthSig in v5/v6 transactions), so the payer needs no transaction
/// parser to extract `t` from a mined transaction.
pub fn find_signature(tx_bytes: &[u8], r_hex: &str, rk_hex: &str, sighash_hex: &str) -> Option<[u8; 64]> {
    let r = bytes32(r_hex)?;
    let mut i = 0;
    while i + 64 <= tx_bytes.len() {
        if tx_bytes[i..i + 32] == r {
            let sig: [u8; 64] = tx_bytes[i..i + 64].try_into().ok()?;
            if verify_sig(rk_hex, sighash_hex, &sig) { return Some(sig); }
        }
        i += 1;
    }
    None
}

pub fn verify_knowledge(vk: Point, proof: &KnowledgeProof, vk_a: Point, vk_b: Point, session: &[u8]) -> bool {
    let label = session_label(vk_a, vk_b, session);
    let c = pok_challenge(&proof.r_point.to_bytes(), &vk.to_bytes(), &label);
    base() * proof.s == proof.r_point + vk * c
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_flow_with_nonzero_alpha() {
        let mut seller = Seller::new();
        let buyer = Buyer::new();
        let session = b"session-1";
        let sighash = b"sighash";
        let alpha = Scalar::from(7u64);
        let r_a_point = seller.new_nonce();
        let partial = buyer.partial(r_a_point, seller.vk_a, alpha, sighash);
        let pok_b = buyer.prove_knowledge(seller.vk_a, session);
        let pok_a = seller.prove_knowledge(buyer.vk_b, session);
        assert!(verify_knowledge(seller.vk_a, &pok_a, seller.vk_a, buyer.vk_b, session));
        let pre = seller.pre_sign(buyer.vk_b, &partial, sighash, session, &pok_b, alpha).unwrap();
        assert!(buyer.verify_presig(&pre, r_a_point, partial.r_b, seller.vk_a, alpha));
        let sig = buyer.complete(&pre, &partial).unwrap();
        assert!(buyer.verify_completed(&pre, &sig));
        let s = Scalar::from_repr(sig[32..].try_into().unwrap()).unwrap();
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        assert_eq!(extract_t(s, s_a, partial.s_b), buyer.t);
    }
    #[test]
    fn nonce_is_single_use() {
        let mut seller = Seller::new();
        let buyer = Buyer::new();
        let r_a = seller.new_nonce();
        let partial = buyer.partial(r_a, seller.vk_a, Scalar::ZERO, b"h");
        let pok = buyer.prove_knowledge(seller.vk_a, b"s");
        seller.pre_sign(buyer.vk_b, &partial, b"h", b"s", &pok, Scalar::ZERO).unwrap();
        assert!(seller.pre_sign(buyer.vk_b, &partial, b"h2", b"s", &pok, Scalar::ZERO).is_err());
    }
    #[test]
    fn rogue_proof_rejected() {
        let mut seller = Seller::new();
        let buyer = Buyer::new();
        let other = Buyer::new();
        seller.new_nonce();
        let partial = buyer.partial(base() * Scalar::ZERO, seller.vk_a, Scalar::ZERO, b"h");
        let bad = other.prove_knowledge(seller.vk_a, b"s");
        assert!(seller.pre_sign(buyer.vk_b, &partial, b"h", b"s", &bad, Scalar::ZERO).is_err());
    }
    #[test]
    fn joint_ak_has_positive_y_and_shares_still_sum() {
        for _ in 0..16 {
            let mut seller = Seller::new();
            let mut buyer = Buyer::new();
            let (ak, neg) = joint_ak(seller.vk_a, buyer.vk_b).unwrap();
            if neg { seller.negate_share(); buyer.negate_share(); }
            assert_eq!(ak, seller.vk_a + buyer.vk_b);
            assert_eq!(ak.to_bytes()[31] & 0x80, 0);
            // the adaptor flow still works on the normalized shares
            let alpha = Scalar::from(5u64);
            let r_a = seller.new_nonce();
            let partial = buyer.partial(r_a, seller.vk_a, alpha, b"m");
            let pok = buyer.prove_knowledge(seller.vk_a, b"s");
            let pre = seller.pre_sign(buyer.vk_b, &partial, b"m", b"s", &pok, alpha).unwrap();
            assert_eq!(pre.vk_hex, hex::encode((ak + base() * alpha).to_bytes()));
            let sig = buyer.complete(&pre, &partial).unwrap();
            assert!(verify_sig(&pre.vk_hex, &pre.sighash_hex, &sig));
        }
    }
    #[test]
    fn refund_completes_without_counterparty_and_rejects_locked_partial() {
        let mut seller = Seller::new();
        let buyer = Buyer::new();
        let alpha = Scalar::from(3u64);
        let r_a = seller.new_nonce();
        let partial = buyer.refund_partial(r_a, seller.vk_a, alpha, b"refund");
        let pok = buyer.prove_knowledge(seller.vk_a, b"s");
        let pre = seller.pre_sign(buyer.vk_b, &partial, b"refund", b"s", &pok, alpha).unwrap();
        let sig = seller.complete_refund(&pre, &partial).unwrap();
        assert!(verify_sig(&pre.vk_hex, "726566756e64", &sig));
        // a partial locked to a real T cannot be completed as a refund
        let r_a2 = seller.new_nonce();
        let locked = buyer.partial(r_a2, seller.vk_a, alpha, b"refund");
        let pre2 = seller.pre_sign(buyer.vk_b, &locked, b"refund", b"s", &pok, alpha).unwrap();
        assert!(seller.complete_refund(&pre2, &locked).is_none());
    }
    #[test]
    fn find_signature_in_bytes() {
        let mut seller = Seller::new();
        let buyer = Buyer::new();
        let r_a = seller.new_nonce();
        let partial = buyer.partial(r_a, seller.vk_a, Scalar::ZERO, b"h");
        let pok = buyer.prove_knowledge(seller.vk_a, b"s");
        let pre = seller.pre_sign(buyer.vk_b, &partial, b"h", b"s", &pok, Scalar::ZERO).unwrap();
        let sig = buyer.complete(&pre, &partial).unwrap();
        let mut blob = vec![7u8; 100];
        blob.extend_from_slice(&pre.r_hex.as_bytes()[..10]);
        blob.extend_from_slice(&sig);
        blob.extend_from_slice(&[1u8; 50]);
        assert_eq!(find_signature(&blob, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex), Some(sig));
        assert_eq!(find_signature(&blob[..140], &pre.r_hex, &pre.vk_hex, &pre.sighash_hex), None);
    }
    #[test]
    fn malformed_peer_input_does_not_panic() {
        let buyer = Buyer::new();
        let bad = PreSignature { r_hex: "zz".into(), s_a_hex: "ff".repeat(32), vk_hex: "00".into(), sighash_hex: "x".into() };
        let p = base();
        assert!(!buyer.verify_presig(&bad, p, p, p, Scalar::ZERO));
        assert!(buyer.complete(&bad, &BuyerPartial { r_b: p, s_b: Scalar::ZERO, t_point: p }).is_none());
        assert!(!buyer.verify_completed(&bad, &[0xffu8; 64]));
        assert!(parse_scalar(&"ff".repeat(32)).is_none());
        assert!(parse_point("00").is_none());
    }
}
