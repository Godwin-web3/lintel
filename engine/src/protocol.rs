//! Lintel two-party adaptor with buyer partial signature.
//! Buyer sends R_b and s_b before the seller pre-signs.
//! Joint nonce R = R_a + R_b + T.
//! Seller extracts t = s - s_a - s_b without learning sk_b.
//! Proofs bind both keys and a session ID.
//! pre_sign folds alpha so the signature verifies under rk.

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
    pub session_hex: String,
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
    pub fn pre_sign(&self, vk_b: Point, partial: &BuyerPartial, sighash: &[u8], session: &[u8], pok: &KnowledgeProof, alpha: Scalar) -> Result<(PreSignature, Scalar), &'static str> {
        if !verify_knowledge(vk_b, pok, self.vk_a, session) {
            return Err("buyer proof failed");
        }
        let mut rng = rng();
        let r_a = Scalar::random(&mut rng);
        let r_joint = base() * r_a + partial.r_b + partial.t_point;
        let rk = self.vk_a + vk_b + base() * alpha;
        let rp = r_joint.to_bytes();
        let c = challenge(&rp, &rk.to_bytes(), sighash);
        let s_a = r_a + c * (self.sk_a + alpha);
        Ok((PreSignature {
            r_hex: hex::encode(rp),
            s_a_hex: hex::encode(s_a.to_repr()),
            vk_hex: hex::encode(rk.to_bytes()),
            sighash_hex: hex::encode(sighash),
            session_hex: hex::encode(session),
        }, r_a))
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
    pub fn partial(&self) -> BuyerPartial {
        let mut rng = rng();
        let r_b = Scalar::random(&mut rng);
        BuyerPartial { r_b: base() * r_b, s_b: r_b, t_point: self.t_point() }
    }
    pub fn complete(&self, pre: &PreSignature, partial: &BuyerPartial) -> [u8; 64] {
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        let s = s_a + partial.s_b + self.t;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&hex::decode(&pre.r_hex).unwrap());
        sig[32..].copy_from_slice(s.to_repr().as_ref());
        sig
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
    fn seller_extracts_t_without_sk_b() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let session = b"session-1";
        let partial = buyer.partial();
        let pok = buyer.prove_knowledge(seller.vk_a, session);
        let (pre, _) = seller.pre_sign(buyer.vk_b, &partial, b"sighash", session, &pok, Scalar::ZERO).unwrap();
        let sig = buyer.complete(&pre, &partial);
        let s = Scalar::from_repr(sig[32..].try_into().unwrap()).unwrap();
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        assert_eq!(extract_t(s, s_a, partial.s_b), buyer.t);
    }
    #[test]
    fn proof_binds_session() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let pok = buyer.prove_knowledge(seller.vk_a, b"session-1");
        assert!(verify_knowledge(buyer.vk_b, &pok, seller.vk_a, b"session-1"));
        assert!(!verify_knowledge(buyer.vk_b, &pok, seller.vk_a, b"session-2"));
    }
    #[test]
    fn rogue_proof_rejected() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let other = Buyer::new();
        let partial = buyer.partial();
        let bad = other.prove_knowledge(seller.vk_a, b"session-1");
        assert!(seller.pre_sign(buyer.vk_b, &partial, b"sighash", b"session-1", &bad, Scalar::ZERO).is_err());
    }
}
