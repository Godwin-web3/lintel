//! Minimal lightwalletd (gRPC) client for on-chain settlement: only the
//! calls Lintel needs, all public data.

use anyhow::{anyhow, ensure, Context, Result};
use tonic::transport::{Channel, ClientTlsConfig};

use crate::chain;


pub mod rpc {
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct BlockId { #[prost(uint64, tag = "1")] pub height: u64, #[prost(bytes = "vec", tag = "2")] pub hash: Vec<u8> }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct BlockRange {
        #[prost(message, optional, tag = "1")] pub start: Option<BlockId>,
        #[prost(message, optional, tag = "2")] pub end: Option<BlockId>,
        #[prost(int32, repeated, tag = "3")] pub pool_types: Vec<i32>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct TxFilter {
        #[prost(message, optional, tag = "1")] pub block: Option<BlockId>,
        #[prost(uint64, tag = "2")] pub index: u64,
        #[prost(bytes = "vec", tag = "3")] pub hash: Vec<u8>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct RawTransaction { #[prost(bytes = "vec", tag = "1")] pub data: Vec<u8>, #[prost(uint64, tag = "2")] pub height: u64 }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct SendResponse { #[prost(int32, tag = "1")] pub error_code: i32, #[prost(string, tag = "2")] pub error_message: String }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ChainSpec {}
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct TreeState {
        #[prost(string, tag = "1")] pub network: String,
        #[prost(uint64, tag = "2")] pub height: u64,
        #[prost(string, tag = "3")] pub hash: String,
        #[prost(uint32, tag = "4")] pub time: u32,
        #[prost(string, tag = "5")] pub sapling_tree: String,
        #[prost(string, tag = "6")] pub orchard_tree: String,
        #[prost(string, tag = "7")] pub ironwood_tree: String,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct CompactOrchardAction {
        #[prost(bytes = "vec", tag = "1")] pub nullifier: Vec<u8>,
        #[prost(bytes = "vec", tag = "2")] pub cmx: Vec<u8>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct CompactTx {
        #[prost(uint64, tag = "1")] pub index: u64,
        #[prost(bytes = "vec", tag = "2")] pub txid: Vec<u8>,
        #[prost(message, repeated, tag = "9")] pub ironwood_actions: Vec<CompactOrchardAction>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct CompactBlock {
        #[prost(uint64, tag = "2")] pub height: u64,
        #[prost(message, repeated, tag = "7")] pub vtx: Vec<CompactTx>,
    }
}

const SVC: &str = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/";
const POOL_IRONWOOD: i32 = 4;

pub struct Lwd { ch: Channel }

impl Lwd {
    pub async fn connect() -> Result<Self> {
        let url = std::env::var("LINTEL_LWD").unwrap_or_else(|_| "https://testnet.zec.rocks:443".into());
        let mut ep = Channel::from_shared(url.clone())?;
        if url.starts_with("https") { ep = ep.tls_config(ClientTlsConfig::new().with_webpki_roots())?; }
        Ok(Self { ch: ep.connect().await.with_context(|| format!("connect {url}"))? })
    }
    pub async fn unary<Q: prost::Message + Send + Sync + 'static, R: prost::Message + Default + Send + Sync + 'static>(&self, m: &str, q: Q) -> Result<R> {
        let mut g = tonic::client::Grpc::new(self.ch.clone());
        g.ready().await?;
        let path = http::uri::PathAndQuery::try_from(format!("{SVC}{m}"))?;
        let r = g.unary(tonic::Request::new(q), path, tonic_prost::ProstCodec::<Q, R>::default()).await
            .map_err(|s| anyhow!("{m}: {}", s.message()))?;
        Ok(r.into_inner())
    }
    pub async fn latest(&self) -> Result<u32> {
        let b: rpc::BlockId = self.unary("GetLatestBlock", rpc::ChainSpec {}).await?;
        Ok(b.height as u32)
    }
    pub async fn tx(&self, txid_hex: &str) -> Result<rpc::RawTransaction> {
        let mut h = hex::decode(txid_hex).context("txid hex")?;
        h.reverse(); // display order -> protocol order
        self.unary("GetTransaction", rpc::TxFilter { block: None, index: 0, hash: h }).await
    }
    pub async fn tree(&self, height: u32) -> Result<rpc::TreeState> {
        self.unary("GetTreeState", rpc::BlockId { height: height as u64, hash: vec![] }).await
    }
    pub async fn block_cmxs(&self, height: u32) -> Result<Vec<[u8; 32]>> {
        let mut g = tonic::client::Grpc::new(self.ch.clone());
        g.ready().await?;
        let path = http::uri::PathAndQuery::from_static("/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlockRange");
        let id = rpc::BlockId { height: height as u64, hash: vec![] };
        let q = rpc::BlockRange { start: Some(id.clone()), end: Some(id), pool_types: vec![POOL_IRONWOOD] };
        let mut s = g.server_streaming(tonic::Request::new(q), path, tonic_prost::ProstCodec::<rpc::BlockRange, rpc::CompactBlock>::default())
            .await.map_err(|s| anyhow!("GetBlockRange: {}", s.message()))?.into_inner();
        let mut out = Vec::new();
        while let Some(b) = s.message().await.map_err(|s| anyhow!("GetBlockRange: {}", s.message()))? {
            let mut vtx = b.vtx;
            vtx.sort_by_key(|t| t.index);
            for t in vtx { for a in t.ironwood_actions { out.push(a.cmx.as_slice().try_into().context("cmx length")?); } }
        }
        Ok(out)
    }
    pub async fn send(&self, raw: Vec<u8>) -> Result<rpc::SendResponse> {
        self.unary("SendTransaction", rpc::RawTransaction { data: raw, height: 0 }).await
    }

    /// Installs the anchor and Merkle witness of the note with commitment
    /// `cmx` mined at `height` (from GetTreeState(height-1) and the compact
    /// block), cross-checks the root with the node's own tree, then proves,
    /// verifies and returns `(raw tx, txid)`.
    pub async fn finalize(&self, p: pczt::Pczt, height: u32, cmx: &[u8; 32], index: usize) -> Result<(Vec<u8>, String)> {
        ensure!(height > 0, "note is not mined yet; wait for a confirmation");
        let prev = self.tree(height - 1).await?;
        let cmxs = self.block_cmxs(height).await?;
        let (anchor, path) = chain::witness(&prev.ironwood_tree, &cmxs, cmx)?;
        let at = self.tree(height).await?;
        ensure!(!at.ironwood_tree.is_empty(), "node returned no Ironwood tree");
        let bytes = hex::decode(&at.ironwood_tree)?;
        let t: incrementalmerkletree::frontier::CommitmentTree<orchard::tree::MerkleHashOrchard, 32> =
            zcash_primitives::merkle_tree::read_commitment_tree(&bytes[..])?;
        ensure!(orchard::Anchor::from(t.root()).to_bytes() == anchor.to_bytes(), "witness root does not match the chain's Ironwood root");
        let p = chain::install_witness(p, index, anchor, path)?;
        chain::prove_and_extract(p)
    }

    /// Waits until `txid` is mined; returns `(raw, height)`.
    pub async fn wait_mined(&self, txid: &str, max_secs: u64) -> Result<(Vec<u8>, u32)> {
        let start = std::time::Instant::now();
        loop {
            if let Ok(r) = self.tx(txid).await {
                if r.height > 0 && r.height < u32::MAX as u64 { return Ok((r.data, r.height as u32)); }
            }
            if start.elapsed().as_secs() > max_secs { return Err(anyhow!("{txid} not mined after {max_secs}s")); }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    }
}
