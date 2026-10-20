//! Browser bindings for presale listings (engine `presale` + `sealed_multi`).
//!
//! * Many copies per listing, each with its own adaptor secret (no shared `t`).
//! * The seller pre-computes everything that does not need a buyer, so a buyer
//!   pre-signs without waiting and the seller finishes in one step later.
//! * Payloads up to `maxPayloadV2()` bytes, proven in parts with the same
//!   pinned parameter file.
//!
//! Secrets (`UnitSecret`, the buyer's DH key) are returned only as opaque JSON
//! for device-local storage; the app never sends them to the relay.

use ff::PrimeField;
use group::GroupEncoding;
use lintel::presale::{self, BuyerKeep, Completion, Order, Pok, UnitPublic, UnitSecret};
use lintel::protocol::{parse_point, parse_scalar};
use lintel::sealed::{self, CHUNKS};
use lintel::sealed_multi::{self, prove::Keys, MultiOffer, MultiOfferWire};
use pasta_curves::pallas::{Point, Scalar};
use serde::{Deserialize, Serialize};
use std::cell::OnceCell;
use wasm_bindgen::prelude::*;

type R<T> = Result<T, JsError>;
fn err(m: &str) -> JsError { JsError::new(m) }
fn ph(p: &Point) -> String { hex::encode(p.to_bytes()) }
fn sh(s: &Scalar) -> String { hex::encode(s.to_repr()) }
fn pt(h: &str, w: &str) -> R<Point> { parse_point(h).ok_or_else(|| err(&format!("invalid {w}"))) }
fn sc(h: &str, w: &str) -> R<Scalar> { parse_scalar(h).ok_or_else(|| err(&format!("invalid {w}"))) }

thread_local! {
    static KEYS: OnceCell<Keys<CHUNKS>> = const { OnceCell::new() };
}
fn with_keys<T>(f: impl FnOnce(&Keys<CHUNKS>) -> T) -> R<T> {
    KEYS.with(|cell| {
        if cell.get().is_none() {
            let k = sealed_multi::prove::setup::<CHUNKS>().map_err(|_| err("proving key setup failed"))?;
            let _ = cell.set(k);
        }
        Ok(f(cell.get().unwrap()))
    })
}

/// Builds the multi-part keys from the published `params.bin` (same file and
/// pinned digest as `warmUpWithParams`).
#[wasm_bindgen(js_name = warmUpV2WithParams)]
pub fn warm_up_v2_with_params(bytes: &[u8]) -> R<()> {
    let mut pinned = [0u8; 32];
    hex::decode_to_slice(super::PINNED_PARAMS, &mut pinned).map_err(|_| err("bad pin"))?;
    KEYS.with(|cell| {
        if cell.get().is_none() {
            let k = sealed_multi::prove::setup_from_params::<CHUNKS>(bytes, &pinned).map_err(err)?;
            let _ = cell.set(k);
        }
        Ok(())
    })
}

#[wasm_bindgen(js_name = warmUpV2)]
pub fn warm_up_v2() -> R<()> { with_keys(|_| ()) }

#[wasm_bindgen(js_name = maxPayloadV2)]
pub fn max_payload_v2() -> usize { sealed_multi::MAX_PAYLOAD }

/// Aggregate content hash (hex) the buyer should expect for `payload`.
#[wasm_bindgen(js_name = contentHashV2)]
pub fn content_hash_v2(payload: &[u8]) -> R<String> {
    sealed_multi::content_hash_bytes::<CHUNKS>(payload).map(hex::encode).ok_or_else(|| err("payload too large"))
}

// ---------- wire ----------

#[derive(Serialize, Deserialize)]
struct PokW { r: String, s: String }
#[derive(Serialize, Deserialize)]
struct SecretW { sk: String, r: String, s: String }
/// A unit as the relay stores it. `pok` and `offer` are JSON strings.
#[derive(Serialize, Deserialize)]
pub struct UnitW { t_point: String, merchant_vk: String, r_b: String, pok: String, #[serde(default)] offer: Option<String> }
#[derive(Serialize, Deserialize)]
struct OrderW { payer_vk: String, r_a: String, dh_point: String, s_a: String, payer_pok: String, alpha: String, sighash: String }
#[derive(Serialize, Deserialize)]
struct DoneW { signature: String, enc_sb: String }

fn pok_to(p: &Pok) -> String { serde_json::to_string(&PokW { r: ph(&p.r), s: sh(&p.s) }).unwrap() }
fn pok_from(j: &str) -> R<Pok> {
    let w: PokW = serde_json::from_str(j).map_err(|_| err("invalid proof json"))?;
    Ok(Pok { r: pt(&w.r, "proof point")?, s: sc(&w.s, "proof scalar")? })
}
fn unit_from(j: &str) -> R<(UnitPublic, Option<String>)> {
    let w: UnitW = serde_json::from_str(j).map_err(|_| err("invalid unit json"))?;
    Ok((UnitPublic { vk: pt(&w.merchant_vk, "unit key")?, r: pt(&w.r_b, "unit nonce")?, t: pt(&w.t_point, "T")?, pok: pok_from(&w.pok)? }, w.offer))
}
fn offer_from(j: &str) -> R<MultiOffer> {
    let w: MultiOfferWire = serde_json::from_str(j).map_err(|_| err("invalid offer json"))?;
    MultiOffer::from_wire(&w).ok_or_else(|| err("malformed offer"))
}
fn order_from(j: &str) -> R<Order> {
    let w: OrderW = serde_json::from_str(j).map_err(|_| err("invalid order json"))?;
    Ok(Order {
        vk_a: pt(&w.payer_vk, "payer key")?, r_a: pt(&w.r_a, "payer nonce")?, e: pt(&w.dh_point, "DH point")?,
        s_a: sc(&w.s_a, "pre-signature")?, pok: pok_from(&w.payer_pok)?, alpha: sc(&w.alpha, "alpha")?,
        sighash: hex::decode(&w.sighash).map_err(|_| err("invalid sighash"))?,
    })
}
/// Digest of exactly the unit the buyer verified (keys, points, PoK and the
/// offer with its proofs), so unlocking later cannot be pointed at a different
/// offer by whoever serves the unit again.
fn unit_digest(j: &str) -> R<String> {
    let w: UnitW = serde_json::from_str(j).map_err(|_| err("invalid unit json"))?;
    let mut st = blake2b_simd::Params::new().hash_length(32).personal(b"Lintel_unitbind1").to_state();
    for f in [w.t_point.as_str(), w.merchant_vk.as_str(), w.r_b.as_str(), w.pok.as_str(), w.offer.as_deref().unwrap_or("")] {
        st.update(&(f.len() as u64).to_le_bytes());
        st.update(f.as_bytes());
    }
    Ok(hex::encode(st.finalize().as_bytes()))
}
/// Buyer's device-local state for one order: the DH secret and the digest of
/// the unit it verified. Legacy form: the bare DH secret (no unit binding).
#[derive(Serialize, Deserialize)]
struct KeepW { e: String, unit: String }

fn order_to(o: &Order) -> OrderW {
    OrderW { payer_vk: ph(&o.vk_a), r_a: ph(&o.r_a), dh_point: ph(&o.e), s_a: sh(&o.s_a), payer_pok: pok_to(&o.pok), alpha: sh(&o.alpha), sighash: hex::encode(&o.sighash) }
}

// ---------- seller ----------

/// Seals `payload` as one fresh unit (new key share, nonce, adaptor secret).
/// Returns `{ unit, secret }`: `unit` is public (send to the relay), `secret`
/// is device-local only.
#[wasm_bindgen(js_name = sealUnit)]
pub fn seal_unit(payload: &[u8]) -> R<String> {
    let (sec, u) = presale::new_unit();
    let offer = with_keys(|k| sealed_multi::seal::<CHUNKS>(k, sec.s, payload))?.map_err(err)?;
    let unit = UnitW {
        t_point: ph(&u.t), merchant_vk: ph(&u.vk), r_b: ph(&u.r), pok: pok_to(&u.pok),
        offer: Some(serde_json::to_string(&offer.to_wire()).unwrap()),
    };
    let secret = serde_json::to_string(&SecretW { sk: sh(&sec.sk), r: sh(&sec.r), s: sealed::field_hex(&sec.s) }).unwrap();
    Ok(serde_json::json!({ "unit": unit, "secret": secret }).to_string())
}

/// Public check of a buyer's order (PoK + pre-signature) for a unit.
#[wasm_bindgen(js_name = checkOrder)]
pub fn check_order(unit: &str, order: &str) -> R<bool> {
    let (u, _) = unit_from(unit)?;
    Ok(presale::verify_order(&u, &order_from(order)?))
}

/// Completes the one sale this unit allows. The caller must durably mark the
/// unit consumed *before* calling and store the result for retries.
#[wasm_bindgen(js_name = sellerComplete)]
pub fn seller_complete(secret: &str, order: &str) -> R<String> {
    let w: SecretW = serde_json::from_str(secret).map_err(|_| err("invalid unit secret"))?;
    let sec = UnitSecret {
        sk: sc(&w.sk, "unit key")?, r: sc(&w.r, "unit nonce")?,
        s: sealed::parse_field(&w.s).ok_or_else(|| err("invalid unit secret"))?,
    };
    let done = presale::seller_complete(sec, &order_from(order)?).map_err(err)?;
    Ok(serde_json::to_string(&DoneW { signature: hex::encode(done.sig), enc_sb: sh(&done.enc_sb) }).unwrap())
}

// ---------- buyer ----------

/// Verifies a unit (seller PoK, offer proofs, T binding, content hash).
#[wasm_bindgen(js_name = verifyUnit)]
pub fn verify_unit(unit: &str, expected_hash: &str) -> R<()> {
    let (u, offer) = unit_from(unit)?;
    if !u.verify_pok() { return Err(err("seller proof of knowledge is invalid")); }
    let o = offer_from(offer.as_deref().ok_or_else(|| err("unit has no offer"))?)?;
    let h: [u8; 32] = hex::decode(expected_hash).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| err("invalid content hash"))?;
    if !with_keys(|k| sealed_multi::verify_offer(k, &o, &u.t, &h))? {
        return Err(err("offer proof does not verify"));
    }
    Ok(())
}

/// Verifies the unit, then pre-signs against it. Returns `{ order, keep }`:
/// `order` is public (send to the relay), `keep` is the buyer's DH secret
/// (device-local). The signing share and nonce are discarded here.
#[wasm_bindgen(js_name = buyerOrder)]
pub fn buyer_order(unit: &str, expected_hash: &str, alpha: &str, sighash: &[u8]) -> R<String> {
    verify_unit(unit, expected_hash)?;
    let (u, _) = unit_from(unit)?;
    let (o, keep) = presale::buyer_order(&u, sc(alpha, "alpha")?, sighash).map_err(err)?;
    let keep = serde_json::to_string(&KeepW { e: sh(&keep.e), unit: unit_digest(unit)? }).unwrap();
    Ok(serde_json::json!({ "order": order_to(&o), "keep": keep }).to_string())
}

/// Checks the seller's completion, extracts this unit's `t`, decrypts.
#[wasm_bindgen(js_name = buyerUnlock)]
pub fn buyer_unlock(keep: &str, unit: &str, order: &str, completion: &str) -> R<Vec<u8>> {
    let e = match serde_json::from_str::<KeepW>(keep) {
        Ok(k) => {
            if k.unit != unit_digest(unit)? { return Err(err("this copy changed since it was verified; refusing to unlock")); }
            k.e
        }
        Err(_) => keep.to_string(), // legacy: bare DH secret
    };
    let (u, offer) = unit_from(unit)?;
    let o = order_from(order)?;
    let d: DoneW = serde_json::from_str(completion).map_err(|_| err("invalid completion json"))?;
    let sig: [u8; 64] = hex::decode(&d.signature).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| err("signature must be 64 bytes"))?;
    let done = Completion { sig, enc_sb: sc(&d.enc_sb, "masked share")? };
    let t = presale::buyer_extract(&BuyerKeep { e: sc(&e, "buyer key")? }, &u, &o, &done).map_err(err)?;
    let offer = offer_from(offer.as_deref().ok_or_else(|| err("unit has no offer"))?)?;
    sealed_multi::open(t, &offer).ok_or_else(|| err("decryption failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presale_flow_through_bindings_with_pinned_params() {
        let params = sealed::prove::params_bytes::<CHUNKS>();
        warm_up_v2_with_params(&params).unwrap();
        let payload: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect(); // 2 parts
        let h = content_hash_v2(&payload).unwrap();
        let sealed: serde_json::Value = serde_json::from_str(&seal_unit(&payload).unwrap()).unwrap();
        let unit = sealed["unit"].to_string();
        let secret = sealed["secret"].as_str().unwrap().to_string();
        verify_unit(&unit, &h).unwrap();
        let alpha = sh(&Scalar::from(5u64));
        let b: serde_json::Value = serde_json::from_str(&buyer_order(&unit, &h, &alpha, b"sighash").unwrap()).unwrap();
        let order = b["order"].to_string();
        assert!(check_order(&unit, &order).unwrap());
        let done = seller_complete(&secret, &order).unwrap();
        let keep = b["keep"].as_str().unwrap();
        let out = buyer_unlock(keep, &unit, &order, &done).unwrap();
        assert_eq!(out, payload);
        // The keep is bound to the verified unit: a re-served unit with any field changed has another digest.
        let mut other: serde_json::Value = serde_json::from_str(&unit).unwrap();
        let sealed2: serde_json::Value = serde_json::from_str(&seal_unit(&payload).unwrap()).unwrap();
        other["offer"] = sealed2["unit"]["offer"].clone();
        assert_ne!(unit_digest(&other.to_string()).unwrap(), unit_digest(&unit).unwrap());
        assert_eq!(unit_digest(&unit).unwrap(), serde_json::from_str::<serde_json::Value>(keep).unwrap()["unit"].as_str().unwrap());
        // (Error paths construct JsError, which only exists on wasm; web/e2e.mjs covers them.)
        // Public output carries no secret material.
        assert!(!unit.contains(&serde_json::from_str::<serde_json::Value>(&secret).unwrap()["s"].as_str().unwrap().to_string()));
    }
}
