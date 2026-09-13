fn main() {
    // Pinned engine ref lives in package.json so build script, CI and app share one source.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let package_json = std::path::Path::new(&manifest_dir).join("..").join("package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    let pinned = std::fs::read_to_string(&package_json)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| {
            json.get("audiosyncEngine")?
                .get("ref")?
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=AUDIOSYNC_ENGINE_REF={pinned}");

    tauri_build::build();
}
