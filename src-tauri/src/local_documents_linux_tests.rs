use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

fn fixture_acl() -> Vec<u8> {
    let mut result = 2u32.to_le_bytes().to_vec();
    for (tag, permission, id) in [
        (1u16, 6u16, u32::MAX),
        (2, 4, 65534),
        (4, 4, u32::MAX),
        (16, 4, u32::MAX),
        (32, 0, u32::MAX),
    ] {
        result.extend(tag.to_le_bytes());
        result.extend(permission.to_le_bytes());
        result.extend(id.to_le_bytes());
    }
    result
}

#[test]
fn access_acl_is_preserved_without_inheriting_a_different_parent_default_acl() {
    let f = Fixture::new();
    let path = f.project().join("code.py");
    std::fs::write(&path, b"old").unwrap();
    let directory = File::open(f.project()).unwrap();
    let acl = fixture_acl();
    assert_eq!(
        unsafe {
            libc::fsetxattr(
                directory.as_raw_fd(),
                c"system.posix_acl_default".as_ptr(),
                acl.as_ptr().cast(),
                acl.len(),
                0,
            )
        },
        0
    );
    let (bound, base) = f.baseline("code.py");
    replace(&f.dir(), &bound, "code.py", &base, b"no extra ACL").unwrap();
    let file = File::open(&path).unwrap();
    assert_eq!(
        unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                c"system.posix_acl_access".as_ptr(),
                std::ptr::null_mut(),
                0,
            )
        },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ENODATA)
    );
    assert_eq!(
        unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                c"system.posix_acl_access".as_ptr(),
                acl.as_ptr().cast(),
                acl.len(),
                0,
            )
        },
        0
    );
    let (_, base) = f.baseline("code.py");
    replace(&f.dir(), &bound, "code.py", &base, b"keep actual ACL").unwrap();
    let saved = File::open(&path).unwrap();
    let mut actual = vec![0u8; acl.len()];
    assert_eq!(
        unsafe {
            libc::fgetxattr(
                saved.as_raw_fd(),
                c"system.posix_acl_access".as_ptr(),
                actual.as_mut_ptr().cast(),
                actual.len(),
            )
        },
        acl.len() as isize
    );
    assert_eq!(actual, acl);
    f.assert_no_temporary();
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("awu-document-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("project")).unwrap();
        Self(root)
    }
    fn project(&self) -> PathBuf {
        self.0.join("project")
    }
    fn dir(&self) -> String {
        self.project().to_str().unwrap().to_owned()
    }
    fn baseline(&self, path: &str) -> (String, Version) {
        let bound = bind(&self.dir()).unwrap().binding_id;
        let version = read(&self.dir(), &bound, path).unwrap().version.unwrap();
        (bound, version)
    }
    fn assert_no_temporary(&self) {
        assert!(std::fs::read_dir(self.project())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".awu-document-")));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let absolute = std::fs::canonicalize(&self.0).unwrap();
        assert_eq!(
            absolute.parent(),
            Some(
                std::fs::canonicalize(std::env::temp_dir())
                    .unwrap()
                    .as_path()
            )
        );
        assert!(absolute
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("awu-document-test-"));
        std::fs::remove_dir_all(absolute).unwrap();
    }
}

#[test]
fn bounded_read_and_atomic_replace_preserve_bytes_mode_owner_and_xattrs() {
    let f = Fixture::new();
    let path = f.project().join("code.py");
    std::fs::write(&path, b"old\r\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
    let file = File::open(&path).unwrap();
    let value = b"fixture-metadata";
    assert_eq!(
        unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                c"user.awu-fixture".as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        },
        0
    );
    let before = file.metadata().unwrap();
    let (bound, base) = f.baseline("code.py");
    let bytes = b"\xff\xfeN\0e\0w\0\r\0\n\0";
    let result = replace(&f.dir(), &bound, "code.py", &base, bytes).unwrap();
    assert_eq!(BASE64.decode(result.data).unwrap(), bytes);
    let saved = File::open(&path).unwrap();
    let after = saved.metadata().unwrap();
    assert_eq!(
        (before.mode(), before.uid(), before.gid()),
        (after.mode(), after.uid(), after.gid())
    );
    assert_ne!(before.ino(), after.ino());
    let mut attributes = [0u8; 16];
    assert_eq!(
        unsafe {
            libc::fgetxattr(
                saved.as_raw_fd(),
                c"user.awu-fixture".as_ptr(),
                attributes.as_mut_ptr().cast(),
                attributes.len(),
            )
        },
        value.len() as isize
    );
    assert_eq!(&attributes[..value.len()], value);
    assert_eq!(
        replace(&f.dir(), &bound, "code.py", &base, b"stale").unwrap_err(),
        "disk_conflict"
    );
    std::fs::write(f.project().join("large.py"), vec![b'x'; MAX_BYTES + 1]).unwrap();
    let large = read(&f.dir(), &bound, "large.py").unwrap();
    assert!(!large.complete && large.version.is_none());
    assert_eq!(BASE64.decode(large.data).unwrap().len(), PREVIEW_BYTES);
    f.assert_no_temporary();
}

#[test]
fn path_links_special_files_and_foreign_binding_are_rejected() {
    let f = Fixture::new();
    std::fs::write(f.project().join("code.py"), b"old").unwrap();
    let (bound, _) = f.baseline("code.py");
    for value in [
        "../escape",
        "/etc/passwd",
        "a/../../escape",
        "a\\b",
        "\0",
        "",
    ] {
        assert!(read(&f.dir(), &bound, value).is_err());
    }
    assert!(read(&f.dir(), "foreign", "code.py").is_err());
    symlink(f.project().join("code.py"), f.project().join("linked.py")).unwrap();
    assert!(read(&f.dir(), &bound, "linked.py").is_err());
    symlink(&f.0, f.project().join("linked-dir")).unwrap();
    assert!(read(&f.dir(), &bound, "linked-dir/project/code.py").is_err());
    symlink(f.project(), f.0.join("linked-root")).unwrap();
    assert!(bind(f.0.join("linked-root").to_str().unwrap()).is_err());
    std::fs::hard_link(f.project().join("code.py"), f.project().join("alias.py")).unwrap();
    assert!(read(&f.dir(), &bound, "code.py").is_err());
    let fifo = name(f.project().join("fifo").as_os_str()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(read(&f.dir(), &bound, "fifo").is_err()); // O_NONBLOCK，不能挂死测试。
}

#[test]
fn same_named_roots_and_deleted_recreated_objects_are_not_interchangeable() {
    let f = Fixture::new();
    let other = Fixture::new();
    std::fs::write(f.project().join("code.py"), b"old").unwrap();
    std::fs::write(other.project().join("code.py"), b"old").unwrap();
    let (bound, base) = f.baseline("code.py");
    assert_ne!(bound, bind(&other.dir()).unwrap().binding_id);
    assert!(read(&other.dir(), &bound, "code.py").is_err());
    std::fs::remove_file(f.project().join("code.py")).unwrap();
    assert!(replace(&f.dir(), &bound, "code.py", &base, b"new").is_err());
    std::fs::write(f.project().join("code.py"), b"old").unwrap();
    assert_eq!(
        replace(&f.dir(), &bound, "code.py", &base, b"new").unwrap_err(),
        "disk_conflict"
    );
    std::fs::rename(f.project(), f.0.join("moved")).unwrap();
    std::fs::create_dir(f.project()).unwrap();
    std::fs::write(f.project().join("code.py"), b"old").unwrap();
    assert_ne!(bound, bind(&f.dir()).unwrap().binding_id);
    assert!(read(&f.dir(), &bound, "code.py").is_err());
}

#[test]
fn inode_recreation_generation_changes_even_with_identical_bytes() {
    let f = Fixture::new();
    let path = f.project().join("code.py");
    std::fs::write(&path, b"identical").unwrap();
    for _ in 0..32 {
        let (bound, base) = f.baseline("code.py");
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"identical").unwrap();
        let current = read(&f.dir(), &bound, "code.py").unwrap().version.unwrap();
        assert_ne!(base.file_id, current.file_id);
        assert_eq!(
            replace(&f.dir(), &bound, "code.py", &base, b"stale").unwrap_err(),
            "disk_conflict"
        );
    }
}

#[test]
fn concurrent_baseline_saves_use_the_production_lock() {
    let f = Fixture::new();
    std::fs::write(f.project().join("code.py"), b"old").unwrap();
    let (bound, base) = f.baseline("code.py");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let handles: Vec<_> = (0..3)
        .map(|_| {
            let (dir, bound, base, barrier) =
                (f.dir(), bound.clone(), base.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                super::super::replace(&dir, &bound, "./code.py", &base, &BASE64.encode(b"new"))
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r.as_ref().is_err_and(|e| e == "disk_conflict"))
            .count(),
        2
    );
    assert_eq!(std::fs::read(f.project().join("code.py")).unwrap(), b"new");
    f.assert_no_temporary();
}

#[test]
fn external_edit_and_precommit_failure_preserve_original() {
    let f = Fixture::new();
    let path = f.project().join("code.py");
    std::fs::write(&path, b"old").unwrap();
    let (bound, base) = f.baseline("code.py");
    assert_eq!(
        replace_checked(
            &f.dir(),
            &bound,
            "code.py",
            &base,
            b"new",
            ".awu-document-failure.tmp",
            || Err("write_not_started".into()),
            || Ok(())
        )
        .unwrap_err(),
        "write_not_started"
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"old");
    assert_eq!(
        replace_checked(
            &f.dir(),
            &bound,
            "code.py",
            &base,
            b"new",
            ".awu-document-external.tmp",
            || {
                std::fs::write(&path, b"external").unwrap();
                Ok(())
            },
            || Ok(())
        )
        .unwrap_err(),
        "disk_conflict"
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"external");
    f.assert_no_temporary();
}

#[test]
fn directory_move_before_commit_is_rejected_and_cleanup_uses_owned_dirfd() {
    let f = Fixture::new();
    std::fs::create_dir(f.project().join("nested")).unwrap();
    std::fs::write(f.project().join("nested/code.py"), b"old").unwrap();
    let (bound, base) = f.baseline("nested/code.py");
    let result = replace_checked(
        &f.dir(),
        &bound,
        "nested/code.py",
        &base,
        b"new",
        ".awu-document-move.tmp",
        || {
            std::fs::rename(f.project().join("nested"), f.0.join("moved")).unwrap();
            std::fs::create_dir(f.project().join("nested")).unwrap();
            std::fs::write(f.project().join("nested/code.py"), b"unrelated").unwrap();
            Ok(())
        },
        || Ok(()),
    );
    assert_eq!(result.unwrap_err(), "stale_workspace");
    assert_eq!(std::fs::read(f.0.join("moved/code.py")).unwrap(), b"old");
    assert_eq!(
        std::fs::read(f.project().join("nested/code.py")).unwrap(),
        b"unrelated"
    );
    assert_eq!(std::fs::read_dir(f.0.join("moved")).unwrap().count(), 1);
}

#[test]
fn revoked_permissions_and_readonly_mode_cannot_be_bypassed_even_as_root() {
    let f = Fixture::new();
    let path = f.project().join("code.py");
    std::fs::write(&path, b"old").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
    let (bound, base) = f.baseline("code.py");
    assert!(read(&f.dir(), &bound, "code.py").unwrap().readonly);
    assert_eq!(
        replace(&f.dir(), &bound, "code.py", &base, b"new").unwrap_err(),
        "document_readonly"
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let (_, base) = f.baseline("code.py");
    let rejected = replace_checked(
        &f.dir(),
        &bound,
        "code.py",
        &base,
        b"new",
        ".awu-document-revoked.tmp",
        || {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
            Ok(())
        },
        || Ok(()),
    )
    .unwrap_err();
    // 同一个文件系统时间 tick 内 chmod 可能不改变 ctime；权限门槛仍须拒绝。
    assert!(["disk_conflict", "document_readonly"].contains(&rejected.as_str()));
    assert_eq!(std::fs::read(&path).unwrap(), b"old");
    f.assert_no_temporary();
}

#[test]
fn uncertain_result_is_not_retried_and_original_baseline_no_longer_wins() {
    let f = Fixture::new();
    let path = f.project().join("code.py");
    std::fs::write(&path, b"old").unwrap();
    let (bound, base) = f.baseline("code.py");
    assert_eq!(
        replace_checked(
            &f.dir(),
            &bound,
            "code.py",
            &base,
            b"new",
            ".awu-document-unknown.tmp",
            || Ok(()),
            || Err("lost_receipt".into())
        )
        .unwrap_err(),
        "save_result_unverified"
    );
    let actual = read(&f.dir(), &bound, "code.py").unwrap();
    assert_eq!(actual.data, BASE64.encode(b"new"));
    assert_ne!(actual.version.as_ref().unwrap(), &base);
    assert_eq!(
        replace(&f.dir(), &bound, "code.py", &base, b"retry").unwrap_err(),
        "disk_conflict"
    );
    f.assert_no_temporary();
}

#[test]
fn exclusive_temporary_collision_never_removes_unowned_file() {
    let f = Fixture::new();
    let path = f.project().join("code.py");
    std::fs::write(&path, b"old").unwrap();
    let (bound, base) = f.baseline("code.py");
    let occupied = f.project().join(".awu-document-collision.tmp");
    std::fs::write(&occupied, b"unrelated").unwrap();
    assert_eq!(
        replace_checked(
            &f.dir(),
            &bound,
            "code.py",
            &base,
            b"new",
            ".awu-document-collision.tmp",
            || Ok(()),
            || Ok(())
        )
        .unwrap_err(),
        "write_not_started"
    );
    assert_eq!(std::fs::read(occupied).unwrap(), b"unrelated");
    assert_eq!(std::fs::read(path).unwrap(), b"old");
}
