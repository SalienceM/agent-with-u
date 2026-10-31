//! One-shot, owned Kit update handoff. Tests inject an inert runner.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const PROTOCOL: u64 = 1;

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().filter(|v| !v.is_empty()).ok_or_else(|| format!("missing {key}"))
}

pub fn digest(value: &Value) -> Result<String, String> {
    // serde_json's default map is sorted; matches the UTF-8 Python journal canonical JSON.
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)))
}

fn read(path: &Path) -> Result<Value, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("update record exceeds limit".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn managed(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let resolved = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) || resolved == root {
        return Err("path outside managed updates".into());
    }
    let mut cursor = path.to_path_buf();
    while cursor != root && cursor.parent().is_some() {
        let metadata = fs::symlink_metadata(&cursor).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        { use std::os::windows::fs::MetadataExt;
          if metadata.file_attributes() & 0x400 != 0 { return Err("reparse update path".into()); } }
        if metadata.file_type().is_symlink() { return Err("linked update path".into()); }
        cursor.pop();
    }
    Ok(resolved)
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut stream = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut block = [0u8; 65536];
    loop {
        let size = stream.read(&mut block).map_err(|e| e.to_string())?;
        if size == 0 { break; }
        hash.update(&block[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub struct Validated {
    pub plan: Value,
    pub binding: Value,
    pub folder: PathBuf,
    pub request: String,
}

pub fn validate(root: &Path, plan_path: &Path, actual_exe: Option<&Path>, actual_pid: Option<u32>) -> Result<Validated, String> {
    let plan_path = managed(root, plan_path)?;
    if plan_path.file_name().and_then(|v| v.to_str()) != Some("install-plan.json") {
        return Err("unexpected plan name".into());
    }
    let plan = read(&plan_path)?;
    let binding = plan["kitUpdate"].clone();
    let request = text(&binding, "requestId")?.to_owned();
    if request.len() != 32 || !request.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || binding["protocol"].as_u64() != Some(PROTOCOL) {
        return Err("unsupported Kit request".into());
    }
    let folder = root.join("kit-installs");
    let record = read(&managed(root, &folder.join(format!("{request}.json")))?)?;
    let slot = read(&managed(root, &folder.join("reservation.json"))?)?;
    if slot["requestId"] != binding["requestId"] || slot["identity"] != binding["identity"]
        || record["requestId"] != binding["requestId"] || record["identity"] != binding["identity"]
        || record["schemaVersion"].as_u64() != Some(PROTOCOL)
        || !matches!(record["phase"].as_str(), Some("handing_off" | "waiting_restart" | "result_unknown"))
        || record["confirmationId"].as_str().unwrap_or("").is_empty()
        || record["planFingerprint"] != binding["planFingerprint"]
        || digest(&record["plan"])? != text(&binding, "planFingerprint")? {
        return Err("Kit request/confirmation/fingerprint mismatch".into());
    }
    let mut installer = plan.clone();
    installer.as_object_mut().ok_or("invalid plan")?.remove("kitUpdate");
    if installer != record["plan"]["installPlan"] { return Err("installer plan changed".into()); }
    let artifact = managed(root, Path::new(text(&plan, "artifactPath")?))?;
    if file_hash(&artifact)? != text(&plan, "artifactSha256")?
        || fs::metadata(&artifact).map_err(|e| e.to_string())?.len() != record["plan"]["artifact"]["size"].as_u64().ok_or("missing size")? {
        return Err("staged artifact checksum/size mismatch".into());
    }
    let exe = text(&record["plan"]["desktop"], "exe")?;
    if plan["restart"]["program"] != exe || plan["restart"]["args"] != json!([]) {
        return Err("restart must target the bound desktop".into());
    }
    if let Some(actual) = actual_exe {
        if fs::canonicalize(actual).map_err(|e| e.to_string())? != fs::canonicalize(exe).map_err(|e| e.to_string())? {
            return Err("wrong installation instance".into());
        }
    }
    if let Some(pid) = actual_pid {
        if record["plan"]["desktop"]["pid"].as_u64() != Some(pid as u64) {
            return Err("wrong desktop process".into());
        }
    }
    let desktop_pid = record["plan"]["desktop"]["pid"].as_u64().ok_or("desktop pid missing")?;
    let backend_pid = record["plan"]["backendPid"].as_u64().ok_or("backend pid missing")?;
    let pids = plan["waitPids"].as_array().ok_or("wait pids missing")?;
    if pids.len() != 2 || !pids.contains(&json!(desktop_pid)) || !pids.contains(&json!(backend_pid)) {
        return Err("unowned wait processes".into());
    }
    // No model-supplied command, cwd, or installer executable.
    let artifact_text = text(&plan, "artifactPath")?;
    let expected = match record["plan"]["artifact"]["kind"].as_str() {
        Some("msi") => ("msiexec.exe", json!(["/i", artifact_text, "/qn", "/norestart"])),
        Some("nsis") => (artifact_text, json!(["/S"])),
        _ => return Err("unsupported Kit installer".into()),
    };
    if plan["install"]["program"] != expected.0 || plan["install"]["args"] != expected.1 {
        return Err("untrusted installer command".into());
    }
    Ok(Validated { plan, binding, folder, request })
}

fn exclusive(path: &Path, value: &Value) -> Result<bool, String> {
    let mut stream = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(stream) => stream,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    stream.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    stream.sync_all().map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn claim_launch(valid: &Validated) -> Result<bool, String> {
    exclusive(&valid.folder.join(format!("{}.launch.json", valid.request)), &valid.binding)
}

pub fn fail_unlaunched(valid: &Validated, error: &str) -> Result<(), String> {
    let mut receipt = valid.binding.clone();
    receipt["installation"] = json!("failed");
    receipt["restart"] = json!("not_started");
    receipt["error"] = json!(error);
    exclusive(&valid.folder.join(format!("{}.result.json", valid.request)), &receipt)?;
    Ok(())
}

pub enum Installation { Succeeded(i32), Failed(String), Unknown(String) }
pub trait Runner {
    fn wait_owned(&mut self, pids: &[u32]) -> Result<(), String>;
    fn install(&mut self, plan: &Value) -> Installation;
    fn restart(&mut self, plan: &Value) -> Result<(), String>;
}

pub fn run(root: &Path, plan_path: &Path, runner: &mut impl Runner) -> Result<Value, String> {
    let valid = validate(root, plan_path, None, None)?;
    let claim = valid.folder.join(format!("{}.claim.json", valid.request));
    if !exclusive(&claim, &valid.binding)? { return Ok(json!({"status":"already_claimed"})); }
    let pids = valid.plan["waitPids"].as_array().ok_or("wait pids missing")?.iter()
        .map(|v| v.as_u64().unwrap_or(0) as u32).collect::<Vec<_>>();
    let installed = match runner.wait_owned(&pids) {
        Ok(()) => runner.install(&valid.plan),
        Err(error) => Installation::Failed(error),
    };
    let mut receipt = valid.binding.clone();
    receipt["finishedAt"] = json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs_f64());
    match installed {
        Installation::Succeeded(code) => {
            receipt["installation"] = json!("succeeded");
            receipt["exitCode"] = json!(code);
            exclusive(&valid.folder.join(format!("{}.installed.json", valid.request)), &receipt)?;
            match runner.restart(&valid.plan) {
                Ok(()) => receipt["restart"] = json!("started"),
                Err(error) => { receipt["restart"] = json!("failed"); receipt["error"] = json!(error); }
            }
        }
        Installation::Failed(error) => {
            receipt["installation"] = json!("failed"); receipt["error"] = json!(error);
            receipt["restart"] = json!("not_started");
        }
        Installation::Unknown(error) => {
            receipt["installation"] = json!("unknown"); receipt["error"] = json!(error);
            receipt["restart"] = json!("not_started");
        }
    }
    // 独立请求的结果只写一次；部分写入按未知处理，绝不借用普通 install-result。
    exclusive(&valid.folder.join(format!("{}.result.json", valid.request)), &receipt)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { root: PathBuf, plan: PathBuf, request: String }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
    }
    fn write(path: &Path, value: &Value) { fs::write(path, serde_json::to_vec(value).unwrap()).unwrap(); }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("awu-kit-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("kit-installs")).unwrap();
            let artifact = root.join("fake.msi");
            fs::write(&artifact, b"inert").unwrap();
            let exe = root.join("fake-desktop.exe");
            fs::write(&exe, b"never execute").unwrap();
            let request = "a".repeat(32);
            let identity = json!({"ownerId":"o", "deviceId":"d", "instanceId":"i", "sessionId":"s", "runId":"r", "stepId":"u"});
            let mut installer = json!({"artifactPath":artifact, "artifactSha256":file_hash(&artifact).unwrap(),
                "waitPids":[12,34], "install":{"program":"msiexec.exe", "args":["/i",artifact,"/qn","/norestart"]},
                "restart":{"program":exe,"args":[]}});
            let frozen = json!({"protocol":1,"requestId":request,"identity":identity,"installPlan":installer,
                "desktop":{"exe":exe,"pid":12},"backendPid":34,"artifact":{"size":5,"kind":"msi"}});
            let binding = json!({"protocol":1,"requestId":request,"identity":identity,"planFingerprint":digest(&frozen).unwrap()});
            let record = json!({"schemaVersion":1,"requestId":request,"identity":identity,"phase":"handing_off",
                "confirmationId":"confirmed-on-panel", "planFingerprint":digest(&frozen).unwrap(),"plan":frozen});
            write(&root.join("kit-installs").join(format!("{request}.json")), &record);
            write(&root.join("kit-installs/reservation.json"), &json!({"requestId":request,"identity":identity}));
            installer["kitUpdate"] = binding;
            let plan = root.join("install-plan.json");
            write(&plan, &installer);
            Self { root, plan, request }
        }
    }
    #[derive(Default)]
    struct Fake { installs: usize, restarts: usize, failed: bool, unknown: bool, spawn_failed: bool }
    impl Runner for Fake {
        fn wait_owned(&mut self, pids: &[u32]) -> Result<(), String> { assert_eq!(pids, &[12,34]); Ok(()) }
        fn install(&mut self, _: &Value) -> Installation {
            self.installs += 1;
            if self.unknown { Installation::Unknown("exit unconfirmed".into()) }
            else if self.failed { Installation::Failed("fake install failed".into()) }
            else { Installation::Succeeded(0) }
        }
        fn restart(&mut self, _: &Value) -> Result<(), String> {
            self.restarts += 1;
            if self.spawn_failed { Err("fake spawn failed".into()) } else { Ok(()) }
        }
    }
    #[test] fn duplicate_notifications_only_install_once() {
        let fixture = Fixture::new();
        let valid = validate(&fixture.root, &fixture.plan, None, Some(12)).unwrap();
        assert!(claim_launch(&valid).unwrap());
        assert!(!claim_launch(&valid).unwrap());
        let mut fake = Fake::default();
        let result = run(&fixture.root, &fixture.plan, &mut fake).unwrap();
        assert_eq!(result["installation"], "succeeded");
        assert_eq!(result["restart"], "started");
        assert_eq!(run(&fixture.root, &fixture.plan, &mut fake).unwrap()["status"], "already_claimed");
        assert_eq!(fake.installs, 1);
        assert_eq!(fake.restarts, 1);
    }
    #[test] fn tampered_artifact_plan_instance_and_outside_path_fail() {
        let fixture = Fixture::new();
        assert!(validate(&fixture.root, &fixture.plan, None, Some(99)).is_err());
        assert!(validate(&fixture.root.join("kit-installs"), &fixture.plan, None, None).is_err());
        let mut plan = read(&fixture.plan).unwrap();
        plan["install"]["program"] = json!("arbitrary.exe");
        write(&fixture.plan, &plan);
        assert!(run(&fixture.root, &fixture.plan, &mut Fake::default()).is_err());
        let fixture = Fixture::new();
        fs::write(fixture.root.join("fake.msi"), b"bad!!").unwrap();
        assert!(run(&fixture.root, &fixture.plan, &mut Fake::default()).is_err());
    }
    #[test] fn failures_and_unknown_exits_never_become_success() {
        for (failed, unknown, spawn_failed) in [(true,false,false),(false,true,false),(false,false,true)] {
            let fixture = Fixture::new();
            let mut fake = Fake { failed, unknown, spawn_failed, ..Fake::default() };
            let result = run(&fixture.root, &fixture.plan, &mut fake).unwrap();
            assert_ne!(result["restart"], "started");
            assert_eq!(fake.restarts, if spawn_failed {1} else {0});
            assert!(fixture.root.join("kit-installs").join(format!("{}.result.json",fixture.request)).exists());
        }
    }
    #[test] fn missing_or_cross_run_confirmation_cannot_launch() {
        let fixture = Fixture::new();
        let path = fixture.root.join("kit-installs").join(format!("{}.json",fixture.request));
        let mut record = read(&path).unwrap();
        record["confirmationId"] = json!("");
        write(&path, &record);
        assert!(validate(&fixture.root, &fixture.plan, None, None).is_err());
        record["confirmationId"] = json!("confirmed");
        record["identity"]["runId"] = json!("other");
        write(&path, &record);
        assert!(validate(&fixture.root, &fixture.plan, None, None).is_err());
    }
}
