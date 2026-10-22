//! Big sealed goods (offer v3): payloads up to [`MAX_PAYLOAD`] bytes (about
//! 1.5 MB), every plaintext byte's decryption proven.
//!
//! Same guarantee as [`crate::sealed`] and [`crate::sealed_multi`]: for every
//! part, a Halo 2 proof shows `T = [s] G` (the adaptor point the payment is
//! locked to), that each ciphertext element is the matching plaintext element
//! plus keystream derived from `s`, and that the plaintext hashes to the
//! part's published hash. There is no unproven key-wrapping step: the
//! ciphertext the buyer downloads is exactly the ciphertext in the proofs.
//!
//! What changes against v2:
//!
//! * **Bigger parts.** [`CHUNKS`] = 768 field elements (23,808 bytes) per
//!   proof at `k = 15` (v2: 64 per proof at `k = 13`). IPA parameters are
//!   transparent, so this only needs a larger parameter file (2 MB,
//!   `params-big.bin`, its own pinned digest); there is no ceremony.
//! * **Rate-2 keystream.** One Poseidon permutation yields two keystream
//!   elements: `(o_0, o_1) = squeeze2(Poseidon_sponge(s, TAG + j))` and
//!   `c_{2j} = m_{2j} + o_0`, `c_{2j+1} = m_{2j+1} + o_1`. This removes a third
//!   of the circuit rows per byte. See "Why the rate-2 keystream is sound"
//!   below.
//! * **Many parts.** Up to [`MAX_PARTS`] parts. Ciphertext and proofs travel
//!   as content-addressed blobs (one per part, SHA-256 named); the relay keeps
//!   only a small manifest, so the relay's JSON body cap no longer limits the
//!   payload.
//! * **Parallel parts.** [`seal_parallel`] proves parts on several threads.
//!
//! ## Keystream and offsets
//!
//! Part `j` covers global chunks `j*N .. (j+1)*N`, i.e. global keystream
//! *pairs* `j*N/2 .. (j+1)*N/2`. Its public `off_j = j * N / 2` (a pair
//! offset). The circuit computes the sponge input `idx = off_j + TAG + i + 1`
//! for local pair `i`, and the verifier checks `off_j == j * N / 2`, so no
//! two parts ever reuse a keystream pair. `TAG = 2^128` keeps every v3 sponge
//! input disjoint from the v1/v2 keystream inputs (which are below `2^64`),
//! so even a secret reused across versions would not repeat keystream.
//!
//! ## Why the rate-2 keystream is sound
//!
//! v1/v2 compute `Poseidon(s, i)` with `ConstantLength<2>`: absorb `(s, i)`
//! into the two rate words of a width-3 state whose capacity word holds the
//! domain tag, permute, output word 0. v3 runs the identical sponge and
//! outputs words 0 *and* 1 (the whole rate). That is plain sponge squeezing:
//! the capacity word (one ~255-bit field element) is never output, which is
//! exactly the security margin P128Pow5T3 is specified with for hashing
//! (128-bit). Each permutation input is distinct (`idx` is unique per pair
//! and per secret), so with `s` unknown the outputs are pseudorandom field
//! elements, the same keyed-sponge/PRF argument v1 relies on, applied to both
//! rate words. Proof soundness is unaffected: the circuit constrains both
//! squeezed words with the same Pow5 chip gates as before.
//!
//! ## Content hash
//!
//! Per part: `h_j = Poseidon_{ConstantLength<N>}(m_j)`, proven in-circuit.
//! Whole payload: BLAKE2b-256(personal "lintel-big-v3", N || P || h_0 || ..),
//! always (also for one part), so a v3 hash never equals a v1/v2 hash.
//!
//! Public instance column per part: `[T.x, T.y, h_j, off_j, c_{j,0}, .., c_{j,N-1}]`.

use ff::{Field, PrimeField};
use group::GroupEncoding;
use halo2_gadgets::{
    ecc::{chip::{CircuitVersion, EccChip, EccConfig}, FixedPointBaseField},
    poseidon::{
        primitives::{ConstantLength, Domain, P128Pow5T3, Spec},
        Hash, PaddedWord, Pow5Chip, Pow5Config, Sponge,
    },
    utilities::lookup_range_check::{LookupRangeCheck, PallasLookupRangeCheckConfig},
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Constraints, Error, Instance, Selector, TableColumn},
    poly::Rotation,
};
use pasta_curves::pallas;
use sha2::{Digest, Sha256};

use crate::sealed::{self, base_from_scalar, generator, point_coords, scalar_from_base, Bases, SpendAuthBase, BYTES_PER_CHUNK};

type F = pallas::Base;

/// Field elements per part (even: the keystream comes in pairs).
pub const CHUNKS: usize = 768;
/// Most parts one v3 offer may carry.
pub const MAX_PARTS: usize = 64;
/// Payload bytes for `parts` parts of `n` chunks (chunk 0 of part 0 = length).
pub const fn capacity(n: usize, parts: usize) -> usize { (n * parts - 1) * BYTES_PER_CHUNK }
/// Largest v3 payload: (768 * 64 - 1) * 31 = 1,523,681 bytes.
pub const MAX_PAYLOAD: usize = capacity(CHUNKS, MAX_PARTS);

/// Circuit size for `n` chunks per part: ~40 rows per Poseidon permutation,
/// `n/2` keystream + `n/2` hash permutations, plus the ECC multiplication and
/// the 1,024-row range-check table. `k_for(768) = 15`.
pub const fn k_for(n: usize) -> u32 {
    let rows = 40 * (n + 2) + 1700;
    let mut k = 11;
    while (1usize << k) < rows { k += 1; }
    k
}

/// `2^128`: keeps v3 keystream inputs disjoint from v1/v2 (< 2^64).
fn tag() -> F { F::from_u128(1u128 << 64).square() }

/// Poseidon P128Pow5T3 permutation (same constants and rounds as
/// `halo2_poseidon`, whose own `permute` is crate-private). Tested against
/// `poseidon::Hash` below.
fn permute(state: &mut [F; 3]) {
    type S = P128Pow5T3;
    let (rc, mds, _) = <S as Spec<F, 3, 2>>::constants();
    let r_f = <S as Spec<F, 3, 2>>::full_rounds() / 2;
    let r_p = <S as Spec<F, 3, 2>>::partial_rounds();
    let sbox = <S as Spec<F, 3, 2>>::sbox;
    let mix = |s: &mut [F; 3]| {
        let mut n = [F::ZERO; 3];
        for i in 0..3 { for j in 0..3 { n[i] += mds[i][j] * s[j]; } }
        *s = n;
    };
    for (r, c) in rc.iter().enumerate() {
        let full = r < r_f || r >= r_f + r_p;
        for i in 0..3 { state[i] += c[i]; }
        if full { for w in state.iter_mut() { *w = sbox(*w); } } else { state[0] = sbox(state[0]); }
        mix(state);
    }
}

/// Keystream pair for global pair index `pair` (0-based).
pub fn keystream2(s: F, pair: u64) -> (F, F) {
    let mut st = [s, tag() + F::from(pair + 1), <ConstantLength<2> as Domain<F, 2>>::initial_capacity_element()];
    permute(&mut st);
    (st[0], st[1])
}

fn encrypt_block(s: F, block: &[F], pair_off: u64) -> Vec<F> {
    let mut out = Vec::with_capacity(block.len());
    for (i, two) in block.chunks(2).enumerate() {
        let (a, b) = keystream2(s, pair_off + i as u64);
        out.push(two[0] + a);
        out.push(two[1] + b);
    }
    out
}

fn decrypt_block(s: F, ct: &[F], pair_off: u64) -> Vec<F> {
    let mut out = Vec::with_capacity(ct.len());
    for (i, two) in ct.chunks(2).enumerate() {
        let (a, b) = keystream2(s, pair_off + i as u64);
        out.push(two[0] - a);
        out.push(two[1] - b);
    }
    out
}

/// Number of parts needed for `len` payload bytes, or `None` above [`MAX_PARTS`].
pub fn parts_for(len: usize, n: usize) -> Option<usize> {
    let p = (1 + len.div_ceil(BYTES_PER_CHUNK)).div_ceil(n).max(1);
    (p <= MAX_PARTS && len <= capacity(n, p)).then_some(p)
}

pub fn part_hash<const N: usize>(m: &[F; N]) -> F { sealed::content_hash(m) }

/// Aggregate content hash over the per-part hashes (see module docs).
pub fn aggregate_hash(n: usize, part_hashes: &[F]) -> [u8; 32] {
    let mut st = blake2b_simd::Params::new().hash_length(32).personal(b"lintel-big-v3\0\0\0").to_state();
    st.update(&(n as u64).to_le_bytes());
    st.update(&(part_hashes.len() as u64).to_le_bytes());
    for h in part_hashes { st.update(h.to_repr().as_ref()); }
    let mut out = [0u8; 32];
    out.copy_from_slice(st.finalize().as_bytes());
    out
}

/// Content hash of raw bytes, as the payer should expect it. `None` if too large.
pub fn content_hash_bytes<const N: usize>(bytes: &[u8]) -> Option<[u8; 32]> {
    let parts = parts_for(bytes.len(), N)?;
    let m = sealed::pack(bytes, N * parts)?;
    let hs: Vec<F> = m.chunks(N).map(|c| part_hash::<N>(c.try_into().unwrap())).collect();
    Some(aggregate_hash(N, &hs))
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
        assert!(N % 2 == 0, "v3 parts hold an even number of chunks");
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
        // a[2] = a[0] + a[1]: used for c = m + k and for idx = off + (TAG + i + 1).
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

        let tag = tag();
        for (i, two) in m.chunks(2).enumerate() {
            // idx = off + (TAG + i + 1), the constant fixed in the circuit.
            let idx = layouter.assign_region(|| "index", |mut region| {
                config.q_add.enable(&mut region, 0)?;
                let o = off.copy_advice(|| "off", &mut region, adv[0], 0)?;
                let k = region.assign_advice_from_constant(|| "TAG+i+1", adv[1], 0, tag + F::from(i as u64 + 1))?;
                region.assign_advice(|| "idx", adv[2], 0, || o.value().copied() + k.value().copied())
            })?;
            // Same sponge as Poseidon ConstantLength<2>, squeezed twice (whole rate).
            let mut sponge = Sponge::<_, _, P128Pow5T3, _, ConstantLength<2>, 3, 2>::new(
                Pow5Chip::construct(config.poseidon.clone()),
                layouter.namespace(|| "keystream init"),
            )?;
            sponge.absorb(layouter.namespace(|| "absorb s"), PaddedWord::Message(s.clone()))?;
            sponge.absorb(layouter.namespace(|| "absorb idx"), PaddedWord::Message(idx))?;
            let mut sq = sponge.finish_absorbing(layouter.namespace(|| "permute"))?;
            let k0 = sq.squeeze(layouter.namespace(|| "o0"))?;
            let k1 = sq.squeeze(layouter.namespace(|| "o1"))?;
            for (w, (mi, k)) in [(0usize, (&two[0], k0)), (1usize, (&two[1], k1))] {
                let c = layouter.assign_region(|| "encrypt", |mut region| {
                    config.q_add.enable(&mut region, 0)?;
                    let m = mi.copy_advice(|| "m", &mut region, adv[0], 0)?;
                    let k = k.copy_advice(|| "k", &mut region, adv[1], 0)?;
                    region.assign_advice(|| "c", adv[2], 0, || m.value().copied() + k.value().copied())
                })?;
                layouter.constrain_instance(c.cell(), config.instance, 4 + 2 * i + w)?;
            }
        }
        Ok(())
    }
}

/// Public instance `[T.x, T.y, h, off, c_0..]`. `None` for the identity.
pub fn public_inputs(t_point: &pallas::Point, h: F, pair_offset: u64, ciphertext: &[F]) -> Option<Vec<F>> {
    let (x, y) = point_coords(t_point)?;
    let mut v = vec![x, y, h, F::from(pair_offset)];
    v.extend_from_slice(ciphertext);
    Some(v)
}

// ---------- keys (own parameter file: params-big.bin) ----------

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

    /// Serialized commitment parameters for `N` (transparent: no trusted setup).
    pub fn params_bytes<const N: usize>() -> Vec<u8> {
        let mut out = vec![];
        Params::<vesta::Affine>::new(k_for(N)).write(&mut out).expect("vec write");
        out
    }

    /// Builds keys from downloaded parameters, which must match the pinned digest.
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
pub struct BigOffer { pub t_point: pallas::Point, pub parts: Vec<Part> }

/// Prepared plaintext for sealing part by part (the browser proves one part
/// per call so it can report progress).
pub struct Sealer<const N: usize> { s: F, t_point: pallas::Point, m: Vec<F> }

impl<const N: usize> Sealer<N> {
    pub fn new(s: F, payload: &[u8]) -> Result<Self, &'static str> {
        let parts = parts_for(payload.len(), N).ok_or("payload too large")?;
        let m = sealed::pack(payload, N * parts).ok_or("payload too large")?;
        if bool::from(s.is_zero()) { return Err("secret is zero"); }
        Ok(Self { s, t_point: pallas::Point::from(generator()) * scalar_from_base(s), m })
    }
    pub fn parts(&self) -> usize { self.m.len() / N }
    pub fn t_point(&self) -> pallas::Point { self.t_point }
    /// Proves part `j`.
    pub fn prove_part(&self, keys: &prove::Keys<N>, j: usize) -> Result<Part, &'static str> {
        let block: [F; N] = self.m.get(j * N..(j + 1) * N).ok_or("no such part")?.try_into().unwrap();
        let offset = (j * N / 2) as u64;
        let hash = part_hash(&block);
        let ciphertext = encrypt_block(self.s, &block, offset);
        let public = public_inputs(&self.t_point, hash, offset, &ciphertext).ok_or("secret is zero")?;
        let proof = prove::prove(keys, PartCircuit::new(self.s, &block), &public).map_err(|_| "proving failed")?;
        Ok(Part { hash, offset, ciphertext, proof })
    }
}

/// Seals `payload` under `s`, one part after another.
pub fn seal<const N: usize>(keys: &prove::Keys<N>, s: F, payload: &[u8]) -> Result<BigOffer, &'static str> {
    seal_parallel(keys, s, payload, 1)
}

/// Seals with up to `threads` parts in flight at once (each proof also uses
/// Halo 2's own multicore pool). Peak memory grows with `threads`. On wasm32
/// this is always sequential (the browser parallelises inside each proof).
pub fn seal_parallel<const N: usize>(keys: &prove::Keys<N>, s: F, payload: &[u8], threads: usize) -> Result<BigOffer, &'static str> {
    let sealer = Sealer::<N>::new(s, payload)?;
    let n = sealer.parts();
    let threads = threads.clamp(1, n);
    #[cfg(not(target_arch = "wasm32"))]
    if threads > 1 {
        use std::sync::{atomic::{AtomicUsize, Ordering}, Mutex};
        let next = AtomicUsize::new(0);
        let out: Mutex<Vec<Option<Result<Part, &'static str>>>> = Mutex::new(vec![None; n]);
        std::thread::scope(|sc| {
            for _ in 0..threads {
                sc.spawn(|| loop {
                    let j = next.fetch_add(1, Ordering::Relaxed);
                    if j >= n { break; }
                    let r = sealer.prove_part(keys, j);
                    out.lock().unwrap()[j] = Some(r);
                });
            }
        });
        let parts = out.into_inner().unwrap().into_iter().map(|p| p.unwrap_or(Err("proving failed"))).collect::<Result<Vec<_>, _>>()?;
        return Ok(BigOffer { t_point: sealer.t_point, parts });
    }
    let parts = (0..n).map(|j| sealer.prove_part(keys, j)).collect::<Result<Vec<_>, _>>()?;
    Ok(BigOffer { t_point: sealer.t_point, parts })
}

impl BigOffer {
    pub fn n(&self) -> usize { self.parts.first().map(|p| p.ciphertext.len()).unwrap_or(0) }
    pub fn content_hash(&self) -> [u8; 32] {
        aggregate_hash(self.n(), &self.parts.iter().map(|p| p.hash).collect::<Vec<_>>())
    }
}

/// Structural checks shared by [`verify_offer`] and [`verify_offer_parallel`].
fn shape_ok<const N: usize>(o: &BigOffer, expected_t: &pallas::Point, expected_hash: &[u8; 32]) -> bool {
    o.t_point.to_bytes() == expected_t.to_bytes()
        && !o.parts.is_empty() && o.parts.len() <= MAX_PARTS
        && &o.content_hash() == expected_hash
        && o.parts.iter().enumerate().all(|(j, p)| p.offset == (j * N / 2) as u64 && p.ciphertext.len() == N)
}

fn part_ok<const N: usize>(keys: &prove::Keys<N>, t: &pallas::Point, p: &Part) -> bool {
    match public_inputs(t, p.hash, p.offset, &p.ciphertext) {
        Some(public) => prove::verify(keys, &p.proof, &public),
        None => false,
    }
}

/// Payer check before paying: locked to `expected_t`, parts in order with
/// non-overlapping keystream, every proof valid, aggregate hash matches.
pub fn verify_offer<const N: usize>(keys: &prove::Keys<N>, o: &BigOffer, expected_t: &pallas::Point, expected_hash: &[u8; 32]) -> bool {
    shape_ok::<N>(o, expected_t, expected_hash) && o.parts.iter().all(|p| part_ok(keys, &o.t_point, p))
}

/// [`verify_offer`] with parts checked on up to `threads` threads (native only).
pub fn verify_offer_parallel<const N: usize>(keys: &prove::Keys<N>, o: &BigOffer, expected_t: &pallas::Point, expected_hash: &[u8; 32], threads: usize) -> bool {
    if !shape_ok::<N>(o, expected_t, expected_hash) { return false; }
    #[cfg(not(target_arch = "wasm32"))]
    if threads > 1 {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let (next, ok) = (AtomicUsize::new(0), AtomicBool::new(true));
        std::thread::scope(|sc| {
            for _ in 0..threads.min(o.parts.len()) {
                sc.spawn(|| loop {
                    let j = next.fetch_add(1, Ordering::Relaxed);
                    if j >= o.parts.len() || !ok.load(Ordering::Relaxed) { break; }
                    if !part_ok(keys, &o.t_point, &o.parts[j]) { ok.store(false, Ordering::Relaxed); }
                });
            }
        });
        return ok.load(Ordering::Relaxed);
    }
    let _ = threads;
    o.parts.iter().all(|p| part_ok(keys, &o.t_point, p))
}

/// After payment: decrypt with the extracted adaptor secret.
pub fn open(t: pallas::Scalar, o: &BigOffer) -> Option<Vec<u8>> {
    let s = base_from_scalar(t)?;
    let mut m = Vec::new();
    for p in &o.parts { m.extend(decrypt_block(s, &p.ciphertext, p.offset)); }
    sealed::unpack(&m)
}

// ---------- blobs and manifest ----------
//
// Blob (one per part), all integers little-endian:
//   "LNT3" | n: u32 | offset: u64 | hash: 32 | ciphertext: n * 32 | proof
// Blob id: lowercase hex SHA-256 of the blob bytes.

const MAGIC: &[u8; 4] = b"LNT3";

/// SHA-256 hex of `bytes`: the content address of a blob.
pub fn blob_id(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }

impl Part {
    pub fn to_blob(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(48 + 32 * self.ciphertext.len() + self.proof.len());
        b.extend_from_slice(MAGIC);
        b.extend_from_slice(&(self.ciphertext.len() as u32).to_le_bytes());
        b.extend_from_slice(&self.offset.to_le_bytes());
        b.extend_from_slice(self.hash.to_repr().as_ref());
        for c in &self.ciphertext { b.extend_from_slice(c.to_repr().as_ref()); }
        b.extend_from_slice(&self.proof);
        b
    }
    /// Parses an untrusted blob. Never panics. Does not verify the proof.
    pub fn from_blob(b: &[u8]) -> Option<Self> {
        if b.len() < 48 || &b[..4] != MAGIC { return None; }
        let n = u32::from_le_bytes(b[4..8].try_into().ok()?) as usize;
        if n == 0 || n > 1 << 16 { return None; }
        let offset = u64::from_le_bytes(b[8..16].try_into().ok()?);
        let field = |s: &[u8]| -> Option<F> { Option::from(F::from_repr(s.try_into().ok()?)) };
        let hash = field(&b[16..48])?;
        let end = 48usize.checked_add(n.checked_mul(32)?)?;
        if b.len() <= end { return None; }
        let ciphertext = b[48..end].chunks(32).map(field).collect::<Option<Vec<_>>>()?;
        Some(Part { hash, offset, ciphertext, proof: b[end..].to_vec() })
    }
}

/// One part as the manifest lists it. `data` (hex of the blob) is filled in
/// by the client after fetching the blob; the relay stores manifests without it.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PartRef {
    pub hash: String,
    pub offset: u64,
    pub blob: String,
    pub len: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

/// Offer v3 wire form: a small manifest; ciphertext and proofs are in blobs.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct BigOfferWire { pub v: u8, pub n: usize, pub t_point: String, pub content_hash: String, pub parts: Vec<PartRef> }

impl BigOffer {
    /// Manifest (without blob data) and the blobs, in part order.
    pub fn to_manifest(&self) -> (BigOfferWire, Vec<Vec<u8>>) {
        let blobs: Vec<Vec<u8>> = self.parts.iter().map(Part::to_blob).collect();
        let parts = self.parts.iter().zip(&blobs).map(|(p, b)| PartRef {
            hash: sealed::field_hex(&p.hash), offset: p.offset, blob: blob_id(b), len: b.len(), data: None,
        }).collect();
        (BigOfferWire { v: 3, n: self.n(), t_point: hex::encode(self.t_point.to_bytes()), content_hash: hex::encode(self.content_hash()), parts }, blobs)
    }

    /// Rebuilds an offer from a manifest and its blobs (untrusted). Rejects a
    /// blob whose SHA-256 is not the id the manifest names, or whose header
    /// disagrees with the manifest. Never panics. Does not verify proofs.
    pub fn from_manifest(w: &BigOfferWire, blobs: &[Vec<u8>]) -> Option<Self> {
        if w.v != 3 || w.parts.is_empty() || w.parts.len() > MAX_PARTS || blobs.len() != w.parts.len() { return None; }
        let mut parts = Vec::with_capacity(blobs.len());
        for (r, b) in w.parts.iter().zip(blobs) {
            if blob_id(b) != r.blob || b.len() != r.len { return None; }
            let p = Part::from_blob(b)?;
            if p.ciphertext.len() != w.n || p.offset != r.offset || sealed::field_hex(&p.hash) != r.hash { return None; }
            parts.push(p);
        }
        let o = Self { t_point: crate::protocol::parse_point(&w.t_point)?, parts };
        if hex::encode(o.content_hash()) != w.content_hash { return None; }
        Some(o)
    }

    /// Same as [`Self::from_manifest`] with each blob inline as `parts[i].data` (hex).
    pub fn from_wire(w: &BigOfferWire) -> Option<Self> {
        let blobs = w.parts.iter().map(|p| hex::decode(p.data.as_ref()?).ok()).collect::<Option<Vec<_>>>()?;
        Self::from_manifest(w, &blobs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use halo2_gadgets::poseidon::primitives as poseidon;
    use halo2_proofs::dev::MockProver;

    #[test]
    fn keystream_word0_is_v1_poseidon_with_tagged_index() {
        let (_, s) = sealed::new_secret();
        for pair in [0u64, 1, 77] {
            let want = poseidon::Hash::<_, P128Pow5T3, ConstantLength<2>, 3, 2>::init().hash([s, tag() + F::from(pair + 1)]);
            assert_eq!(keystream2(s, pair).0, want);
        }
        // Distinct pairs, distinct words.
        let (a, b) = keystream2(s, 0);
        let (c, d) = keystream2(s, 1);
        assert!(a != b && a != c && b != d);
    }

    #[test]
    fn real_size_fits_k15_and_offsets_are_bound() {
        const N: usize = CHUNKS;
        assert_eq!(k_for(N), 15);
        let (_, s) = sealed::new_secret();
        let data = vec![9u8; capacity(N, 2) - 3];
        let m = sealed::pack(&data, 2 * N).unwrap();
        let block: [F; N] = m[N..].try_into().unwrap();
        let t = pallas::Point::from(generator()) * scalar_from_base(s);
        let off = (N / 2) as u64;
        let ct = encrypt_block(s, &block, off);
        let public = public_inputs(&t, part_hash(&block), off, &ct).unwrap();
        let run = |p: Vec<F>| MockProver::run(k_for(N), &PartCircuit::<N>::new(s, &block), vec![p]).unwrap().verify().is_ok();
        assert!(run(public.clone()));
        let mut bad = public.clone(); bad[3] = F::ZERO; assert!(!run(bad)); // keystream reuse
        let mut bad = public.clone(); bad[4 + N - 1] += F::ONE; assert!(!run(bad)); // last (odd) word
        let mut bad = public; bad[2] += F::ONE; assert!(!run(bad)); // hash
    }

    #[test]
    fn sizes() {
        assert_eq!(MAX_PAYLOAD, 1_523_681);
        assert_eq!(parts_for(0, CHUNKS), Some(1));
        assert_eq!(parts_for(capacity(CHUNKS, 1), CHUNKS), Some(1));
        assert_eq!(parts_for(capacity(CHUNKS, 1) + 1, CHUNKS), Some(2));
        assert_eq!(parts_for(MAX_PAYLOAD, CHUNKS), Some(MAX_PARTS));
        assert_eq!(parts_for(MAX_PAYLOAD + 1, CHUNKS), None);
        assert!(content_hash_bytes::<CHUNKS>(&vec![0u8; MAX_PAYLOAD + 1]).is_none());
        // v3 hashes never collide with v2 hashes of the same bytes.
        assert_ne!(content_hash_bytes::<CHUNKS>(b"x").unwrap(), crate::sealed_multi::content_hash_bytes::<{ sealed::CHUNKS }>(b"x").unwrap());
    }

    #[test]
    fn multi_part_roundtrip_blobs_tamper_and_parallel() {
        const N: usize = 8; // small circuit for speed; same code path
        let keys = prove::setup::<N>().unwrap();
        let payload: Vec<u8> = (0..capacity(N, 5) - 4).map(|i| (i * 13 + 1) as u8).collect();
        let (t, s) = sealed::new_secret();
        let o = seal_parallel::<N>(&keys, s, &payload, 3).unwrap();
        assert_eq!(o.parts.len(), 5);
        let h = content_hash_bytes::<N>(&payload).unwrap();
        let tp = pallas::Point::from(generator()) * t;
        assert!(verify_offer(&keys, &o, &tp, &h));
        assert!(verify_offer_parallel(&keys, &o, &tp, &h, 2));
        assert_eq!(open(t, &o).unwrap(), payload);
        // Sequential and parallel sealing produce the same ciphertext.
        assert_eq!(seal::<N>(&keys, s, &payload).unwrap().parts[3].ciphertext, o.parts[3].ciphertext);

        // Manifest + blobs round trip.
        let (man, blobs) = o.to_manifest();
        assert!(serde_json::to_string(&man).unwrap().len() < 2048);
        let back = BigOffer::from_manifest(&man, &blobs).unwrap();
        assert!(verify_offer(&keys, &back, &tp, &h));
        assert_eq!(open(t, &back).unwrap(), payload);
        let mut inline = man.clone();
        for (p, b) in inline.parts.iter_mut().zip(&blobs) { p.data = Some(hex::encode(b)); }
        let back = BigOffer::from_wire(&serde_json::from_str(&serde_json::to_string(&inline).unwrap()).unwrap()).unwrap();
        assert_eq!(open(t, &back).unwrap(), payload);

        // A tampered blob is rejected by its content address...
        let mut bad = blobs.clone();
        let last = bad[2].len() - 1;
        bad[2][last] ^= 1;
        assert!(BigOffer::from_manifest(&man, &bad).is_none());
        // ...and if someone also rewrites the manifest to the tampered blob's id,
        // the proof no longer verifies (proof bytes changed) or the hash breaks.
        let mut man2 = man.clone();
        man2.parts[2].blob = blob_id(&bad[2]);
        let forged = BigOffer::from_manifest(&man2, &bad).unwrap();
        assert!(!verify_offer(&keys, &forged, &tp, &h));
        // Tampered ciphertext inside a re-addressed blob: proof fails.
        let mut p = o.parts[1].clone(); p.ciphertext[0] += F::ONE;
        let mut bad = blobs.clone(); bad[1] = p.to_blob();
        let mut man3 = man.clone(); man3.parts[1].blob = blob_id(&bad[1]);
        assert!(!verify_offer(&keys, &BigOffer::from_manifest(&man3, &bad).unwrap(), &tp, &h));
        // Swapped blobs: manifest offsets/hashes disagree.
        let mut sw = blobs.clone(); sw.swap(0, 1);
        assert!(BigOffer::from_manifest(&man, &sw).is_none());
        // Swapped parts (manifest and blobs together): offset order check.
        let mut so = o.clone(); so.parts.swap(0, 1);
        assert!(!verify_offer(&keys, &so, &tp, &h));
        // Dropped part: aggregate hash changes.
        let mut dr = o.clone(); dr.parts.pop();
        assert!(!verify_offer(&keys, &dr, &tp, &h));
        // Different T.
        let (t2, _) = sealed::new_secret();
        assert!(!verify_offer(&keys, &o, &(pallas::Point::from(generator()) * t2), &h));
        // Garbage blobs never panic.
        for g in [vec![], b"LNT3".to_vec(), vec![0u8; 100], [b"LNT3".as_slice(), &[255, 255, 255, 255], &[0u8; 60]].concat()] {
            assert!(Part::from_blob(&g).is_none());
        }
    }
}
