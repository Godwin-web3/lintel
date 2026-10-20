// Prints the pinned digest and writes the parameter file the browser downloads.
use lintel::sealed::{prove, CHUNKS};
fn main() {
    let path = std::env::args().nth(1).unwrap_or("params.bin".into());
    if let Some(dir) = std::path::Path::new(&path).parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).expect("create output directory");
        }
    }
    let b = prove::params_bytes::<CHUNKS>();
    std::fs::write(&path, &b).expect("write params file");
    println!("{} {}", b.len(), hex::encode(prove::params_digest(&b)));
}
