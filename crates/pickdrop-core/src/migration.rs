//! Explicit, non-destructive import of legacy desktop data.
use crate::{
    atomic,
    protocol::{random, s, signing, Replica},
    Core,
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

impl Core {
    /// Non-destructive desktop migration. Destination must be a new directory and the old app must be closed.
    /// Mobile secrets live in SecureStore and must be exported explicitly or the device must rejoin.
    pub async fn import_legacy_desktop(source: PathBuf, destination: PathBuf) -> Result<Value> {
        ensure!(
            source.canonicalize()? != destination.canonicalize().unwrap_or(destination.clone()),
            "Source and destination must differ"
        );
        if destination.exists() {
            ensure!(
                tokio::fs::read_dir(&destination)
                    .await?
                    .next_entry()
                    .await?
                    .is_none(),
                "Migration destination must be empty"
            );
        }
        let groups: Value =
            serde_json::from_slice(&tokio::fs::read(source.join("groups.json")).await?)?;
        let identity: Value =
            serde_json::from_slice(&tokio::fs::read(source.join("peer-identity.json")).await?)?;
        let key = signing(s(&identity, "privateKey"))?;
        let device = groups["device"].clone();
        ensure!(
            uuid::Uuid::parse_str(s(&device, "id")).is_ok(),
            "Invalid legacy device"
        );
        let mut snapshots = Vec::new();
        let mut skipped = 0;
        for group in groups["groups"]
            .as_array()
            .context("Invalid legacy groups")?
        {
            if s(group, "mode") != "peer" {
                skipped += 1;
                continue;
            }
            let id = s(group, "id");
            ensure!(uuid::Uuid::parse_str(id).is_ok(), "Invalid group ID");
            let saved: Value = serde_json::from_slice(
                &tokio::fs::read(source.join("groups").join(id).join("peer.json")).await?,
            )?;
            let replica = Replica::new(
                saved["genesis"].clone(),
                saved["events"]
                    .as_array()
                    .cloned()
                    .context("Missing events")?,
            )?;
            ensure!(
                s(&replica.genesis, "groupId") == id,
                "Legacy group ID mismatch"
            );
            let mut value = replica.snapshot();
            value["peers"] = saved["peers"].clone();
            value["hidden"] = json!(!replica.member(
                s(&device, "id"),
                &hex::encode(key.verifying_key().to_bytes())
            ));
            snapshots.push((id.to_string(), value, replica.state["messages"].clone()));
        }
        // Validate all snapshots before writing any migration artifact.
        let stage = destination.with_extension(format!("migration-{}", random(8)));
        tokio::fs::create_dir_all(stage.join("files")).await?;
        let result=async {
            atomic(&stage.join("identity.json"),&json!({"privateKey":hex::encode(key.to_bytes()),"device":device})).await?;
            let mut copied=0usize;
            for(id,value,messages)in &snapshots{
                atomic(&stage.join(format!("group_{id}.json")),value).await?;
                for message in messages.as_array().unwrap(){if s(message,"type")!="file"{continue;}
                    let file=source.join("groups").join(id).join("files").join(s(message,"id")).join(s(message,"fileName"));
                    if tokio::fs::symlink_metadata(&file).await.is_ok_and(|m|m.is_file()) {
                        let target=stage.join("files").join(s(message,"sha256"));if target.exists(){continue;}
                        let mut input=tokio::fs::File::open(file).await?;let mut output=tokio::fs::File::create(&target).await?;let mut hash=Sha256::new();let mut bytes=0u64;let mut buffer=vec![0;256*1024];loop{let n=input.read(&mut buffer).await?;if n==0{break;}hash.update(&buffer[..n]);bytes+=n as u64;output.write_all(&buffer[..n]).await?;}
                        if bytes!=message["size"].as_u64().unwrap()||hex::encode(hash.finalize())!=s(message,"sha256"){tokio::fs::remove_file(target).await?;}else{output.sync_all().await?;copied+=1;}
                    }
                }
            }
            if destination.exists(){tokio::fs::remove_dir(&destination).await?;}tokio::fs::rename(&stage,&destination).await?;
            Ok::<_,anyhow::Error>(json!({"groups":snapshots.len(),"files":copied,"skippedLegacyHostedGroups":skipped,"destination":destination}))
        }.await;
        if result.is_err() {
            let _ = tokio::fs::remove_dir_all(stage).await;
        }
        result
    }
}
