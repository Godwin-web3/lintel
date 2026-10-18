//! Lintel two-party adaptor protocol.
//! pre_sign rejects vk_b unless a valid knowledge proof is supplied.

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

#[derive(Clone)]
pub struct Seller { pub sk_a: Scalar, pub vk_a: Point }
#[derive(Clone)]
pub struct Buyer { pub sk_b: Scalar, pub vk_b: Point, pub t: Scalar }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PreSignature {
    pub r_prime_hex: String,
    pub s_a_hex: String,
    pub vk_hex: String,
    pub t_point_hex: String,
    pub sighash_hex: String,
}

#[derive(Clone, Debug)]
pub struct KnowledgeProof { pub r_point: Point, pub s: Scalar }

impl Seller {
    pub fn new() -> Self {
        let mut rng = rng();
        let sk_a = Scalar::random(&mut rng);
        Self { sk_a, vk_a: base() * sk_a }
    }
    /// Rejects the call if the buyer's knowledge proof does not verify.
    pub fn pre_sign(&self, vk_b: Point, t_point: Point, sighash: &[u8], pok: &KnowledgeProof) -> Result<PreSignature, &'static str> {
        if !verify_knowledge(vk_b, pok, b"pok-sk-b") {
            return Err("buyer knowledge proof failed");
        }
        let mut rng = rng();
        let r = Scalar::random(&mut rng);
        let r_prime = base() * r + t_point;
        let vk = self.vk_a + vk_b;
        let rp = r_prime.to_bytes();
        let vb = vk.to_bytes();
        let c = challenge(&rp, &vb, sighash);
        Ok(PreSignature {
            r_prime_hex: hex::encode(rp),
            s_a_hex: hex::encode((r + c * self.sk_a).to_repr()),
            vk_hex: hex::encode(vb),
            t_point_hex: hex::encode(t_point.to_bytes()),
            sighash_hex: hex::encode(sighash),
        })
    }
    pub fn prove_knowledge(&self) -> KnowledgeProof {
        let mut rng = rng();
        let k = Scalar::random(&mut rng);
        let r_point = base() * k;
        let c = challenge(&r_point.to_bytes(), &self.vk_a.to_bytes(), b"pok-sk-a");
        KnowledgeProof { r_point, s: k + c * self.sk_a }
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
    pub fn verify_presig(&self, pre: &PreSignature) -> bool {
        let rp = Point::from_bytes(&hex::decode(&pre.r_prime_hex).unwrap().try_into().unwrap()).unwrap();
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        let vk = Point::from_bytes(&hex::decode(&pre.vk_hex).unwrap().try_into().unwrap()).unwrap();
        let tp = Point::from_bytes(&hex::decode(&pre.t_point_hex).unwrap().try_into().unwrap()).unwrap();
        let msg = hex::decode(&pre.sighash_hex).unwrap();
        let c = challenge(&rp.to_bytes(), &vk.to_bytes(), &msg);
        base() * s_a == rp - tp + (vk - self.vk_b) * c
    }
    pub fn complete(&self, pre: &PreSignature) -> [u8; 64] {
        let rp = Point::from_bytes(&hex::decode(&pre.r_prime_hex).unwrap().try_into().unwrap()).unwrap();
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        let vk = Point::from_bytes(&hex::decode(&pre.vk_hex).unwrap().try_into().unwrap()).unwrap();
        let msg = hex::decode(&pre.sighash_hex).unwrap();
        let c = challenge(&rp.to_bytes(), &vk.to_bytes(), &msg);
        let s = s_a + c * self.sk_b + self.t;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&rp.to_bytes());
        sig[32..].copy_from_slice(s.to_repr().as_ref());
        sig
    }
    pub fn verify_completed(&self, pre: &PreSignature, sig: &[u8; 64]) -> bool {
        let rp = Point::from_bytes(&sig[..32].try_into().unwrap()).unwrap();
        let s = Scalar::from_repr(sig[32..].try_into().unwrap()).unwrap();
        let vk = Point::from_bytes(&hex::decode(&pre.vk_hex).unwrap().try_into().unwrap()).unwrap();
        let msg = hex::decode(&pre.sighash_hex).unwrap();
        let c = challenge(&rp.to_bytes(), &vk.to_bytes(), &msg);
        base() * s == rp + vk * c
    }
    pub fn prove_knowledge(&self) -> KnowledgeProof {
        let mut rng = rng();
        let k = Scalar::random(&mut rng);
        let r_point = base() * k;
        let c = challenge(&r_point.to_bytes(), &self.vk_b.to_bytes(), b"pok-sk-b");
        KnowledgeProof { r_point, s: k + c * self.sk_b }
    }
}

pub fn extract_t(pre: &PreSignature, sig: &[u8; 64], sk_b: Scalar) -> Scalar {
    let rp = Point::from_bytes(&hex::decode(&pre.r_prime_hex).unwrap().try_into().unwrap()).unwrap();
    let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
    let vk = Point::from_bytes(&hex::decode(&pre.vk_hex).unwrap().try_into().unwrap()).unwrap();
    let msg = hex::decode(&pre.sighash_hex).unwrap();
    let c = challenge(&rp.to_bytes(), &vk.to_bytes(), &msg);
    Scalar::from_repr(sig[32..].try_into().unwrap()).unwrap() - s_a - c * sk_b
}

pub fn verify_knowledge(vk: Point, proof: &KnowledgeProof, label: &[u8]) -> bool {
    let c = challenge(&proof.r_point.to_bytes(), &vk.to_bytes(), label);
    base() * proof.s == proof.r_point + vk * c
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_verify() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let pre = seller.pre_sign(buyer.vk_b, buyer.t_point(), b"sighash", &buyer.prove_knowledge()).unwrap();
        assert!(buyer.verify_presig(&pre));
        let sig = buyer.complete(&pre);
        assert!(buyer.verify_completed(&pre, &sig));
        assert_eq!(extract_t(&pre, &sig, buyer.sk_b), buyer.t);
    }
    #[test]
    fn rogue_key_rejected() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let other = Buyer::new();
        // Proof for a different key must be rejected
        assert!(seller.pre_sign(buyer.vk_b, buyer.t_point(), b"sighash", &other.prove_knowledge()).is_err());
    }
    #[test]
    fn wrong_t_fails() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let pre = seller.pre_sign(buyer.vk_b, buyer.t_point(), b"sighash", &buyer.prove_knowledge()).unwrap();
        let mut fake = Buyer::new();
        fake.sk_b = buyer.sk_b;
        fake.vk_b = buyer.vk_b;
        assert!(!buyer.verify_completed(&pre, &fake.complete(&pre)));
    }
}
