//! Benchmarks one proven part per circuit size: keygen, prove, verify, proof
//! size and peak memory. Run one size per process so peak RSS is per size:
//!
//!   cargo run --release --example bench_parts -- 1024
//!
//! Sizes: 64 (k=13), 256 (k=14), 512 (k=15), 1024 (k=16), 2048 (k=17).
//!
//! v3 (`sealed_big`): `bench_parts big <n> <parts> <threads>`, n in 360 (k=14),
//! 768 (k=15, the shipped size), 1536 (k=16).
use lintel::sealed::{self, k_for, BYTES_PER_CHUNK};
use lintel::sealed_multi::{self, prove};
use std::time::Instant;

fn peak_rss_mb() -> f64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    s.lines().find(|l| l.starts_with("VmHWM:"))
        .and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<f64>().ok())
        .map(|kb| kb / 1024.0).unwrap_or(0.0)
}

fn run<const N: usize>() {
    let k = k_for(N);
    let t0 = Instant::now();
    let keys = prove::setup::<N>().expect("setup");
    let setup = t0.elapsed().as_secs_f64();
    let payload: Vec<u8> = (0..N * BYTES_PER_CHUNK - BYTES_PER_CHUNK).map(|i| (i * 31 + 7) as u8).collect();
    let (t, s) = sealed::new_secret();
    let t1 = Instant::now();
    let offer = sealed_multi::seal::<N>(&keys, s, &payload).expect("seal");
    let prove_s = t1.elapsed().as_secs_f64();
    assert_eq!(offer.parts.len(), 1);
    let h = sealed_multi::content_hash_bytes::<N>(&payload).unwrap();
    let tp = pasta_curves::pallas::Point::from(sealed::generator()) * t;
    let t2 = Instant::now();
    assert!(sealed_multi::verify_offer(&keys, &offer, &tp, &h));
    let verify = t2.elapsed().as_secs_f64();
    println!(
        "{{\"n\":{N},\"k\":{k},\"payload_bytes\":{},\"params_bytes\":{},\"setup_s\":{setup:.2},\"prove_s\":{prove_s:.2},\"verify_s\":{verify:.3},\"proof_bytes\":{},\"peak_rss_mb\":{:.0},\"threads\":{}}}",
        payload.len(), 64 * (1usize << k) + 100, offer.parts[0].proof.len(), peak_rss_mb(),
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
    );
}

/// v3 (rate-2 keystream, own params): `parts` parts proved `threads` at a time.
fn run_big<const N: usize>(parts: usize, threads: usize) {
    use lintel::sealed_big as big;
    let k = big::k_for(N);
    let t0 = Instant::now();
    let keys = big::prove::setup::<N>().expect("setup");
    let setup = t0.elapsed().as_secs_f64();
    let payload: Vec<u8> = (0..big::capacity(N, parts)).map(|i| (i * 31 + 7) as u8).collect();
    let (t, s) = sealed::new_secret();
    let t1 = Instant::now();
    let offer = big::seal_parallel::<N>(&keys, s, &payload, threads).expect("seal");
    let prove_s = t1.elapsed().as_secs_f64();
    assert_eq!(offer.parts.len(), parts);
    let h = big::content_hash_bytes::<N>(&payload).unwrap();
    let tp = pasta_curves::pallas::Point::from(sealed::generator()) * t;
    let t2 = Instant::now();
    assert!(big::verify_offer_parallel(&keys, &offer, &tp, &h, threads));
    let verify = t2.elapsed().as_secs_f64();
    let (_, blobs) = offer.to_manifest();
    let blob_bytes: usize = blobs.iter().map(|b| b.len()).sum();
    assert_eq!(big::open(t, &offer).unwrap(), payload);
    println!(
        "{{\"v\":3,\"n\":{N},\"k\":{k},\"parts\":{parts},\"part_threads\":{threads},\"payload_bytes\":{},\"blob_bytes\":{blob_bytes},\"setup_s\":{setup:.2},\"prove_s\":{prove_s:.2},\"verify_s\":{verify:.3},\"proof_bytes\":{},\"peak_rss_mb\":{:.0},\"cpus\":{}}}",
        payload.len(), offer.parts[0].proof.len(), peak_rss_mb(),
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
    );
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.get(1).map(|s| s.as_str()) == Some("big") {
        let n: usize = a.get(2).and_then(|v| v.parse().ok()).unwrap_or(768);
        let parts: usize = a.get(3).and_then(|v| v.parse().ok()).unwrap_or(1);
        let threads: usize = a.get(4).and_then(|v| v.parse().ok()).unwrap_or(1);
        match n {
            8 => run_big::<8>(parts, threads),
            360 => run_big::<360>(parts, threads),
            768 => run_big::<768>(parts, threads),
            1536 => run_big::<1536>(parts, threads),
            _ => panic!("big size must be one of 8, 360, 768, 1536"),
        }
        return;
    }
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(64);
    match n {
        64 => run::<64>(),
        256 => run::<256>(),
        512 => run::<512>(),
        1024 => run::<1024>(),
        2048 => run::<2048>(),
        _ => panic!("size must be one of 64, 256, 512, 1024, 2048"),
    }
}
