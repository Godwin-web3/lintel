//! MinValue circuit with in-circuit commitment.
//! C = value + blind + txid is a public input. r0 is assigned 0 and the sum starts from row 1.

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
    q_commit: Selector,
    value: Column<Advice>,
    diff: Column<Advice>,
    bit: Column<Advice>,
    running: Column<Advice>,
    min_col: Column<Advice>,
    blind: Column<Advice>,
    commit: Column<Advice>,
    txid: Column<Advice>,
    claim_instance: Column<Instance>,
    commit_instance: Column<Instance>,
}

struct MinValueCircuit { value: u64, min: u64, blind: F, txid: F }

impl Circuit<F> for MinValueCircuit {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self { Self { value: 0, min: 0, blind: F::ZERO, txid: self.txid } }

    fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
        let q_min = meta.selector();
        let q_bit = meta.selector();
        let q_sum = meta.selector();
        let q_commit = meta.selector();
        let value = meta.advice_column();
        let diff = meta.advice_column();
        let bit = meta.advice_column();
        let running = meta.advice_column();
        let min_col = meta.advice_column();
        let blind = meta.advice_column();
        let commit = meta.advice_column();
        let txid = meta.advice_column();
        let claim_instance = meta.instance_column();
        let commit_instance = meta.instance_column();

        for c in [value, diff, bit, running, min_col, blind, commit, txid] { meta.enable_equality(c); }
        meta.enable_equality(claim_instance);
        meta.enable_equality(commit_instance);

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

        meta.create_gate("commitment", |meta| {
            let q = meta.query_selector(q_commit);
            let v = meta.query_advice(value, Rotation::cur());
            let b = meta.query_advice(blind, Rotation::cur());
            let t = meta.query_advice(txid, Rotation::cur());
            let c = meta.query_advice(commit, Rotation::cur());
            vec![q * (c - (v + b + t))]
        });

        Config { q_min, q_bit, q_sum, q_commit, value, diff, bit, running, min_col, blind, commit, txid, claim_instance, commit_instance }
    }

    fn synthesize(&self, config: Self::Config, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        if self.value < self.min { return Err(Error::Synthesis); }
        let diff = self.value - self.min;
        let c_val = F::from(self.value) + self.blind + self.txid;
        let (min_cell, commit_cell) = layouter.assign_region(|| "minvalue", |mut region| {
            config.q_min.enable(&mut region, 0)?;
            config.q_commit.enable(&mut region, 0)?;
            region.assign_advice(|| "value", config.value, 0, || Value::known(F::from(self.value)))?;
            let dc = region.assign_advice(|| "diff", config.diff, 0, || Value::known(F::from(diff)))?;
            let mc = region.assign_advice(|| "min", config.min_col, 0, || Value::known(F::from(self.min)))?;
            region.assign_advice(|| "blind", config.blind, 0, || Value::known(self.blind))?;
            region.assign_advice(|| "txid", config.txid, 0, || Value::known(self.txid))?;
            let cc = region.assign_advice(|| "commit", config.commit, 0, || Value::known(c_val))?;

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
            let final_cell = region.assign_advice(|| "final", config.running, DIFF_BITS, || Value::known(run))?;
            region.constrain_equal(dc.cell(), final_cell.cell())?;
            Ok((mc, cc))
        })?;
        layouter.constrain_instance(min_cell.cell(), config.claim_instance, 0)?;
        layouter.constrain_instance(commit_cell.cell(), config.commit_instance, 0)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use halo2_proofs::dev::MockProver;

    #[test]
    fn minvalue_with_commitment() {
        let txid = F::from(42u64);
        let blind = F::from(7u64);
        let circuit = MinValueCircuit { value: 5_000_000_000, min: 1_000_000_000, blind, txid };
        let c = F::from(5_000_000_000u64) + blind + txid;
        MockProver::run(8, &circuit, vec![vec![F::from(1_000_000_000u64)], vec![c]]).unwrap().assert_satisfied();
    }
}
