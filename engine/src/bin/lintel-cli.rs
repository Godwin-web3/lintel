use lintel::protocol::{Seller, Buyer};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || args[1] != "demo" {
        eprintln!("Usage: lintel-cli demo");
        eprintln!("Runs a two-party create/complete and verifies the result.");
        std::process::exit(1);
    }
    let seller = Seller::new();
    let buyer = Buyer::new();
    let sighash = b"example-sighash";
    let pre = seller.pre_sign(buyer.vk_b, buyer.t_point(), sighash);
    let ok_pre = buyer.verify_presig(&pre);
    let sig = buyer.complete(&pre);
    let ok_sig = buyer.verify_completed(&pre, &sig);
    println!(
        "{{\"presig_ok\":{},\"completed_ok\":{},\"r_prime\":\"{}\"}}",
        ok_pre, ok_sig, &pre.r_prime_hex[..16]
    );
}
