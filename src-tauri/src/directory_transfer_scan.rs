//! 传输专用完整扫描：任何范围内读取失败均中止，绝不把漏读解释为删除。
use super::{hex_encode, sync_is_ignored, SyncFileInfo};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Read, path::Path};

pub(crate) fn scan(dir: &str, scope: &str, directory: bool, ignore: &[String], include_git: bool) -> Result<HashMap<String, SyncFileInfo>, String> {
    if scope.contains('\\') || scope.starts_with('/') || scope.split('/').any(|p| p == ".." || p == "." || p.contains(':')) {
        return Err("非法扫描范围".into());
    }
    let root = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("源目录不存在".into()); }
    let mut selected = root.clone();
    for part in scope.split('/').filter(|p| !p.is_empty()) {
        selected.push(part);
        check(&selected)?;
    }
    if selected.is_dir() != directory || !selected.exists() { return Err("源文件或目录已变化".into()); }
    if !scope.is_empty() && sync_is_ignored(scope, ignore, include_git) { return Err("所选范围被同步规则排除".into()); }
    let mut files = HashMap::new();
    let mut total = 0;
    visit(&root, &selected, ignore, include_git, &mut files, &mut total)?;
    Ok(files)
}

fn check(path: &Path) -> Result<std::fs::Metadata, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let mut linked = meta.file_type().is_symlink();
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        linked |= meta.file_attributes() & 0x400 != 0;
    }
    if linked || (!meta.is_dir() && !meta.is_file()) { return Err("不支持链接、目录联接或特殊文件".into()); }
    Ok(meta)
}

fn visit(root: &Path, path: &Path, ignore: &[String], include_git: bool, files: &mut HashMap<String, SyncFileInfo>, total: &mut u64) -> Result<(), String> {
    let rel = path.strip_prefix(root).map_err(|e| e.to_string())?.to_str().ok_or("文件名编码无效")?.replace('\\', "/");
    if !rel.is_empty() && sync_is_ignored(&rel, ignore, include_git) { return Ok(()); }
    let meta = check(path)?;
    if meta.is_dir() {
        for item in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            visit(root, &item.map_err(|e| e.to_string())?.path(), ignore, include_git, files, total)?;
        }
    } else {
        *total += meta.len();
        if files.len() >= 20000 || *total > 8 * 1024 * 1024 * 1024 { return Err("超出扫描预算".into()); }
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut size = 0u64;
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            size += n as u64; hash.update(&buffer[..n]);
        }
        let after = check(path)?;
        if size != meta.len() || after.len() != size || after.modified().ok() != meta.modified().ok() {
            return Err("扫描期间源文件变化".into());
        }
        files.insert(rel, SyncFileInfo { hash: hex_encode(&hash.finalize()), size, mtime: None });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_scope_and_missing_directory() {
        let root = std::env::temp_dir().join(format!("awu-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("part/.git")).unwrap();
        std::fs::write(root.join("part/a"), b"hello").unwrap();
        std::fs::write(root.join("part/.git/config"), b"protected").unwrap();
        std::fs::write(root.join("outside"), b"outside").unwrap();
        let files = scan(root.to_str().unwrap(), "part", true, &[], false).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files["part/a"].hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert!(scan(root.to_str().unwrap(), "missing", true, &[], false).is_err());
        assert!(scan(root.to_str().unwrap(), "../outside", true, &[], false).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
