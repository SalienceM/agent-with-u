//! Read-only installed-instance identity. A missing/ambiguous registry entry is unsupported.
use std::path::Path;

// NSIS writes InstallLocation with a matched outer pair of quotes. This is a
// directory, never a command line: do not split arguments or expand variables.
fn install_location(value: &str) -> Option<&Path> {
    let trimmed = value.trim();
    let location = if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    if location.is_empty() || location.contains('"') || location.chars().any(char::is_control) {
        return None;
    }
    let path = Path::new(location);
    path.is_absolute().then_some(path)
}

fn unique_installation(parent: &Path, locations: &std::collections::HashSet<std::path::PathBuf>) -> bool {
    locations.len() == 1 && locations.contains(parent)
}

#[cfg(windows)]
pub fn installed(exe: &Path) -> bool {
    use windows_sys::Win32::System::Registry::*;
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, ERROR_NO_MORE_ITEMS};
    fn wide(v: &str) -> Vec<u16> { v.encode_utf16().chain(Some(0)).collect() }
    unsafe fn value(key: HKEY, name: &str) -> Option<String> {
        let mut bytes = vec![0u16; 4096];
        let mut size = (bytes.len() * 2) as u32;
        let mut kind = 0;
        if RegQueryValueExW(key, wide(name).as_ptr(), std::ptr::null(), &mut kind,
                           bytes.as_mut_ptr() as *mut u8, &mut size) != ERROR_SUCCESS
            || kind != REG_SZ || size < 2 || size > 8192 { return None; }
        Some(String::from_utf16_lossy(&bytes[..(size as usize / 2)]).trim_end_matches('\0').to_owned())
    }
    let parent = match exe.parent().and_then(|p| p.canonicalize().ok()) { Some(p) => p, None => return false };
    let mut locations = std::collections::HashSet::new();
    unsafe {
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                let mut key = std::ptr::null_mut();
                if RegOpenKeyExW(hive, wide("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall").as_ptr(),
                                 0, KEY_READ | view, &mut key) != ERROR_SUCCESS { continue; }
                for index in 0..4096 {
                    let mut name = [0u16; 512]; let mut length = name.len() as u32;
                    let result = RegEnumKeyExW(key, index, name.as_mut_ptr(), &mut length, std::ptr::null(),
                                              std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
                    if result == ERROR_NO_MORE_ITEMS { break; }
                    if result != ERROR_SUCCESS { continue; }
                    let mut child = std::ptr::null_mut();
                    if RegOpenKeyExW(key, name.as_ptr(), 0, KEY_READ | view, &mut child) != ERROR_SUCCESS { continue; }
                    let display = value(child, "DisplayName").unwrap_or_default();
                    if display.to_lowercase().starts_with("agentwithu") {
                        if let Some(location) = value(child, "InstallLocation")
                            .and_then(|v| install_location(&v).and_then(|p| p.canonicalize().ok())) {
                            locations.insert(location);
                        }
                    }
                    RegCloseKey(child);
                }
                RegCloseKey(key);
            }
        }
    }
    unique_installation(&parent, &locations)
}

#[cfg(not(windows))]
pub fn installed(_exe: &Path) -> bool { false }

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    #[test]
    fn accepts_nsis_quotes_and_plain_directories() {
        let expected = Path::new(r"C:\Users\Test User\AppData\Local\AgentWithU");
        for value in [expected.to_str().unwrap().to_owned(), format!("\"{}\"", expected.display()),
                      format!("  \"{}\"  ", expected.display())] {
            assert_eq!(install_location(&value), Some(expected));
        }
    }

    #[test]
    fn rejects_empty_relative_malformed_or_command_values() {
        for value in ["", " ", "\"\"", "\" \"", "AgentWithU", r"C:AgentWithU", r"\AgentWithU",
                      "\"C:\\AgentWithU", "C:\\AgentWithU\"", "\"\"C:\\AgentWithU\"\"",
                      "\"C:\\AgentWithU\" /S", "C:\\Agent\0WithU", "C:\\Agent\nWithU"] {
            assert!(install_location(value).is_none(), "accepted {value:?}");
        }
    }

    #[test]
    fn duplicate_registry_views_are_one_location_but_other_installs_are_not() {
        let parent = PathBuf::from(r"C:\Apps\AgentWithU");
        let other = PathBuf::from(r"D:\Apps\AgentWithU");
        let mut locations = HashSet::new();
        assert!(!unique_installation(&parent, &locations));
        locations.insert(other.clone());
        assert!(!unique_installation(&parent, &locations));
        locations.clear();
        locations.insert(parent.clone());
        locations.insert(parent.clone());
        assert!(unique_installation(&parent, &locations));
        locations.insert(other);
        assert!(!unique_installation(&parent, &locations));
    }

    #[test]
    fn quoted_existing_directory_resolves_to_the_real_executable_parent() {
        let root = std::env::temp_dir().join(format!("awu-installed-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let result = (|| {
            let quoted = format!("\"{}\"", root.display());
            let canonical = install_location(&quoted).unwrap().canonicalize().unwrap();
            let parent = root.join("agent-with-u.exe").parent().unwrap().canonicalize().unwrap();
            let locations = HashSet::from([canonical]);
            assert!(unique_installation(&parent, &locations));
        })();
        std::fs::remove_dir(&root).unwrap();
        result
    }
}
