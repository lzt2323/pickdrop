import Tauri
import UIKit
import Photos
import WebKit

struct FileArgs: Decodable { let path: String }
struct IncomingResponse: Encodable { let items: [String] }
class PickDropNativePlugin: Plugin {
    @objc public func share(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(FileArgs.self)
        DispatchQueue.main.async {
            let sheet = UIActivityViewController(activityItems: [URL(fileURLWithPath: args.path)], applicationActivities: nil)
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  var controller = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { invoke.reject("无法打开分享面板"); return }
            while let presented = controller.presentedViewController { controller = presented }
            sheet.popoverPresentationController?.sourceView = controller.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX,y: controller.view.bounds.midY,width: 0,height: 0)
            controller.present(sheet, animated: true) { invoke.resolve() }
        }
    }
    @objc public func open(_ invoke: Invoke) throws { try share(invoke) }
    @objc public func backDefault(_ invoke: Invoke) { invoke.resolve() }
    @objc public func consumeIncoming(_ invoke: Invoke) { invoke.resolve(IncomingResponse(items: [])) }
    @objc public func saveGallery(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(FileArgs.self)
        let url = URL(fileURLWithPath: args.path)
        PHPhotoLibrary.requestAuthorization { status in
            var granted = status == .authorized
            if #available(iOS 14, *) { granted = granted || status == .limited }
            guard granted else { invoke.reject("请允许拾传保存到相册"); return }
            PHPhotoLibrary.shared().performChanges({
                let suffix = url.pathExtension.lowercased()
                if ["mp4","mov","m4v"].contains(suffix) { PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url) }
                else { PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url) }
            }) { success, error in
                if success { invoke.resolve() } else { invoke.reject(error?.localizedDescription ?? "保存相册失败") }
            }
        }
    }
}
@_cdecl("init_plugin_pickdrop_native")
public func initPlugin() -> Plugin { PickDropNativePlugin() }
