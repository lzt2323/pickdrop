// swift-tools-version:5.3
import PackageDescription
let package = Package(name:"tauri-plugin-pickdrop-native",platforms:[.iOS(.v13)],products:[.library(name:"tauri-plugin-pickdrop-native",type:.static,targets:["tauri-plugin-pickdrop-native"])],dependencies:[.package(name:"Tauri",path:"../.tauri/tauri-api")],targets:[.target(name:"tauri-plugin-pickdrop-native",dependencies:[.byName(name:"Tauri")],path:"Sources")])
