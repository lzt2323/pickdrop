package app.pickdrop.nativebridge

import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.OnBackPressedCallback
import android.content.Intent
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors

@InvokeArg
class FileArgs { var path: String = "" }

@TauriPlugin
class PickDropNativePlugin(private val activity: Activity): Plugin(activity) {
    private val io = Executors.newSingleThreadExecutor()
    private val pending = mutableListOf<JSObject>()
    private var multicast: WifiManager.MulticastLock? = null
    private val discovery = NativeDiscovery(activity)
    private fun acquireMulticast() {
        try {
            if (multicast == null) multicast = (activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createMulticastLock("pickdrop-discovery").apply { setReferenceCounted(false) }
            if (multicast?.isHeld == false) multicast?.acquire()
        } catch (_: Exception) { /* Direct-address invitations remain available. */ }
    }
    override fun load(webView: WebView) {
        acquireMulticast(); ingest(activity.intent)
        val owner = activity as? AppCompatActivity
        owner?.onBackPressedDispatcher?.addCallback(owner, object: OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { trigger("back", JSObject()) }
        })
    }
    @Command
    fun configureDiscovery(invoke: Invoke) {
        val args=invoke.parseArgs(DiscoveryArgs::class.java)
        activity.runOnUiThread { discovery.configure(args); invoke.resolve() }
    }
    override fun onDestroy(activity: AppCompatActivity) { discovery.pause(); if (multicast?.isHeld==true)multicast?.release(); io.shutdown() }
    @Command
    fun backDefault(invoke: Invoke) {
        activity.runOnUiThread { activity.moveTaskToBack(true); invoke.resolve() }
    }
    override fun onResume(activity: AppCompatActivity) { acquireMulticast(); discovery.resume() }
    override fun onPause(activity: AppCompatActivity) { discovery.pause(); if (multicast?.isHeld == true) multicast?.release() }
    override fun onNewIntent(intent: Intent) { ingest(intent) }
    private fun mime(file: File) = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"
    private fun ingest(intent: Intent?) {
        if (intent == null || intent.action !in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return
        val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty() else listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        // Consume once, including cold launches; stream copy uses a worker, never JS or the UI thread.
        intent.action = Intent.ACTION_MAIN
        io.execute {
            for (uri in uris) try {
                var name = "文件"
                activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) name = c.getString(0) ?: name }
                val dir = File(activity.filesDir, "incoming").apply { mkdirs() }
                val unique = File(dir, System.nanoTime().toString()).apply { mkdirs() }
                val file = File(unique, name.replace('/', '_').replace('\\', '_'))
                activity.contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { input.copyTo(it) } } ?: continue
                synchronized(pending) { pending.add(JSObject().put("path",file.absolutePath).put("name",name).put("size",file.length())) }
            } catch (_: Exception) { /* Failed provider reads leave no UI-thread work. */ }
            if (!text.isNullOrBlank()) synchronized(pending) { pending.add(JSObject().put("text", text)) }
            activity.runOnUiThread { trigger("incoming", JSObject()) }
        }
    }
    @Command
    fun metadata(invoke: Invoke) {
        val args = invoke.parseArgs(FileArgs::class.java)
        io.execute {
            try {
                val uri = Uri.parse(args.path)
                var name = "文件"
                var size = 0L
                activity.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE),null,null,null)?.use { cursor ->
                    if (cursor.moveToFirst()) { name = cursor.getString(0) ?: name; if (!cursor.isNull(1)) size = cursor.getLong(1) }
                }
                invoke.resolve(JSObject().put("name",name).put("size",size))
            } catch (e: Exception) { invoke.reject(e.message ?: "无法读取文件信息") }
        }
    }
    @Command
    fun consumeIncoming(invoke: Invoke) {
        io.execute {
            val result = synchronized(pending) { val result = JSONArray(pending.toList()); pending.clear(); result }
            invoke.resolve(JSObject().put("items", result))
        }
    }
    @Command
    fun share(invoke: Invoke) = launchFile(invoke, true)
    @Command
    fun open(invoke: Invoke) = launchFile(invoke, false)
    private fun launchFile(invoke: Invoke, share: Boolean) {
        val args = invoke.parseArgs(FileArgs::class.java)
        io.execute {
            try {
                val source = File(args.path)
                val dir = File(activity.cacheDir,"pickdrop-share").apply { mkdirs() }
                dir.listFiles()?.filter { System.currentTimeMillis()-it.lastModified()>24*60*60*1000 }?.forEach { it.delete() }
                val file = File(dir, source.name); source.copyTo(file, overwrite=true)
                val uri = FileProvider.getUriForFile(activity,"${activity.packageName}.pickdrop.files",file)
                val intent = Intent(if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW).apply {
                    type = mime(source)
                    if (share) putExtra(Intent.EXTRA_STREAM,uri) else setDataAndType(uri,mime(source))
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.runOnUiThread {
                    try { activity.startActivity(Intent.createChooser(intent, if (share) "分享文件" else "打开文件")); invoke.resolve() }
                    catch (e: Exception) { invoke.reject(e.message ?: "没有可用的应用") }
                }
            } catch (e: Exception) { invoke.reject(e.message ?: "无法读取文件") }
        }
    }
    @Command
    fun saveGallery(invoke: Invoke) {
        val args = invoke.parseArgs(FileArgs::class.java)
        io.execute {
            try {
                if (Build.VERSION.SDK_INT < 29) { invoke.reject("Android 10 以下请通过保存文件导出图片"); return@execute }
                val file = File(args.path); val type = mime(file)
                require(type.startsWith("image/") || type.startsWith("video/")) { "只有图片和视频可以保存到相册" }
                val collection = if (type.startsWith("video/")) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                val values = ContentValues().apply { put(MediaStore.MediaColumns.DISPLAY_NAME,file.name); put(MediaStore.MediaColumns.MIME_TYPE,type); put(MediaStore.MediaColumns.RELATIVE_PATH,if(type.startsWith("video/"))"Movies/PickDrop" else "Pictures/PickDrop"); put(MediaStore.MediaColumns.IS_PENDING,1) }
                val uri = activity.contentResolver.insert(collection,values) ?: error("无法创建相册文件")
                try {
                    activity.contentResolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("无法写入相册")
                    values.clear(); values.put(MediaStore.MediaColumns.IS_PENDING,0);activity.contentResolver.update(uri,values,null,null)
                    invoke.resolve(JSObject().put("uri",uri.toString()))
                } catch (e: Exception) { activity.contentResolver.delete(uri,null,null); throw e }
            } catch (e: Exception) { invoke.reject(e.message ?: "保存相册失败") }
        }
    }
}

class PickDropFileProvider: FileProvider()
