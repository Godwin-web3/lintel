//! Sealed goods: verifiable encryption under the adaptor secret.
//!
//! The party that holds the adaptor secret `t` (the one who completes the
//! signature and gets paid) encrypts a payload so that the counterparty can
//! check, *before* pre-signing, that:
//!
//! * `T = [t] G` is the same adaptor point the payment is locked to,
//! * the ciphertext decrypts under `t` to some plaintext `m`, and
//! * `Poseidon(m) = h`, a content hash the payer already knows or agreed on.
//!
//! When the payment confirms, the payer extracts `t` from the on-chain
//! signature (`protocol::extract_t`) and decrypts. Paying reveals the key, and
//! the proof guarantees the key opens the promised content.
//!
//! Encryption is a Poseidon keystream over field elements:
//! `c_i = m_i + Poseidon(s, i + 1)`, where `s` is `t` read as a Pallas base
//! field element. `t` must be below the base modulus `p` (`p < q` on Pallas),
//! which [`new_secret`] guarantees.
//!
//! Plaintext packing: chunk 0 holds the byte length, then 31 bytes per chunk.
//!
//! Public instance column, in order: `[T.x, T.y, h, c_0, .., c_{N-1}]`.

use ff::{Field, PrimeField};
use group::{Curve, GroupEncoding};
use halo2_gadgets::{
    ecc::{
        chip::{BaseFieldElem, CircuitVersion, EccChip, EccConfig, FixedPoint, FullScalar, ShortScalar, H},
        FixedPointBaseField, FixedPoints,
    },
    poseidon::{
        primitives::{self as poseidon, ConstantLength, P128Pow5T3},
        Hash, Pow5Chip, Pow5Config,
    },
    utilities::lookup_range_check::{LookupRangeCheck, PallasLookupRangeCheckConfig},
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Constraints, Error, Instance, Selector, TableColumn},
    poly::Rotation,
};
use pasta_curves::{arithmetic::CurveAffine, pallas};

use crate::spend_auth_g;

type F = pallas::Base;

/// Payload bytes packed per field element.
pub const BYTES_PER_CHUNK: usize = 31;
/// Default number of chunks: 63 * 31 = 1953 payload bytes.
pub const CHUNKS: usize = 64;

/// Circuit size for `n` chunks (2^k rows).
pub const fn k_for(n: usize) -> u32 {
    // ~40 rows per Poseidon permutation, n keystream perms + n/2 hash perms,
    // plus ECC (~400 rows) and the 1024-row lookup table.
    let rows = 40 * (n + n / 2 + 2) + 600;
    let mut k = 11;
    while (1usize << k) < rows + 16 { k += 1; }
    k
}

// ---------- fixed base: Orchard SpendAuthG (= protocol::ORCHARD_BASEPOINT) ----------

#[derive(Debug, Eq, PartialEq, Clone)]
pub struct Bases;
#[derive(Debug, Eq, PartialEq, Clone)]
pub struct SpendAuthBase;
#[derive(Debug, Eq, PartialEq, Clone)]
pub struct Unused;

fn us() -> Vec<[[u8; 32]; H]> { spend_auth_g::U.clone() }

impl FixedPoint<pallas::Affine> for SpendAuthBase {
    type FixedScalarKind = BaseFieldElem;
    fn generator(&self) -> pallas::Affine { generator() }
    fn u(&self) -> Vec<[[u8; 32]; H]> { us() }
    fn z(&self) -> Vec<u64> { spend_auth_g::Z.to_vec() }
}
impl FixedPoint<pallas::Affine> for Unused {
    type FixedScalarKind = FullScalar;
    fn generator(&self) -> pallas::Affine { generator() }
    fn u(&self) -> Vec<[[u8; 32]; H]> { us() }
    fn z(&self) -> Vec<u64> { spend_auth_g::Z.to_vec() }
}
#[derive(Debug, Eq, PartialEq, Clone)]
pub struct UnusedShort;
impl FixedPoint<pallas::Affine> for UnusedShort {
    type FixedScalarKind = ShortScalar;
    fn generator(&self) -> pallas::Affine { generator() }
    fn u(&self) -> Vec<[[u8; 32]; H]> { unreachable!("short fixed-base mul is not used") }
    fn z(&self) -> Vec<u64> { unreachable!("short fixed-base mul is not used") }
}
impl FixedPoints<pallas::Affine> for Bases {
    type FullScalar = Unused;
    type ShortScalar = UnusedShort;
    type Base = SpendAuthBase;
}

/// The Orchard spend-auth generator, the same point the adaptor protocol uses.
pub fn generator() -> pallas::Affine {
    pallas::Affine::from_xy(
        F::from_repr(spend_auth_g::GENERATOR.0).unwrap(),
        F::from_repr(spend_auth_g::GENERATOR.1).unwrap(),
    )
    .unwrap()
}

// ---------- off-circuit helpers ----------

/// Samples an adaptor secret that is valid both as a scalar `t` and as a
/// base field element `s`. Returns `(t, s)`.
pub fn new_secret() -> (pallas::Scalar, F) {
    loop {
        let s = F::random(&mut rand::rng());
        if bool::from(s.is_zero()) { continue; }
        return (scalar_from_base(s), s);
    }
}

/// Reads a base field element as a scalar. Always succeeds since p < q.
pub fn scalar_from_base(s: F) -> pallas::Scalar {
    Option::from(pallas::Scalar::from_repr(s.to_repr())).expect("p < q")
}

/// Reads an extracted adaptor secret as a base field element.
pub fn base_from_scalar(t: pallas::Scalar) -> Option<F> {
    Option::from(F::from_repr(t.to_repr()))
}

/// Packs bytes into `n` field elements, or `None` if they do not fit.
pub fn pack(bytes: &[u8], n: usize) -> Option<Vec<F>> {
    if bytes.len() > (n - 1) * BYTES_PER_CHUNK { return None; }
    let mut out = vec![F::from(bytes.len() as u64)];
    for i in 0..n - 1 {
        let mut repr = [0u8; 32];
        let start = (i * BYTES_PER_CHUNK).min(bytes.len());
        let end = ((i + 1) * BYTES_PER_CHUNK).min(bytes.len());
        repr[..end - start].copy_from_slice(&bytes[start..end]);
        out.push(F::from_repr(repr).unwrap()); // top byte is 0, so < p
    }
    Some(out)
}

/// Inverse of [`pack`]. Returns `None` on a malformed plaintext.
pub fn unpack(m: &[F]) -> Option<Vec<u8>> {
    let len_repr = m.first()?.to_repr();
    if len_repr[8..].iter().any(|b| *b != 0) { return None; }
    let len = u64::from_le_bytes(len_repr[..8].try_into().unwrap()) as usize;
    if len > (m.len() - 1) * BYTES_PER_CHUNK { return None; }
    let mut out = Vec::with_capacity(len);
    for c in &m[1..] {
        out.extend_from_slice(&c.to_repr()[..BYTES_PER_CHUNK]);
    }
    out.truncate(len);
    Some(out)
}

fn keystream(s: F, i: usize) -> F {
    poseidon::Hash::<_, P128Pow5T3, ConstantLength<2>, 3, 2>::init().hash([s, F::from(i as u64 + 1)])
}

/// Content hash of a packed plaintext.
pub fn content_hash<const N: usize>(m: &[F; N]) -> F {
    poseidon::Hash::<_, P128Pow5T3, ConstantLength<N>, 3, 2>::init().hash(*m)
}

/// Content hash of raw bytes as packed into `N` chunks.
pub fn content_hash_bytes<const N: usize>(bytes: &[u8]) -> Option<F> {
    let m: [F; N] = pack(bytes, N)?.try_into().ok()?;
    Some(content_hash(&m))
}

pub fn encrypt(s: F, m: &[F]) -> Vec<F> {
    m.iter().enumerate().map(|(i, mi)| *mi + keystream(s, i)).collect()
}

pub fn decrypt(s: F, c: &[F]) -> Vec<F> {
    c.iter().enumerate().map(|(i, ci)| *ci - keystream(s, i)).collect()
}

/// Adaptor point `T = [t] G` as affine coordinates. `None` for the identity.
pub fn point_coords(t_point: &pallas::Point) -> Option<(F, F)> {
    let a = t_point.to_affine();
    let c: Option<pasta_curves::arithmetic::Coordinates<pallas::Affine>> = a.coordinates().into();
    c.map(|c| (*c.x(), *c.y()))
}

/// Public instance vector `[T.x, T.y, h, c_0..]`. `None` if `T` is the identity.
pub fn public_inputs(t_point: &pallas::Point, h: F, ciphertext: &[F]) -> Option<Vec<F>> {
    let (x, y) = point_coords(t_point)?;
    let mut v = vec![x, y, h];
    v.extend_from_slice(ciphertext);
    Some(v)
}

// ---------- circuit ----------

#[derive(Clone, Debug)]
pub struct Config {
    advice: [Column<Advice>; 10],
    instance: Column<Instance>,
    table: TableColumn,
    ecc: EccConfig<Bases>,
    poseidon: Pow5Config<F, 3, 2>,
    q_enc: Selector,
}

#[derive(Clone, Debug)]
pub struct SealedCircuit<const N: usize> {
    pub secret: Value<F>,
    pub plaintext: [Value<F>; N],
}

impl<const N: usize> Default for SealedCircuit<N> {
    fn default() -> Self { Self { secret: Value::unknown(), plaintext: [Value::unknown(); N] } }
}

impl<const N: usize> SealedCircuit<N> {
    pub fn new(secret: F, plaintext: &[F; N]) -> Self {
        Self { secret: Value::known(secret), plaintext: plaintext.map(Value::known) }
    }
}

impl<const N: usize> Circuit<F> for SealedCircuit<N> {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self { Self::default() }

    fn configure(meta: &mut ConstraintSystem<F>) -> Config {
        let advice: [Column<Advice>; 10] = std::array::from_fn(|_| meta.advice_column());
        let instance = meta.instance_column();
        meta.enable_equality(instance);
        for a in advice { meta.enable_equality(a); }

        let table = meta.lookup_table_column();
        let lagrange: [_; 8] = std::array::from_fn(|_| meta.fixed_column());
        let constants = meta.fixed_column();
        meta.enable_constant(constants);

        let range_check = PallasLookupRangeCheckConfig::configure(meta, advice[9], table);
        let ecc = EccChip::<Bases>::configure(meta, advice, lagrange, range_check);

        // Same column sharing as the Orchard action circuit.
        let poseidon = Pow5Chip::configure::<P128Pow5T3>(
            meta,
            [advice[6], advice[7], advice[8]],
            advice[5],
            [lagrange[2], lagrange[3], lagrange[4]],
            [lagrange[5], lagrange[6], lagrange[7]],
        );

        // advice[0] = m, advice[1] = k, advice[2] = c
        let q_enc = meta.selector();
        meta.create_gate("c = m + k", |meta| {
            let q = meta.query_selector(q_enc);
            let m = meta.query_advice(advice[0], Rotation::cur());
            let k = meta.query_advice(advice[1], Rotation::cur());
            let c = meta.query_advice(advice[2], Rotation::cur());
            Constraints::with_selector(q, [("enc", c - m - k)])
        });

        Config { advice, instance, table, ecc, poseidon, q_enc }
    }

    fn synthesize(&self, config: Config, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        let adv = config.advice;
        // 10-bit range-check table used by the ECC chip.
        layouter.assign_table(|| "table_idx", |mut t| {
            for i in 0..(1usize << 10) {
                t.assign_cell(|| "idx", config.table, i, || Value::known(F::from(i as u64)))?;
            }
            Ok(())
        })?;
        let ecc = EccChip::construct(config.ecc.clone(), CircuitVersion::AnchoredBase);

        // Witness s and every plaintext chunk once.
        let (s, m): (AssignedCell<F, F>, Vec<AssignedCell<F, F>>) =
            layouter.assign_region(|| "witnesses", |mut region| {
                let s = region.assign_advice(|| "s", adv[0], 0, || self.secret)?;
                let m = self.plaintext.iter().enumerate()
                    .map(|(i, v)| region.assign_advice(|| "m", adv[1], i, || *v))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((s, m))
            })?;

        // T = [s] G, exposed as public (x, y).
        let base = FixedPointBaseField::from_inner(ecc.clone(), SpendAuthBase);
        let t_point = base.mul(layouter.namespace(|| "[s] G"), s.clone())?;
        layouter.constrain_instance(t_point.inner().x().cell(), config.instance, 0)?;
        layouter.constrain_instance(t_point.inner().y().cell(), config.instance, 1)?;

        // h = Poseidon(m_0..m_{N-1})
        let hasher = Hash::<_, _, P128Pow5T3, ConstantLength<N>, 3, 2>::init(
            Pow5Chip::construct(config.poseidon.clone()),
            layouter.namespace(|| "content hash init"),
        )?;
        let m_arr: [AssignedCell<F, F>; N] = m.clone().try_into().map_err(|_| Error::Synthesis)?;
        let h = hasher.hash(layouter.namespace(|| "content hash"), m_arr)?;
        layouter.constrain_instance(h.cell(), config.instance, 2)?;

        // c_i = m_i + Poseidon(s, i + 1)
        for (i, mi) in m.iter().enumerate() {
            let idx = layouter.assign_region(|| "index", |mut region| {
                region.assign_advice_from_constant(|| "i+1", adv[0], 0, F::from(i as u64 + 1))
            })?;
            let hasher = Hash::<_, _, P128Pow5T3, ConstantLength<2>, 3, 2>::init(
                Pow5Chip::construct(config.poseidon.clone()),
                layouter.namespace(|| "keystream init"),
            )?;
            let k = hasher.hash(layouter.namespace(|| "keystream"), [s.clone(), idx])?;
            let c = layouter.assign_region(|| "encrypt", |mut region| {
                config.q_enc.enable(&mut region, 0)?;
                let m = mi.copy_advice(|| "m", &mut region, adv[0], 0)?;
                let k = k.copy_advice(|| "k", &mut region, adv[1], 0)?;
                region.assign_advice(|| "c", adv[2], 0, || m.value().copied() + k.value().copied())
            })?;
            layouter.constrain_instance(c.cell(), config.instance, 3 + i)?;
        }
        Ok(())
    }
}

// ---------- proving ----------

pub mod prove {
    use super::*;
    use halo2_proofs::{
        plonk::{create_proof, keygen_pk, keygen_vk, verify_proof, ProvingKey, SingleVerifier, VerifyingKey},
        poly::commitment::Params,
        transcript::{Blake2bRead, Blake2bWrite, Challenge255},
    };
    use pasta_curves::vesta;

    pub struct Keys<const N: usize> {
        pub params: Params<vesta::Affine>,
        pub vk: VerifyingKey<vesta::Affine>,
        pub pk: ProvingKey<vesta::Affine>,
    }

    pub fn setup<const N: usize>() -> Result<Keys<N>, Error> {
        keys_from_params(Params::new(k_for(N)))
    }

    /// Serialized commitment parameters (public, transparent: no trusted setup).
    /// Shipping these saves the slowest part of setup on low-power devices.
    pub fn params_bytes<const N: usize>() -> Vec<u8> {
        let mut out = vec![];
        Params::<vesta::Affine>::new(k_for(N)).write(&mut out).expect("vec write");
        out
    }

    /// BLAKE2b-256 digest used to pin a parameter file.
    pub fn params_digest(bytes: &[u8]) -> [u8; 32] {
        let h = blake2b_simd::Params::new().hash_length(32).personal(b"lintel-params-v1").hash(bytes);
        let mut d = [0u8; 32];
        d.copy_from_slice(h.as_bytes());
        d
    }

    /// Builds keys from downloaded parameters. The digest must match the one
    /// pinned in the binary: substituted generators would break soundness.
    pub fn setup_from_params<const N: usize>(bytes: &[u8], pinned: &[u8; 32]) -> Result<Keys<N>, &'static str> {
        if &params_digest(bytes) != pinned {
            return Err("parameter file does not match pinned digest");
        }
        let params = Params::<vesta::Affine>::read(&mut &bytes[..]).map_err(|_| "malformed parameters")?;
        if params.k() != k_for(N) {
            return Err("parameters are for the wrong circuit size");
        }
        keys_from_params(params).map_err(|_| "key generation failed")
    }

    fn keys_from_params<const N: usize>(params: Params<vesta::Affine>) -> Result<Keys<N>, Error> {
        let empty = SealedCircuit::<N>::default();
        let vk = keygen_vk(&params, &empty)?;
        let pk = keygen_pk(&params, vk.clone(), &empty)?;
        Ok(Keys { params, vk, pk })
    }

    pub fn prove<const N: usize>(keys: &Keys<N>, circuit: SealedCircuit<N>, public: &[F]) -> Result<Vec<u8>, Error> {
        let mut transcript = Blake2bWrite::<_, _, Challenge255<_>>::init(vec![]);
        create_proof(&keys.params, &keys.pk, &[circuit], &[&[public]], rand::rng(), &mut transcript)?;
        Ok(transcript.finalize())
    }

    pub fn verify<const N: usize>(keys: &Keys<N>, proof: &[u8], public: &[F]) -> bool {
        let strategy = SingleVerifier::new(&keys.params);
        let mut transcript = Blake2bRead::<_, _, Challenge255<_>>::init(proof);
        verify_proof(&keys.params, &keys.vk, strategy, &[&[public]], &mut transcript).is_ok()
    }
}

/// Everything the seller of a sealed payload publishes before payment.
#[derive(Clone, Debug)]
pub struct SealedOffer {
    pub t_point: pallas::Point,
    pub content_hash: F,
    pub ciphertext: Vec<F>,
    pub proof: Vec<u8>,
}

/// Wire form of [`SealedOffer`]: hex strings, safe to relay.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SealedOfferWire {
    pub t_point: String,
    pub content_hash: String,
    pub ciphertext: Vec<String>,
    pub proof: String,
}

pub fn field_hex(f: &F) -> String { hex::encode(f.to_repr()) }

/// Parses a canonical base field element from untrusted hex. Never panics.
pub fn parse_field(h: &str) -> Option<F> {
    let b: [u8; 32] = hex::decode(h).ok()?.try_into().ok()?;
    Option::from(F::from_repr(b))
}

impl SealedOffer {
    pub fn to_wire(&self) -> SealedOfferWire {
        SealedOfferWire {
            t_point: hex::encode(self.t_point.to_bytes()),
            content_hash: field_hex(&self.content_hash),
            ciphertext: self.ciphertext.iter().map(field_hex).collect(),
            proof: hex::encode(&self.proof),
        }
    }
    /// Parses untrusted wire data. Never panics.
    pub fn from_wire(w: &SealedOfferWire) -> Option<Self> {
        Some(Self {
            t_point: crate::protocol::parse_point(&w.t_point)?,
            content_hash: parse_field(&w.content_hash)?,
            ciphertext: w.ciphertext.iter().map(|c| parse_field(c)).collect::<Option<Vec<_>>>()?,
            proof: hex::decode(&w.proof).ok()?,
        })
    }
}

/// Seals `payload` under secret `s` (with `t = scalar_from_base(s)`).
pub fn seal<const N: usize>(keys: &prove::Keys<N>, s: F, payload: &[u8]) -> Result<SealedOffer, &'static str> {
    let m: [F; N] = pack(payload, N).ok_or("payload too large")?.try_into().unwrap();
    let t_point = pallas::Point::from(generator()) * scalar_from_base(s);
    let h = content_hash(&m);
    let ciphertext = encrypt(s, &m);
    let public = public_inputs(&t_point, h, &ciphertext).ok_or("secret is zero")?;
    let proof = prove::prove(keys, SealedCircuit::new(s, &m), &public).map_err(|_| "proving failed")?;
    Ok(SealedOffer { t_point, content_hash: h, ciphertext, proof })
}

/// Payer-side check before pre-signing: the offer is locked to `expected_t`
/// and decrypts to content hashing to `expected_hash`.
pub fn verify_offer<const N: usize>(keys: &prove::Keys<N>, offer: &SealedOffer, expected_t: &pallas::Point, expected_hash: F) -> bool {
    if offer.t_point.to_bytes() != expected_t.to_bytes() || offer.content_hash != expected_hash || offer.ciphertext.len() != N {
        return false;
    }
    match public_inputs(&offer.t_point, offer.content_hash, &offer.ciphertext) {
        Some(public) => prove::verify(keys, &offer.proof, &public),
        None => false,
    }
}

/// After payment: decrypt with the extracted adaptor secret.
pub fn open(t: pallas::Scalar, offer: &SealedOffer) -> Option<Vec<u8>> {
    let s = base_from_scalar(t)?;
    unpack(&decrypt(s, &offer.ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol;
    use halo2_proofs::dev::MockProver;

    const N: usize = 8;

    fn instance(s: F, payload: &[u8]) -> ([F; N], Vec<F>) {
        let m: [F; N] = pack(payload, N).unwrap().try_into().unwrap();
        let t_point = pallas::Point::from(generator()) * scalar_from_base(s);
        let public = public_inputs(&t_point, content_hash(&m), &encrypt(s, &m)).unwrap();
        (m, public)
    }

    fn mock(s: F, m: &[F; N], public: Vec<F>) -> bool {
        MockProver::run(k_for(N), &SealedCircuit::<N>::new(s, m), vec![public]).unwrap().verify().is_ok()
    }

    #[test]
    fn generator_matches_protocol_base() {
        let b = pallas::Point::from_bytes(&protocol::ORCHARD_BASEPOINT).unwrap();
        assert_eq!(pallas::Point::from(generator()).to_bytes(), b.to_bytes());
    }

    #[test]
    fn wire_roundtrip_and_garbage() {
        let w = SealedOfferWire { t_point: "zz".into(), content_hash: "00".into(), ciphertext: vec![], proof: "".into() };
        assert!(SealedOffer::from_wire(&w).is_none());
        let (_, s) = new_secret();
        let o = SealedOffer {
            t_point: pallas::Point::from(generator()) * scalar_from_base(s),
            content_hash: F::from(5u64), ciphertext: vec![F::ONE, F::from(2u64)], proof: vec![1, 2, 3],
        };
        let back = SealedOffer::from_wire(&o.to_wire()).unwrap();
        assert_eq!(back.t_point, o.t_point);
        assert_eq!(back.ciphertext, o.ciphertext);
    }

    #[test]
    fn pack_roundtrip() {
        let data = b"reentrancy in withdraw(): call before balance update".repeat(3);
        let m = pack(&data, N).unwrap();
        assert_eq!(unpack(&m).unwrap(), data);
        assert!(pack(&vec![0u8; (N - 1) * BYTES_PER_CHUNK + 1], N).is_none());
    }

    #[test]
    fn honest_seal_passes() {
        let (_, s) = new_secret();
        let (m, public) = instance(s, b"PoC: drain via flash loan");
        assert!(mock(s, &m, public));
    }

    #[test]
    fn wrong_content_hash_fails() {
        let (_, s) = new_secret();
        let (m, mut public) = instance(s, b"real report");
        public[2] += F::ONE;
        assert!(!mock(s, &m, public));
    }

    #[test]
    fn junk_ciphertext_fails() {
        let (_, s) = new_secret();
        let (m, mut public) = instance(s, b"real report");
        public[3 + 1] += F::ONE;
        assert!(!mock(s, &m, public));
    }

    #[test]
    fn key_not_bound_to_adaptor_point_fails() {
        // Encrypt under s, but claim a different T.
        let (_, s) = new_secret();
        let (_, other) = new_secret();
        let (m, mut public) = instance(s, b"real report");
        let (x, y) = point_coords(&(pallas::Point::from(generator()) * scalar_from_base(other))).unwrap();
        public[0] = x;
        public[1] = y;
        assert!(!mock(s, &m, public));
    }

    #[test]
    fn end_to_end_pay_to_decrypt() {
        let keys = prove::setup::<N>().unwrap();
        let report = b"Critical: unchecked return in bridge relay lets anyone mint.";

        // Secret holder (protocol::Buyer completes and gets paid) seals the report.
        let (t, s) = new_secret();
        let holder = protocol::Buyer::with_secret(t);
        let offer = seal::<N>(&keys, s, report).unwrap();

        // Payer knows the agreed content hash and checks the offer first.
        let agreed = content_hash_bytes::<N>(report).unwrap();
        assert!(verify_offer(&keys, &offer, &holder.t_point(), agreed));
        assert!(!verify_offer(&keys, &offer, &holder.t_point(), agreed + F::ONE));

        // Adaptor flow: payment completes, payer extracts t and decrypts.
        let mut payer = protocol::Seller::new();
        let session = b"sale-1";
        let sighash = b"sighash";
        let alpha = pallas::Scalar::from(3u64);
        let r_a = payer.new_nonce();
        let partial = holder.partial(r_a, payer.vk_a, alpha, sighash);
        let pok = holder.prove_knowledge(payer.vk_a, session);
        let pre = payer.pre_sign(holder.vk_b, &partial, sighash, session, &pok, alpha).unwrap();
        let sig = holder.complete(&pre, &partial).unwrap();
        assert!(holder.verify_completed(&pre, &sig));

        let s_final = protocol::parse_scalar(&hex::encode(&sig[32..])).unwrap();
        let s_a = protocol::parse_scalar(&pre.s_a_hex).unwrap();
        let t_extracted = protocol::extract_t(s_final, s_a, partial.s_b);
        assert_eq!(open(t_extracted, &offer).unwrap(), report.to_vec());
    }
}
