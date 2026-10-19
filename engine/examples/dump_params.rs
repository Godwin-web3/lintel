// Prints the pinned digest and writes the parameter file the browser downloads.
use lintel::sealed::{prove, CHUNKS};
fn main() {
    let b = prove::params_bytes::<CHUNKS>();
    std::fs::write(std::env::args().nth(1).unwrap_or("params.bin".into()), &b).unwrap();
    println!("{} {}", b.len(), hex::encode(prove::params_digest(&b)));
}
