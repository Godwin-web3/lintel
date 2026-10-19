use lintel::protocol::{extract_t, parse_scalar, Buyer, Seller};
use pasta_curves::pallas::Scalar;
use ff::PrimeField;

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
    if args.len() < 2 || args[1] != "demo" {
        eprintln!("Usage: lintel-cli demo");
        std::process::exit(1);
    }
    match run() {
        Ok((a, b, c)) => println!("{{\"presig_ok\":{},\"completed_ok\":{},\"extracted_ok\":{}}}", a, b, c),
        Err(e) => { eprintln!("error: {e}"); std::process::exit(1); }
    }
}
