//! Live testnet sale against `lintel-agent`, with the seller's app closed.
//!
//! Two separate commands, run as separate processes:
//!
//!   live_agent_sale <dir> seller <relay-url>
//!       Seals a payload, publishes a single-copy on-chain listing to the relay
//!       (the same POST /listings body the app sends), writes the handoff file
//!       exactly as the app's "Hand off to agent" button does, and EXITS. From
//!       here on only `lintel-agent import` + `lintel-agent run` act for the
//!       seller.
//!
//!   live_agent_sale <dir> buyer <relay-url>
//!       The buyer, step for step as `advanceBuyer` in web/app/src/onchain.js
//!       (and the scripted buyer in tests/agent.rs), over the relay's HTTP API
//!       and a real lightwalletd: verifies the offer proof, opens a chain-mode
//!       session, key proof, builds + proves the funding (not broadcast) and the
//!       time-locked refund, has the refund co-signed, keeps it, broadcasts the
//!       funding, checks the seller's settlement against its own terms,
//!       pre-signs, then reads the MINED settlement, extracts `t`, decrypts and
//!       checks the content hash. Writes `evidence-agent-sale.json`.
//!
//! <dir> must hold `payer-wallet.json` (`lintel-chain wallet`) and
//! `payer-source-note.json` (`lintel-chain scan --wallet ...`) for a funded
//! Ironwood note covering price + 20,000 + 20,000 (lock coin) + 15,000 zats.
//! Files named *.SECRET.json hold keys: never commit them.
//!
//! Nothing secret (shares, t, plaintext) is printed. The seller command keeps
//! the payload in `<dir>/payload.SECRET.txt` only so the buyer run can also
//! compare bytes (the primary check is the listing's content hash).

use std::fs;
use std::time::Duration;

use anyhow::{anyhow, bail, ensure, Context, Result};
use ff::PrimeField;
use group::GroupEncoding;
use lintel::agent::{self, MerchantState, SETTLE_FEE};
use lintel::chain::{self, NoteRecord, RefundLock, SpendTerms, TransparentKey, TransparentOut};
use lintel::lwd::Lwd;
use lintel::protocol::{self, parse_scalar, Seller as Payer};
use lintel::sealed;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use serde_json::{json, Value};

const PRICE_ZEC: &str = "0.02";
const LOCK_VALUE: u64 = chain::LOCK_UTXO_VALUE; // 20,000, same as onchain.js
const CLAIM_BLOCKS: u32 = 60; // same as onchain.js
const POLL: Duration = Duration::from_secs(5);
const STEP_TIMEOUT_SECS: u64 = 1800;

fn log(step: &str, v: Value) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!("[{secs}] [{step}] {v}");
}
fn pt_hex(p: &pasta_curves::pallas::Point) -> String { hex::encode(p.to_bytes()) }
fn sc_hex(s: &pasta_curves::pallas::Scalar) -> String { hex::encode(s.to_repr()) }

// ---------------------------------------------------------------- relay over HTTP

struct Relay { base: String, http: reqwest::Client }
impl Relay {
    fn new(base: &str) -> Result<Self> {
        Ok(Self { base: base.trim_end_matches('/').into(), http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build()? })
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>, token: Option<&str>) -> Result<Value> {
        let mut rq = self.http.request(method, format!("{}{}", self.base, path));
        if let Some(t) = token { rq = rq.bearer_auth(t); }
        if let Some(b) = body { rq = rq.json(&b); }
        let res = rq.send().await.with_context(|| format!("relay {path}"))?;
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        ensure!(status.is_success(), "relay {path}: {} {}", status, v["error"]);
        Ok(v)
    }
    async fn get(&self, path: &str) -> Result<Value> { self.call(reqwest::Method::GET, path, None, None).await }
    async fn post(&self, path: &str, body: Value, token: Option<&str>) -> Result<Value> { self.call(reqwest::Method::POST, path, Some(body), token).await }
}

// ---------------------------------------------------------------- seller (one shot, then exits)

async fn seller(dir: &str, relay_url: &str) -> Result<()> {
    let relay = Relay::new(relay_url)?;
    let payload = format!("Lintel live agent sale: sealed finding #{} (seller app closed; lintel-agent settled this)", hex::encode(rand::random::<[u8; 4]>()));
    let keys = sealed::prove::setup::<{ sealed::CHUNKS }>().map_err(|e| anyhow!("{e:?}"))?;
    // Same as the wasm `Merchant::new` + `seal` the app runs.
    let (t, s) = sealed::new_secret();
    let m = protocol::Buyer::with_secret(t);
    let offer = sealed::seal::<{ sealed::CHUNKS }>(&keys, s, payload.as_bytes()).map_err(|e| anyhow!(e))?;
    let content_hash = sealed::field_hex(&sealed::content_hash_bytes::<{ sealed::CHUNKS }>(payload.as_bytes()).unwrap());
    ensure!(sealed::verify_offer(&keys, &offer, &m.t_point(), offer.content_hash), "own offer does not verify");
    let state = MerchantState { sk_b: sc_hex(&m.sk_b), secret: sealed::field_hex(&s), negated: false };

    // Payout wallet (the app uses its device wallet's address).
    let payout_sk = loop {
        let b: [u8; 32] = rand::random();
        if let Some(sk) = Option::<SpendingKey>::from(SpendingKey::from_bytes(b)) { break (sk, b); }
    };
    let payout_ua = chain::encode_ua(&FullViewingKey::from(&payout_sk.0).address_at(0u32, Scope::External));
    fs::write(format!("{dir}/payout-wallet.SECRET.json"), json!({ "sk": hex::encode(payout_sk.1) }).to_string())?;

    // POST /listings: the body App.jsx `submitOnchain` sends.
    let r = relay.post("/listings", json!({
        "title": "Live agent sale (testnet)", "description": "Sold while the seller's browser was closed; lintel-agent settled it.",
        "price_zec": PRICE_ZEC, "content_hash": content_hash, "merchant_vk": pt_hex(&m.vk_b), "t_point": pt_hex(&m.t_point()),
        "offer": serde_json::to_string(&offer.to_wire())?, "size": payload.len(),
    }), None).await?;
    let listing = &r["listing"];
    let lid = listing["id"].as_str().ok_or_else(|| anyhow!("no listing id"))?.to_string();
    let token = r["seller_token"].as_str().ok_or_else(|| anyhow!("no seller token"))?;

    // The handoff file, field for field as App.jsx `handOff` writes it.
    let handoff = json!({ "kind": "lintel-agent-handoff", "v": 1, "relay": relay_url, "listing_id": lid, "title": listing["title"],
        "token": token, "state": serde_json::to_string(&state)?, "payout_address": payout_ua, "chain": Value::Null });
    fs::write(format!("{dir}/handoff.SECRET.json"), serde_json::to_string_pretty(&handoff)?)?;
    fs::write(format!("{dir}/payload.SECRET.txt"), &payload)?;
    fs::write(format!("{dir}/listing.json"), serde_json::to_string_pretty(&json!({ "listing_id": lid, "relay": relay_url,
        "payout_address": payout_ua, "content_hash": content_hash, "price_zec": PRICE_ZEC }))?)?;
    log("seller", json!({ "listing_id": lid, "content_hash": content_hash, "handoff": format!("{dir}/handoff.SECRET.json"),
        "note": "seller process exits now; only lintel-agent acts for the seller from here" }));
    Ok(())
}

// ---------------------------------------------------------------- buyer

async fn wait_for<F: Fn(&Value) -> bool>(relay: &Relay, sid: &str, what: &str, ok: F) -> Result<Value> {
    let start = std::time::Instant::now();
    loop {
        let s = relay.get(&format!("/sessions/{sid}")).await?["session"].clone();
        if ok(&s) { return Ok(s); }
        ensure!(start.elapsed().as_secs() < STEP_TIMEOUT_SECS, "timed out waiting for {what}");
        tokio::time::sleep(POLL).await;
    }
}
fn ch(s: &Value, k: &str) -> Option<String> { s["chain"][k].as_str().map(String::from) }

async fn broadcast(l: &Lwd, raw: Vec<u8>, txid: &str) -> Result<()> {
    let r = l.send(raw).await?;
    if r.error_code != 0 {
        // a lost reply / resend: fine if the node already has it
        ensure!(l.tx(txid).await.is_ok(), "broadcast of {txid} rejected: {} (code {})", r.error_message, r.error_code);
    }
    Ok(())
}

async fn buyer(dir: &str, relay_url: &str) -> Result<()> {
    let relay = Relay::new(relay_url)?;
    let rd = |f: &str| fs::read(format!("{dir}/{f}")).with_context(|| format!("read {dir}/{f}"));
    let wr = |f: &str, b: &[u8]| fs::write(format!("{dir}/{f}"), b).with_context(|| format!("write {dir}/{f}"));
    let info: Value = serde_json::from_slice(&rd("listing.json")?)?;
    let lid = info["listing_id"].as_str().unwrap().to_string();
    let l = Lwd::connect().await?;

    let w: Value = serde_json::from_slice(&rd("payer-wallet.json")?)?;
    let sk = Option::<SpendingKey>::from(SpendingKey::from_bytes(hex::decode(w["sk"].as_str().unwrap())?.try_into().unwrap())).unwrap();
    let fvk = FullViewingKey::from(&sk);
    let ua = chain::encode_ua(&fvk.address_at(0u32, Scope::External));
    let tkey = TransparentKey::random(); // fresh t-address per sale, as the app does
    wr("payer-tkey.SECRET.json", json!({ "tsk": hex::encode(tkey.to_bytes()) }).to_string().as_bytes())?;
    let mut src: NoteRecord = serde_json::from_slice(&rd("payer-source-note.json")?)?;
    if src.height == 0 { src.height = l.wait_mined(&src.txid, STEP_TIMEOUT_SECS).await?.1; }

    // ---- the listing, and its offer proof (as the app's Market page does)
    let r = relay.get(&format!("/listings/{lid}")).await?;
    let listing = r["listing"].clone();
    ensure!(r["session"].is_null() && listing["status"] == "open", "listing is not open");
    let price = agent::zats(listing["price_zec"].as_str().unwrap())?;
    let escrow_value = price + 2 * SETTLE_FEE;
    ensure!(src.value >= escrow_value + LOCK_VALUE + 15_000, "source note too small");
    let keys = sealed::prove::setup::<{ sealed::CHUNKS }>().map_err(|e| anyhow!("{e:?}"))?;
    let offer = sealed::SealedOffer::from_wire(&serde_json::from_str(listing["offer"].as_str().unwrap())?).ok_or_else(|| anyhow!("bad offer"))?;
    let t_listing = protocol::parse_point(listing["t_point"].as_str().unwrap()).ok_or_else(|| anyhow!("bad T"))?;
    let want_hash = sealed::parse_field(listing["content_hash"].as_str().unwrap()).ok_or_else(|| anyhow!("bad hash"))?;
    ensure!(sealed::verify_offer(&keys, &offer, &t_listing, want_hash), "offer proof does not verify");
    log("offer", json!({ "listing_id": lid, "proof_verified": true, "price_zats": price }));

    // ---- session (mode chain) and B1
    let mut payer = Payer::new();
    let r = relay.post(&format!("/listings/{lid}/sessions"), json!({ "payer_vk": pt_hex(&payer.vk_a), "mode": "chain" }), None).await?;
    let sid = r["session"]["id"].as_str().unwrap().to_string();
    let tok = r["buyer_token"].as_str().unwrap().to_string();
    let post = |field: &'static str, value: String| {
        let (relay, sid, tok) = (&relay, sid.clone(), tok.clone());
        async move { relay.post(&format!("/sessions/{sid}/chain/{field}"), json!({ "value": value }), Some(&tok)).await.map(|_| ()) }
    };
    let mut merchant_vk = protocol::parse_point(listing["merchant_vk"].as_str().unwrap()).ok_or_else(|| anyhow!("bad merchant vk"))?;
    let (ak, neg) = protocol::joint_ak(payer.vk_a, merchant_vk).map_err(|e| anyhow!(e))?;
    if neg { payer.negate_share(); merchant_vk = -merchant_vk; }
    let pok = payer.prove_knowledge(merchant_vk, sid.as_bytes());
    let contrib = hex::encode(rand::random::<[u8; 32]>());
    post("payer_contrib", contrib.clone()).await?;
    post("payer_address", ua.clone()).await?;
    post("payer_pok", json!({ "r_point": pt_hex(&pok.r_point), "s": sc_hex(&pok.s) }).to_string()).await?;
    log("B1", json!({ "session": sid, "shares_negated": neg, "note": "key proof + contribution posted; seller app is closed, waiting for lintel-agent" }));

    // ---- B2: the agent binds the escrow key
    let s = wait_for(&relay, &sid, "escrow address", |s| ch(s, "escrow_address").is_some() && ch(s, "merchant_contrib").is_some() && ch(s, "merchant_address").is_some()).await?;
    let joint = agent::joint(&pt_hex(&ak), sid.as_bytes(), &contrib, &ch(&s, "merchant_contrib").unwrap())?;
    let jv: Value = serde_json::from_str(&joint)?;
    ensure!(jv["escrow_address"].as_str() == ch(&s, "escrow_address").as_deref(), "seller announced a different escrow address");
    let jfvk = chain::JointKeyInfo { ak: jv["ak"].as_str().unwrap().into(), nk: jv["nk"].as_str().unwrap().into(), rivk: jv["rivk"].as_str().unwrap().into() }.fvk()?;
    let merchant_address = ch(&s, "merchant_address").unwrap();
    log("B2", json!({ "escrow_address": jv["escrow_address"], "same_escrow_both_sides": true }));

    // ---- B3: funding built + proven (NOT broadcast), time-locked refund, ask to co-sign
    let tip = l.latest().await?;
    let e = tip + CLAIM_BLOCKS;
    let fund_terms = SpendTerms { kind: "fund".into(), pay_to: jv["escrow_address"].as_str().unwrap().into(), amount: escrow_value,
        change_to: Some(ua.clone()), target_height: tip + 1, expiry_height: tip + 40, lock: None,
        t_out: Some(TransparentOut { address: tkey.address(), value: LOCK_VALUE }) };
    let src_note = src.note()?;
    let p = chain::build_spend(&fvk, &src_note, &fund_terms)?;
    let idx = chain::spend_index(&p, &fvk, &src_note)?;
    let p = chain::sign_own(p, &sk)?;
    let (fund_raw, fund_txid) = l.finalize(p, src.height, &hex::decode(&src.cmx)?.try_into().unwrap(), idx).await?;
    let found = chain::find_notes(&fund_raw, tip + 1, &jfvk)?;
    let mut escrow = NoteRecord::from_found(found.first().ok_or_else(|| anyhow!("funding does not create the escrow note"))?, &fund_txid, 0);
    ensure!(escrow.value == escrow_value, "escrow value");
    let refund_terms = SpendTerms { kind: "refund".into(), pay_to: ua.clone(), amount: chain::refund_payout(escrow_value), change_to: None,
        target_height: tip + 1, expiry_height: 0, t_out: None,
        lock: Some(RefundLock { txid: fund_txid.clone(), vout: 0, value: LOCK_VALUE, address: tkey.address(), lock_height: e }) };
    let rp = chain::build_spend(&jfvk, &escrow.note()?, &refund_terms)?;
    let r_info = chain::check_spend(&rp, &jfvk, &escrow.note()?, &refund_terms)?;
    let rp = chain::pczt_to_bytes(rp)?;
    let refund_r_a = payer.new_nonce();
    wr("fund-tx.SECRET.hex", hex::encode(&fund_raw).as_bytes())?;
    post("refund_terms", json!({ "terms": refund_terms, "settle_expiry": e, "escrow_note": escrow }).to_string()).await?;
    post("refund_pczt", agent::b64(&rp)).await?;
    post("refund_r_a", pt_hex(&refund_r_a)).await?;
    log("B3", json!({ "funding_txid_predicted": fund_txid, "claim_window_E": e, "refund_txid": r_info.txid, "tip": tip }));

    // ---- B4: complete the refund alone, keep it, THEN broadcast the funding
    let s = wait_for(&relay, &sid, "refund co-signature", |s| ch(s, "refund_partial").is_some()).await?;
    let rpj: Value = serde_json::from_str(&ch(&s, "refund_partial").unwrap())?;
    let partial = agent::partial_from(rpj["partial"].as_str().unwrap())?;
    let mpok = agent::pok_from(rpj["pok"].as_str().unwrap())?;
    let pre = payer.pre_sign(merchant_vk, &partial, &hex::decode(&r_info.sighash)?, sid.as_bytes(), &mpok, parse_scalar(&r_info.alpha).unwrap()).map_err(|e| anyhow!(e))?;
    let sig = payer.complete_refund(&pre, &partial).ok_or_else(|| anyhow!("refund completion failed"))?;
    let refund = chain::apply_signature(chain::pczt_from_bytes(&rp)?, r_info.action_index, sig)?; // reddsa-verified
    let refund = chain::sign_lock_input(refund, &tkey)?;
    wr("refund-signed.SECRET.pczt", &chain::pczt_to_bytes(refund)?)?;
    wr("refund-info.json", serde_json::to_string_pretty(&json!({ "refund_txid": r_info.txid, "action_index": r_info.action_index,
        "escrow": escrow, "lock_height": e, "funding_txid": fund_txid }))?.as_bytes())?;
    log("B4", json!({ "refund_signed_and_stored": true, "refund_valid_after": e }));
    broadcast(&l, fund_raw.clone(), &fund_txid).await?;
    post("funding_txid", fund_txid.clone()).await?;
    log("funding", json!({ "broadcast": fund_txid }));
    let (_, fund_h) = l.wait_mined(&fund_txid, STEP_TIMEOUT_SECS).await?;
    escrow.height = fund_h;
    if let Some(c) = chain::find_notes(&fund_raw, fund_h, &fvk)?.into_iter().next() {
        wr("payer-change-note.json", serde_json::to_string_pretty(&NoteRecord::from_found(&c, &fund_txid, fund_h))?.as_bytes())?;
    }
    log("funding", json!({ "mined": fund_txid, "height": fund_h }));

    // ---- B6: check the agent's settlement against OUR terms; send a nonce
    let s = wait_for(&relay, &sid, "settlement PCZT", |s| ch(s, "settle_terms").is_some() && ch(s, "settle_pczt").is_some()).await?;
    let t: Value = serde_json::from_str(&ch(&s, "settle_terms").unwrap())?;
    for (k, v) in [("kind", json!("settle")), ("pay_to", json!(merchant_address)), ("amount", json!(price)), ("change_to", json!(ua)), ("expiry_height", json!(e))] {
        ensure!(t[k] == v, "settlement terms: {k} is {}, agreed {v}: refusing to sign", t[k]);
    }
    let terms: SpendTerms = serde_json::from_value(t)?;
    let settle_pczt = agent::unb64(&ch(&s, "settle_pczt").unwrap())?;
    let s_info = chain::check_spend(&chain::pczt_from_bytes(&settle_pczt)?, &jfvk, &escrow.note()?, &terms)?;
    let settle_r_a = payer.new_nonce();
    post("settle_r_a", pt_hex(&settle_r_a)).await?;
    log("B6", json!({ "settlement_checked": true, "predicted_txid": s_info.txid, "sighash": s_info.sighash }));

    // ---- B7: pre-sign, locked to the listing's T
    let s = wait_for(&relay, &sid, "partial signature", |s| s["partial"].is_string()).await?;
    let partial = agent::partial_from(s["partial"].as_str().unwrap())?;
    ensure!(partial.t_point == t_listing, "partial is locked to a different T than the verified offer");
    let mpok = agent::pok_from(s["merchant_pok"].as_str().unwrap())?;
    let pre = payer.pre_sign(merchant_vk, &partial, &hex::decode(&s_info.sighash)?, sid.as_bytes(), &mpok, parse_scalar(&s_info.alpha).unwrap()).map_err(|e| anyhow!(e))?;
    ensure!(pre.vk_hex == s_info.rk, "joint key does not match the escrow spend rk");
    relay.post(&format!("/sessions/{sid}/presig"), json!({ "presig": serde_json::to_string(&pre)? }), Some(&tok)).await?;
    log("B7", json!({ "presigned": true }));

    // ---- B8: t from the MINED settlement
    let s = wait_for(&relay, &sid, "settlement txid", |s| ch(s, "settle_txid").is_some()).await?;
    let settle_txid = ch(&s, "settle_txid").unwrap();
    ensure!(settle_txid == s_info.txid, "seller posted a different settlement txid than the one we signed");
    log("settlement", json!({ "broadcast_by_agent": settle_txid }));
    let (raw, settle_h) = l.wait_mined(&settle_txid, STEP_TIMEOUT_SECS).await?;
    let on_chain = protocol::find_signature(&raw, &pre.r_hex, &pre.vk_hex, &pre.sighash_hex).ok_or_else(|| anyhow!("signature not found in the mined settlement"))?;
    let t_rec = protocol::extract_t(parse_scalar(&hex::encode(&on_chain[32..])).unwrap(), parse_scalar(&pre.s_a_hex).unwrap(), partial.s_b);
    let opened = sealed::open(t_rec, &offer).ok_or_else(|| anyhow!("decryption failed"))?;
    let got_hash = sealed::content_hash_bytes::<{ sealed::CHUNKS }>(&opened).ok_or_else(|| anyhow!("payload too large"))?;
    let hash_ok = got_hash == want_hash;
    let bytes_ok = rd("payload.SECRET.txt").map(|p| p == opened).ok();
    let final_session = relay.get(&format!("/sessions/{sid}")).await?["session"].clone();
    let final_listing = relay.get(&format!("/listings/{lid}")).await?["listing"].clone();

    // seller's payout, read with the payout wallet's viewing key
    let payout_received: Option<u64> = match rd("payout-wallet.SECRET.json") {
        Ok(b) => {
            let pw: Value = serde_json::from_slice(&b)?;
            let psk = Option::<SpendingKey>::from(SpendingKey::from_bytes(hex::decode(pw["sk"].as_str().unwrap())?.try_into().unwrap())).unwrap();
            Some(chain::find_notes(&raw, settle_h, &FullViewingKey::from(&psk))?.iter().map(|n| n.note.value().inner()).sum())
        }
        Err(_) => None,
    };
    let buyer_change: u64 = chain::find_notes(&raw, settle_h, &fvk)?.iter().map(|n| n.note.value().inner()).sum();
    log("B8", json!({ "settle_height": settle_h, "t_recovered_from_mined_tx": true, "content_hash_matches": hash_ok, "bytes_match": bytes_ok }));
    ensure!(hash_ok, "decrypted content does not match the listing's content hash");

    let evidence = json!({
        "network": "testnet", "branch": format!("{:08x}", u32::from(chain::branch_for(fund_h))), "pool": "Ironwood", "tx_version": "v6",
        "flow": "seller agent: seller browser closed, lintel-agent (separate process) ran the seller side; buyer = examples/live_agent_sale.rs over relay HTTP + lightwalletd",
        "relay": "local (web/relay, node server.js)", "listing_id": lid, "session_id": sid, "price_zats": price,
        "escrow_address": jv["escrow_address"], "joint_ak": pt_hex(&ak),
        "funding": { "txid": fund_txid, "height": fund_h, "escrow_value": escrow_value, "lock_coin": { "outpoint": format!("{fund_txid}:0"), "value": LOCK_VALUE } },
        "refund_presigned_before_funding": { "txid": r_info.txid, "co_signed_by": "lintel-agent", "n_lock_time": e,
            "status": "conflicts with the settlement (same escrow nullifier); never broadcast" },
        "claim_window": { "settlement_expiry_height": e, "refund_first_valid_height": e + 1 },
        "settlement": { "txid": settle_txid, "height": settle_h, "built_signed_proved_broadcast_by": "lintel-agent", "expiry_height": terms.expiry_height,
            "sighash": s_info.sighash, "rk": s_info.rk, "merchant_received": payout_received, "buyer_change": buyer_change },
        "buyer": { "offer_proof_verified": true, "t_recovered_from_mined_tx": true, "decrypted_matches_content_hash": hash_ok,
            "decrypted_bytes_match_sealed_payload": bytes_ok, "content_hash": listing["content_hash"] },
        "relay_saw_signature": !final_session["signature"].is_null(), "listing_status_after": final_listing["status"],
    });
    wr("evidence-agent-sale.json", serde_json::to_string_pretty(&evidence)?.as_bytes())?;
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (Some(dir), Some(role), Some(relay)) = (a.first(), a.get(1), a.get(2)) else {
        bail!("usage: live_agent_sale <dir> (seller|buyer) <relay-url>")
    };
    match role.as_str() {
        "seller" => seller(dir, relay).await,
        "buyer" => buyer(dir, relay).await,
        _ => bail!("role must be seller or buyer"),
    }
}
