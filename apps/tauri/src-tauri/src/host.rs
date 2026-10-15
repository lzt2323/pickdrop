//! Native host state and the canonical-path allowlist shared by file commands.
use pickdrop_core::Core;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub(crate) struct Host {
    pub(crate) core: Core,
    files: Mutex<HashSet<PathBuf>>,
    pub(crate) data: PathBuf,
}
impl Host {
    pub(crate) fn new(core: Core, data: PathBuf) -> Self {
        let files = std::fs::read(data.join("approved-files.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            core,
            data,
            files: Mutex::new(files),
        }
    }

    pub(crate) fn allow(&self, path: &Path) -> Result<PathBuf, String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let mut files = self.files.lock().map_err(|e| e.to_string())?;
        files.insert(path.clone());
        let data = serde_json::to_vec(&*files).map_err(|e| e.to_string())?;
        let temporary = self.data.join("approved-files.tmp");
        std::fs::write(&temporary, data).map_err(|e| e.to_string())?;
        std::fs::rename(temporary, self.data.join("approved-files.json"))
            .map_err(|e| e.to_string())?;
        Ok(path)
    }
    pub(crate) fn permitted(&self, path: &str) -> Result<PathBuf, String> {
        let files = self.files.lock().map_err(|e| e.to_string())?;
        permitted_path(&self.data, &files, path)
    }
}

fn permitted_path(data: &Path, approved: &HashSet<PathBuf>, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if approved.contains(&path) || path.starts_with(data) {
        Ok(path)
    } else {
        Err("请先通过文件选择器选择该文件".into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn downloaded_cache_is_approved_without_picker_and_outside_is_denied() {
        let temporary = tempfile::tempdir().unwrap();
        let app_data = temporary.path().join("preview-data");
        let cache = app_data.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let downloaded = cache.join("sha256-object");
        std::fs::write(&downloaded, b"received bytes").unwrap();
        let outside = temporary.path().join("private.txt");
        std::fs::write(&outside, b"outside bytes").unwrap();
        let data = app_data.canonicalize().unwrap();
        let approved = std::collections::HashSet::new();
        assert_eq!(
            super::permitted_path(&data, &approved, &downloaded.to_string_lossy()).unwrap(),
            downloaded.canonicalize().unwrap()
        );
        assert!(super::permitted_path(&data, &approved, &outside.to_string_lossy()).is_err());
        #[cfg(unix)]
        {
            let alias = cache.join("outside-alias");
            std::os::unix::fs::symlink(&outside, &alias).unwrap();
            assert!(super::permitted_path(&data, &approved, &alias.to_string_lossy()).is_err());
            let app_alias = temporary.path().join("android-data-alias");
            std::os::unix::fs::symlink(&app_data, &app_alias).unwrap();
            assert!(super::permitted_path(
                &app_alias.canonicalize().unwrap(),
                &approved,
                &downloaded.to_string_lossy()
            )
            .is_ok());
        }
    }
}
