//! Inject Lintel create→complete signatures into a proved Ironwood PCZT.
//!
//! For each unsigned Ironwood action:
//!   1. lintel-cli create <amount> <sighash> --alpha <action_alpha>
//!   2. lintel-cli complete  (JSON → sig hex)
//!   3. Signer::apply_ironwood_signature(index, sig)
//!
//! The sighash is the real per-tx shielded sighash from Signer::shielded_sighash().
//! Never prints spending keys.
//!
//! LEGACY single-process tool (both shares come from `lintel-cli create`).
//! The two-party, escrow-bound path is `lintel-chain` + `lintel::chain`.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{anyhow, bail};
use ff::PrimeField;
use orchard::primitives::redpallas::{self, SpendAuth};
use pczt::roles::low_level_signer;
use pczt::roles::signer::Signer;
use pczt::Pczt;

fn main() -> anyhow::Result<()> {
    let mut pczt_path: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut cli = PathBuf::from("lintel-cli");
    let mut amount = "1".to_string();

    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--pczt" => pczt_path = Some(PathBuf::from(args.next().unwrap())),
            "--output" => output = Some(PathBuf::from(args.next().unwrap())),
            "--cli" => cli = PathBuf::from(args.next().unwrap()),
            "--amount" => amount = args.next().unwrap(),
            _ => {}
        }
    }

    let pczt_path = pczt_path.ok_or_else(|| anyhow!("missing --pczt"))?;
    let output = output.ok_or_else(|| anyhow!("missing --output"))?;

    let mut buf = Vec::new();
    fs::File::open(&pczt_path)?.read_to_end(&mut buf)?;
    let pczt = Pczt::parse(&buf).map_err(|e| anyhow!("parse: {e:?}"))?;

    let mut signer = Signer::new(pczt).map_err(|e| anyhow!("Signer::new: {e:?}"))?;
    let sighash = signer.shielded_sighash();
    let sighash_hex = hex::encode(sighash);

    // Probe unsigned actions for alpha
    let mut to_sign = Vec::new();
    {
        let probe = Pczt::parse(&buf).map_err(|e| anyhow!("{e:?}"))?;
        low_level_signer::Signer::new(probe)
            .sign_ironwood_with::<low_level_signer::OrchardParseError, _>(|_, bundle, _| {
                for (index, action) in bundle.actions().iter().enumerate() {
                    if action.spend().spend_auth_sig().is_none() {
                        if let Some(alpha) = action.spend().alpha() {
                            to_sign.push((index, *alpha));
                        }
                    }
                }
                Ok(())
            })
            .map_err(|e| anyhow!("{e:?}"))?;
    }

    if to_sign.is_empty() {
        bail!("no unsigned actions");
    }

    for (index, alpha) in &to_sign {
        let alpha_hex = hex::encode(alpha.to_repr());
        let create_out = Command::new(&cli)
            .args(["create", &amount, &sighash_hex, "--alpha", &alpha_hex])
            .output()?;
        if !create_out.status.success() {
            bail!("create failed");
        }
        let create_json = String::from_utf8(create_out.stdout)?;

        let mut child = Command::new(&cli)
            .arg("complete")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        child.stdin.take().unwrap().write_all(create_json.trim().as_bytes())?;
        let complete_out = child.wait_with_output()?;
        let sig_hex = String::from_utf8(complete_out.stdout)?.trim().to_string();
        let sig_bytes = hex::decode(&sig_hex)?;
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(&sig_bytes);
        let completed = redpallas::Signature::<SpendAuth>::from(sig_arr);
        signer.apply_ironwood_signature(*index, completed)
            .map_err(|e| anyhow!("apply: {e:?}"))?;
    }

    let signed = signer.finish();
    let out_bytes = signed.serialize().map_err(|e| anyhow!("{e:?}"))?;
    fs::write(&output, &out_bytes)?;
    eprintln!("Wrote signed PCZT to {}", output.display());
    Ok(())
}
