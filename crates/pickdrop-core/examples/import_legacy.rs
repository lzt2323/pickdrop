use pickdrop_core::Core;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    anyhow::ensure!(
        args.len() == 3,
        "Usage: import_legacy <old desktop data directory> <NEW empty data directory>"
    );
    let report =
        Core::import_legacy_desktop(args[1].clone().into(), args[2].clone().into()).await?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
