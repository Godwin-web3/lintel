//! Lintel two-party adaptor protocol.
//! Seller holds only sk_a. Buyer holds only sk_b and t.
//! T = t·G is the only value shared before completion.
//! The message signed is the transaction sighash, not a condition string.

use pasta_curves::pallas::{Point, Scalar};
use group::{Group, GroupEncoding};
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

fn base() -> Point {
    Point::from_bytes(&ORCHARD_BASEPOINT).unwrap()
}

/// Seller's view. Holds only sk_a.
#[derive(Clone)]
pub struct Seller {
    pub sk_a: Scalar,
    pub vk_a: Point,
}

/// Buyer's view. Holds only sk_b and the condition secret t.
#[derive(Clone)]
pub struct Buyer {
    pub sk_b: Scalar,
    pub vk_b: Point,
    pub t: Scalar,
}

/// What the seller publishes. Does not contain sk_a, sk_b, or t.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PreSignature {
    pub r_prime_hex: String,
    pub s_a_hex: String,
    pub vk_a_hex: String,
    pub t_point_hex: String,
    pub sighash_hex: String,
}

impl Seller {
    pub fn new() -> Self {
        let mut rng = rng();
        let sk_a = Scalar::random(&mut rng);
        let vk_a = base() * sk_a;
        Self { sk_a, vk_a }
    }

    /// Create an adaptor pre-signature. Receives only T from the buyer.
    pub fn pre_sign(&self, t_point: Point, sighash: &[u8]) -> PreSignature {
        let mut rng = rng();
        let r = Scalar::random(&mut rng);
        let r_prime = base() * r + t_point;
        let rp_bytes = r_prime.to_bytes();
        let vk_bytes = self.vk_a.to_bytes();
        let c = challenge(&rp_bytes, &vk_bytes, sighash);
        let s_a = r + c * self.sk_a;
        PreSignature {
            r_prime_hex: hex::encode(rp_bytes),
            s_a_hex: hex::encode(s_a.to_repr()),
            vk_a_hex: hex::encode(vk_bytes),
            t_point_hex: hex::encode(t_point.to_bytes()),
            sighash_hex: hex::encode(sighash),
        }
    }
}

impl Buyer {
    pub fn new() -> Self {
        let mut rng = rng();
        let sk_b = Scalar::random(&mut rng);
        let t = Scalar::random(&mut rng);
        let vk_b = base() * sk_b;
        Self { sk_b, vk_b, t }
    }

    pub fn t_point(&self) -> Point {
        base() * self.t
    }

    /// Verify the seller's pre-signature: s_a·G == R' - T + c·vk_a
    pub fn verify_presig(&self, pre: &PreSignature) -> bool {
        let rp = Point::from_bytes(&hex::decode(&pre.r_prime_hex).unwrap().try_into().unwrap()).unwrap();
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        let vk_a = Point::from_bytes(&hex::decode(&pre.vk_a_hex).unwrap().try_into().unwrap()).unwrap();
        let t_point = Point::from_bytes(&hex::decode(&pre.t_point_hex).unwrap().try_into().unwrap()).unwrap();
        let sighash = hex::decode(&pre.sighash_hex).unwrap();
        let c = challenge(&rp.to_bytes(), &vk_a.to_bytes(), &sighash);
        let lhs = base() * s_a;
        let rhs = rp - t_point + vk_a * c;
        lhs == rhs
    }

    /// Complete the signature. Only the buyer can do this.
    pub fn complete(&self, pre: &PreSignature) -> [u8; 64] {
        let rp = Point::from_bytes(&hex::decode(&pre.r_prime_hex).unwrap().try_into().unwrap()).unwrap();
        let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
        let vk_a = Point::from_bytes(&hex::decode(&pre.vk_a_hex).unwrap().try_into().unwrap()).unwrap();
        let sighash = hex::decode(&pre.sighash_hex).unwrap();
        let vk = vk_a + self.vk_b;
        let c = challenge(&rp.to_bytes(), &vk.to_bytes(), &sighash);
        let s = s_a + c * self.sk_b + self.t;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&rp.to_bytes());
        sig[32..].copy_from_slice(s.to_repr().as_ref());
        sig
    }
}

/// Extract t from the completed signature.
pub fn extract_t(pre: &PreSignature, completed_sig: &[u8; 64], sk_b: Scalar) -> Scalar {
    let rp = Point::from_bytes(&hex::decode(&pre.r_prime_hex).unwrap().try_into().unwrap()).unwrap();
    let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
    let vk_a = Point::from_bytes(&hex::decode(&pre.vk_a_hex).unwrap().try_into().unwrap()).unwrap();
    let sighash = hex::decode(&pre.sighash_hex).unwrap();
    let vk = vk_a + base() * sk_b;
    let c = challenge(&rp.to_bytes(), &vk.to_bytes(), &sighash);
    let s = Scalar::from_repr(completed_sig[32..].try_into().unwrap()).unwrap();
    s - s_a - c * sk_b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_party_roundtrip() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let sighash = b"real-tx-sighash-32-bytes-pad!!";
        let pre = seller.pre_sign(buyer.t_point(), sighash);
        assert!(buyer.verify_presig(&pre), "pre-signature must verify");
        let sig = buyer.complete(&pre);
        let extracted = extract_t(&pre, &sig, buyer.sk_b);
        assert_eq!(extracted, buyer.t, "extracted t must match");
    }

    #[test]
    fn adversary_cannot_complete() {
        let seller = Seller::new();
        let buyer = Buyer::new();
        let sighash = b"sighash";
        let pre = seller.pre_sign(buyer.t_point(), sighash);
        let mut fake = Buyer::new();
        fake.sk_b = buyer.sk_b;
        let bad_sig = fake.complete(&pre);
        let extracted = extract_t(&pre, &bad_sig, buyer.sk_b);
        assert_ne!(extracted, buyer.t);
    }
}
