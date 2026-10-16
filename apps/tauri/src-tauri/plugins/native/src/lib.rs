#[cfg(mobile)]
use tauri::{plugin::PluginHandle, Manager};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pickdrop_native);
#[cfg(mobile)]
pub struct Native<R: Runtime>(PluginHandle<R>);
#[cfg(mobile)]
impl<R: Runtime> Native<R> {
    pub fn call(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.0
            .run_mobile_plugin(command, args)
            .map_err(|e| e.to_string())
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pickdrop-native")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle =
                api.register_android_plugin("app.pickdrop.nativebridge", "PickDropNativePlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_pickdrop_native)?;
            #[cfg(mobile)]
            app.manage(Native(handle));
            #[cfg(desktop)]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
