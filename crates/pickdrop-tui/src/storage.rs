//! Offline cleanup of app-owned chat data; identity, settings and exports are retained.
use anyhow::{ensure, Context, Result};
use std::path::Path;

/// Call only after the core runtime has stopped, while the data-directory lock is held.
pub fn clear_chat_data(data: &Path) -> Result<()> {
    let entries = std::fs::read_dir(data)?.collect::<std::io::Result<Vec<_>>>()?;
    let mut targets = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let owned = name.starts_with("group_")
            && (name.ends_with(".json") || name.ends_with(".tmp"))
            || (name.starts_with("pending-joins.") && name.ends_with(".tmp"))
            || matches!(
                name.as_ref(),
                "pending-joins.json" | "pending-joins.tmp" | "tui-drafts.json" | "tui-drafts.tmp"
            );
        if owned {
            ensure!(
                entry.file_type()?.is_file(),
                "群聊数据不是普通文件：{}",
                entry.path().display()
            );
            targets.push(entry.path());
        }
    }
    let files = data.join("files");
    if files.exists() {
        ensure!(
            !std::fs::symlink_metadata(&files)?.file_type().is_symlink(),
            "缓存目录不能是符号链接"
        );
        for entry in std::fs::read_dir(files)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                targets.push(entry.path());
            }
        }
    }
    for path in targets {
        std::fs::remove_file(&path).with_context(|| {
            format!(
                "清理 {} 失败，可能仅部分清理，请检查数据目录",
                path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chat_cleanup_preserves_identity_settings_lock_and_unrelated_files() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path();
        for name in [
            "identity.json",
            "settings.json",
            "network.json",
            "tui-preferences.json",
            "tui.lock",
            "export.txt",
        ] {
            std::fs::write(data.join(name), name).unwrap();
        }
        for name in ["group_123.json", "pending-joins.json", "tui-drafts.json"] {
            std::fs::write(data.join(name), b"chat").unwrap();
        }
        std::fs::create_dir(data.join("files")).unwrap();
        std::fs::write(data.join("files/cache"), b"file").unwrap();
        clear_chat_data(data).unwrap();
        for name in [
            "identity.json",
            "settings.json",
            "network.json",
            "tui-preferences.json",
            "tui.lock",
            "export.txt",
        ] {
            assert_eq!(std::fs::read(data.join(name)).unwrap(), name.as_bytes());
        }
        for name in [
            "group_123.json",
            "pending-joins.json",
            "tui-drafts.json",
            "files/cache",
        ] {
            assert!(!data.join(name).exists());
        }
    }
    #[cfg(unix)]
    #[test]
    fn cleanup_never_traverses_a_symlink_cache_directory() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("export"), b"keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("files")).unwrap();
        assert!(clear_chat_data(directory.path()).is_err());
        assert!(outside.path().join("export").exists());
    }
}
