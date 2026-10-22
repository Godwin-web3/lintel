// Prints the pinned digest and writes the parameter file the browser downloads.
//
//   cargo run --release --example dump_params -- ../web/app/public/params.bin
//   cargo run --release --example dump_params -- ../web/app/public/params-big.bin big
//
// `big` writes the k = 15 file for offer v3 (`sealed_big`, payloads above
// 7,905 bytes); without it, the k = 13 file for v1/v2.
use lintel::{sealed, sealed_big};
fn main() {
    let path = std::env::args().nth(1).unwrap_or("params.bin".into());
    let big = std::env::args().nth(2).as_deref() == Some("big");
    if let Some(dir) = std::path::Path::new(&path).parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).expect("create output directory");
        }
    }
    let b = if big { sealed_big::prove::params_bytes::<{ sealed_big::CHUNKS }>() } else { sealed::prove::params_bytes::<{ sealed::CHUNKS }>() };
    std::fs::write(&path, &b).expect("write params file");
    println!("{} {}", b.len(), hex::encode(sealed::prove::params_digest(&b)));
}
