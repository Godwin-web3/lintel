// scratch (not committed): print a tx's transparent side and pay-in notes
use lintel::{chain, lwd::Lwd};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let l = Lwd::connect().await?;
    if a[0] == "scan" { let sk = Option::<orchard::keys::SpendingKey>::from(orchard::keys::SpendingKey::from_bytes(hex::decode(&a[3])?.try_into().unwrap())).unwrap(); return scan(&l, a[1].parse()?, a[2].parse()?, &sk).await; }
    let r = l.tx(&a[0]).await?;
    let tx = chain::parse_tx(&r.data, r.height as u32)?;
    println!("height {} txid {}", r.height, tx.txid());
    if let Some(b) = tx.transparent_bundle() {
        for i in &b.vin { println!(" vin {}:{} seq {:x}", hex::encode({ let mut h = *i.prevout().hash(); h.reverse(); h }), i.prevout().n(), i.sequence()); }
        for (k, o) in b.vout.iter().enumerate() { println!(" vout {k} {} {:?}", u64::from(o.value()), o.recipient_address()); }
    }
    println!(" ironwood actions {}", tx.ironwood_bundle().map_or(0, |b| b.actions().len()));
    if let Some(skh) = a.get(1) {
        let sk = Option::<orchard::keys::SpendingKey>::from(orchard::keys::SpendingKey::from_bytes(hex::decode(skh)?.try_into().unwrap())).unwrap();
        for n in chain::find_notes(&r.data, r.height as u32, &orchard::keys::FullViewingKey::from(&sk))? { println!(" own note {} at action {}", n.note.value().inner(), n.action_index); }
    }
    Ok(())
}
// scan mode via env SCAN=from:to
pub async fn scan(l: &Lwd, from: u32, to: u32, sk: &orchard::keys::SpendingKey) -> anyhow::Result<()> {
    let fvk = orchard::keys::FullViewingKey::from(sk);
    for (h, txid, acts) in l.compact_range(from, to).await? {
        if !lintel::payin::scan_compact(&fvk, &acts)?.is_empty() { println!("hit {h} {txid}"); }
    }
    Ok(())
}
