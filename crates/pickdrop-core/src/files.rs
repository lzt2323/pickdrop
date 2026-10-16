//! File transfers, integrity checks, and local cache projections.
use crate::{
    protocol::{random, s},
    Core,
};
use anyhow::{bail, ensure, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

// Local paths are privileged projection fields, never authority granted by a peer.
pub(super) fn project_cached_message(directory: &std::path::Path, message: &Value) -> Value {
    let mut projected = message.clone();
    if let Some(fields) = projected.as_object_mut() {
        fields.remove("localPath");
        fields.remove("path");
    }
    let hash = s(&projected, "sha256");
    if s(&projected, "type") == "file"
        && hash.len() == 64
        && hash.bytes().all(|c| c.is_ascii_hexdigit())
    {
        let path = directory.join("files").join(hash);
        if std::fs::metadata(&path).is_ok_and(|metadata| {
            metadata.is_file() && Some(metadata.len()) == projected["size"].as_u64()
        }) {
            projected["localPath"] = json!(path);
        }
    }
    projected
}

impl Core {
    pub(super) async fn send_file(
        &self,
        id: &str,
        path: PathBuf,
        transfer_id: &str,
        token: &CancellationToken,
    ) -> Result<Value> {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .context("Invalid file path")?
            .to_string();
        let temp = self
            .0
            .dir
            .join("files")
            .join(format!(".{}.part", random(16)));
        self.emit(json!({"type":"transfer","id":transfer_id,"status":"sending","bytes":0,"total":tokio::fs::metadata(&path).await?.len()}));
        let copied = copy_hash(&path, &temp, self, transfer_id, token).await;
        if copied.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        let (sha, size) = copied?;
        if token.is_cancelled() {
            let _ = tokio::fs::remove_file(&temp).await;
            bail!("已取消");
        }
        let dest = self.0.dir.join("files").join(&sha);
        if dest.exists() {
            tokio::fs::remove_file(&temp).await?
        } else {
            tokio::fs::rename(&temp, &dest).await?
        }
        let mut data = self.0.data.lock().await;
        let device = data.device.clone();
        let g = data.groups.get_mut(id).context("Unknown group")?;
        self.0.transfers.lock().await.remove(transfer_id);
        ensure!(!token.is_cancelled(), "已取消");
        let m = json!({"id":uuid::Uuid::new_v4(),"type":"file","fileName":name,"mime":file_mime(&name),"size":size,"sha256":sha,"senderId":device["id"],"senderName":device["name"],"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        g.replica
            .append("message", m.clone(), &device, &self.0.key)?;
        self.changed(id, &mut data).await?;
        self.kick_sync();
        self.emit(
            json!({"type":"transfer","id":if transfer_id.is_empty(){s(&m,"id")}else{transfer_id},"messageId":m["id"],"status":"completed","bytes":size,"total":size}),
        );
        Ok(m)
    }
    pub(super) async fn receive_file(
        &self,
        group: &str,
        id: &str,
        transfer_id: &str,
        token: &CancellationToken,
    ) -> Result<Value> {
        let (m, peers, device) = {
            let data = self.0.data.lock().await;
            let g = data.groups.get(group).context("Unknown group")?;
            ensure!(
                g.replica.member(
                    s(&data.device, "id"),
                    &hex::encode(self.0.key.verifying_key().to_bytes())
                ),
                "Not an active member"
            );
            let m = g.replica.state["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| s(m, "id") == id && s(m, "type") == "file")
                .context("Unknown file")?
                .clone();
            let now = chrono::Utc::now().timestamp_millis();
            let mut peers: Vec<_> = g.peers.keys().cloned().collect();
            peers.sort_by_key(|url| {
                let verified = g.route_seen.get(url).copied().unwrap_or(0);
                let hint = g.route_hints.get(url).copied().unwrap_or(0);
                std::cmp::Reverse((
                    if now - verified < 15000 {
                        2
                    } else if now - hint < 15000 {
                        1
                    } else {
                        0
                    },
                    verified.max(hint),
                ))
            });
            (m, peers, data.device.clone())
        };
        let path = self.0.dir.join("files").join(s(&m, "sha256"));
        if path.exists() && tokio::fs::metadata(&path).await?.len() == m["size"].as_u64().unwrap() {
            return Ok(json!({"path":path,"sha256":m["sha256"],"size":m["size"]}));
        }
        ensure!(
            !peers.is_empty(),
            "当前没有可尝试的设备地址；请保持发送端在线并检查群组连接"
        );
        let attempted = peers.len();
        let mut failures = Vec::new();
        for peer in peers {
            let proof = {
                let data = self.0.data.lock().await;
                data.groups[group]
                    .replica
                    .proof("file", json!({"id":id}), &device, &self.0.key)
            };
            let outcome=async {let response=tokio::select!{_=token.cancelled()=>{bail!("已取消")},response=self.0.file_http.get(format!("{peer}/api/peer/files/{id}")).header("X-Peer-Proof",proof.to_string()).send()=>response?}.error_for_status()?;let temp=self.0.dir.join("files").join(format!(".{}.part",random(16)));let result=async{let mut f=tokio::fs::File::create(&temp).await?;let mut stream=response.bytes_stream();let mut hash=Sha256::new();let mut bytes=0u64;let mut last=std::time::Instant::now();loop{let next=tokio::select!{_=token.cancelled()=>{bail!("已取消")},next=tokio::time::timeout(Duration::from_secs(30),stream.next())=>next?};let Some(chunk)=next else{break};let chunk=chunk?;bytes+=chunk.len()as u64;ensure!(bytes<=m["size"].as_u64().unwrap(),"File exceeds signed size");hash.update(&chunk);f.write_all(&chunk).await?;if last.elapsed()>=Duration::from_millis(150){self.emit(json!({"type":"transfer","id":transfer_id,"messageId":id,"status":"receiving","bytes":bytes,"total":m["size"]}));last=std::time::Instant::now();}}ensure!(bytes==m["size"].as_u64().unwrap()&&hex::encode(hash.finalize())==s(&m,"sha256"),"File integrity check failed");f.sync_all().await?;tokio::fs::rename(&temp,&path).await?;Ok::<_,anyhow::Error>(())}.await;if result.is_err(){let _=tokio::fs::remove_file(temp).await;}result}.await;
            if token.is_cancelled() {
                bail!("已取消");
            }
            match outcome {
                Ok(()) => {
                    self.emit(json!({"type":"transfer","id":transfer_id,"messageId":id,"status":"completed","bytes":m["size"],"total":m["size"],"path":path}));
                    return Ok(json!({"path":path,"sha256":m["sha256"],"size":m["size"]}));
                }
                Err(error) if failures.len() < 3 => failures.push(format!("{peer}: {error:#}")),
                Err(_) => {}
            }
        }
        bail!("文件接收失败：已尝试 {attempted} 个设备地址。请检查发送端监听地址、网络连接及文件副本。详情：{}", failures.join("；"))
    }
    pub(super) async fn cache_stats(&self) -> Result<(usize, u64)> {
        let mut e = tokio::fs::read_dir(self.0.dir.join("files")).await?;
        let (mut count, mut size) = (0, 0);
        while let Some(f) = e.next_entry().await? {
            let m = f.metadata().await?;
            if m.is_file() {
                count += 1;
                size += m.len()
            }
        }
        Ok((count, size))
    }
}

// MIME is an interoperability hint; hosts validate image bytes before decoding thumbnails.
fn file_mime(name: &str) -> &'static str {
    match std::path::Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "json" => "application/json",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}
async fn copy_hash(
    source: &std::path::Path,
    dest: &std::path::Path,
    core: &Core,
    transfer_id: &str,
    token: &CancellationToken,
) -> Result<(String, u64)> {
    let mut input = tokio::fs::File::open(source).await?;
    ensure!(
        input.metadata().await?.is_file(),
        "Only regular files are supported"
    );
    let mut output = tokio::fs::File::create(dest).await?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let total = input.metadata().await?.len();
    let mut last = std::time::Instant::now();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let n =
            tokio::select! {_=token.cancelled()=>{bail!("已取消")},n=input.read(&mut buffer)=>n?};
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        output.write_all(&buffer[..n]).await?;
        size += n as u64;
        if last.elapsed() >= Duration::from_millis(150) {
            core.emit(json!({"type":"transfer","id":transfer_id,"status":"sending","bytes":size,"total":total}));
            last = std::time::Instant::now();
        }
    }
    output.sync_all().await?;
    Ok((hex::encode(hash.finalize()), size))
}
#[cfg(test)]
mod cache_projection_tests {
    use super::*;
    #[test]
    fn peer_paths_cannot_turn_an_unreceived_message_into_a_local_file() {
        let directory = tempfile::tempdir().unwrap();
        let hash = "a".repeat(64);
        let message = json!({"type":"file","fileName":"photo.png","sha256":hash,"size":3,"localPath":directory.path().join("identity.json"),"path":"/private/file"});
        let missing = project_cached_message(directory.path(), &message);
        assert!(missing.get("localPath").is_none() && missing.get("path").is_none());
        std::fs::create_dir(directory.path().join("files")).unwrap();
        let cache = directory.path().join("files").join(hash);
        std::fs::write(&cache, b"png").unwrap();
        let received = project_cached_message(directory.path(), &message);
        assert_eq!(received["localPath"], json!(cache));
        assert!(received.get("path").is_none());
        assert_eq!(received["fileName"], message["fileName"]);
        assert!(
            message.get("path").is_some(),
            "signed event payload is preserved"
        );
        std::fs::write(&cache, b"wrong length").unwrap();
        assert!(project_cached_message(directory.path(), &message)
            .get("localPath")
            .is_none());
    }
}
