//! Read-only installed-instance identity. A missing/ambiguous registry entry is unsupported.
use std::path::Path;

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
                        if let Some(location) = value(child, "InstallLocation").and_then(|v| Path::new(&v).canonicalize().ok()) {
                            locations.insert(location);
                        }
                    }
                    RegCloseKey(child);
                }
                RegCloseKey(key);
            }
        }
    }
    locations.len() == 1 && locations.contains(&parent)
}

#[cfg(not(windows))]
pub fn installed(_exe: &Path) -> bool { false }
