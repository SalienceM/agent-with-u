//! 本机副本文档接口；原 dir_sync_* 的显式传输契约保持不变。
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const PREVIEW_BYTES: usize = 256 * 1024;
// 所属 worker 持有锁直到实际结束；WebView/RPC 取消不释放提交中的保护。
static DOCUMENT_IO: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Version {
    exists: bool,
    sha256: String,
    byte_length: usize,
    file_id: String,
    modified_ns: String,
    changed_ns: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundRoot {
    binding_id: String,
    canonical_root: String,
    case_sensitive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteDocument {
    data: String,
    size: u64,
    complete: bool,
    readonly: bool,
    canonical_path: String,
    version: Option<Version>,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn bind(dir: &str) -> Result<BoundRoot, String> {
    let _guard = DOCUMENT_IO.lock().map_err(|_| "document_lock_failed")?;
    platform::bind(dir)
}

pub fn read(dir: &str, binding_id: &str, rel: &str) -> Result<ByteDocument, String> {
    let _guard = DOCUMENT_IO.lock().map_err(|_| "document_lock_failed")?;
    platform::read(dir, binding_id, rel)
}

pub fn replace(
    dir: &str,
    binding_id: &str,
    rel: &str,
    baseline: &Version,
    data: &str,
) -> Result<ByteDocument, String> {
    if data.len() > (MAX_BYTES + 2) / 3 * 4 {
        return Err("write_not_started".into());
    }
    let bytes = BASE64.decode(data).map_err(|_| "write_not_started")?;
    if bytes.len() > MAX_BYTES {
        return Err("write_not_started".into());
    }
    let _guard = DOCUMENT_IO.lock().map_err(|_| "document_lock_failed")?;
    platform::replace(dir, binding_id, rel, baseline, &bytes)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
    use std::{
        fs::{File, OpenOptions},
        io::{Read, Write},
        path::{Path, PathBuf},
    };
    use windows_sys::Win32::Storage::FileSystem::*;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    fn same_path(a: &Path, b: &Path) -> bool {
        a.as_os_str().to_string_lossy().to_uppercase()
            == b.as_os_str().to_string_lossy().to_uppercase()
    }
    fn final_path(file: &File) -> Result<PathBuf, String> {
        let mut value = vec![0u16; 32768];
        let n = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                value.as_mut_ptr(),
                value.len() as u32,
                0,
            )
        };
        if n == 0 || n as usize >= value.len() {
            return Err("path_unverifiable".into());
        }
        Ok(PathBuf::from(
            String::from_utf16(&value[..n as usize]).map_err(|_| "path_unverifiable")?,
        ))
    }
    fn info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, String> {
        let mut value = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) } == 0 {
            return Err("path_unverifiable".into());
        }
        if value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("linked_path".into());
        }
        Ok(value)
    }
    fn file_id(value: &BY_HANDLE_FILE_INFORMATION) -> String {
        format!(
            "{}:{}:{}",
            value.dwVolumeSerialNumber, value.nFileIndexHigh, value.nFileIndexLow
        )
    }
    fn open(path: &Path, directory: bool) -> Result<File, String> {
        let file = OpenOptions::new()
            .read(true)
            .access_mode(if directory {
                FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY
            } else {
                0x80000000
            })
            .share_mode(
                FILE_SHARE_READ | FILE_SHARE_WRITE | if directory { 0 } else { FILE_SHARE_DELETE },
            )
            .custom_flags(
                FILE_FLAG_OPEN_REPARSE_POINT
                    | if directory {
                        FILE_FLAG_BACKUP_SEMANTICS
                    } else {
                        0
                    },
            )
            .open(path)
            .map_err(|_| "document_unavailable")?;
        let metadata = info(&file)?;
        if (metadata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
            return Err("invalid_path".into());
        }
        if !directory && metadata.nNumberOfLinks != 1 {
            return Err("hardlinked_file".into());
        }
        Ok(file)
    }
    fn root(dir: &str) -> Result<(BoundRoot, File), String> {
        let path = Path::new(dir);
        if !path.is_absolute() || dir.contains('\0') {
            return Err("invalid_path".into());
        }
        let file = open(path, true)?;
        let canonical = final_path(&file)?;
        let binding_id = format!(
            "tauri:{}",
            hash(
                format!(
                    "{}|{}",
                    canonical.to_string_lossy().to_uppercase(),
                    file_id(&info(&file)?)
                )
                .as_bytes()
            )
        );
        Ok((
            BoundRoot {
                binding_id,
                canonical_root: canonical.to_string_lossy().into_owned(),
                case_sensitive: false,
            },
            file,
        ))
    }
    pub(super) fn bind(dir: &str) -> Result<BoundRoot, String> {
        Ok(root(dir)?.0)
    }

    fn parts(rel: &str) -> Result<Vec<&str>, String> {
        if rel.is_empty() || rel.len() > 4096 || rel.starts_with(['/', '\\']) {
            return Err("invalid_path".into());
        }
        let mut out = vec![];
        for part in rel.split(['/', '\\']) {
            if part.is_empty() || part == "." {
                continue;
            }
            let stem = part.split('.').next().unwrap_or("").to_uppercase();
            if part == ".."
                || part.ends_with([' ', '.'])
                || part.chars().any(|c| c < ' ' || ":*?\"<>|".contains(c))
                || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
                || (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.len() == 4
                    && stem.as_bytes()[3].is_ascii_digit()
            {
                return Err("invalid_path".into());
            }
            out.push(part);
        }
        if out.is_empty() {
            return Err("invalid_path".into());
        }
        Ok(out)
    }
    // 所有父目录都持有不共享删除的句柄，不仅做字符串 starts_with 校验。
    fn target(dir: &str, binding: &str, rel: &str) -> Result<(PathBuf, Vec<File>), String> {
        let (root, handle) = root(dir)?;
        if root.binding_id != binding {
            return Err("stale_workspace".into());
        }
        let segments = parts(rel)?;
        let mut handles = vec![handle];
        let mut path = PathBuf::from(root.canonical_root);
        for (index, part) in segments.iter().enumerate() {
            path.push(part);
            if index + 1 < segments.len() {
                let directory = open(&path, true)?;
                if !same_path(&final_path(&directory)?, &path) {
                    return Err("path_unverifiable".into());
                }
                handles.push(directory);
            }
        }
        Ok((path, handles))
    }
    fn version(file: &File, bytes: &[u8]) -> Result<Version, String> {
        let metadata = info(file)?;
        let mut basic = FILE_BASIC_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err("path_unverifiable".into());
        }
        Ok(Version {
            exists: true,
            sha256: hash(bytes),
            byte_length: bytes.len(),
            file_id: file_id(&metadata),
            modified_ns: basic.LastWriteTime.to_string(),
            changed_ns: basic.ChangeTime.to_string(),
        })
    }
    fn snapshot(path: &Path) -> Result<ByteDocument, String> {
        let mut file = open(path, false)?;
        if !same_path(&final_path(&file)?, path) {
            return Err("path_unverifiable".into());
        }
        let first = info(&file)?;
        let size = ((first.nFileSizeHigh as u64) << 32) | first.nFileSizeLow as u64;
        let complete = size <= MAX_BYTES as u64;
        let before = version(&file, &[])?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(if complete {
                size + 1
            } else {
                PREVIEW_BYTES as u64
            })
            .read_to_end(&mut bytes)
            .map_err(|_| "document_unavailable")?;
        let after = version(&file, &bytes)?;
        let current = open(path, false)?;
        if before.file_id != after.file_id
            || before.modified_ns != after.modified_ns
            || before.changed_ns != after.changed_ns
            || info(&current).map(|v| file_id(&v))? != after.file_id
            || complete && bytes.len() as u64 != size
        {
            return Err("disk_conflict".into());
        }
        Ok(ByteDocument {
            data: BASE64.encode(bytes),
            size,
            complete,
            readonly: first.dwFileAttributes & FILE_ATTRIBUTE_READONLY != 0,
            canonical_path: path.to_string_lossy().into_owned(),
            version: if complete { Some(after) } else { None },
        })
    }
    pub(super) fn read(dir: &str, binding: &str, rel: &str) -> Result<ByteDocument, String> {
        let (path, _parents) = target(dir, binding, rel)?;
        snapshot(&path)
    }
    pub(super) fn replace(
        dir: &str,
        binding: &str,
        rel: &str,
        baseline: &Version,
        bytes: &[u8],
    ) -> Result<ByteDocument, String> {
        replace_checked(dir, binding, rel, baseline, bytes, || Ok(()))
    }
    fn replace_checked(
        dir: &str,
        binding: &str,
        rel: &str,
        baseline: &Version,
        bytes: &[u8],
        before_commit: impl FnOnce() -> Result<(), String>,
    ) -> Result<ByteDocument, String> {
        if bytes.len() > MAX_BYTES {
            return Err("write_not_started".into());
        }
        let (path, _parents) = target(dir, binding, rel).map_err(|_| "write_not_started")?;
        let original = snapshot(&path).map_err(|_| "write_not_started")?;
        if original.version.as_ref() != Some(baseline) {
            return Err("disk_conflict".into());
        }
        if original.readonly || !original.complete {
            return Err("document_readonly".into());
        }
        let temporary = path.with_file_name(format!(".awu-document-{}.tmp", uuid::Uuid::new_v4()));
        let mut commit_started = false;
        let mut temporary_created = false;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(FILE_SHARE_READ)
                .open(&temporary)
                .map_err(|_| "write_not_started")?;
            temporary_created = true;
            if !same_path(&final_path(&file)?, &temporary) {
                return Err("write_not_started".into());
            }
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "write_not_started")?;
            drop(file);
            before_commit()?;
            if snapshot(&path)?.version.as_ref() != Some(baseline) {
                return Err("disk_conflict".into());
            }
            let destination = wide(&path);
            let source = wide(&temporary);
            commit_started = true;
            // 不忽略 ACL/流合并失败，也不退回会丢失属性的裸覆盖。
            if unsafe {
                ReplaceFileW(
                    destination.as_ptr(),
                    source.as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            } == 0
            {
                return Err("save_result_unverified".into());
            }
            let result = snapshot(&path)?;
            if result.version.as_ref().map(|v| v.sha256.as_str()) != Some(hash(bytes).as_str()) {
                return Err("save_result_unverified".into());
            }
            Ok(result)
        })();
        // 仅清理本次独占创建的临时路径，不回滚/删除用户目标文件。
        if temporary_created {
            let _ = std::fs::remove_file(temporary);
        }
        result.map_err(|reason| {
            if commit_started {
                "save_result_unverified".into()
            } else {
                reason
            }
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        struct Fixture(PathBuf);
        impl Fixture {
            fn new() -> Self {
                let path = std::env::temp_dir()
                    .join(format!("awu-document-test-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&path).unwrap();
                Self(path)
            }
            fn dir(&self) -> &str {
                self.0.to_str().unwrap()
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let absolute = std::fs::canonicalize(&self.0).unwrap();
                let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
                assert_eq!(absolute.parent(), Some(temp.as_path()));
                assert!(absolute
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("awu-document-test-"));
                std::fs::remove_dir_all(absolute).unwrap();
            }
        }
        #[test]
        fn bounded_read_and_atomic_replace_preserve_streams() {
            let f = Fixture::new();
            let file = f.0.join("a.py");
            std::fs::write(&file, b"old\r\n").unwrap();
            std::fs::write(f.0.join("a.py:audit"), b"stream").unwrap();
            let root = bind(f.dir()).unwrap();
            let old = read(f.dir(), &root.binding_id, "a.py").unwrap();
            let saved = replace(
                f.dir(),
                &root.binding_id,
                "a.py",
                old.version.as_ref().unwrap(),
                b"new\r\n",
            )
            .unwrap();
            assert_eq!(saved.data, BASE64.encode(b"new\r\n"));
            assert_eq!(std::fs::read(f.0.join("a.py:audit")).unwrap(), b"stream");
            assert_eq!(
                replace(
                    f.dir(),
                    &root.binding_id,
                    "a.py",
                    old.version.as_ref().unwrap(),
                    b"stale"
                )
                .unwrap_err(),
                "disk_conflict"
            );
            std::fs::write(f.0.join("large.py"), vec![b'x'; MAX_BYTES + 1]).unwrap();
            let large = read(f.dir(), &root.binding_id, "large.py").unwrap();
            assert!(!large.complete && large.version.is_none());
            assert_eq!(BASE64.decode(large.data).unwrap().len(), PREVIEW_BYTES);
        }
        #[test]
        fn concurrent_change_failure_and_path_aliases_never_overwrite() {
            let f = Fixture::new();
            let file = f.0.join("a.py");
            std::fs::write(&file, b"old").unwrap();
            let root = bind(f.dir()).unwrap();
            let base = read(f.dir(), &root.binding_id, "a.py")
                .unwrap()
                .version
                .unwrap();
            let result = replace_checked(f.dir(), &root.binding_id, "a.py", &base, b"mine", || {
                std::fs::write(&file, b"external").unwrap();
                Ok(())
            });
            assert_eq!(result.unwrap_err(), "disk_conflict");
            assert_eq!(std::fs::read(&file).unwrap(), b"external");
            assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
            for path in ["../escape", "a.py:stream", "CON", "x.", "C:/escape"] {
                assert!(read(f.dir(), &root.binding_id, path).is_err());
            }
            std::fs::hard_link(&file, f.0.join("alias.py")).unwrap();
            assert!(read(f.dir(), &root.binding_id, "a.py").is_err());
        }
        #[test]
        fn failure_before_commit_preserves_old_bytes_and_parent_handles_pin_directory() {
            let f = Fixture::new();
            let file = f.0.join("a.py");
            std::fs::write(&file, b"old").unwrap();
            let root = bind(f.dir()).unwrap();
            let base = read(f.dir(), &root.binding_id, "a.py")
                .unwrap()
                .version
                .unwrap();
            assert_eq!(
                replace_checked(f.dir(), &root.binding_id, "a.py", &base, b"mine", || Err(
                    "write_not_started".into()
                ))
                .unwrap_err(),
                "write_not_started"
            );
            assert_eq!(std::fs::read(&file).unwrap(), b"old");
            assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
            let (_path, parents) = target(f.dir(), &root.binding_id, "a.py").unwrap();
            let moved = f.0.with_extension("moved");
            let renamed = std::fs::rename(&f.0, &moved).is_ok();
            if renamed {
                std::fs::rename(&moved, &f.0).unwrap();
            }
            assert!(!renamed);
            drop(parents);
            assert!(read(f.dir(), "foreign-binding", "a.py").is_err());
        }

        #[test]
        fn revoked_write_and_unknown_replace_leave_original_intact() {
            let f = Fixture::new();
            let file = f.0.join("a.py");
            std::fs::write(&file, b"old").unwrap();
            let root = bind(f.dir()).unwrap();
            let base = read(f.dir(), &root.binding_id, "a.py")
                .unwrap()
                .version
                .unwrap();
            let mut permissions = std::fs::metadata(&file).unwrap().permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&file, permissions.clone()).unwrap();
            assert!(replace(f.dir(), &root.binding_id, "a.py", &base, b"new").is_err());
            permissions.set_readonly(false);
            std::fs::set_permissions(&file, permissions).unwrap();
            let base = read(f.dir(), &root.binding_id, "a.py")
                .unwrap()
                .version
                .unwrap();
            // 模拟非合作进程不共享删除：ReplaceFileW 无法提交，保守返回未知。
            let pinned = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .open(&file)
                .unwrap();
            assert_eq!(
                replace(f.dir(), &root.binding_id, "a.py", &base, b"new").unwrap_err(),
                "save_result_unverified"
            );
            drop(pinned);
            assert_eq!(std::fs::read(&file).unwrap(), b"old");
            assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
        }
    }
}

#[cfg(target_os = "linux")]
#[path = "local_documents_linux.rs"]
mod platform;

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::*;
    pub(super) fn bind(_: &str) -> Result<BoundRoot, String> {
        Err("safe_local_documents_unsupported".into())
    }
    pub(super) fn read(_: &str, _: &str, _: &str) -> Result<ByteDocument, String> {
        Err("safe_local_documents_unsupported".into())
    }
    pub(super) fn replace(
        _: &str,
        _: &str,
        _: &str,
        _: &Version,
        _: &[u8],
    ) -> Result<ByteDocument, String> {
        Err("safe_local_documents_unsupported".into())
    }
}
