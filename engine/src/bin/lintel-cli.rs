use lintel::protocol::{extract_t, parse_scalar, Buyer, Seller};
use pasta_curves::pallas::Scalar;
use ff::PrimeField;
use lintel::sealed::{self, CHUNKS};
use std::time::Instant;

/// Pay-to-decrypt: seal a payload under the adaptor secret, verify the offer,
/// settle, extract t, decrypt.
fn sealed_demo(payload: &[u8]) -> Result<String, &'static str> {
    let t0 = Instant::now();
    let keys = sealed::prove::setup::<CHUNKS>().map_err(|_| "setup failed")?;
    let (t, s) = sealed::new_secret();
    let holder = Buyer::with_secret(t);
    let t1 = Instant::now();
    let offer = sealed::seal::<CHUNKS>(&keys, s, payload)?;
    let prove_ms = t1.elapsed().as_millis();
    let agreed = sealed::content_hash_bytes::<CHUNKS>(payload).ok_or("payload too large")?;
    let offer_ok = sealed::verify_offer(&keys, &offer, &holder.t_point(), agreed);

    let mut payer = Seller::new();
    let (session, sighash, alpha) = (b"sale", b"sighash", Scalar::from(3u64));
    let r_a = payer.new_nonce();
    let partial = holder.partial(r_a, payer.vk_a, alpha, sighash);
    let pok = holder.prove_knowledge(payer.vk_a, session);
    let pre = payer.pre_sign(holder.vk_b, &partial, sighash, session, &pok, alpha)?;
    let sig = holder.complete(&pre, &partial).ok_or("complete failed")?;
    let paid_ok = holder.verify_completed(&pre, &sig);
    let s_final = parse_scalar(&hex::encode(&sig[32..])).ok_or("bad s")?;
    let s_a = parse_scalar(&pre.s_a_hex).ok_or("bad s_a")?;
    let opened = sealed::open(extract_t(s_final, s_a, partial.s_b), &offer).ok_or("decrypt failed")?;
    Ok(format!(
        "{{\"offer_verified\":{},\"paid_ok\":{},\"decrypted_ok\":{},\"proof_bytes\":{},\"prove_ms\":{},\"total_ms\":{}}}",
        offer_ok, paid_ok, opened == payload, offer.proof.len(), prove_ms, t0.elapsed().as_millis()
    ))
}

fn run() -> Result<(bool, bool, bool), &'static str> {
    let mut seller = Seller::new();
    let buyer = Buyer::new();
    let session = b"demo-session";
    let sighash = b"demo-sighash";
    let alpha = Scalar::from(3u64);

    let r_a = seller.new_nonce();
    let partial = buyer.partial(r_a, seller.vk_a, alpha, sighash);
    let pok_b = buyer.prove_knowledge(seller.vk_a, session);
    let pre = seller.pre_sign(buyer.vk_b, &partial, sighash, session, &pok_b, alpha)?;
    let ok_pre = buyer.verify_presig(&pre, r_a, partial.r_b, seller.vk_a, alpha);
    let sig = buyer.complete(&pre, &partial).ok_or("complete failed")?;
    let ok_sig = buyer.verify_completed(&pre, &sig);
    let mut s_bytes = [0u8; 32];
    s_bytes.copy_from_slice(&sig[32..]);
    let s = Option::<Scalar>::from(Scalar::from_repr(s_bytes)).ok_or("bad s")?;
    let s_a = parse_scalar(&pre.s_a_hex).ok_or("bad s_a")?;
    let ok_extract = extract_t(s, s_a, partial.s_b) == buyer.t;
    Ok((ok_pre, ok_sig, ok_extract))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "sealed-demo" {
        let payload = args.get(2).cloned().unwrap_or_else(|| "Critical: unchecked return in relay lets anyone mint.".into());
        match sealed_demo(payload.as_bytes()) {
            Ok(out) => println!("{out}"),
            Err(e) => { eprintln!("error: {e}"); std::process::exit(1); }
        }
        return;
    }
    if args.len() < 2 || args[1] != "demo" {
        eprintln!("Usage: lintel-cli demo | lintel-cli sealed-demo [payload]");
        std::process::exit(1);
    }
    match run() {
        Ok((a, b, c)) => println!("{{\"presig_ok\":{},\"completed_ok\":{},\"extracted_ok\":{}}}", a, b, c),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1); }
    }
}
