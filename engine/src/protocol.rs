//! Lintel two-party adaptor.
//! R = R_a + R_b + T, rk = vk_a + vk_b + alpha*G, c = H(R || rk || sighash).
//! Buyer partial: s_b = r_b + c*sk_b. Seller checks s_b*G == R_b + c*vk_b.
//! Completed signature verifies under rk. Seller extracts t = s - s_a - s_b.

use pasta_curves::pallas::{Point, Scalar};
use group::{Group, GroupEncoding};
use ff::{Field, PrimeField, FromUniformBytes};
use rand::thread_rng as rng;
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
fn base() -> Point { Point::from_bytes(&ORCHARD_BASEPOINT).unwrap() }
fn session_label(a: Point, b: Point, session: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&a.to_bytes());
    v.extend_from_slice(&b.to_bytes());
    v.extend_from_slice(session);
    v
}

#[derive(Clone)]
pub struct Seller { pub sk_a: Scalar, pub vk_a: Point }
#[derive(Clone)]
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
        Self { sk_a, vk_a: base() * sk_a }
    }
    pub fn prove_knowledge(&self, vk_b: Point, session: &[u8]) -> KnowledgeProof {
        let mut rng = rng();
        let k = Scalar::random(&mut rng);
        let r_point = base() * k;
        let label = session_label(self.vk_a, vk_b, session);
        let c = challenge(&r_point.to_bytes(), &self.vk_a.to_bytes(), &label);
        KnowledgeProof { r_point, s: k + c * self.sk_a }
    }
    pub fn pre_sign(&self, vk_b: Point, partial: &BuyerPartial, sighash: &[u8], session: &[u8], pok: &KnowledgeProof, alpha: Scalar, r_a: Scalar) -> Result<PreSignature, &'static str> {
        if !verify_knowledge(vk_b, pok, self.vk_a, session) {
            return Err("buyer proof failed");
        }
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
    pub fn t_point(&self) -> Point { base() * self.t }
    pub fn prove_knowledge(&self, vk_a: Point, session: &[u8]) -> KnowledgeProof {
        let mut rng = rng();
        let k = Scalar::random(&mut rng);
        let r_point = base() * k;
        let label = session_label(vk_a, self.vk_b, session);
        let c = challenge(&r_point.to_bytes(), &self.vk_b.to_bytes(), &label);
        KnowledgeProof { r_point, s: k + c * self.sk_b }
    }
    pub fn complete(&self, pre: &PreSignature, partial: &BuyerPartial) -> [u8; 64] {
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        let s = s_a + partial.s_b + self.t;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&hex::decode(&pre.r_hex).unwrap());
        sig[32..].copy_from_slice(s.to_repr().as_ref());
        sig
    }
    pub fn verify_completed(&self, pre: &PreSignature, sig: &[u8; 64]) -> bool {
        let rp = Point::from_bytes(&sig[..32].try_into().unwrap()).unwrap();
        let s = Scalar::from_repr(sig[32..].try_into().unwrap()).unwrap();
        let rk = Point::from_bytes(&hex::decode(&pre.vk_hex).unwrap().try_into().unwrap()).unwrap();
        let msg = hex::decode(&pre.sighash_hex).unwrap();
        let c = challenge(&rp.to_bytes(), &rk.to_bytes(), &msg);
        base() * s == rp + rk * c
    }
}

pub fn extract_t(s: Scalar, s_a: Scalar, s_b: Scalar) -> Scalar { s - s_a - s_b }

pub fn verify_knowledge(vk: Point, proof: &KnowledgeProof, vk_other: Point, session: &[u8]) -> bool {
    let label = session_label(vk_other, vk, session);
    let c = challenge(&proof.r_point.to_bytes(), &vk.to_bytes(), &label);
    base() * proof.s == proof.r_point + vk * c
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seller_extracts_t_and_sig_verifies_under_rk() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let session = b"session-1";
        let sighash = b"sighash";
        let alpha = Scalar::ZERO;
        let mut rng = rng();
        let r_a = Scalar::random(&mut rng);
        let r_b = Scalar::random(&mut rng);
        let r_joint = base() * r_a + base() * r_b + buyer.t_point();
        let rk = seller.vk_a + buyer.vk_b + base() * alpha;
        let c = challenge(&r_joint.to_bytes(), &rk.to_bytes(), sighash);
        let s_b = r_b + c * buyer.sk_b;
        let partial = BuyerPartial { r_b: base() * r_b, s_b, t_point: buyer.t_point() };
        let pok = buyer.prove_knowledge(seller.vk_a, session);
        let pre = seller.pre_sign(buyer.vk_b, &partial, sighash, session, &pok, alpha, r_a).unwrap();
        let sig = buyer.complete(&pre, &partial);
        assert!(buyer.verify_completed(&pre, &sig));
        let s = Scalar::from_repr(sig[32..].try_into().unwrap()).unwrap();
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        assert_eq!(extract_t(s, s_a, partial.s_b), buyer.t);
    }
    #[test]
    fn rogue_proof_rejected() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let other = Buyer::new();
        let partial = BuyerPartial { r_b: base() * Scalar::ZERO, s_b: Scalar::ZERO, t_point: buyer.t_point() };
        let bad = other.prove_knowledge(seller.vk_a, b"session-1");
        assert!(seller.pre_sign(buyer.vk_b, &partial, b"sighash", b"session-1", &bad, Scalar::ZERO, Scalar::ZERO).is_err());
    }
    #[test]
    fn proof_binds_session() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let pok = buyer.prove_knowledge(seller.vk_a, b"session-1");
        assert!(verify_knowledge(buyer.vk_b, &pok, seller.vk_a, b"session-1"));
        assert!(!verify_knowledge(buyer.vk_b, &pok, seller.vk_a, b"session-2"));
    }
}
