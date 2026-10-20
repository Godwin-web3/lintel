//! Multi-part sealed goods: payloads larger than one proof, same pinned params.
//!
//! [`crate::sealed`] proves one block of `N` field elements (1,953 payload
//! bytes at `N = 64`). Growing `N` would grow the circuit past `k = 13` and
//! need a new parameter file and pin. Instead, this module splits a payload
//! into up to [`MAX_PARTS`] blocks and proves each block separately with the
//! *same* `k`, so the published `params.bin` and its pinned digest are
//! unchanged (a circuit change only changes the verifying key, which every
//! party derives locally from the pinned params and this code).
//!
//! Every part is bound to the one adaptor secret `s` (each proof shows
//! `T = [s] G`), and the keystream index is global:
//! `c_{j,i} = m_{j,i} + Poseidon(s, off_j + i + 1)` with the public offset
//! `off_j = j * N`. The verifier checks `off_j == j * N`, so no two parts can
//! reuse keystream (no two-time pad). Part 0, offset 0 encrypts exactly like
//! the single-part circuit.
//!
//! Content hash of the whole payload: for one part it is that part's in-circuit
//! Poseidon hash `h_0` (identical to `sealed::content_hash_bytes`); for more
//! parts it is BLAKE2b-256("lintel-mpart-v1", P || h_0 || .. || h_{P-1}),
//! computed off-circuit over hashes that are each proven in-circuit.
//!
//! Public instance column, in order: `[T.x, T.y, h_j, off_j, c_{j,0}, .., c_{j,N-1}]`.

use ff::PrimeField;
use group::GroupEncoding;
use halo2_gadgets::{
    ecc::{chip::{EccChip, EccConfig, CircuitVersion}, FixedPointBaseField},
    poseidon::{primitives::{self as poseidon, ConstantLength, P128Pow5T3}, Hash, Pow5Chip, Pow5Config},
    utilities::lookup_range_check::{LookupRangeCheck, PallasLookupRangeCheckConfig},
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Constraints, Error, Instance, Selector, TableColumn},
    poly::Rotation,
};
use pasta_curves::pallas;

use crate::sealed::{self, generator, k_for, point_coords, scalar_from_base, base_from_scalar, Bases, SpendAuthBase, BYTES_PER_CHUNK, CHUNKS};

type F = pallas::Base;

/// Most parts one offer may carry (bounded by relay body size: ~13 KB/part).
pub const MAX_PARTS: usize = 4;

/// Payload capacity for `parts` parts of `N` chunks (chunk 0 of part 0 = length).
pub const fn capacity(n: usize, parts: usize) -> usize { (n * parts - 1) * BYTES_PER_CHUNK }

/// Largest payload at the default chunk count and [`MAX_PARTS`].
pub const MAX_PAYLOAD: usize = capacity(CHUNKS, MAX_PARTS);

fn keystream(s: F, idx: u64) -> F {
    poseidon::Hash::<_, P128Pow5T3, ConstantLength<2>, 3, 2>::init().hash([s, F::from(idx)])
}

/// Number of parts needed for `len` payload bytes, or `None` above [`MAX_PARTS`].
pub fn parts_for(len: usize, n: usize) -> Option<usize> {
    (1..=MAX_PARTS).find(|p| len <= capacity(n, *p))
}

/// Packs `bytes` into `parts * n` field elements (same layout as `sealed::pack`).
pub fn pack(bytes: &[u8], n: usize, parts: usize) -> Option<Vec<F>> { sealed::pack(bytes, n * parts) }

pub fn part_hash<const N: usize>(m: &[F; N]) -> F { sealed::content_hash(m) }

/// Aggregate content hash over per-part hashes (see module docs). 32 bytes.
pub fn aggregate_hash(part_hashes: &[F]) -> [u8; 32] {
    if part_hashes.len() == 1 {
        return part_hashes[0].to_repr();
    }
    let mut st = blake2b_simd::Params::new().hash_length(32).personal(b"lintel-mpart-v1").to_state();
    st.update(&(part_hashes.len() as u64).to_le_bytes());
    for h in part_hashes { st.update(h.to_repr().as_ref()); }
    let mut out = [0u8; 32];
    out.copy_from_slice(st.finalize().as_bytes());
    out
}

/// Content hash of raw bytes, as the payer should expect it. `None` if too large.
pub fn content_hash_bytes<const N: usize>(bytes: &[u8]) -> Option<[u8; 32]> {
    let parts = parts_for(bytes.len(), N)?;
    let m = pack(bytes, N, parts)?;
    let hs: Vec<F> = m.chunks(N).map(|c| part_hash::<N>(c.try_into().unwrap())).collect();
    Some(aggregate_hash(&hs))
}

// ---------- circuit ----------

#[derive(Clone, Debug)]
pub struct Config {
    advice: [Column<Advice>; 10],
    instance: Column<Instance>,
    table: TableColumn,
    ecc: EccConfig<Bases>,
    poseidon: Pow5Config<F, 3, 2>,
    q_add: Selector,
}

#[derive(Clone, Debug)]
pub struct PartCircuit<const N: usize> {
    pub secret: Value<F>,
    pub plaintext: [Value<F>; N],
}

impl<const N: usize> Default for PartCircuit<N> {
    fn default() -> Self { Self { secret: Value::unknown(), plaintext: [Value::unknown(); N] } }
}

impl<const N: usize> PartCircuit<N> {
    pub fn new(secret: F, plaintext: &[F; N]) -> Self {
        Self { secret: Value::known(secret), plaintext: plaintext.map(Value::known) }
    }
}

impl<const N: usize> Circuit<F> for PartCircuit<N> {
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
        let poseidon = Pow5Chip::configure::<P128Pow5T3>(
            meta,
            [advice[6], advice[7], advice[8]],
            advice[5],
            [lagrange[2], lagrange[3], lagrange[4]],
            [lagrange[5], lagrange[6], lagrange[7]],
        );
        // a[2] = a[0] + a[1]: used for c = m + k and for idx = off + (i + 1).
        let q_add = meta.selector();
        meta.create_gate("sum", |meta| {
            let q = meta.query_selector(q_add);
            let a = meta.query_advice(advice[0], Rotation::cur());
            let b = meta.query_advice(advice[1], Rotation::cur());
            let c = meta.query_advice(advice[2], Rotation::cur());
            Constraints::with_selector(q, [("sum", c - a - b)])
        });
        Config { advice, instance, table, ecc, poseidon, q_add }
    }

    fn synthesize(&self, config: Config, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        let adv = config.advice;
        layouter.assign_table(|| "table_idx", |mut t| {
            for i in 0..(1usize << 10) {
                t.assign_cell(|| "idx", config.table, i, || Value::known(F::from(i as u64)))?;
            }
            Ok(())
        })?;
        let ecc = EccChip::construct(config.ecc.clone(), CircuitVersion::AnchoredBase);

        let (s, off, m): (AssignedCell<F, F>, AssignedCell<F, F>, Vec<AssignedCell<F, F>>) =
            layouter.assign_region(|| "witnesses", |mut region| {
                let s = region.assign_advice(|| "s", adv[0], 0, || self.secret)?;
                let off = region.assign_advice_from_instance(|| "offset", config.instance, 3, adv[2], 0)?;
                let m = self.plaintext.iter().enumerate()
                    .map(|(i, v)| region.assign_advice(|| "m", adv[1], i, || *v))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((s, off, m))
            })?;

        let base = FixedPointBaseField::from_inner(ecc.clone(), SpendAuthBase);
        let t_point = base.mul(layouter.namespace(|| "[s] G"), s.clone())?;
        layouter.constrain_instance(t_point.inner().x().cell(), config.instance, 0)?;
        layouter.constrain_instance(t_point.inner().y().cell(), config.instance, 1)?;

        let hasher = Hash::<_, _, P128Pow5T3, ConstantLength<N>, 3, 2>::init(
            Pow5Chip::construct(config.poseidon.clone()),
            layouter.namespace(|| "part hash init"),
        )?;
        let m_arr: [AssignedCell<F, F>; N] = m.clone().try_into().map_err(|_| Error::Synthesis)?;
        let h = hasher.hash(layouter.namespace(|| "part hash"), m_arr)?;
        layouter.constrain_instance(h.cell(), config.instance, 2)?;

        for (i, mi) in m.iter().enumerate() {
            // idx = off + (i + 1), with (i + 1) fixed by a constant.
            let idx = layouter.assign_region(|| "index", |mut region| {
                config.q_add.enable(&mut region, 0)?;
                let o = off.copy_advice(|| "off", &mut region, adv[0], 0)?;
                let k = region.assign_advice_from_constant(|| "i+1", adv[1], 0, F::from(i as u64 + 1))?;
                region.assign_advice(|| "idx", adv[2], 0, || o.value().copied() + k.value().copied())
            })?;
            let hasher = Hash::<_, _, P128Pow5T3, ConstantLength<2>, 3, 2>::init(
                Pow5Chip::construct(config.poseidon.clone()),
                layouter.namespace(|| "keystream init"),
            )?;
            let k = hasher.hash(layouter.namespace(|| "keystream"), [s.clone(), idx])?;
            let c = layouter.assign_region(|| "encrypt", |mut region| {
                config.q_add.enable(&mut region, 0)?;
                let m = mi.copy_advice(|| "m", &mut region, adv[0], 0)?;
                let k = k.copy_advice(|| "k", &mut region, adv[1], 0)?;
                region.assign_advice(|| "c", adv[2], 0, || m.value().copied() + k.value().copied())
            })?;
            layouter.constrain_instance(c.cell(), config.instance, 4 + i)?;
        }
        Ok(())
    }
}

/// Public instance `[T.x, T.y, h, off, c_0..]`. `None` for the identity.
pub fn public_inputs(t_point: &pallas::Point, h: F, offset: u64, ciphertext: &[F]) -> Option<Vec<F>> {
    let (x, y) = point_coords(t_point)?;
    let mut v = vec![x, y, h, F::from(offset)];
    v.extend_from_slice(ciphertext);
    Some(v)
}

// ---------- keys (same pinned params as `sealed`) ----------

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

    pub fn setup<const N: usize>() -> Result<Keys<N>, Error> { keys(Params::new(k_for(N))) }

    /// Same file, same pin and same checks as `sealed::prove::setup_from_params`.
    pub fn setup_from_params<const N: usize>(bytes: &[u8], pinned: &[u8; 32]) -> Result<Keys<N>, &'static str> {
        if &sealed::prove::params_digest(bytes) != pinned {
            return Err("parameter file does not match pinned digest");
        }
        let params = Params::<vesta::Affine>::read(&mut &bytes[..]).map_err(|_| "malformed parameters")?;
        if params.k() != k_for(N) { return Err("parameters are for the wrong circuit size"); }
        keys(params).map_err(|_| "key generation failed")
    }

    fn keys<const N: usize>(params: Params<vesta::Affine>) -> Result<Keys<N>, Error> {
        let empty = PartCircuit::<N>::default();
        let vk = keygen_vk(&params, &empty)?;
        let pk = keygen_pk(&params, vk.clone(), &empty)?;
        Ok(Keys { params, vk, pk })
    }

    pub fn prove<const N: usize>(k: &Keys<N>, c: PartCircuit<N>, public: &[F]) -> Result<Vec<u8>, Error> {
        let mut tr = Blake2bWrite::<_, _, Challenge255<_>>::init(vec![]);
        create_proof(&k.params, &k.pk, &[c], &[&[public]], rand::rng(), &mut tr)?;
        Ok(tr.finalize())
    }

    pub fn verify<const N: usize>(k: &Keys<N>, proof: &[u8], public: &[F]) -> bool {
        let mut tr = Blake2bRead::<_, _, Challenge255<_>>::init(proof);
        verify_proof(&k.params, &k.vk, SingleVerifier::new(&k.params), &[&[public]], &mut tr).is_ok()
    }
}

// ---------- offers ----------

#[derive(Clone, Debug)]
pub struct Part { pub hash: F, pub offset: u64, pub ciphertext: Vec<F>, pub proof: Vec<u8> }

#[derive(Clone, Debug)]
pub struct MultiOffer { pub t_point: pallas::Point, pub parts: Vec<Part> }

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PartWire { pub hash: String, pub offset: u64, pub ciphertext: Vec<String>, pub proof: String }

/// Wire form: hex strings, safe to relay. `content_hash` is the aggregate.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct MultiOfferWire { pub v: u8, pub t_point: String, pub content_hash: String, pub parts: Vec<PartWire> }

impl MultiOffer {
    pub fn content_hash(&self) -> [u8; 32] {
        aggregate_hash(&self.parts.iter().map(|p| p.hash).collect::<Vec<_>>())
    }
    pub fn to_wire(&self) -> MultiOfferWire {
        MultiOfferWire {
            v: 2,
            t_point: hex::encode(self.t_point.to_bytes()),
            content_hash: hex::encode(self.content_hash()),
            parts: self.parts.iter().map(|p| PartWire {
                hash: sealed::field_hex(&p.hash), offset: p.offset,
                ciphertext: p.ciphertext.iter().map(sealed::field_hex).collect(), proof: hex::encode(&p.proof),
            }).collect(),
        }
    }
    /// Parses untrusted wire data. Never panics. Does not verify proofs.
    pub fn from_wire(w: &MultiOfferWire) -> Option<Self> {
        if w.v != 2 || w.parts.is_empty() || w.parts.len() > MAX_PARTS { return None; }
        let o = Self {
            t_point: crate::protocol::parse_point(&w.t_point)?,
            parts: w.parts.iter().map(|p| Some(Part {
                hash: sealed::parse_field(&p.hash)?, offset: p.offset,
                ciphertext: p.ciphertext.iter().map(|c| sealed::parse_field(c)).collect::<Option<Vec<_>>>()?,
                proof: hex::decode(&p.proof).ok()?,
            })).collect::<Option<Vec<_>>>()?,
        };
        if hex::encode(o.content_hash()) != w.content_hash { return None; }
        Some(o)
    }
}

/// Seals `payload` under secret `s` in as many parts as it needs.
pub fn seal<const N: usize>(keys: &prove::Keys<N>, s: F, payload: &[u8]) -> Result<MultiOffer, &'static str> {
    let parts = parts_for(payload.len(), N).ok_or("payload too large")?;
    let m = pack(payload, N, parts).ok_or("payload too large")?;
    let t_point = pallas::Point::from(generator()) * scalar_from_base(s);
    let mut out = Vec::with_capacity(parts);
    for (j, block) in m.chunks(N).enumerate() {
        let block: [F; N] = block.try_into().unwrap();
        let offset = (j * N) as u64;
        let hash = part_hash(&block);
        let ciphertext: Vec<F> = block.iter().enumerate().map(|(i, mi)| *mi + keystream(s, offset + i as u64 + 1)).collect();
        let public = public_inputs(&t_point, hash, offset, &ciphertext).ok_or("secret is zero")?;
        let proof = prove::prove(keys, PartCircuit::new(s, &block), &public).map_err(|_| "proving failed")?;
        out.push(Part { hash, offset, ciphertext, proof });
    }
    Ok(MultiOffer { t_point, parts: out })
}

/// Payer check before paying: locked to `expected_t`, parts in order with
/// non-overlapping keystream, every proof valid, aggregate hash matches.
pub fn verify_offer<const N: usize>(keys: &prove::Keys<N>, o: &MultiOffer, expected_t: &pallas::Point, expected_hash: &[u8; 32]) -> bool {
    if o.t_point.to_bytes() != expected_t.to_bytes() || o.parts.is_empty() || o.parts.len() > MAX_PARTS { return false; }
    if &o.content_hash() != expected_hash { return false; }
    o.parts.iter().enumerate().all(|(j, p)| {
        p.offset == (j * N) as u64 && p.ciphertext.len() == N && match public_inputs(&o.t_point, p.hash, p.offset, &p.ciphertext) {
            Some(public) => prove::verify(keys, &p.proof, &public),
            None => false,
        }
    })
}

/// After payment: decrypt with the extracted adaptor secret.
pub fn open(t: pallas::Scalar, o: &MultiOffer) -> Option<Vec<u8>> {
    let s = base_from_scalar(t)?;
    let mut m = Vec::new();
    for p in &o.parts {
        for (i, c) in p.ciphertext.iter().enumerate() { m.push(*c - keystream(s, p.offset + i as u64 + 1)); }
    }
    sealed::unpack(&m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ff::Field;
    use halo2_proofs::dev::MockProver;

    #[test]
    fn default_size_fits_pinned_k_and_offsets_are_bound() {
        // The real N = 64 circuit must satisfy at the pinned k (13).
        const N: usize = CHUNKS;
        let (_, s) = sealed::new_secret();
        let data = vec![7u8; capacity(N, 2) - 5];
        let m = pack(&data, N, 2).unwrap();
        let block: [F; N] = m[N..].try_into().unwrap();
        let t = pallas::Point::from(generator()) * scalar_from_base(s);
        let off = N as u64;
        let ct: Vec<F> = block.iter().enumerate().map(|(i, x)| *x + keystream(s, off + i as u64 + 1)).collect();
        let public = public_inputs(&t, part_hash(&block), off, &ct).unwrap();
        let run = |p: Vec<F>| MockProver::run(k_for(N), &PartCircuit::<N>::new(s, &block), vec![p]).unwrap().verify().is_ok();
        assert!(run(public.clone()));
        // Claiming offset 0 for keystream made at offset N fails (no keystream reuse).
        let mut bad = public.clone(); bad[3] = F::ZERO; assert!(!run(bad));
        let mut bad = public; bad[4 + 3] += F::ONE; assert!(!run(bad));
    }

    #[test]
    fn single_part_hash_matches_v1() {
        let data = b"short report";
        assert_eq!(content_hash_bytes::<CHUNKS>(data).unwrap(), sealed::content_hash_bytes::<CHUNKS>(data).unwrap().to_repr());
        assert_eq!(MAX_PAYLOAD, 7905);
        assert!(content_hash_bytes::<CHUNKS>(&vec![0u8; MAX_PAYLOAD + 1]).is_none());
    }

    #[test]
    fn multi_part_roundtrip_reorder_and_wire() {
        const N: usize = 8; // small circuit for speed; same code path
        let keys = prove::setup::<N>().unwrap();
        let payload: Vec<u8> = (0..capacity(N, 3) - 10).map(|i| (i * 7) as u8).collect();
        let (t, s) = sealed::new_secret();
        let o = seal::<N>(&keys, s, &payload).unwrap();
        assert_eq!(o.parts.len(), 3);
        let h = content_hash_bytes::<N>(&payload).unwrap();
        let tp = pallas::Point::from(generator()) * t;
        assert!(verify_offer(&keys, &o, &tp, &h));
        let back = MultiOffer::from_wire(&o.to_wire()).unwrap();
        assert!(verify_offer(&keys, &back, &tp, &h));
        assert_eq!(open(t, &back).unwrap(), payload);
        // Swapping parts (with their offsets) breaks the offset order check.
        let mut sw = o.clone(); sw.parts.swap(0, 1);
        assert!(!verify_offer(&keys, &sw, &tp, &h));
        // Dropping a part changes the aggregate hash.
        let mut dr = o.clone(); dr.parts.pop();
        assert!(!verify_offer(&keys, &dr, &tp, &h));
        // A different T is rejected.
        let (t2, _) = sealed::new_secret();
        assert!(!verify_offer(&keys, &o, &(pallas::Point::from(generator()) * t2), &h));
        assert!(open(t2, &o).is_none() || open(t2, &o).unwrap() != payload);
    }
}
