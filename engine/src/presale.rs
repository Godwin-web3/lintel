//! Presale: sales that complete without the seller online when the buyer
//! arrives, and listings that sell more than once.
//!
//! # Why not reuse one `t` across buyers
//! The completed signature `s = s_a + s_b + t` reveals `t` to anyone who also
//! sees `s_a` and `s_b`. With one `t` per listing, the first sale makes the
//! content free for everyone. Here every copy ("unit") of a listing has its own
//! adaptor secret `t_i`, its own ciphertext and Halo 2 proof, its own merchant
//! key share `sk_i` and its own nonce `r_i`.
//!
//! # Preprocessing (seller side, at listing time)
//! For each unit the seller publishes `(vk_i, R_i, T_i, PoK_i, offer_i)`. The
//! nonce point `R_i` is fixed *before* any buyer exists (MuSig2-style
//! preprocessing). This is safe here because each `(sk_i, r_i)` pair is used
//! for at most one signature: one response `s_b = r_i + c * sk_i` with a fresh
//! uniform `r_i` hides `sk_i` perfectly, and with a single session per key there
//! are no concurrent sessions for a ROS/Wagner attack to combine. The seller
//! app enforces single use by marking a unit consumed on-device *before* it
//! computes `s_b`, and storing the completion so a retry re-sends identical
//! values (never a second response under the same nonce).
//!
//! # Buyer (any time; seller may be offline)
//! The buyer verifies `PoK_i` and `offer_i`, then pre-signs immediately:
//! `R = R_a + R_i + T_i`, `rk = vk_a + vk_i + alpha*G`, `c = H(R, rk, sighash)`,
//! `s_a = r_a + c (sk_a + alpha)`. It also sends a PoK of `sk_a` bound to the
//! unit and an ephemeral DH point `E = e*G`. `sk_a` and `r_a` are dropped after
//! this step; the buyer keeps only `e`.
//!
//! # Seller (next time its app runs)
//! One step: check the buyer PoK and `s_a`, then `s_b = r_i + c sk_i`,
//! `s = s_a + s_b + t_i`, and publish `s` with `s_b` masked to the buyer:
//! `enc_sb = s_b + H(sk_i * E, ...)`. The relay sees `s`, `s_a` and `enc_sb`,
//! which do not determine `t_i`. The buyer unmasks with `e * vk_i`, checks
//! `s_b * G == R_i + c vk_i`, and extracts `t_i = s - s_a - s_b`.
//!
//! # What still needs the seller
//! Completion *is* the release of `t_i`: whoever computes `s` learns `t_i`.
//! So a sale cannot finish with no `t`-holder online at all unless a third
//! party holds `t_i`, which this design refuses to do. Preprocessing removes
//! every round trip *before* completion, so the seller needs to come online
//! once, at any later time, and finishes all pending sales in one pass.

use blake2b_simd::Params;
use ff::{Field, FromUniformBytes, PrimeField};
use group::GroupEncoding;
use pasta_curves::pallas::{Base, Point, Scalar};
use rand::rng;

use crate::protocol::ORCHARD_BASEPOINT;
use crate::sealed;

fn g() -> Point { Point::from_bytes(&ORCHARD_BASEPOINT).unwrap() }

fn wide(personal: &[u8], parts: &[&[u8]]) -> Scalar {
    let mut st = Params::new().hash_length(64).personal(personal).to_state();
    for p in parts { st.update(p); }
    let arr: [u8; 64] = st.finalize().as_bytes().try_into().unwrap();
    <Scalar as FromUniformBytes<64>>::from_uniform_bytes(&arr)
}
/// RedPallas challenge, identical to `protocol::challenge`.
fn challenge(r: &Point, rk: &Point, msg: &[u8]) -> Scalar {
    wide(b"Zcash_RedPallasH", &[&r.to_bytes(), &rk.to_bytes(), msg])
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pok { pub r: Point, pub s: Scalar }

fn pok_prove(sk: Scalar, vk: Point, label: &[&[u8]]) -> Pok {
    let k = Scalar::random(&mut rng());
    let r = g() * k;
    let mut parts: Vec<&[u8]> = vec![];
    let (rb, vb) = (r.to_bytes(), vk.to_bytes());
    parts.push(&rb); parts.push(&vb); parts.extend_from_slice(label);
    let c = wide(b"Lintel_PoK_v2", &parts);
    Pok { r, s: k + c * sk }
}
fn pok_verify(p: &Pok, vk: Point, label: &[&[u8]]) -> bool {
    let mut parts: Vec<&[u8]> = vec![];
    let (rb, vb) = (p.r.to_bytes(), vk.to_bytes());
    parts.push(&rb); parts.push(&vb); parts.extend_from_slice(label);
    let c = wide(b"Lintel_PoK_v2", &parts);
    g() * p.s == p.r + vk * c
}

/// Public part of one unit. Safe to publish.
#[derive(Clone, Debug)]
pub struct UnitPublic { pub vk: Point, pub r: Point, pub t: Point, pub pok: Pok }

impl UnitPublic {
    fn label(&self) -> [[u8; 32]; 2] { [self.r.to_bytes(), self.t.to_bytes()] }
    /// Seller knows `sk_i` for `vk_i`, bound to this unit's `R_i` and `T_i`.
    pub fn verify_pok(&self) -> bool {
        let [r, t] = self.label();
        pok_verify(&self.pok, self.vk, &[b"unit", &r, &t])
    }
}

/// Secret part of one unit. Seller device only. Single use.
#[derive(Clone, Debug)]
pub struct UnitSecret { pub sk: Scalar, pub r: Scalar, pub s: Base }

impl UnitSecret {
    pub fn t(&self) -> Scalar { sealed::scalar_from_base(self.s) }
    pub fn public(&self) -> UnitPublic {
        let (vk, r, t) = (g() * self.sk, g() * self.r, g() * self.t());
        let pok = pok_prove(self.sk, vk, &[b"unit", &r.to_bytes(), &t.to_bytes()]);
        UnitPublic { vk, r, t, pok }
    }
}

/// Fresh unit: new key share, nonce and adaptor secret (`s` doubles as the
/// sealing secret, see `sealed::new_secret`).
pub fn new_unit() -> (UnitSecret, UnitPublic) {
    let (_, s) = sealed::new_secret();
    let sec = UnitSecret { sk: Scalar::random(&mut rng()), r: Scalar::random(&mut rng()), s };
    let p = sec.public();
    (sec, p)
}

/// What the buyer publishes with its order.
#[derive(Clone, Debug)]
pub struct Order { pub vk_a: Point, pub r_a: Point, pub e: Point, pub s_a: Scalar, pub pok: Pok, pub alpha: Scalar, pub sighash: Vec<u8> }

/// What the buyer keeps (only the DH secret; `sk_a`, `r_a` are dropped).
#[derive(Clone, Debug)]
pub struct BuyerKeep { pub e: Scalar }

/// Seller's completion: the full signature and `s_b` masked to the buyer.
#[derive(Clone, Debug)]
pub struct Completion { pub sig: [u8; 64], pub enc_sb: Scalar }

fn joint(u: &UnitPublic, o: &Order) -> (Point, Point, Scalar) {
    let r = o.r_a + u.r + u.t;
    let rk = o.vk_a + u.vk + g() * o.alpha;
    let c = challenge(&r, &rk, &o.sighash);
    (r, rk, c)
}
fn buyer_label(u: &UnitPublic, vk_a: &Point, e: &Point) -> [[u8; 32]; 5] {
    [u.vk.to_bytes(), u.r.to_bytes(), u.t.to_bytes(), vk_a.to_bytes(), e.to_bytes()]
}
fn pad(dh: &Point, u: &UnitPublic, o: &Order, r: &Point, rk: &Point) -> Scalar {
    wide(b"Lintel_sbpad_v1", &[&dh.to_bytes(), &u.vk.to_bytes(), &o.e.to_bytes(), &r.to_bytes(), &rk.to_bytes(), &o.sighash])
}

/// Buyer: pre-sign against a unit (after verifying its offer). Fails if the
/// unit's PoK is invalid.
pub fn buyer_order(u: &UnitPublic, alpha: Scalar, sighash: &[u8]) -> Result<(Order, BuyerKeep), &'static str> {
    if !u.verify_pok() { return Err("seller proof of knowledge is invalid"); }
    let mut rg = rng();
    let (sk_a, r_a, e) = (Scalar::random(&mut rg), Scalar::random(&mut rg), Scalar::random(&mut rg));
    let (vk_a, r_a_pt, e_pt) = (g() * sk_a, g() * r_a, g() * e);
    let l = buyer_label(u, &vk_a, &e_pt);
    let pok = pok_prove(sk_a, vk_a, &[b"buyer", &l[0], &l[1], &l[2], &l[3], &l[4]]);
    let mut o = Order { vk_a, r_a: r_a_pt, e: e_pt, s_a: Scalar::ZERO, pok, alpha, sighash: sighash.to_vec() };
    let (_, _, c) = joint(u, &o);
    o.s_a = r_a + c * (sk_a + alpha);
    Ok((o, BuyerKeep { e }))
}

/// Anyone (seller, relay, tests) can check a buyer's order against public data.
pub fn verify_order(u: &UnitPublic, o: &Order) -> bool {
    let l = buyer_label(u, &o.vk_a, &o.e);
    if !pok_verify(&o.pok, o.vk_a, &[b"buyer", &l[0], &l[1], &l[2], &l[3], &l[4]]) { return false; }
    let (_, _, c) = joint(u, o);
    g() * o.s_a == o.r_a + (o.vk_a + g() * o.alpha) * c
}

/// Seller: complete one order for one unit. Consumes the unit secret: the
/// caller must have durably marked the unit used before calling.
pub fn seller_complete(sec: UnitSecret, o: &Order) -> Result<Completion, &'static str> {
    let u = UnitPublic { vk: g() * sec.sk, r: g() * sec.r, t: g() * sec.t(), pok: Pok { r: g(), s: Scalar::ZERO } };
    if !verify_order(&u, o) { return Err("buyer order is invalid"); }
    let (r, rk, c) = joint(&u, o);
    let s_b = sec.r + c * sec.sk;
    let s = o.s_a + s_b + sec.t();
    if g() * s != r + rk * c { return Err("completed signature does not verify"); }
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r.to_bytes());
    sig[32..].copy_from_slice(s.to_repr().as_ref());
    let enc_sb = s_b + pad(&(o.e * sec.sk), &u, o, &r, &rk);
    Ok(Completion { sig, enc_sb })
}

/// Buyer: unmask `s_b`, check everything, return `t_i`.
pub fn buyer_extract(keep: &BuyerKeep, u: &UnitPublic, o: &Order, done: &Completion) -> Result<Scalar, &'static str> {
    let (r, rk, c) = joint(u, o);
    if done.sig[..32] != r.to_bytes() { return Err("signature uses a different nonce"); }
    let s: Scalar = Option::from(Scalar::from_repr(done.sig[32..].try_into().unwrap())).ok_or("invalid s")?;
    if g() * s != r + rk * c { return Err("signature does not verify"); }
    let s_b = done.enc_sb - pad(&(u.vk * keep.e), u, o, &r, &rk);
    if g() * s_b != u.r + u.vk * c { return Err("seller share does not verify"); }
    let t = s - o.s_a - s_b;
    if g() * t != u.t { return Err("extracted secret does not match T"); }
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol;

    fn order_for(u: &UnitPublic) -> (Order, BuyerKeep) { buyer_order(u, Scalar::from(11u64), b"sighash-x").unwrap() }

    #[test]
    fn offline_flow_extracts_t_and_sig_is_redpallas_valid() {
        let (sec, u) = new_unit();
        assert!(u.verify_pok());
        let t = sec.t();
        let (o, keep) = order_for(&u);
        assert!(verify_order(&u, &o));
        let done = seller_complete(sec, &o).unwrap();
        // Same verifier the rest of the engine uses.
        let rk = o.vk_a + u.vk + g() * o.alpha;
        assert!(protocol::verify_sig(&hex::encode(rk.to_bytes()), &hex::encode(&o.sighash), &done.sig));
        assert_eq!(buyer_extract(&keep, &u, &o, &done).unwrap(), t);
    }

    #[test]
    fn relay_view_does_not_reveal_t() {
        let (sec, u) = new_unit();
        let t = sec.t();
        let (o, _) = order_for(&u);
        let done = seller_complete(sec, &o).unwrap();
        let s: Scalar = Option::from(Scalar::from_repr(done.sig[32..].try_into().unwrap())).unwrap();
        // Everything the relay stores: s, s_a, enc_sb. None of the obvious combinations give t.
        for cand in [s - o.s_a, s - o.s_a - done.enc_sb, s - done.enc_sb, s] {
            assert_ne!(cand, t);
            assert_ne!(g() * cand, u.t);
        }
        // A party with the wrong DH secret cannot unmask s_b.
        let wrong = BuyerKeep { e: Scalar::random(&mut rng()) };
        assert!(buyer_extract(&wrong, &u, &o, &done).is_err());
    }

    #[test]
    fn units_are_independent_so_one_sale_does_not_unlock_another() {
        let (sec1, u1) = new_unit();
        let (sec2, u2) = new_unit();
        let t2 = sec2.t();
        let (o1, k1) = order_for(&u1);
        let d1 = seller_complete(sec1, &o1).unwrap();
        let t1 = buyer_extract(&k1, &u1, &o1, &d1).unwrap();
        assert_ne!(t1, t2);
        assert_ne!(u1.vk, u2.vk);
        assert_ne!(u1.r, u2.r);
    }

    #[test]
    fn tampered_orders_and_completions_are_rejected() {
        let (sec, u) = new_unit();
        let (o, keep) = order_for(&u);
        let mut bad = o.clone(); bad.s_a += Scalar::ONE;
        assert!(!verify_order(&u, &bad));
        assert!(seller_complete(sec.clone(), &bad).is_err());
        let mut bad = o.clone(); bad.sighash = b"other".to_vec();
        assert!(!verify_order(&u, &bad));
        // PoK from another unit does not transfer.
        let (_, u2) = new_unit();
        let (o2, _) = order_for(&u2);
        let mut bad = o.clone(); bad.pok = o2.pok.clone();
        assert!(!verify_order(&u, &bad));
        let mut forged = u.clone(); forged.pok = u2.pok.clone();
        assert!(!forged.verify_pok());
        assert!(buyer_order(&forged, Scalar::ONE, b"h").is_err());
        let mut done = seller_complete(sec, &o).unwrap();
        done.enc_sb += Scalar::ONE;
        assert!(buyer_extract(&keep, &u, &o, &done).is_err());
    }

    #[test]
    fn reusing_a_unit_nonce_would_leak_the_key_share() {
        // Documents why the app must never complete one unit twice.
        let (sec, u) = new_unit();
        let (o1, _) = order_for(&u);
        let (o2, _) = order_for(&u);
        let d1 = seller_complete(sec.clone(), &o1).unwrap();
        let d2 = seller_complete(sec.clone(), &o2).unwrap();
        let s = |d: &Completion| -> Scalar { Option::from(Scalar::from_repr(d.sig[32..].try_into().unwrap())).unwrap() };
        let (_, _, c1) = joint(&u, &o1);
        let (_, _, c2) = joint(&u, &o2);
        // A buyer who learns both s_b values (each buyer learns its own) recovers sk.
        let sb1 = s(&d1) - o1.s_a - sec.t();
        let sb2 = s(&d2) - o2.s_a - sec.t();
        assert_eq!((sb1 - sb2) * (c1 - c2).invert().unwrap(), sec.sk);
    }
}
