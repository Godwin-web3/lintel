//! MinValue circuit with a public commitment.
//! C = value + blinding is a public input. The proof shows the committed value is >= min.

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
    q_commit: Selector,
    value: Column<Advice>,
    diff: Column<Advice>,
    bit: Column<Advice>,
    running: Column<Advice>,
    min_col: Column<Advice>,
    blinding: Column<Advice>,
    commitment: Column<Advice>,
    txid: Column<Advice>,
    claim_instance: Column<Instance>,
    commit_instance: Column<Instance>,
    txid_instance: Column<Instance>,
}

struct MinValueCircuit {
    value: u64,
    min: u64,
    blinding: F,
    txid: F,
}

impl Circuit<F> for MinValueCircuit {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self {
        Self { value: 0, min: 0, blinding: F::ZERO, txid: self.txid }
    }

    fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
        let q_min = meta.selector();
        let q_bit = meta.selector();
        let q_commit = meta.selector();
        let value = meta.advice_column();
        let diff = meta.advice_column();
        let bit = meta.advice_column();
        let running = meta.advice_column();
        let min_col = meta.advice_column();
        let blinding = meta.advice_column();
        let commitment = meta.advice_column();
        let txid = meta.advice_column();
        let claim_instance = meta.instance_column();
        let commit_instance = meta.instance_column();
        let txid_instance = meta.instance_column();

        for c in [value, diff, bit, running, min_col, blinding, commitment, txid] {
            meta.enable_equality(c);
        }
        meta.enable_equality(claim_instance);
        meta.enable_equality(commit_instance);
        meta.enable_equality(txid_instance);

        meta.create_gate("value = min + diff", |meta| {
            let q = meta.query_selector(q_min);
            let v = meta.query_advice(value, Rotation::cur());
            let d = meta.query_advice(diff, Rotation::cur());
            let m = meta.query_advice(min_col, Rotation::cur());
            vec![q * (v - (m + d))]
        });

        meta.create_gate("bit is boolean", |meta| {
            let q = meta.query_selector(q_bit);
            let b = meta.query_advice(bit, Rotation::cur());
            vec![q * b.clone() * (b - Expression::Constant(F::ONE))]
        });

        meta.create_gate("commitment opens", |meta| {
            let q = meta.query_selector(q_commit);
            let v = meta.query_advice(value, Rotation::cur());
            let b = meta.query_advice(blinding, Rotation::cur());
            let c = meta.query_advice(commitment, Rotation::cur());
            vec![q * (c - (v + b))]
        });

        Config { q_min, q_bit, q_commit, value, diff, bit, running, min_col, blinding, commitment, txid, claim_instance, commit_instance, txid_instance }
    }

    fn synthesize(&self, config: Self::Config, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        let diff = self.value - self.min;
        let c_val = F::from(self.value) + self.blinding;
        let (min_cell, commit_cell, txid_cell) = layouter.assign_region(|| "minvalue", |mut region| {
            config.q_min.enable(&mut region, 0)?;
            config.q_commit.enable(&mut region, 0)?;
            region.assign_advice(|| "value", config.value, 0, || Value::known(F::from(self.value)))?;
            let dc = region.assign_advice(|| "diff", config.diff, 0, || Value::known(F::from(diff)))?;
            let mc = region.assign_advice(|| "min", config.min_col, 0, || Value::known(F::from(self.min)))?;
            region.assign_advice(|| "blind", config.blinding, 0, || Value::known(self.blinding))?;
            let cc = region.assign_advice(|| "commit", config.commitment, 0, || Value::known(c_val))?;

            let mut run = F::ZERO;
            region.assign_advice(|| "run0", config.running, 0, || Value::known(F::ZERO))?;
            for i in 0..DIFF_BITS {
                config.q_bit.enable(&mut region, i + 1)?;
                let bit = ((diff >> i) & 1) as u64;
                let bit_fe = F::from(bit);
                region.assign_advice(|| format!("b{}", i), config.bit, i + 1, || Value::known(bit_fe))?;
                run = run + bit_fe * F::from(1u64 << i);
                region.assign_advice(|| format!("r{}", i), config.running, i + 1, || Value::known(run))?;
            }
            let final_run = region.assign_advice(|| "final", config.running, DIFF_BITS + 1, || Value::known(run))?;
            region.constrain_equal(dc.cell(), final_run.cell())?;

            let tc = region.assign_advice(|| "txid", config.txid, 0, || Value::known(self.txid))?;
            Ok((mc, cc, tc))
        })?;
        layouter.constrain_instance(min_cell.cell(), config.claim_instance, 0)?;
        layouter.constrain_instance(commit_cell.cell(), config.commit_instance, 0)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use halo2_proofs::dev::MockProver;

    #[test]
    fn minvalue_opens_commitment() {
        let txid = txid_to_fe("51c6daaf0aba583cfcfed9a928a53d22e5f5f7c3f97db71935a0b6d4387d02b8");
        let blinding = F::from(42u64);
        let value = 5_000_000_000u64;
        let min = 1_000_000_000u64;
        let commitment = F::from(value) + blinding;
        let circuit = MinValueCircuit { value, min, blinding, txid };
        MockProver::run(8, &circuit, vec![vec![F::from(min)], vec![commitment], vec![txid]])
            .unwrap()
            .assert_satisfied();
    }
}
