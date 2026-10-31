fn main() {
    println!("cargo:rerun-if-changed=../src/_version.py");
    let stamped = std::fs::read_to_string("../src/_version.py").expect("release identity source");
    for (source, destination) in [
        ("__display_version__", "AWU_DISPLAY_VERSION"), ("__package_version__", "AWU_PACKAGE_VERSION"),
        ("__build_id__", "AWU_BUILD_ID"), ("__build_sequence__", "AWU_BUILD_SEQUENCE"),
    ] {
        let value = stamped.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == source).then(|| value.trim().trim_matches('\'').trim_matches('"'))
        }).unwrap_or("");
        println!("cargo:rustc-env={destination}={value}");
    }
    tauri_build::build()
}
