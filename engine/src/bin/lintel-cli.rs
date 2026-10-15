use lintel::service;
use std::io::{self, Read};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage:");
        eprintln!("  lintel-cli create <amount> <condition>");
        eprintln!("  lintel-cli complete   (reads CreateResult JSON from stdin)");
        std::process::exit(1);
    }
    match args[1].as_str() {
        "create" => {
            let amount = args.get(2).map(|s| s.as_str()).unwrap_or("1.0");
            let condition = args.get(3).map(|s| s.as_str()).unwrap_or("test");
            let result = service::create_payment(amount, condition);
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
        }
        "complete" => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input).unwrap();
            let cr: service::CreateResult = serde_json::from_str(&input).expect("invalid JSON");
            match service::complete_payment(&cr) {
                Ok(sig_hex) => {
                    println!("{{\"status\":\"completed\",\"signature_hex\":\"{}\"}}", sig_hex);
                }
                Err(e) => {
                    eprintln!("complete failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        _ => {
            eprintln!("unknown command");
            std::process::exit(1);
        }
    }
}
