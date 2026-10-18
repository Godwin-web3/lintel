use lintel::protocol::{Seller, Buyer, extract_t};
use pasta_curves::pallas::Scalar;
use ff::PrimeField;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || args[1] != "demo" {
        eprintln!("Usage: lintel-cli demo");
        std::process::exit(1);
    }
    let mut seller = Seller::new();
    let buyer = Buyer::new();
    let session = b"demo-session";
    let sighash = b"demo-sighash";
    let alpha = Scalar::from(3u64);

    let r_a = seller.new_nonce();
    let partial = buyer.partial(r_a, seller.vk_a, alpha, sighash);
    let pok_b = buyer.prove_knowledge(seller.vk_a, session);
    let pre = seller.pre_sign(buyer.vk_b, &partial, sighash, session, &pok_b, alpha).unwrap();
    let ok_pre = buyer.verify_presig(&pre, r_a, seller.vk_a, alpha);
    let sig = buyer.complete(&pre, &partial).unwrap();
    let ok_sig = buyer.verify_completed(&pre, &sig);
    let s = Scalar::from_repr(sig[32..].try_into().unwrap()).unwrap();
    let s_a = Scalar::from_repr(hex::decode(&pre.s_a_hex).unwrap().try_into().unwrap()).unwrap();
    let ok_extract = extract_t(s, s_a, partial.s_b) == buyer.t;

    println!("{{\"presig_ok\":{},\"completed_ok\":{},\"extracted_ok\":{}}}", ok_pre, ok_sig, ok_extract);
}
