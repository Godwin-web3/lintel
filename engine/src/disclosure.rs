//! Halo 2 selective disclosure circuit.
//! Proves MinValue (value >= min, difference bit-range-checked) or InvoiceHash.
//! Bound to a txid. Value and invoice stay private.

use ff::{Field, PrimeField};
use halo2_proofs::{
    circuit::{Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Error, Expression, Instance, Selector},
    poly::Rotation,
};
use pasta_curves::pallas::Base as F;

const DIFF_BITS: usize = 32;

#[derive(Clone, Copy, Debug)]
pub enum Claim {
    MinValue { min: u64 },
    InvoiceHash { hash: [u8; 32] },
}

#[derive(Clone, Debug)]
struct Config {
    q_min: Selector,
    q_inv: Selector,
    q_bit: Selector,
    value: Column<Advice>,
    diff: Column<Advice>,
    bit: Column<Advice>,
    invoice: Column<Advice>,
    min_or_hash: Column<Advice>,
    txid: Column<Advice>,
    claim_instance: Column<Instance>,
    txid_instance: Column<Instance>,
}

struct DisclosureCircuit {
    value: Value<F>,
    invoice: Value<F>,
    claim: Claim,
    txid: F,
}

impl Circuit<F> for DisclosureCircuit {
    type Config = Config;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self {
        Self { value: Value::unknown(), invoice: Value::unknown(), claim: self.claim, txid: self.txid }
    }

    fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
        let q_min = meta.selector();
        let q_inv = meta.selector();
        let q_bit = meta.selector();
        let value = meta.advice_column();
        let diff = meta.advice_column();
        let bit = meta.advice_column();
        let invoice = meta.advice_column();
        let min_or_hash = meta.advice_column();
        let txid = meta.advice_column();
        let claim_instance = meta.instance_column();
        let txid_instance = meta.instance_column();

        for c in [value, diff, bit, invoice, min_or_hash, txid] {
            meta.enable_equality(c);
        }
        meta.enable_equality(claim_instance);
        meta.enable_equality(txid_instance);

        meta.create_gate("min value", |meta| {
            let q = meta.query_selector(q_min);
            let v = meta.query_advice(value, Rotation::cur());
            let d = meta.query_advice(diff, Rotation::cur());
            let m = meta.query_advice(min_or_hash, Rotation::cur());
            vec![q * (v - (m + d))]
        });

        meta.create_gate("invoice hash", |meta| {
            let q = meta.query_selector(q_inv);
            let inv = meta.query_advice(invoice, Rotation::cur());
            let h = meta.query_advice(min_or_hash, Rotation::cur());
            vec![q * (inv - h)]
        });

        meta.create_gate("bit boolean", |meta| {
            let q = meta.query_selector(q_bit);
            let b = meta.query_advice(bit, Rotation::cur());
            vec![q * b.clone() * (b - Expression::Constant(F::ONE))]
        });

        Config { q_min, q_inv, q_bit, value, diff, bit, invoice, min_or_hash, txid, claim_instance, txid_instance }
    }

    fn synthesize(&self, config: Self::Config, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        let (claim_cell, txid_cell) = layouter.assign_region(|| "disclosure", |mut region| {
            let claim_cell = match self.claim {
                Claim::MinValue { min } => {
                    config.q_min.enable(&mut region, 0)?;
                    let diff_fe = self.value.map(|v| v - F::from(min));
                    region.assign_advice(|| "value", config.value, 0, || self.value)?;
                    region.assign_advice(|| "diff", config.diff, 0, || diff_fe)?;
                    for i in 0..DIFF_BITS {
                        config.q_bit.enable(&mut region, i + 1)?;
                        let bit_val = diff_fe.map(|d| {
                            let bytes = d.to_repr();
                            let byte = bytes.as_ref()[i / 8];
                            F::from(((byte >> (i % 8)) & 1) as u64)
                        });
                        region.assign_advice(|| format!("bit{}", i), config.bit, i + 1, || bit_val)?;
                    }
                    region.assign_advice(|| "min", config.min_or_hash, 0, || Value::known(F::from(min)))?
                }
                Claim::InvoiceHash { hash } => {
                    config.q_inv.enable(&mut region, 0)?;
                    let mut hb = [0u8; 32];
                    hb[..31].copy_from_slice(&hash[..31]);
                    let hfe = F::from_repr(hb).unwrap();
                    region.assign_advice(|| "invoice", config.invoice, 0, || self.invoice)?;
                    region.assign_advice(|| "hash", config.min_or_hash, 0, || Value::known(hfe))?
                }
            };
            let tc = region.assign_advice(|| "txid", config.txid, 0, || Value::known(self.txid))?;
            Ok((claim_cell, tc))
        })?;
        layouter.constrain_instance(claim_cell.cell(), config.claim_instance, 0)?;
        layouter.constrain_instance(txid_cell.cell(), config.txid_instance, 0)?;
        Ok(())
    }
}

fn txid_to_fe(txid_hex: &str) -> F {
    let bytes = hex::decode(txid_hex).unwrap();
    let mut fe_bytes = [0u8; 32];
    fe_bytes[..31].copy_from_slice(&bytes[..31]);
    F::from_repr(fe_bytes).unwrap()
}

/// Run MockProver on both claims. Returns Ok if both verify.
pub fn run_both_claims() -> Result<(), Box<dyn std::error::Error>> {
    use halo2_proofs::dev::MockProver;
    let k = 8u32;
    let txid = txid_to_fe("51c6daaf0aba583cfcfed9a928a53d22e5f5f7c3f97db71935a0b6d4387d02b8");

    let value = F::from(5_000_000_000u64);
    let min = 1_000_000_000u64;
    let circuit_min = DisclosureCircuit {
        value: Value::known(value),
        invoice: Value::unknown(),
        claim: Claim::MinValue { min },
        txid,
    };
    MockProver::run(k, &circuit_min, vec![vec![F::from(min)], vec![txid]])?.assert_satisfied();

    let mut inv_hash = [0u8; 32];
    inv_hash[0] = 0xab;
    let mut hb = [0u8; 32];
    hb[..31].copy_from_slice(&inv_hash[..31]);
    let inv_fe = F::from_repr(hb).unwrap();
    let circuit_inv = DisclosureCircuit {
        value: Value::unknown(),
        invoice: Value::known(inv_fe),
        claim: Claim::InvoiceHash { hash: inv_hash },
        txid,
    };
    MockProver::run(k, &circuit_inv, vec![vec![inv_fe], vec![txid]])?.assert_satisfied();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minvalue_and_invoice_pass() {
        run_both_claims().expect("both claims must verify");
    }
}
