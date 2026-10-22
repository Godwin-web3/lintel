//! Browser bindings for big sealed payloads (offer v3, engine `sealed_big`).
//!
//! * Up to `maxPayloadBig()` bytes (about 1.5 MB), every byte's decryption
//!   proven: 768 field elements (23,808 bytes) per Halo 2 proof at k = 15.
//! * Keys come from `params-big.bin` (2 MB, transparent IPA parameters) whose
//!   digest is pinned below; any other file is rejected.
//! * Sealing is one part per call (`BigSealer.provePart`), so the app can show
//!   progress and keep the tab responsive between parts. Each call returns the
//!   part's blob; the app uploads blobs to the relay's content-addressed store
//!   and publishes only the manifest (`BigSealer.manifest`).
//! * Verifying and opening take the manifest with every blob inline as
//!   `parts[i].data` (hex), which the app fills after fetching the blobs; each
//!   blob is re-checked here against the SHA-256 the manifest names.

use lintel::sealed_big::{self, prove::Keys, BigOffer, BigOfferWire, PartRef, Sealer, CHUNKS};
use lintel::sealed;
use pasta_curves::pallas::{Point, Scalar};
use std::cell::OnceCell;
use wasm_bindgen::prelude::*;

type R<T> = Result<T, JsError>;
fn err(m: &str) -> JsError { JsError::new(m) }

/// BLAKE2b-256 (personal "lintel-params-v1") of `params-big.bin` (k = 15).
/// Regenerate with `cargo run --release --example dump_params -- params-big.bin big`.
pub(crate) const PINNED_PARAMS_BIG: &str = "0544c62205e5aef0143b8602a8db238c938faece80f05816467a1b74e9004e73";

thread_local! {
    static KEYS: OnceCell<Keys<CHUNKS>> = const { OnceCell::new() };
}

pub(crate) fn with_keys<T>(f: impl FnOnce(&Keys<CHUNKS>) -> T) -> R<T> {
    KEYS.with(|cell| match cell.get() {
        Some(k) => Ok(f(k)),
        None => Err(err("big-payload keys are not loaded (call warmUpBigWithParams first)")),
    })
}

/// Builds the v3 keys from `params-big.bin`. Rejects any file whose digest differs.
#[wasm_bindgen(js_name = warmUpBigWithParams)]
pub fn warm_up_big_with_params(bytes: &[u8]) -> R<()> {
    let mut pinned = [0u8; 32];
    hex::decode_to_slice(PINNED_PARAMS_BIG, &mut pinned).map_err(|_| err("bad pin"))?;
    KEYS.with(|cell| {
        if cell.get().is_none() {
            let k = sealed_big::prove::setup_from_params::<CHUNKS>(bytes, &pinned).map_err(err)?;
            let _ = cell.set(k);
        }
        Ok(())
    })
}

#[wasm_bindgen(js_name = bigReady)]
pub fn big_ready() -> bool { KEYS.with(|c| c.get().is_some()) }

#[wasm_bindgen(js_name = maxPayloadBig)]
pub fn max_payload_big() -> usize { sealed_big::MAX_PAYLOAD }

/// Payload bytes per proven part (23,808).
#[wasm_bindgen(js_name = bigPartBytes)]
pub fn big_part_bytes() -> usize { CHUNKS * sealed::BYTES_PER_CHUNK }

/// Number of proofs a payload of `len` bytes needs (0 if too large).
#[wasm_bindgen(js_name = bigPartsFor)]
pub fn big_parts_for(len: usize) -> usize { sealed_big::parts_for(len, CHUNKS).unwrap_or(0) }

/// v3 content hash (hex) the buyer should expect for `payload`.
#[wasm_bindgen(js_name = contentHashBig)]
pub fn content_hash_big(payload: &[u8]) -> R<String> {
    sealed_big::content_hash_bytes::<CHUNKS>(payload).map(hex::encode).ok_or_else(|| err("payload too large"))
}

/// Seals one payload part by part under an adaptor secret.
#[wasm_bindgen]
pub struct BigSealer {
    inner: Sealer<CHUNKS>,
    refs: Vec<Option<(sealed_big::Part, PartRef)>>,
}

impl BigSealer {
    pub(crate) fn from_secret(s: pasta_curves::pallas::Base, payload: &[u8]) -> R<BigSealer> {
        let inner = Sealer::<CHUNKS>::new(s, payload).map_err(err)?;
        let n = inner.parts();
        Ok(BigSealer { inner, refs: vec![None; n] })
    }
}

#[wasm_bindgen]
impl BigSealer {
    /// `secret` is the adaptor secret as a base field element (hex), e.g. the
    /// `s` of a presale unit secret. Device-local only.
    #[wasm_bindgen(constructor)]
    pub fn new(secret: &str, payload: &[u8]) -> R<BigSealer> {
        let s = sealed::parse_field(secret).ok_or_else(|| err("invalid secret"))?;
        Self::from_secret(s, payload)
    }

    pub fn parts(&self) -> usize { self.inner.parts() }

    /// Proves part `j` and returns its blob (upload it under `blobId(j)`).
    #[wasm_bindgen(js_name = provePart)]
    pub fn prove_part(&mut self, j: usize) -> R<Vec<u8>> {
        let part = with_keys(|k| self.inner.prove_part(k, j))?.map_err(err)?;
        let blob = part.to_blob();
        let r = PartRef { hash: sealed::field_hex(&part.hash), offset: part.offset, blob: sealed_big::blob_id(&blob), len: blob.len(), data: None };
        self.refs[j] = Some((part, r));
        Ok(blob)
    }

    /// SHA-256 id of part `j`'s blob (after `provePart(j)`).
    #[wasm_bindgen(js_name = blobId)]
    pub fn blob_id(&self, j: usize) -> R<String> {
        self.refs.get(j).and_then(|r| r.as_ref()).map(|(_, r)| r.blob.clone()).ok_or_else(|| err("part not proven yet"))
    }

    /// The public manifest (offer v3, no blob data). Every part must be proven.
    pub fn manifest(&self) -> R<String> {
        let parts = self.refs.iter().map(|r| r.as_ref().map(|(p, _)| p.clone())).collect::<Option<Vec<_>>>()
            .ok_or_else(|| err("not every part is proven yet"))?;
        let (w, _) = BigOffer { t_point: self.inner.t_point(), parts }.to_manifest();
        Ok(serde_json::to_string(&w).unwrap())
    }

    #[wasm_bindgen(js_name = tPoint)]
    pub fn t_point(&self) -> String { hex::encode(group::GroupEncoding::to_bytes(&self.inner.t_point())) }
}

/// Parses a v3 offer (manifest with inline blob data). `None` if it is not v3.
pub(crate) fn parse(offer: &str) -> Option<R<BigOffer>> {
    let v: serde_json::Value = serde_json::from_str(offer).ok()?;
    if v.get("v").and_then(|x| x.as_u64()) != Some(3) { return None; }
    Some((|| {
        let w: BigOfferWire = serde_json::from_value(v).map_err(|_| err("invalid offer json"))?;
        if w.parts.iter().any(|p| p.data.is_none()) { return Err(err("offer blobs are not attached (fetch them from the relay first)")); }
        BigOffer::from_wire(&w).ok_or_else(|| err("malformed offer or a blob does not match its content address"))
    })())
}

/// Verifies a v3 offer against `expected_t` and the expected content hash.
pub(crate) fn verify(o: &BigOffer, expected_t: &Point, expected_hash: &str) -> R<()> {
    let h: [u8; 32] = hex::decode(expected_hash).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| err("invalid content hash"))?;
    if !with_keys(|k| sealed_big::verify_offer(k, o, expected_t, &h))? {
        return Err(err("offer proof does not verify"));
    }
    Ok(())
}

pub(crate) fn open(t: Scalar, o: &BigOffer) -> R<Vec<u8>> {
    sealed_big::open(t, o).ok_or_else(|| err("decryption failed"))
}

/// Standalone check of a v3 offer (manifest with inline blobs). Returns T (hex).
#[wasm_bindgen(js_name = verifyBigOffer)]
pub fn verify_big_offer(offer: &str, expected_hash: &str) -> R<String> {
    let o = parse(offer).ok_or_else(|| err("not a v3 offer"))??;
    verify(&o, &o.t_point, expected_hash)?;
    Ok(hex::encode(group::GroupEncoding::to_bytes(&o.t_point)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attach(manifest: &str, blobs: &[Vec<u8>]) -> String {
        let mut w: BigOfferWire = serde_json::from_str(manifest).unwrap();
        for (p, b) in w.parts.iter_mut().zip(blobs) { p.data = Some(hex::encode(b)); }
        serde_json::to_string(&w).unwrap()
    }

    /// Real size (k = 15) through the bindings: an on-chain style listing
    /// (Merchant/Payer) and a presale unit, both with v3 offers.
    #[test]
    fn big_offer_flows_through_bindings() {
        warm_up_big_with_params(&sealed_big::prove::params_bytes::<CHUNKS>()).unwrap();
        assert!(big_ready());
        let payload: Vec<u8> = (0..30_000u32).map(|i| (i % 253) as u8).collect(); // 2 parts
        assert_eq!(big_parts_for(payload.len()), 2);
        let h = content_hash_big(&payload).unwrap();

        // Single-copy listing (the on-chain flow's offer).
        let merchant = crate::Merchant::new();
        let mut sealer = merchant.big_sealer(&payload).unwrap();
        let blobs: Vec<Vec<u8>> = (0..sealer.parts()).map(|j| sealer.prove_part(j).unwrap()).collect();
        assert_eq!(sealer.blob_id(1).unwrap(), sealed_big::blob_id(&blobs[1]));
        let manifest = sealer.manifest().unwrap();
        assert!(manifest.len() < 1024, "the relay stores only this");
        let offer = attach(&manifest, &blobs);
        let mut payer = crate::Payer::new();
        let t = payer.verify_offer(&offer, &h).unwrap();
        assert_eq!(t, merchant.t_point());
        let (session, sighash, alpha) = (b"big-1".as_slice(), b"sighash".as_slice(), crate::sc_hex(&Scalar::from(4u64)));
        let r_a = payer.nonce();
        let partial = merchant.partial(&r_a, &payer.verification_key(), &alpha, sighash).unwrap();
        let pok = merchant.prove_knowledge(&payer.verification_key(), session).unwrap();
        let pre = payer.pre_sign(&merchant.verification_key(), &partial, sighash, session, &pok, &alpha, &t).unwrap();
        let sig = merchant.complete(&pre, &partial).unwrap();
        assert_eq!(payer.unlock(&sig, &pre, &partial, &offer).unwrap(), payload);
        // A tampered blob fails its content address (error paths need wasm for JsError,
        // so check the engine call the binding makes).
        let mut bad = blobs.clone(); bad[1][200] ^= 1;
        let w: BigOfferWire = serde_json::from_str(&attach(&manifest, &bad)).unwrap();
        assert!(BigOffer::from_wire(&w).is_none());

        // Presale unit with a v3 offer.
        let small: Vec<u8> = (0..9_000u32).map(|i| (i % 7) as u8).collect();
        let hs = content_hash_big(&small).unwrap();
        let fresh: serde_json::Value = serde_json::from_str(&crate::v2::presale_new_unit().unwrap()).unwrap();
        let secret = fresh["secret"].as_str().unwrap().to_string();
        let s_hex = serde_json::from_str::<serde_json::Value>(&secret).unwrap()["s"].as_str().unwrap().to_string();
        let mut sealer = BigSealer::new(&s_hex, &small).unwrap();
        let blobs = vec![sealer.prove_part(0).unwrap()];
        let mut unit = fresh["unit"].clone();
        assert_eq!(unit["t_point"].as_str().unwrap(), sealer.t_point());
        unit["offer"] = serde_json::Value::String(attach(&sealer.manifest().unwrap(), &blobs));
        let unit = unit.to_string();
        crate::v2::verify_unit(&unit, &hs).unwrap();
        let b: serde_json::Value = serde_json::from_str(&crate::v2::buyer_order(&unit, &hs, &alpha, b"sh").unwrap()).unwrap();
        let order = b["order"].to_string();
        assert!(crate::v2::check_order(&unit, &order).unwrap());
        let done = crate::v2::seller_complete(&secret, &order).unwrap();
        assert_eq!(crate::v2::buyer_unlock(b["keep"].as_str().unwrap(), &unit, &order, &done).unwrap(), small);
    }

    #[test]
    fn pinned_big_params_match() {
        let b = sealed_big::prove::params_bytes::<CHUNKS>();
        let mut pin = [0u8; 32];
        hex::decode_to_slice(PINNED_PARAMS_BIG, &mut pin).unwrap();
        assert_eq!(sealed::prove::params_digest(&b), pin);
        let mut bad = b.clone();
        let n = bad.len() - 9; bad[n] ^= 1;
        assert!(sealed_big::prove::setup_from_params::<CHUNKS>(&bad, &pin).is_err());
    }
}
