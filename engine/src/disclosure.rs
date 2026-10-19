//! MinValue selective disclosure circuit.
//!
//! Proves, without revealing `value` or `blind`:
//! * value >= min            (64-bit range check on diff = value - min)
//! * C = Poseidon(value, blind, txid_lo, txid_hi), computed in-circuit
//!
//! Public instance column, in order: [min, txid_lo, txid_hi, C].
//! The txid is a public input, so a proof for one transaction does not
//! verify for another. The running sum starts from a fixed constant 0.

use ff::{Field, FromUniformBytes, PrimeField};
use halo2_gadgets::poseidon::{
    primitives::{self as poseidon, ConstantLength, P128Pow5T3},
    Hash, Pow5Chip, Pow5Config,
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Constraints, Error, Expression, Instance, Selector},
    poly::Rotation,
};
use pasta_curves::pallas::Base as F;

pub const DIFF_BITS: usize = 64;
pub const K: u32 = 9;

const IDX_MIN: usize = 0;
const IDX_TXID_LO: usize = 1;
const IDX_TXID_HI: usize = 2;
const IDX_COMMIT: usize = 3;

#[derive(Clone, Debug)]
pub struct Config {
    advice: [Column<Advice>; 4],
    instance: Column<Instance>,
    poseidon: Pow5Config<F, 3, 2>,
    q_range: Selector,
    q_sub: Selector,
}

#[derive(Clone, Debug, Default)]
pub struct MinValueCircuit {
    pub value: Value<F>,
    pub blind: Value<F>,
}

impl MinValueCircuit {
    pub fn new(value: u64, blind: F) -> Self {
        Self { value: Value::known(F::from(value)), blind: Value::known(blind) }
    }
}

/// Splits a 32-byte txid into two 128-bit field elements.
pub fn txid_to_fields(txid: &[u8; 32]) -> (F, F) {
    let mut lo = [0u8; 64];
    let mut hi = [0u8; 64];
    lo[..16].copy_from_slice(&txid[..16]);
    hi[..16].copy_from_slice(&txid[16..]);
    (F::from_uniform_bytes(&lo), F::from_uniform_bytes(&hi))
}

/// Hiding, binding commitment to (value, blind) under a txid.
pub fn commitment(value: u64, blind: F, txid: &[u8; 32]) -> F {
    let (lo, hi) = txid_to_fields(txid);
    poseidon::Hash::<_, P128Pow5T3, ConstantLength<4>, 3, 2>::init().hash([F::from(value), blind, lo, hi])
}

/// Public instance vector: [min, txid_lo, txid_hi, C].
pub fn public_inputs(min: u64, txid: &[u8; 32], c: F) -> Vec<F> {
    let (lo, hi) = txid_to_fields(txid);
    vec![F::from(min), lo, hi, c]
}

impl Circuit<F> for MinValueCircuit {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self { Self::default() }

    fn configure(meta: &mut ConstraintSystem<F>) -> Config {
        let advice = [meta.advice_column(), meta.advice_column(), meta.advice_column(), meta.advice_column()];
        let instance = meta.instance_column();
        meta.enable_equality(instance);
        for a in advice { meta.enable_equality(a); }

        let rc_a = [meta.fixed_column(), meta.fixed_column(), meta.fixed_column()];
        let rc_b = [meta.fixed_column(), meta.fixed_column(), meta.fixed_column()];
        meta.enable_constant(rc_b[0]);
        let poseidon = Pow5Chip::configure::<P128Pow5T3>(meta, [advice[0], advice[1], advice[2]], advice[3], rc_a, rc_b);

        let q_range = meta.selector();
        let q_sub = meta.selector();

        // advice[0] = bit, advice[1] = running sum
        meta.create_gate("bit decomposition", |meta| {
            let q = meta.query_selector(q_range);
            let bit = meta.query_advice(advice[0], Rotation::cur());
            let acc = meta.query_advice(advice[1], Rotation::cur());
            let acc_next = meta.query_advice(advice[1], Rotation::next());
            let one = Expression::Constant(F::ONE);
            let two = Expression::Constant(F::from(2));
            Constraints::with_selector(q, [
                ("bool", bit.clone() * (one - bit.clone())),
                ("acc", acc_next - (acc * two + bit)),
            ])
        });

        // advice[0] = value, advice[1] = min, advice[2] = diff
        meta.create_gate("diff = value - min", |meta| {
            let q = meta.query_selector(q_sub);
            let v = meta.query_advice(advice[0], Rotation::cur());
            let m = meta.query_advice(advice[1], Rotation::cur());
            let d = meta.query_advice(advice[2], Rotation::cur());
            Constraints::with_selector(q, [("sub", v - m - d)])
        });

        Config { advice, instance, poseidon, q_range, q_sub }
    }

    fn synthesize(&self, config: Config, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        let adv = config.advice;

        let (value, diff) = layouter.assign_region(|| "value - min", |mut region| {
            config.q_sub.enable(&mut region, 0)?;
            let value = region.assign_advice(|| "value", adv[0], 0, || self.value)?;
            let min = region.assign_advice_from_instance(|| "min", config.instance, IDX_MIN, adv[1], 0)?;
            let diff = region.assign_advice(|| "diff", adv[2], 0, || self.value - min.value().copied())?;
            Ok((value, diff))
        })?;

        // diff < 2^64, so value >= min with no wraparound.
        let acc_final: AssignedCell<F, F> = layouter.assign_region(|| "range check", |mut region| {
            let bits: Value<Vec<bool>> = diff.value().map(|d| {
                let repr = d.to_repr();
                (0..DIFF_BITS).rev().map(|i| (repr.as_ref()[i / 8] >> (i % 8)) & 1 == 1).collect()
            });
            // r0 is pinned to the constant 0.
            let mut acc = region.assign_advice_from_constant(|| "r0", adv[1], 0, F::ZERO)?;
            for i in 0..DIFF_BITS {
                config.q_range.enable(&mut region, i)?;
                let bit = bits.as_ref().map(|b| if b[i] { F::ONE } else { F::ZERO });
                region.assign_advice(|| "bit", adv[0], i, || bit)?;
                let next = acc.value().copied() * Value::known(F::from(2)) + bit;
                acc = region.assign_advice(|| "acc", adv[1], i + 1, || next)?;
            }
            Ok(acc)
        })?;
        layouter.assign_region(|| "acc == diff", |mut region| region.constrain_equal(acc_final.cell(), diff.cell()))?;

        let inputs = layouter.assign_region(|| "hash inputs", |mut region| {
            let v = value.copy_advice(|| "value", &mut region, adv[0], 0)?;
            let blind = region.assign_advice(|| "blind", adv[1], 0, || self.blind)?;
            let lo = region.assign_advice_from_instance(|| "txid_lo", config.instance, IDX_TXID_LO, adv[2], 0)?;
            let hi = region.assign_advice_from_instance(|| "txid_hi", config.instance, IDX_TXID_HI, adv[3], 0)?;
            Ok([v, blind, lo, hi])
        })?;
        let chip = Pow5Chip::construct(config.poseidon.clone());
        let hasher = Hash::<_, _, P128Pow5T3, ConstantLength<4>, 3, 2>::init(chip, layouter.namespace(|| "poseidon init"))?;
        let out = hasher.hash(layouter.namespace(|| "poseidon"), inputs)?;
        layouter.constrain_instance(out.cell(), config.instance, IDX_COMMIT)?;
        Ok(())
    }
}

/// Real proving and verification (IPA over Pasta).
pub mod prove {
    use super::*;
    use halo2_proofs::{
        plonk::{create_proof, keygen_pk, keygen_vk, verify_proof, ProvingKey, SingleVerifier, VerifyingKey},
        poly::commitment::Params,
        transcript::{Blake2bRead, Blake2bWrite, Challenge255},
    };
    use pasta_curves::vesta;

    pub struct Keys {
        pub params: Params<vesta::Affine>,
        pub vk: VerifyingKey<vesta::Affine>,
        pub pk: ProvingKey<vesta::Affine>,
    }

    pub fn setup() -> Result<Keys, Error> {
        let params: Params<vesta::Affine> = Params::new(K);
        let empty = MinValueCircuit::default();
        let vk = keygen_vk(&params, &empty)?;
        let pk = keygen_pk(&params, vk.clone(), &empty)?;
        Ok(Keys { params, vk, pk })
    }

    pub fn prove(keys: &Keys, circuit: MinValueCircuit, public: &[F]) -> Result<Vec<u8>, Error> {
        let mut transcript = Blake2bWrite::<_, _, Challenge255<_>>::init(vec![]);
        create_proof(&keys.params, &keys.pk, &[circuit], &[&[public]], rand::rng(), &mut transcript)?;
        Ok(transcript.finalize())
    }

    pub fn verify(keys: &Keys, proof: &[u8], public: &[F]) -> bool {
        let strategy = SingleVerifier::new(&keys.params);
        let mut transcript = Blake2bRead::<_, _, Challenge255<_>>::init(proof);
        verify_proof(&keys.params, &keys.vk, strategy, &[&[public]], &mut transcript).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use halo2_proofs::dev::MockProver;

    const TXID: [u8; 32] = [42u8; 32];

    fn run(value: u64, _min: u64, blind: F, public: Vec<F>) -> bool {
        let circuit = MinValueCircuit::new(value, blind);
        MockProver::run(K, &circuit, vec![public]).unwrap().verify().is_ok()
    }

    #[test]
    fn honest_proof_passes() {
        let blind = F::from(7u64);
        let c = commitment(5_000_000_000, blind, &TXID);
        assert!(run(5_000_000_000, 1_000_000_000, blind, public_inputs(1_000_000_000, &TXID, c)));
    }

    #[test]
    fn value_below_min_fails() {
        let blind = F::from(7u64);
        let c = commitment(1, blind, &TXID);
        assert!(!run(1, 1_000_000_000, blind, public_inputs(1_000_000_000, &TXID, c)));
    }

    #[test]
    fn wrong_txid_fails() {
        let blind = F::from(7u64);
        let c = commitment(5_000_000_000, blind, &TXID);
        assert!(!run(5_000_000_000, 1_000_000_000, blind, public_inputs(1_000_000_000, &[9u8; 32], c)));
    }

    #[test]
    fn reopen_to_other_value_fails() {
        // Linear commitments let you shift blind to reopen; Poseidon does not.
        let blind = F::from(7u64);
        let c = commitment(5_000_000_000, blind, &TXID);
        let shifted = blind + F::from(5_000_000_000u64) - F::from(9_000_000_000u64);
        assert!(!run(9_000_000_000, 1_000_000_000, shifted, public_inputs(1_000_000_000, &TXID, c)));
    }

    #[test]
    fn real_proof_roundtrip() {
        let keys = prove::setup().unwrap();
        let blind = F::from(11u64);
        let c = commitment(2_000, blind, &TXID);
        let public = public_inputs(1_000, &TXID, c);
        let proof = prove::prove(&keys, MinValueCircuit::new(2_000, blind), &public).unwrap();
        assert!(prove::verify(&keys, &proof, &public));
        let other = public_inputs(1_000, &[1u8; 32], c);
        assert!(!prove::verify(&keys, &proof, &other));
    }
}
