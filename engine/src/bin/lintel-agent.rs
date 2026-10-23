//! lintel-agent: finishes your on-chain sales while the Lintel app is closed.
//!
//! In the app, "Hand off to agent" on one of your listings downloads a handoff
//! file. Import it here, run the agent, and close the browser: the agent binds
//! the escrow key, co-signs the buyer's time-locked refund, builds the
//! settlement once the escrow is funded, signs, and broadcasts it (which is
//! what reveals the key to the buyer). Payouts go to your app wallet's
//! address; the agent never holds a wallet spending key.
//!
//! The handoff file and the agent directory hold SECRET material (the
//! listing's signing share and adaptor secret). Anyone who has them can
//! complete the sale. Keep them on a machine you control.
//!
//! Chain data comes straight from lightwalletd (LINTEL_LWD, default
//! https://testnet.zec.rocks:443), not through the relay.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, ensure, Context, Result};
use lintel::agent::{self, AgentListing, Handoff, Status};
use lintel::lwd::Lwd;
use serde_json::{json, Value};

const USAGE: &str = "lintel-agent <command> [options]
  import <handoff.json> [--dir DIR] [--force]   check a handoff file against the relay and store it
  run [--dir DIR] [--interval SECS] [--once]     advance every stored listing until stopped
  status [--dir DIR]                             show each stored listing's stage
  remove <listing-id> [--dir DIR]                stop handling a listing (deletes its secrets here)

DIR defaults to $LINTEL_AGENT_DIR, else ~/.lintel-agent. SECRET: keep it private.";

// ---------------------------------------------------------------- relay over HTTP

/// `token`: the listing's seller token. Sent on reads too: the relay returns
/// the full session record (partial, pre-signature, chain fields) only to the
/// session's buyer and seller, and a redacted status view to anyone else.
struct HttpRelay { base: String, http: reqwest::Client, token: String }

impl HttpRelay {
    fn new(base: &str, token: &str) -> Result<Self> {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?;
        Ok(Self { base: base.trim_end_matches('/').to_string(), http, token: token.to_string() })
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>, token: Option<&str>) -> Result<Value> {
        let mut rq = self.http.request(method, format!("{}{}", self.base, path));
        if let Some(t) = token { rq = rq.bearer_auth(t); }
        if let Some(b) = body { rq = rq.json(&b); }
        let res = rq.send().await.with_context(|| format!("relay {path}"))?;
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            bail!("relay {path}: {}", v.get("error").and_then(Value::as_str).map(String::from).unwrap_or_else(|| status.to_string()));
        }
        Ok(v)
    }
}

impl agent::Relay for HttpRelay {
    async fn listing(&self, lid: &str) -> Result<(Value, Value)> {
        let v = self.call(reqwest::Method::GET, &format!("/listings/{lid}"), None, Some(&self.token)).await?;
        Ok((v["listing"].clone(), v["session"].clone()))
    }
    async fn post_chain(&self, sid: &str, field: &str, value: &str, token: &str) -> Result<()> {
        self.call(reqwest::Method::POST, &format!("/sessions/{sid}/chain/{field}"), Some(json!({ "value": value })), Some(token)).await.map(|_| ())
    }
    async fn post_partial(&self, sid: &str, partial: &str, pok: &str, token: &str) -> Result<()> {
        self.call(reqwest::Method::POST, &format!("/sessions/{sid}/partial"), Some(json!({ "partial": partial, "merchant_pok": pok })), Some(token)).await.map(|_| ())
    }
}

// ---------------------------------------------------------------- chain over lightwalletd

struct LwdChain(Lwd);

impl agent::Chain for LwdChain {
    async fn height(&self) -> Result<u32> { self.0.latest().await }
    async fn mined(&self, txid: &str) -> Result<Option<(Vec<u8>, u32)>> {
        // An unknown txid is an error from lightwalletd: treat it as "not yet".
        Ok(match self.0.tx(txid).await {
            Ok(r) if r.height > 0 && r.height < u32::MAX as u64 => Some((r.data, r.height as u32)),
            _ => None,
        })
    }
    async fn known(&self, txid: &str) -> Result<bool> { Ok(self.0.tx(txid).await.is_ok()) }
    async fn finalize(&self, p: pczt::Pczt, note_height: u32, cmx: &[u8; 32], action_index: usize) -> Result<(Vec<u8>, String)> {
        self.0.finalize(p, note_height, cmx, action_index).await
    }
    async fn send(&self, raw: Vec<u8>) -> Result<()> {
        let r = self.0.send(raw).await?;
        ensure!(r.error_code == 0, "{} (code {})", r.error_message, r.error_code);
        Ok(())
    }
}

// ---------------------------------------------------------------- storage

fn default_dir() -> PathBuf {
    if let Ok(d) = std::env::var("LINTEL_AGENT_DIR") { return d.into(); }
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".lintel-agent")
}

fn ensure_dir(d: &Path) -> Result<()> {
    fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(d, fs::Permissions::from_mode(0o700))?; }
    Ok(())
}

/// Writes a secret file atomically (temp file + rename), owner-only on Unix.
fn write_secret(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut o = fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
        let mut f = o.open(&tmp).with_context(|| format!("write {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

fn listing_path(dir: &Path, lid: &str) -> Result<PathBuf> {
    ensure!(!lid.is_empty() && lid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "bad listing id");
    Ok(dir.join(format!("{lid}.json")))
}

fn save(dir: &Path, l: &AgentListing) -> Result<()> {
    write_secret(&listing_path(dir, &l.listing_id)?, serde_json::to_string_pretty(l)?.as_bytes())
}

fn load_all(dir: &Path) -> Result<Vec<AgentListing>> {
    let mut out = Vec::new();
    if !dir.exists() { return Ok(out); }
    let mut paths: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    paths.sort();
    for p in paths {
        let l: AgentListing = serde_json::from_slice(&fs::read(&p)?).with_context(|| format!("parse {}", p.display()))?;
        out.push(l);
    }
    Ok(out)
}

/// One agent per directory: two would race on the same write-once fields.
struct DirLock(PathBuf);
impl DirLock {
    fn take(dir: &Path) -> Result<Self> {
        let p = dir.join("agent.lock");
        match fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => { writeln!(f, "{}", std::process::id())?; Ok(Self(p)) }
            Err(_) => bail!("another lintel-agent seems to be running on {} (remove {} if it is not)", dir.display(), p.display()),
        }
    }
}
impl Drop for DirLock { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }

// ---------------------------------------------------------------- commands

struct Args(Vec<String>);
impl Args {
    fn get(&self, k: &str) -> Option<String> { self.0.iter().position(|a| a == k).and_then(|i| self.0.get(i + 1).cloned()) }
    fn has(&self, k: &str) -> bool { self.0.iter().any(|a| a == k) }
    fn dir(&self) -> PathBuf { self.get("--dir").map(PathBuf::from).unwrap_or_else(default_dir) }
}

fn log(lid: &str, msg: &str) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("[{secs}] {lid}: {msg}");
}

fn stage(l: &AgentListing) -> &'static str {
    let c = &l.chain;
    if c.sold_height.is_some() { "sold" }
    else if c.settle_txid.is_some() { "settlement broadcast" }
    else if c.settle_pczt.is_some() { "settlement built" }
    else if c.e.is_some() { "refund co-signed" }
    else if c.joint.is_some() { "escrow key bound" }
    else { "waiting for a buyer" }
}

async fn import(a: &Args) -> Result<()> {
    let file = a.0.get(1).filter(|s| !s.starts_with("--")).ok_or_else(|| anyhow!("usage: lintel-agent import <handoff.json>"))?;
    let h: Handoff = serde_json::from_slice(&fs::read(file).with_context(|| format!("read {file}"))?).context("parse handoff")?;
    let l = h.into_listing()?;
    let dir = a.dir();
    ensure_dir(&dir)?;
    let path = listing_path(&dir, &l.listing_id)?;
    ensure!(a.has("--force") || !path.exists(), "{} is already imported (use --force to replace it)", l.listing_id);
    let relay = HttpRelay::new(&l.relay, &l.token)?;
    let (listing, session) = agent::Relay::listing(&relay, &l.listing_id).await?;
    agent::check_listing_matches(&l, &listing)?;
    ensure!(listing["status"].as_str() != Some("sold"), "listing is already sold");
    save(&dir, &l)?;
    let state = if session.is_null() { "no buyer yet".to_string() } else { format!("buyer session {}", session["id"].as_str().unwrap_or("?")) };
    println!("{}", serde_json::to_string_pretty(&json!({
        "imported": l.listing_id, "title": l.title, "relay": l.relay, "payout_address": l.payout_address,
        "stage": stage(&l), "relay_state": state, "stored_in": path,
    }))?);
    eprintln!("You can delete {file} now; the agent keeps its own copy.");
    Ok(())
}

async fn run(a: &Args) -> Result<()> {
    let dir = a.dir();
    ensure_dir(&dir)?;
    let _lock = DirLock::take(&dir)?;
    let interval = a.get("--interval").map(|s| s.parse::<u64>()).transpose()?.unwrap_or(10).max(2);
    let once = a.has("--once");
    let lwd = LwdChain(Lwd::connect().await?);
    println!("lintel-agent: watching {} (every {interval}s)", dir.display());
    loop {
        let listings = load_all(&dir)?;
        if listings.is_empty() { println!("no listings imported yet; run `lintel-agent import <handoff.json>`"); }
        for mut l in listings {
            if l.chain.sold_height.is_some() { continue; }
            let relay = match HttpRelay::new(&l.relay, &l.token) { Ok(r) => r, Err(e) => { log(&l.listing_id, &format!("error: {e:#}")); continue } };
            // Up to a few steps per tick, so a sale moves as fast as both sides allow.
            for _ in 0..4 {
                let mut persist = |x: &AgentListing| save(&dir, x);
                match agent::advance(&mut l, &relay, &lwd, &mut persist).await {
                    Ok(Status::Acted(m)) => { log(&l.listing_id, &m); continue }
                    Ok(Status::Sold(h)) => { log(&l.listing_id, &format!("SOLD: settlement mined at block {h}")); break }
                    Ok(Status::Waiting(m)) => { if once { log(&l.listing_id, &m) } break }
                    Err(e) => { log(&l.listing_id, &format!("error: {e:#}")); break }
                }
            }
        }
        if once { return Ok(()); }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
            _ = tokio::signal::ctrl_c() => { println!("stopping"); return Ok(()); }
        }
    }
}

fn status(a: &Args) -> Result<()> {
    let rows: Vec<Value> = load_all(&a.dir())?.iter().map(|l| json!({
        "listing": l.listing_id, "title": l.title, "stage": stage(l), "session": l.chain.sid,
        "claim_window_ends": l.chain.e, "settle_txid": l.chain.settle_txid, "sold_height": l.chain.sold_height,
    })).collect();
    println!("{}", serde_json::to_string_pretty(&rows)?);
    Ok(())
}

fn remove(a: &Args) -> Result<()> {
    let lid = a.0.get(1).filter(|s| !s.starts_with("--")).ok_or_else(|| anyhow!("usage: lintel-agent remove <listing-id>"))?;
    let path = listing_path(&a.dir(), lid)?;
    ensure!(path.exists(), "{lid} is not imported");
    let l: AgentListing = serde_json::from_slice(&fs::read(&path)?)?;
    if l.chain.e.is_some() && l.chain.sold_height.is_none() {
        eprintln!("warning: a buyer has funded or is funding an escrow for this listing. Take it back in the app before the claim window ends (block {}), or the buyer will refund.", l.chain.e.unwrap());
    }
    fs::remove_file(&path)?;
    println!("removed {lid}");
    Ok(())
}

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let a = Args(argv);
    let r = match a.0.first().map(String::as_str) {
        Some("import") => import(&a).await,
        Some("run") => run(&a).await,
        Some("status") => status(&a),
        Some("remove") => remove(&a),
        _ => { eprintln!("{USAGE}"); std::process::exit(2) }
    };
    if let Err(e) = r { eprintln!("error: {e:#}"); std::process::exit(1); }
}
