//! Legacy single-process demo service used by web/server.py.
//! Peer-supplied hex is parsed without panicking.
use pasta_curves::pallas::{Point, Scalar};
use group::GroupEncoding;
use ff::{Field, PrimeField, FromUniformBytes};
use rand::rng;
use blake2b_simd::Params;
use crate::protocol::{parse_point, parse_scalar};
use serde::{Serialize, Deserialize};

const ORCHARD_BASEPOINT: [u8; 32] = [
    99, 201, 117, 184, 132, 114, 26, 141, 12, 161, 112, 123, 227, 12, 127, 12, 95, 68, 95, 62, 124,
    24, 141, 59, 6, 214, 241, 40, 179, 35, 85, 183,
];

fn challenge(r: &[u8; 32], vk: &[u8; 32], msg: &[u8]) -> Scalar {
    let h = Params::new().hash_length(64).personal(b"Zcash_RedPallasH")
        .to_state().update(r).update(vk).update(msg).finalize();
    let arr: [u8; 64] = h.as_bytes().try_into().unwrap();
    <Scalar as FromUniformBytes<64>>::from_uniform_bytes(&arr)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CreateResult {
    pub code: String,
    pub amount: String,
    pub condition: String,
    pub r_prime_hex: String,
    pub s_a_hex: String,
    pub vk_hex: String,
    pub sk_b_hex: String,
    pub t_hex: String,
}

pub fn create_payment(amount: &str, condition: &str) -> CreateResult {
    let mut rng = rng();
    let base = Point::from_bytes(&ORCHARD_BASEPOINT).unwrap();
    let sk_a = Scalar::random(&mut rng);
    let sk_b = Scalar::random(&mut rng);
    let t = Scalar::random(&mut rng);
    let r = Scalar::random(&mut rng);
    let sk = sk_a + sk_b;
    let vk = base * sk;
    let msg = condition.as_bytes();
    let r_prime = base * r + base * t;
    let rp_bytes = r_prime.to_bytes();
    let vk_bytes = vk.to_bytes();
    let c = challenge(&rp_bytes, &vk_bytes, msg);
    let s_a = r + c * sk_a;
    let code = format!("LINTEL-{}", &hex::encode(&rp_bytes)[..8].to_uppercase());
    CreateResult {
        code,
        amount: amount.into(),
        condition: condition.into(),
        r_prime_hex: hex::encode(rp_bytes),
        s_a_hex: hex::encode(s_a.to_repr()),
        vk_hex: hex::encode(vk_bytes),
        sk_b_hex: hex::encode(sk_b.to_repr()),
        t_hex: hex::encode(t.to_repr()),
    }
}

pub fn complete_payment(cr: &CreateResult) -> Result<String, &'static str> {
    let rp = parse_point(&cr.r_prime_hex).ok_or("invalid r_prime")?;
    let s_a = parse_scalar(&cr.s_a_hex).ok_or("invalid s_a")?;
    let vk = parse_point(&cr.vk_hex).ok_or("invalid vk")?;
    let sk_b = parse_scalar(&cr.sk_b_hex).ok_or("invalid sk_b")?;
    let t = parse_scalar(&cr.t_hex).ok_or("invalid t")?;
    let msg = cr.condition.as_bytes();
    let c = challenge(&rp.to_bytes(), &vk.to_bytes(), msg);
    let s = s_a + c * sk_b + t;
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&rp.to_bytes());
    sig[32..].copy_from_slice(s.to_repr().as_ref());
    Ok(hex::encode(sig))
}
