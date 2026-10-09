//! Linux 本机文档：逐段 openat、拒绝链接、同目录原子提交。不是全系统 CAS。
use super::*;
use std::{
    ffi::{CStr, CString},
    fs::{File, Metadata},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path, PathBuf},
};

const MAX_ATTRIBUTES: usize = 1024 * 1024;

fn name(value: &std::ffi::OsStr) -> Result<CString, String> {
    CString::new(value.as_bytes()).map_err(|_| "invalid_path".into())
}

fn open_at(parent: i32, value: &CStr, flags: i32) -> Result<File, String> {
    let fd = unsafe {
        libc::openat(
            parent,
            value.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        return Err("document_unavailable".into());
    }
    // 此 fd 仅在成功 open 后转交 File，错误路径也由 RAII 关闭。
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn final_path(file: &File) -> Result<PathBuf, String> {
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| "path_unverifiable".into())
}

fn metadata(file: &File) -> Result<Metadata, String> {
    file.metadata().map_err(|_| "path_unverifiable".into())
}

fn object_id(file: &File) -> Result<String, String> {
    let value = metadata(file)?;
    let mut generation: libc::c_int = 0;
    // Linux _IOR('v', 1, long)；代次由 inode 分配时生成，不能只比较 dev/ino 和时间。
    let request = 0x80007601u64 | ((std::mem::size_of::<libc::c_long>() as u64) << 16);
    if unsafe { libc::ioctl(file.as_raw_fd(), request as libc::c_ulong, &mut generation) } != 0 {
        return Err("file_identity_unverifiable".into());
    }
    Ok(format!(
        "{}:{}:{}",
        value.dev(),
        value.ino(),
        generation as u32
    ))
}

fn version(value: &Metadata, bytes: &[u8], file_id: String) -> Version {
    Version {
        exists: true,
        sha256: hash(bytes),
        byte_length: bytes.len(),
        file_id,
        modified_ns: format!("{}:{:09}", value.mtime(), value.mtime_nsec()),
        changed_ns: format!("{}:{:09}", value.ctime(), value.ctime_nsec()),
    }
}

fn stable(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
        && a.nlink() == b.nlink()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}

fn root(dir: &str) -> Result<(BoundRoot, File), String> {
    let path = Path::new(dir);
    if !path.is_absolute() || dir.len() > 16384 || dir.contains('\0') {
        return Err("invalid_path".into());
    }
    let mut handle = open_at(libc::AT_FDCWD, c"/", libc::O_RDONLY | libc::O_DIRECTORY)?;
    for part in path.components() {
        match part {
            Component::RootDir | Component::CurDir => (),
            Component::Normal(segment) => {
                handle = open_at(
                    handle.as_raw_fd(),
                    &name(segment)?,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                )?;
            }
            _ => return Err("invalid_path".into()),
        }
    }
    let canonical = final_path(&handle)?;
    let canonical_root = canonical.to_str().ok_or("path_unverifiable")?.to_owned();
    let binding_id = format!(
        "tauri:{}",
        hash(format!("{}|{}", canonical_root, object_id(&handle)?).as_bytes())
    );
    Ok((
        BoundRoot {
            binding_id,
            canonical_root,
            case_sensitive: true,
        },
        handle,
    ))
}

pub(super) fn bind(dir: &str) -> Result<BoundRoot, String> {
    Ok(root(dir)?.0)
}

struct Target {
    path: PathBuf,
    leaf: CString,
    // 句柄固定目标对象，但 POSIX 不会因此禁止其他进程移动目录；提交前再次验证。
    parents: Vec<(PathBuf, File)>,
}

impl Target {
    fn parent(&self) -> &File {
        &self.parents.last().unwrap().1
    }

    fn verify(&self) -> Result<(), String> {
        for (expected, handle) in &self.parents {
            if final_path(handle)? != *expected {
                return Err("stale_workspace".into());
            }
        }
        Ok(())
    }

    fn open(&self) -> Result<File, String> {
        self.verify()?;
        let file = open_at(self.parent().as_raw_fd(), &self.leaf, libc::O_RDONLY)?;
        let stat = metadata(&file)?;
        if !stat.is_file() {
            return Err("invalid_path".into());
        }
        if stat.nlink() != 1 {
            return Err("hardlinked_file".into());
        }
        if final_path(&file)? != self.path {
            return Err("path_unverifiable".into());
        }
        Ok(file)
    }
}

fn target(dir: &str, binding: &str, rel: &str) -> Result<Target, String> {
    let (bound, file) = root(dir)?;
    if bound.binding_id != binding {
        return Err("stale_workspace".into());
    }
    if rel.is_empty() || rel.len() > 4096 || rel.starts_with('/') || rel.contains(['\0', '\\']) {
        return Err("invalid_path".into());
    }
    let parts: Vec<_> = rel
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.is_empty() || parts.iter().any(|p| *p == "..") {
        return Err("invalid_path".into());
    }
    let mut path = PathBuf::from(bound.canonical_root);
    let mut parents = vec![(path.clone(), file)];
    for part in &parts[..parts.len() - 1] {
        let handle = open_at(
            parents.last().unwrap().1.as_raw_fd(),
            &name(part.as_ref())?,
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        path.push(part);
        if final_path(&handle)? != path {
            return Err("path_unverifiable".into());
        }
        parents.push((path.clone(), handle));
    }
    let leaf = name(parts.last().unwrap().as_ref())?;
    path.push(parts.last().unwrap());
    let result = Target {
        path,
        leaf,
        parents,
    };
    result.verify()?;
    Ok(result)
}

fn writable(target: &Target, stat: &Metadata) -> bool {
    // root 也不得绕过用户设置的只读 mode；ACL/有效用户权限交给内核核验。
    stat.mode() & 0o222 != 0
        && open_at(target.parent().as_raw_fd(), &target.leaf, libc::O_WRONLY)
            .ok()
            .and_then(|file| metadata(&file).ok())
            .is_some_and(|current| stable(stat, &current))
}

fn snapshot(target: &Target) -> Result<ByteDocument, String> {
    let mut file = target.open()?;
    let first = metadata(&file)?;
    let complete = first.len() <= MAX_BYTES as u64;
    let mut bytes = Vec::new();
    (&mut file)
        .take(if complete {
            first.len() + 1
        } else {
            PREVIEW_BYTES as u64
        })
        .read_to_end(&mut bytes)
        .map_err(|_| "document_unavailable")?;
    let after = metadata(&file)?;
    let current = target.open()?;
    if !stable(&first, &after)
        || !stable(&after, &metadata(&current)?)
        || complete && bytes.len() as u64 != first.len()
    {
        return Err("disk_conflict".into());
    }
    Ok(ByteDocument {
        data: BASE64.encode(&bytes),
        size: first.len(),
        complete,
        readonly: !writable(target, &first),
        canonical_path: target.path.to_str().ok_or("path_unverifiable")?.into(),
        version: if complete {
            Some(version(&after, &bytes, object_id(&file)?))
        } else {
            None
        },
    })
}

pub(super) fn read(dir: &str, binding: &str, rel: &str) -> Result<ByteDocument, String> {
    snapshot(&target(dir, binding, rel)?)
}

fn copy_attributes(source: &File, destination: &File) -> Result<(), String> {
    let stat = metadata(source)?;
    let dst = destination.as_raw_fd();
    let src = source.as_raw_fd();
    // chown 可能清掉 set-id 位，先转移 owner/group 再恢复 mode；ACL/xattrs 不能静默丢弃。
    if unsafe { libc::fchown(dst, stat.uid(), stat.gid()) } != 0
        || unsafe { libc::fchmod(dst, stat.mode() & 0o7777) } != 0
    {
        return Err("attributes_unavailable".into());
    }
    // 同目录新文件可能继承 default ACL；必须移除源文件没有的属性。
    let inherited_length = unsafe { libc::flistxattr(dst, std::ptr::null_mut(), 0) };
    if inherited_length > MAX_ATTRIBUTES as isize {
        return Err("attributes_unavailable".into());
    }
    if inherited_length < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOTSUP)
    {
        return Err("attributes_unavailable".into());
    }
    if inherited_length > 0 {
        let mut inherited = vec![0u8; inherited_length as usize];
        if unsafe { libc::flistxattr(dst, inherited.as_mut_ptr().cast(), inherited.len()) }
            != inherited_length
        {
            return Err("attributes_unavailable".into());
        }
        for value in inherited.split_inclusive(|b| *b == 0) {
            let attribute =
                CStr::from_bytes_with_nul(value).map_err(|_| "attributes_unavailable")?;
            if unsafe { libc::fremovexattr(dst, attribute.as_ptr()) } != 0 {
                return Err("attributes_unavailable".into());
            }
        }
    }
    let length = unsafe { libc::flistxattr(src, std::ptr::null_mut(), 0) };
    if length < 0 {
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOTSUP) {
            return Ok(());
        }
        return Err("attributes_unavailable".into());
    }
    if length as usize > MAX_ATTRIBUTES {
        return Err("attributes_unavailable".into());
    }
    if length == 0 {
        return Ok(());
    }
    let mut names = vec![0u8; length as usize];
    if unsafe { libc::flistxattr(src, names.as_mut_ptr().cast(), names.len()) } != length {
        return Err("attributes_unavailable".into());
    }
    let mut budget = MAX_ATTRIBUTES - names.len();
    for value in names.split_inclusive(|b| *b == 0) {
        let attribute = CStr::from_bytes_with_nul(value).map_err(|_| "attributes_unavailable")?;
        let size = unsafe { libc::fgetxattr(src, attribute.as_ptr(), std::ptr::null_mut(), 0) };
        if size < 0 || size as usize > budget {
            return Err("attributes_unavailable".into());
        }
        let mut bytes = vec![0u8; size as usize];
        if unsafe {
            libc::fgetxattr(
                src,
                attribute.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        } != size
            || unsafe {
                libc::fsetxattr(
                    dst,
                    attribute.as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                )
            } != 0
        {
            return Err("attributes_unavailable".into());
        }
        budget -= bytes.len();
    }
    Ok(())
}

pub(super) fn replace(
    dir: &str,
    binding: &str,
    rel: &str,
    baseline: &Version,
    bytes: &[u8],
) -> Result<ByteDocument, String> {
    replace_checked(
        dir,
        binding,
        rel,
        baseline,
        bytes,
        &format!(".awu-document-{}.tmp", uuid::Uuid::new_v4()),
        || Ok(()),
        || Ok(()),
    )
}

fn replace_checked(
    dir: &str,
    binding: &str,
    rel: &str,
    baseline: &Version,
    bytes: &[u8],
    temporary: &str,
    before_commit: impl FnOnce() -> Result<(), String>,
    after_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ByteDocument, String> {
    if bytes.len() > MAX_BYTES {
        return Err("write_not_started".into());
    }
    let target = target(dir, binding, rel).map_err(|_| "write_not_started")?;
    let original = snapshot(&target).map_err(|_| "write_not_started")?;
    if original.version.as_ref() != Some(baseline) {
        return Err("disk_conflict".into());
    }
    if original.readonly || !original.complete {
        return Err("document_readonly".into());
    }
    let source = target.open()?;
    if object_id(&source)? != baseline.file_id {
        return Err("disk_conflict".into());
    }
    let temp = name(temporary.as_ref())?;
    let mut owned: Option<File> = None;
    let mut commit_started = false;
    let result = (|| {
        owned = Some(
            open_at(
                target.parent().as_raw_fd(),
                &temp,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            )
            .map_err(|_| "write_not_started")?,
        );
        let file = owned.as_mut().unwrap();
        file.write_all(bytes).map_err(|_| "write_not_started")?;
        copy_attributes(&source, file)?;
        file.sync_all().map_err(|_| "write_not_started")?;
        before_commit()?;
        target.verify()?;
        let current = snapshot(&target)?;
        if current.version.as_ref() != Some(baseline) {
            return Err("disk_conflict".into());
        }
        if current.readonly {
            return Err("document_readonly".into());
        }
        // 验证当前根仍是同一个对象；dirfd 固定对象但不禁止外部 rename。
        if root(dir)?.0.binding_id != binding {
            return Err("stale_workspace".into());
        }
        let temp_current = open_at(target.parent().as_raw_fd(), &temp, libc::O_RDONLY)?;
        let temp_stat = metadata(file)?;
        let temp_id = object_id(file)?;
        if !stable(&temp_stat, &metadata(&temp_current)?) || temp_stat.nlink() != 1 {
            return Err("write_not_started".into());
        }
        commit_started = true;
        if unsafe {
            libc::renameat(
                target.parent().as_raw_fd(),
                temp.as_ptr(),
                target.parent().as_raw_fd(),
                target.leaf.as_ptr(),
            )
        } != 0
        {
            return Err("save_result_unverified".into());
        }
        target
            .parent()
            .sync_all()
            .map_err(|_| "save_result_unverified")?;
        after_commit()?;
        let saved = snapshot(&target)?;
        let committed = saved.version.as_ref().ok_or("save_result_unverified")?;
        if committed.sha256 != hash(bytes) || committed.file_id != temp_id {
            return Err("save_result_unverified".into());
        }
        Ok(saved)
    })();
    // 失败也只删除本次独占创建且仍为相同对象的临时入口；碰撞不清理用户文件。
    if let Some(file) = owned {
        if let Ok(current) = open_at(target.parent().as_raw_fd(), &temp, libc::O_RDONLY) {
            if metadata(&file)
                .ok()
                .zip(metadata(&current).ok())
                .is_some_and(|(a, b)| a.dev() == b.dev() && a.ino() == b.ino())
            {
                unsafe {
                    libc::unlinkat(target.parent().as_raw_fd(), temp.as_ptr(), 0);
                }
            }
        }
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
#[path = "local_documents_linux_tests.rs"]
mod tests;
