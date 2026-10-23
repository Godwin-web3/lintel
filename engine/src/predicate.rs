//! Predicates: public claims about sealed content, proven over the same
//! plaintext cells the sealing proof decrypts and hashes.
//!
//! A v3 part proof (see [`crate::sealed_big`]) shows that the part's
//! ciphertext decrypts, under the secret behind `T`, to plaintext `m` with
//! Poseidon hash `h`. A [`Predicate`] adds constraints over those **same**
//! cells `m` inside the same circuit, so the claim is about exactly the bytes
//! the buyer will decrypt, not about a copy. Each predicate is its own circuit
//! (its own verifying key); its parameters are extra public inputs appended
//! after the ciphertext, so a claim cannot be changed without the proof
//! failing.
//!
//! [`HashOnly`] adds nothing: a `PartCircuit<N, HashOnly>` is constraint for
//! constraint the circuit every existing v3 offer was proven with (the
//! verifying key digest is pinned in a test), so old offers verify unchanged.
//!
//! [`Format`] is the first real predicate. One circuit covers:
//!
//! * **length bounds**: `min <= len <= max` on the payload length (chunk 0
//!   of part 0, the length word [`crate::sealed::pack`] writes);
//! * **magic prefix**: the payload starts with given bytes;
//! * **bytes at offset**: payload bytes `[o, o + l)` equal a public value
//!   (for example a contract address in a report header).
//!
//! It runs on part 0 only, so byte claims must lie in the first
//! `(N - 1) * 31` payload bytes (23,777 at the shipped `N = 768`). Up to
//! [`WINDOWS`] byte claims of at most [`MAX_CLAIM_BYTES`] bytes each, plus
//! one length claim. Claims the seller did not make are filled with vacuous
//! parameters (length `0..2^40-1`, all-zero masks), so one verifying key
//! serves every combination.
//!
//! ## How `Format` is constrained
//!
//! * **Selection.** For each byte window the circuit selects plaintext
//!   chunks `m_w` and `m_{w+1}` for a public chunk index `w` with a
//!   one-row-per-chunk multiplexer: `eq_i = 1 - (i - w) inv_i`,
//!   `(i - w) eq_i = 0`, so `eq_i = [i == w]`, and running sums
//!   `a += eq_i m_i`, `b += eq_i m_{i+1}`. The verifier checks
//!   `w <= N - 2`, so exactly one `eq_i` is 1.
//! * **Byte decomposition.** Each selected chunk is split into 31 bytes,
//!   each range-checked to 8 bits with the existing 10-bit lookup table, and
//!   recomposed by Horner's rule (`acc' = 256 acc + b`) to equal the chunk.
//!   31 bytes are at most `2^248 - 1 < p`, so the decomposition is unique.
//! * **Byte claims.** Per byte position `q` of the 62-byte window, public
//!   `mask_q` and `value_q`, constrained `mask_q (b_q - value_q) = 0`.
//! * **Length.** `d1 = len - min`, `d2 = max - len` and
//!   `d3 = len - end` (where `end` is the largest claimed byte end, so a
//!   byte claim can never point past the real payload into zero padding)
//!   are each range-checked below `2^40`. With `max < 2^40` this gives
//!   `min <= len <= max` and `len >= end` over the integers.
//!
//! Every byte gadget lives in advice columns the Poseidon chip does not use,
//! so the circuit stays at `k = 15` with the same `params-big.bin`.

use ff::{Field, PrimeField};
use halo2_gadgets::utilities::lookup_range_check::{LookupRangeCheck, PallasLookupRangeCheckConfig};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Value},
    plonk::{Advice, Column, ConstraintSystem, Constraints, Error, Expression, Fixed, Instance, Selector},
    poly::Rotation,
};
use pasta_curves::pallas;

use crate::sealed::BYTES_PER_CHUNK;

type F = pallas::Base;

/// Columns of the part circuit a predicate may use. Advice columns 5 to 8
/// belong to the Poseidon chip; a predicate should stay in 0 to 4 and 9
/// (9 is the lookup range check's running-sum column) so its regions pack
/// beside the Poseidon rows instead of after them.
#[derive(Clone, Debug)]
pub struct Cols {
    pub advice: [Column<Advice>; 10],
    pub instance: Column<Instance>,
    pub range_check: PallasLookupRangeCheckConfig,
}

/// A claim about the plaintext of one part, proven inside the part circuit.
pub trait Predicate: Clone + std::fmt::Debug + Default + Send + Sync {
    type Config: Clone + std::fmt::Debug;
    /// Stable identifier ("" for hash only).
    const ID: &'static str;
    /// Adds the predicate's columns and gates. Called after the part circuit
    /// has configured everything it needs.
    fn configure(meta: &mut ConstraintSystem<F>, cols: &Cols) -> Self::Config;
    /// Copy with all witnesses unknown (key generation).
    fn without_witnesses(&self) -> Self;
    /// Constrains the plaintext cells `m`. Public parameters start at
    /// instance row `first_public`.
    fn synthesize(
        &self,
        config: &Self::Config,
        cols: &Cols,
        layouter: &mut impl Layouter<F>,
        m: &[AssignedCell<F, F>],
        first_public: usize,
    ) -> Result<(), Error>;
    /// The public parameters, in instance order (empty when unknown).
    fn public_inputs(&self) -> Vec<F>;
}

/// No predicate: the plain sealing circuit (content hash only).
#[derive(Clone, Debug, Default)]
pub struct HashOnly;

impl Predicate for HashOnly {
    type Config = ();
    const ID: &'static str = "";
    fn configure(_: &mut ConstraintSystem<F>, _: &Cols) -> Self::Config {}
    fn without_witnesses(&self) -> Self { HashOnly }
    fn synthesize(&self, _: &(), _: &Cols, _: &mut impl Layouter<F>, _: &[AssignedCell<F, F>], _: usize) -> Result<(), Error> { Ok(()) }
    fn public_inputs(&self) -> Vec<F> { vec![] }
}

// ---------- Format ----------

/// Byte windows (independent byte claims) per `Format` proof.
pub const WINDOWS: usize = 2;
/// Bytes one window covers: two chunks.
pub const WINDOW_BYTES: usize = 2 * BYTES_PER_CHUNK;
/// Longest single byte claim.
pub const MAX_CLAIM_BYTES: usize = 32;
/// Length bounds and byte ends must be below this (range checks are 40 bits).
pub const LEN_LIMIT: u64 = 1 << 40;
/// Public inputs `Format` appends: `min, max, end`, then per window
/// `w, mask[62], value[62]`.
pub const FORMAT_PUBLIC: usize = 3 + WINDOWS * (1 + 2 * WINDOW_BYTES);

/// One byte window: chunk index `w` (local to the part) and, per byte of
/// chunks `w` and `w + 1`, whether it is claimed and its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub chunk: u64,
    pub mask: [bool; WINDOW_BYTES],
    pub value: [u8; WINDOW_BYTES],
}

impl Window {
    pub fn unused() -> Self { Self { chunk: 0, mask: [false; WINDOW_BYTES], value: [0; WINDOW_BYTES] } }
    pub fn is_unused(&self) -> bool { self.mask.iter().all(|m| !m) }
}

/// Public parameters of a `Format` proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatParams {
    pub min_len: u64,
    pub max_len: u64,
    pub end: u64,
    pub windows: [Window; WINDOWS],
}

impl FormatParams {
    pub fn to_public(&self) -> Vec<F> {
        let mut v = vec![F::from(self.min_len), F::from(self.max_len), F::from(self.end)];
        for w in &self.windows {
            v.push(F::from(w.chunk));
            v.extend(w.mask.iter().map(|m| F::from(*m as u64)));
            v.extend(w.value.iter().map(|b| F::from(*b as u64)));
        }
        debug_assert_eq!(v.len(), FORMAT_PUBLIC);
        v
    }
}

/// Length bounds, magic prefix and bytes-at-offset over part 0 (see module docs).
#[derive(Clone, Debug, Default)]
pub struct Format { pub params: Option<FormatParams> }

#[derive(Clone, Debug)]
pub struct FormatConfig {
    idx: Column<Fixed>,
    q_mux: Selector,
    q_bytes: Selector,
    q_len: Selector,
}

fn byte_of(x: &F, k: usize) -> F { F::from(x.to_repr()[k] as u64) }

impl Predicate for Format {
    type Config = FormatConfig;
    const ID: &'static str = "format";

    fn configure(meta: &mut ConstraintSystem<F>, cols: &Cols) -> FormatConfig {
        let a = cols.advice;
        let idx = meta.fixed_column();
        let (q_mux, q_bytes, q_len) = (meta.selector(), meta.selector(), meta.selector());

        // Multiplexer, one row per chunk i: a[0] = m_i, a[1] = eq, a[2] = inv,
        // a[3] = acc_a, a[4] = acc_b, a[9] = w, fixed idx = i.
        meta.create_gate("select chunk w and w+1", |meta| {
            let q = meta.query_selector(q_mux);
            let i = meta.query_fixed(idx);
            let m = meta.query_advice(a[0], Rotation::cur());
            let m_next = meta.query_advice(a[0], Rotation::next());
            let eq = meta.query_advice(a[1], Rotation::cur());
            let inv = meta.query_advice(a[2], Rotation::cur());
            let (acc_a, acc_a2) = (meta.query_advice(a[3], Rotation::cur()), meta.query_advice(a[3], Rotation::next()));
            let (acc_b, acc_b2) = (meta.query_advice(a[4], Rotation::cur()), meta.query_advice(a[4], Rotation::next()));
            let (w, w2) = (meta.query_advice(a[9], Rotation::cur()), meta.query_advice(a[9], Rotation::next()));
            let d = i - w.clone();
            let one = Expression::Constant(F::ONE);
            Constraints::with_selector(q, [
                ("eq * d = 0", eq.clone() * d.clone()),
                ("eq = 1 - d * inv", eq.clone() - one + d * inv),
                ("acc_a", acc_a2 - acc_a - eq.clone() * m),
                ("acc_b", acc_b2 - acc_b - eq * m_next),
                ("w constant", w2 - w),
            ])
        });

        // Horner recomposition with byte claims: a[0] = acc, a[1] = byte,
        // a[2] = mask, a[3] = value.
        meta.create_gate("bytes", |meta| {
            let q = meta.query_selector(q_bytes);
            let acc = meta.query_advice(a[0], Rotation::cur());
            let prev = meta.query_advice(a[0], Rotation::prev());
            let b = meta.query_advice(a[1], Rotation::cur());
            let mask = meta.query_advice(a[2], Rotation::cur());
            let v = meta.query_advice(a[3], Rotation::cur());
            Constraints::with_selector(q, [
                ("horner", acc - prev * Expression::Constant(F::from(256u64)) - b.clone()),
                ("claim", mask * (b - v)),
            ])
        });

        // Length: row 0 a[0] = len, a[1] = min, a[2] = max, a[3] = end;
        // row 1 a[0] = d1, a[1] = d2, a[2] = d3.
        meta.create_gate("length", |meta| {
            let q = meta.query_selector(q_len);
            let len = meta.query_advice(a[0], Rotation::cur());
            let min = meta.query_advice(a[1], Rotation::cur());
            let max = meta.query_advice(a[2], Rotation::cur());
            let end = meta.query_advice(a[3], Rotation::cur());
            let d1 = meta.query_advice(a[0], Rotation::next());
            let d2 = meta.query_advice(a[1], Rotation::next());
            let d3 = meta.query_advice(a[2], Rotation::next());
            Constraints::with_selector(q, [
                ("d1 = len - min", d1 - (len.clone() - min)),
                ("d2 = max - len", d2 - (max - len.clone())),
                ("d3 = len - end", d3 - (len - end)),
            ])
        });

        FormatConfig { idx, q_mux, q_bytes, q_len }
    }

    fn without_witnesses(&self) -> Self { Format { params: None } }

    fn synthesize(
        &self,
        cfg: &FormatConfig,
        cols: &Cols,
        layouter: &mut impl Layouter<F>,
        m: &[AssignedCell<F, F>],
        first: usize,
    ) -> Result<(), Error> {
        let a = cols.advice;
        let n = m.len();
        let p = |f: &dyn Fn(&FormatParams) -> F| match &self.params {
            Some(x) => Value::known(f(x)),
            None => Value::unknown(),
        };

        // ---- length ----
        let ds = layouter.assign_region(|| "length", |mut region| {
            cfg.q_len.enable(&mut region, 0)?;
            let len = m[0].copy_advice(|| "len", &mut region, a[0], 0)?;
            let min = region.assign_advice_from_instance(|| "min", cols.instance, first, a[1], 0)?;
            let max = region.assign_advice_from_instance(|| "max", cols.instance, first + 1, a[2], 0)?;
            let end = region.assign_advice_from_instance(|| "end", cols.instance, first + 2, a[3], 0)?;
            let l = len.value().copied();
            let d1 = region.assign_advice(|| "d1", a[0], 1, || l - min.value().copied())?;
            let d2 = region.assign_advice(|| "d2", a[1], 1, || max.value().copied() - l)?;
            let d3 = region.assign_advice(|| "d3", a[2], 1, || l - end.value().copied())?;
            Ok([d1, d2, d3])
        })?;
        for (i, d) in ds.into_iter().enumerate() {
            // 4 words of 10 bits, strict: d < 2^40.
            cols.range_check.copy_check(layouter.namespace(|| format!("d{i} < 2^40")), d, 4, true)?;
        }

        // ---- byte windows ----
        for win in 0..WINDOWS {
            let base = first + 3 + win * (1 + 2 * WINDOW_BYTES);
            let w_val = p(&|x: &FormatParams| F::from(x.windows[win].chunk));
            let (x0, x1) = layouter.assign_region(|| "select window", |mut region| {
                let mut acc_a = region.assign_advice_from_constant(|| "acc_a0", a[3], 0, F::ZERO)?;
                let mut acc_b = region.assign_advice_from_constant(|| "acc_b0", a[4], 0, F::ZERO)?;
                region.assign_advice_from_instance(|| "w", cols.instance, base, a[9], 0)?;
                for (i, mi) in m.iter().enumerate() {
                    cfg.q_mux.enable(&mut region, i)?;
                    region.assign_fixed(|| "i", cfg.idx, i, || Value::known(F::from(i as u64)))?;
                    mi.copy_advice(|| "m_i", &mut region, a[0], i)?;
                    let d = w_val.map(|w| F::from(i as u64) - w);
                    let inv = d.map(|d| d.invert().unwrap_or(F::ZERO));
                    let eq = d.map(|d| if d.is_zero_vartime() { F::ONE } else { F::ZERO });
                    region.assign_advice(|| "eq", a[1], i, || eq)?;
                    region.assign_advice(|| "inv", a[2], i, || inv)?;
                    let m_next = if i + 1 < n { m[i + 1].value().copied() } else { Value::known(F::ZERO) };
                    let na = acc_a.value().copied() + eq * mi.value().copied();
                    let nb = acc_b.value().copied() + eq * m_next;
                    acc_a = region.assign_advice(|| "acc_a", a[3], i + 1, || na)?;
                    acc_b = region.assign_advice(|| "acc_b", a[4], i + 1, || nb)?;
                    region.assign_advice(|| "w", a[9], i + 1, || w_val)?;
                }
                region.assign_advice_from_constant(|| "m_n = 0", a[0], n, F::ZERO)?;
                Ok((acc_a, acc_b))
            })?;

            for (s, x) in [x0, x1].into_iter().enumerate() {
                // 31 bytes, each range-checked to 8 bits.
                let bytes = (0..BYTES_PER_CHUNK)
                    .map(|k| {
                        let v = x.value().map(|x| byte_of(x, k));
                        cols.range_check.witness_short_check(layouter.namespace(|| "byte"), v, 8)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                layouter.assign_region(|| "recompose", |mut region| {
                    let mut acc = region.assign_advice_from_constant(|| "acc0", a[0], 0, F::ZERO)?;
                    for r in 1..=BYTES_PER_CHUNK {
                        let k = BYTES_PER_CHUNK - r; // big-endian: highest byte first
                        let q = s * BYTES_PER_CHUNK + k;
                        cfg.q_bytes.enable(&mut region, r)?;
                        let b = bytes[k].copy_advice(|| "b", &mut region, a[1], r)?;
                        region.assign_advice_from_instance(|| "mask", cols.instance, base + 1 + q, a[2], r)?;
                        region.assign_advice_from_instance(|| "value", cols.instance, base + 1 + WINDOW_BYTES + q, a[3], r)?;
                        let v = acc.value().copied() * Value::known(F::from(256u64)) + b.value().copied();
                        acc = region.assign_advice(|| "acc", a[0], r, || v)?;
                    }
                    region.constrain_equal(acc.cell(), x.cell())
                })?;
            }
        }
        Ok(())
    }

    fn public_inputs(&self) -> Vec<F> { self.params.as_ref().map(|p| p.to_public()).unwrap_or_default() }
}

// ---------- claims (wire form, plain English) ----------

/// A claim as it travels in the offer manifest (`predicates`).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "id", rename_all = "snake_case", deny_unknown_fields)]
pub enum Claim {
    /// Payload length in bytes is between `min` and `max` (inclusive).
    Length { min: u64, max: u64 },
    /// Payload starts with these bytes (hex).
    Prefix { hex: String },
    /// Payload bytes at `offset` equal these bytes (hex).
    BytesAt { offset: u64, hex: String },
}

fn fmt_bytes(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 { out.push(','); }
        out.push(c);
    }
    out
}

fn show_bytes(b: &[u8]) -> String {
    let printable = !b.is_empty() && b.iter().all(|c| (0x20..0x7f).contains(c));
    if printable { String::from_utf8_lossy(b).into_owned() } else { format!("0x{}", hex::encode(b)) }
}

impl Claim {
    /// Byte claim as (offset, bytes), `None` for a length claim or bad hex.
    fn bytes(&self) -> Option<(u64, Vec<u8>)> {
        match self {
            Claim::Length { .. } => None,
            Claim::Prefix { hex: h } => Some((0, hex::decode(h).ok()?)),
            Claim::BytesAt { offset, hex: h } => Some((*offset, hex::decode(h).ok()?)),
        }
    }

    /// The claim in plain English, as the buyer sees it next to the proof.
    pub fn describe(&self) -> String {
        match self {
            Claim::Length { min, max } if min == max => format!("Length is exactly {} bytes", fmt_bytes(*min)),
            Claim::Length { min, max } => format!("Length between {} and {} bytes", fmt_bytes(*min), fmt_bytes(*max)),
            Claim::Prefix { hex: h } => match hex::decode(h) {
                Ok(b) if b.iter().all(|c| (0x20..0x7f).contains(c)) => format!("Starts with \"{}\"", show_bytes(&b)),
                Ok(b) => format!("Starts with bytes {}", show_bytes(&b)),
                Err(_) => "Malformed prefix claim".into(),
            },
            Claim::BytesAt { offset, hex: h } => match hex::decode(h) {
                Ok(b) if b.iter().all(|c| (0x20..0x7f).contains(c)) => {
                    format!("Bytes at offset {} equal \"{}\" (0x{})", fmt_bytes(*offset), show_bytes(&b), hex::encode(&b))
                }
                Ok(b) => format!("Bytes at offset {} equal {}", fmt_bytes(*offset), show_bytes(&b)),
                Err(_) => "Malformed bytes claim".into(),
            },
        }
    }

    /// Whether `payload` satisfies the claim (seller-side check before proving).
    pub fn holds(&self, payload: &[u8]) -> bool {
        match self {
            Claim::Length { min, max } => (*min..=*max).contains(&(payload.len() as u64)),
            _ => match self.bytes() {
                Some((o, b)) => {
                    let o = o as usize;
                    o.checked_add(b.len()).is_some_and(|e| e <= payload.len()) && payload[o..o + b.len()] == b[..]
                }
                None => false,
            },
        }
    }
}

/// Maps claims to the `Format` public parameters for parts of `n` chunks.
/// Deterministic: the verifier rebuilds the same parameters from the wire.
/// Rejects anything the circuit cannot prove soundly.
pub fn format_params(claims: &[Claim], n: usize) -> Result<FormatParams, &'static str> {
    if claims.is_empty() { return Err("no claims"); }
    if !(2..=1 << 16).contains(&n) { return Err("bad part size"); }
    let (mut min_len, mut max_len, mut end) = (0u64, LEN_LIMIT - 1, 0u64);
    let mut windows = [Window::unused(), Window::unused()];
    let (mut n_len, mut n_win) = (0, 0);
    let first_part = ((n - 1) * BYTES_PER_CHUNK) as u64;
    for c in claims {
        match c {
            Claim::Length { min, max } => {
                n_len += 1;
                if n_len > 1 { return Err("at most one length claim"); }
                if min > max || *max >= LEN_LIMIT { return Err("length bounds must satisfy min <= max < 2^40"); }
                (min_len, max_len) = (*min, *max);
            }
            _ => {
                let (o, b) = c.bytes().ok_or("byte claim hex is malformed")?;
                if b.is_empty() || b.len() > MAX_CLAIM_BYTES { return Err("a byte claim covers 1 to 32 bytes"); }
                if n_win >= WINDOWS { return Err("at most two byte claims"); }
                let e = o.checked_add(b.len() as u64).ok_or("offset too large")?;
                if e > first_part { return Err("byte claims must lie in the first part of the payload"); }
                let g = 1 + o as usize / BYTES_PER_CHUNK; // global chunk of the first byte (chunk 0 = length)
                let w = g.min(n - 2);
                let mut win = Window { chunk: w as u64, ..Window::unused() };
                for (t, byte) in b.iter().enumerate() {
                    let off = o as usize + t;
                    let q = (1 + off / BYTES_PER_CHUNK - w) * BYTES_PER_CHUNK + off % BYTES_PER_CHUNK;
                    if q >= WINDOW_BYTES { return Err("byte claim does not fit one window"); }
                    win.mask[q] = true;
                    win.value[q] = *byte;
                }
                windows[n_win] = win;
                n_win += 1;
                end = end.max(e);
            }
        }
    }
    Ok(FormatParams { min_len, max_len, end, windows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_wire_and_english() {
        let cs = vec![
            Claim::Prefix { hex: hex::encode(b"%PDF") },
            Claim::Length { min: 1000, max: 25_000 },
            Claim::BytesAt { offset: 40, hex: "deadbeef".into() },
        ];
        let j = serde_json::to_string(&cs).unwrap();
        assert_eq!(j, r#"[{"id":"prefix","hex":"25504446"},{"id":"length","min":1000,"max":25000},{"id":"bytes_at","offset":40,"hex":"deadbeef"}]"#);
        assert_eq!(serde_json::from_str::<Vec<Claim>>(&j).unwrap(), cs);
        assert_eq!(cs[0].describe(), "Starts with \"%PDF\"");
        assert_eq!(cs[1].describe(), "Length between 1,000 and 25,000 bytes");
        assert_eq!(cs[2].describe(), "Bytes at offset 40 equal 0xdeadbeef");
        assert!(serde_json::from_str::<Claim>(r#"{"id":"regex","hex":"00"}"#).is_err());
        assert!(serde_json::from_str::<Claim>(r#"{"id":"length","min":1,"max":2,"x":1}"#).is_err());
    }

    #[test]
    fn params_mapping() {
        const N: usize = 768;
        // Prefix: bytes 0.. sit in chunk 1, window w = 1, positions 0..4.
        let p = format_params(&[Claim::Prefix { hex: "25504446".into() }], N).unwrap();
        assert_eq!(p.windows[0].chunk, 1);
        assert_eq!(&p.windows[0].value[..4], b"%PDF");
        assert!(p.windows[0].mask[..4].iter().all(|m| *m) && !p.windows[0].mask[4]);
        assert!(p.windows[1].is_unused());
        assert_eq!((p.min_len, p.max_len, p.end), (0, LEN_LIMIT - 1, 4));
        // A 32-byte field straddling chunks 1 and 2.
        let p = format_params(&[Claim::BytesAt { offset: 20, hex: "11".repeat(32) }], N).unwrap();
        assert_eq!(p.windows[0].chunk, 1);
        assert_eq!(p.windows[0].mask.iter().filter(|m| **m).count(), 32);
        assert!(p.windows[0].mask[20] && p.windows[0].mask[51] && !p.windows[0].mask[52]);
        // Last chunk of part 0: window shifts back one chunk.
        let last = ((N - 2) * BYTES_PER_CHUNK) as u64; // first byte of chunk N-1
        let p = format_params(&[Claim::BytesAt { offset: last, hex: "ab".into() }], N).unwrap();
        assert_eq!(p.windows[0].chunk, (N - 2) as u64);
        assert!(p.windows[0].mask[BYTES_PER_CHUNK]);
        // Rejections.
        let cap = ((N - 1) * BYTES_PER_CHUNK) as u64;
        assert!(format_params(&[Claim::BytesAt { offset: cap - 1, hex: "abcd".into() }], N).is_err());
        assert!(format_params(&[Claim::BytesAt { offset: cap - 2, hex: "abcd".into() }], N).is_ok());
        assert!(format_params(&[Claim::Prefix { hex: "00".repeat(33) }], N).is_err());
        assert!(format_params(&[Claim::Prefix { hex: "zz".into() }], N).is_err());
        assert!(format_params(&[Claim::Length { min: 5, max: 4 }], N).is_err());
        assert!(format_params(&[Claim::Length { min: 0, max: LEN_LIMIT }], N).is_err());
        let b = Claim::Prefix { hex: "00".into() };
        assert!(format_params(&[b.clone(), b.clone(), b], N).is_err());
        let l = Claim::Length { min: 1, max: 2 };
        assert!(format_params(&[l.clone(), l], N).is_err());
        assert!(format_params(&[], N).is_err());
    }

    #[test]
    fn holds() {
        let data = b"%PDF-1.7 hello";
        assert!(Claim::Prefix { hex: hex::encode(b"%PDF") }.holds(data));
        assert!(!Claim::Prefix { hex: hex::encode(b"PK") }.holds(data));
        assert!(Claim::BytesAt { offset: 9, hex: hex::encode(b"hello") }.holds(data));
        assert!(!Claim::BytesAt { offset: 10, hex: hex::encode(b"hello") }.holds(data));
        assert!(Claim::Length { min: 14, max: 14 }.holds(data));
        assert!(!Claim::Length { min: 15, max: 99 }.holds(data));
    }
}
