//! Prints a digest of the v3 part verifying keys (hash-only), used to pin
//! that adding predicates leaves the hash-only circuit unchanged.
use lintel::sealed_big::prove;
fn d<const N: usize>() -> String {
    let k = prove::setup::<N>().unwrap();
    let s = format!("{:?}", k.vk.pinned());
    hex::encode(blake2b_simd::Params::new().hash_length(32).hash(s.as_bytes()).as_bytes())
}
fn main() { println!("8 {}", d::<8>()); println!("768 {}", d::<768>()); }
