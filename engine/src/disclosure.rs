//! MinValue circuit with gated running sum.
//! Each row: r_cur = 2*r_prev + bit. r_0 = 0. Final gated cell equals diff.

use ff::{Field, PrimeField};
use halo2_proofs::{
    circuit::{Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Error, Expression, Instance, Selector},
    poly::Rotation,
};
use pasta_curves::pallas::Base as F;

const DIFF_BITS: usize = 64;

#[derive(Clone)]
struct Config {
    q_min: Selector,
    q_bit: Selector,
    q_sum: Selector,
    value: Column<Advice>,
    diff: Column<Advice>,
    bit: Column<Advice>,
    running: Column<Advice>,
    min_col: Column<Advice>,
    txid: Column<Advice>,
    claim_instance: Column<Instance>,
    txid_instance: Column<Instance>,
}

struct MinValueCircuit { value: u64, min: u64, txid: F }

impl Circuit<F> for MinValueCircuit {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self { Self { value: 0, min: 0, txid: self.txid } }

    fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
        let q_min = meta.selector();
        let q_bit = meta.selector();
        let q_sum = meta.selector();
        let value = meta.advice_column();
        let diff = meta.advice_column();
        let bit = meta.advice_column();
        let running = meta.advice_column();
        let min_col = meta.advice_column();
        let txid = meta.advice_column();
        let claim_instance = meta.instance_column();
        let txid_instance = meta.instance_column();

        for c in [value, diff, bit, running, min_col, txid] { meta.enable_equality(c); }
        meta.enable_equality(claim_instance);
        meta.enable_equality(txid_instance);

        meta.create_gate("value = min + diff", |meta| {
            let q = meta.query_selector(q_min);
            let v = meta.query_advice(value, Rotation::cur());
            let d = meta.query_advice(diff, Rotation::cur());
            let m = meta.query_advice(min_col, Rotation::cur());
            vec![q * (v - (m + d))]
        });

        meta.create_gate("bit boolean", |meta| {
            let q = meta.query_selector(q_bit);
            let b = meta.query_advice(bit, Rotation::cur());
            vec![q * b.clone() * (b - Expression::Constant(F::ONE))]
        });

        meta.create_gate("running sum", |meta| {
            let q = meta.query_selector(q_sum);
            let r_cur = meta.query_advice(running, Rotation::cur());
            let r_prev = meta.query_advice(running, Rotation::prev());
            let b = meta.query_advice(bit, Rotation::cur());
            vec![q * (r_cur - (r_prev * F::from(2u64) + b))]
        });

        Config { q_min, q_bit, q_sum, value, diff, bit, running, min_col, txid, claim_instance, txid_instance }
    }

    fn synthesize(&self, config: Self::Config, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        if self.value < self.min { return Err(Error::Synthesis); }
        let diff = self.value - self.min;
        let (min_cell, txid_cell) = layouter.assign_region(|| "minvalue", |mut region| {
            config.q_min.enable(&mut region, 0)?;
            region.assign_advice(|| "value", config.value, 0, || Value::known(F::from(self.value)))?;
            let dc = region.assign_advice(|| "diff", config.diff, 0, || Value::known(F::from(diff)))?;
            let mc = region.assign_advice(|| "min", config.min_col, 0, || Value::known(F::from(self.min)))?;

            region.assign_advice(|| "r0", config.running, 0, || Value::known(F::ZERO))?;
            let mut run = F::ZERO;
            for i in 0..DIFF_BITS {
                config.q_bit.enable(&mut region, i + 1)?;
                config.q_sum.enable(&mut region, i + 1)?;
                let bit = ((diff >> (DIFF_BITS - 1 - i)) & 1) as u64;
                let bit_fe = F::from(bit);
                region.assign_advice(|| format!("b{}", i), config.bit, i + 1, || Value::known(bit_fe))?;
                run = run * F::from(2u64) + bit_fe;
                region.assign_advice(|| format!("r{}", i), config.running, i + 1, || Value::known(run))?;
            }
            let final_run = region.assign_advice(|| "final", config.running, DIFF_BITS, || Value::known(run))?;
            region.constrain_equal(dc.cell(), final_run.cell())?;

            let tc = region.assign_advice(|| "txid", config.txid, 0, || Value::known(self.txid))?;
            Ok((mc, tc))
        })?;
        layouter.constrain_instance(min_cell.cell(), config.claim_instance, 0)?;
        layouter.constrain_instance(txid_cell.cell(), config.txid_instance, 0)?;
        Ok(())
    }
}

fn txid_to_fe(hex_str: &str) -> F {
    let bytes = hex::decode(hex_str).unwrap();
    let mut b = [0u8; 32];
    b[..31].copy_from_slice(&bytes[..31]);
    F::from_repr(b).unwrap()
}

/// Public commitment that binds value and txid.
/// C = H(value || txid). A different txid produces a different commitment.
pub fn commit_value_txid(value: u64, txid: &[u8; 32]) -> [u8; 32] {
    use blake2b_simd::Params;
    let mut v = value.to_le_bytes().to_vec();
    v.extend_from_slice(txid);
    let h = Params::new().hash_length(32).personal(b"Lintel_Commit")
        .to_state().update(&v).finalize();
    h.as_bytes().try_into().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use halo2_proofs::dev::MockProver;

    #[test]
    fn minvalue_gated_sum() {
        let txid = txid_to_fe("51c6daaf0aba583cfcfed9a928a53d22e5f5f7c3f97db71935a0b6d4387d02b8");
        let circuit = MinValueCircuit { value: 5_000_000_000, min: 1_000_000_000, txid };
        MockProver::run(8, &circuit, vec![vec![F::from(1_000_000_000u64)], vec![txid]]).unwrap().assert_satisfied();
    }

    #[test]
    fn value_below_min_fails() {
        let txid = txid_to_fe("51c6daaf0aba583cfcfed9a928a53d22e5f5f7c3f97db71935a0b6d4387d02b8");
        let circuit = MinValueCircuit { value: 1, min: 1_000_000_000, txid };
        assert!(MockProver::run(8, &circuit, vec![vec![F::from(1_000_000_000u64)], vec![txid]]).is_err());
    }

    #[test]
    fn commitment_binds_txid() {
        let txid1 = [1u8; 32];
        let txid2 = [2u8; 32];
        assert_ne!(commit_value_txid(1000, &txid1), commit_value_txid(1000, &txid2));
    }
}
