package app.pickdrop.nativebridge

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject
import org.json.JSONArray
import java.net.Inet4Address
import java.util.ArrayDeque

@InvokeArg
class DiscoveryGroup { var id: String = ""; var name: String = "传输群" }
@InvokeArg
class DiscoveryArgs {
    var deviceId: String = ""
    var port: Int = 0
    var baseUrl: String = ""
    var groups: List<DiscoveryGroup> = emptyList()
    lateinit var events: Channel
}

/** System NSD uses Android's daemon, avoiding per-app VPN capture of Rust UDP. */
class NativeDiscovery(private val activity: Activity) {
    private val main = Handler(Looper.getMainLooper())
    private val manager = activity.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var configuration: DiscoveryArgs? = null
    private var fingerprint = ""
    private var active = true
    private var listener: NsdManager.DiscoveryListener? = null
    private val registrations = mutableListOf<NsdManager.RegistrationListener>()
    private val callbacks = mutableMapOf<String, NsdManager.ServiceInfoCallback>()
    private val present = mutableSetOf<String>()
    private val waiting = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var generation = 0
    private fun key(info: NsdServiceInfo) = "${info.serviceName}|${info.serviceType}"
    fun configure(args: DiscoveryArgs) {
        val next = "${args.deviceId}|${args.port}|${args.baseUrl}|${physicalNetwork()?.networkHandle}|" + args.groups.take(32).sortedBy { it.id }.joinToString { "${it.id}:${it.name}" }
        configuration = args
        if (next == fingerprint && listener != null) return
        fingerprint = next
        stop()
        if (active) start()
    }
    fun resume() { active = true; if (listener == null) start() }
    fun pause() { active = false; stop() }
    private fun physicalNetwork(): Network? {
        val connectivity = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return connectivity.allNetworks.firstOrNull { network ->
            val caps = connectivity.getNetworkCapabilities(network)
            caps != null && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        }
    }
    private fun start() {
        val args = configuration ?: return
        if (args.port !in 1..65535 || args.deviceId.length != 36) return
        val network = physicalNetwork()
        val session = ++generation
        val discovery = object: NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, errorCode: Int) { main.post { if (generation == session) { stop(); main.postDelayed({ if (active && generation != session) start() }, 3000) } } }
            override fun onStopDiscoveryFailed(type: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) { main.post {
                if (generation == session && info.serviceType.trimEnd('.') == "_pickdrop._tcp" && present.size < 100 && present.add(key(info))) {
                    if (Build.VERSION.SDK_INT >= 34) watch(info,session)
                    else { waiting.add(info); resolveNext(session) }
                }
            } }
            override fun onServiceLost(info: NsdServiceInfo) { main.post {
                if(generation!=session)return@post
                present.remove(key(info))
                if (Build.VERSION.SDK_INT >= 34) callbacks.remove(key(info))?.let { runCatching { manager.unregisterServiceInfoCallback(it) } }
            } }
        }
        listener = discovery
        try {
            if (Build.VERSION.SDK_INT >= 33 && network != null) manager.discoverServices("_pickdrop._tcp.", NsdManager.PROTOCOL_DNS_SD, network, activity.mainExecutor, discovery)
            else manager.discoverServices("_pickdrop._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery)
        } catch (_: Exception) { listener = null }
        for (group in args.groups.take(32)) {
            if (group.id.length != 36) continue
            val info = NsdServiceInfo().apply {
                serviceName = "pickdrop-${group.id.take(8)}-${args.deviceId}"
                serviceType = "_pickdrop._tcp."
                port = args.port
                setAttribute("protocol","pickdrop");setAttribute("version","1")
                setAttribute("groupId",group.id);setAttribute("hostDeviceId",args.deviceId)
                setAttribute("peerProtocol","pickdrop-peer-v1");setAttribute("name",group.name.take(60))
                if (Build.VERSION.SDK_INT >= 33 && network != null) setNetwork(network)
            }
            val registration = object: NsdManager.RegistrationListener {
                override fun onServiceRegistered(info: NsdServiceInfo) {}
                override fun onRegistrationFailed(info: NsdServiceInfo,errorCode: Int) {}
                override fun onServiceUnregistered(info: NsdServiceInfo) {}
                override fun onUnregistrationFailed(info: NsdServiceInfo,errorCode: Int) {}
            }
            try { manager.registerService(info,NsdManager.PROTOCOL_DNS_SD,registration);registrations.add(registration) } catch (_: Exception) {}
        }
    }
    private fun resolved(info: NsdServiceInfo, session: Int) {
        if (generation != session || !active || info.port !in 1..65535) return
        val args = configuration ?: return
        fun txt(name: String) = info.attributes[name]?.toString(Charsets.UTF_8) ?: ""
        val device = txt("hostDeviceId");val group = txt("groupId")
        if (txt("protocol") != "pickdrop" || txt("peerProtocol") != "pickdrop-peer-v1" || device == args.deviceId || device.length != 36 || group.length != 36) return
        val addresses = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
        val records = JSONArray()
        for (address in addresses.filterIsInstance<Inet4Address>().filter { !it.isLoopbackAddress && !it.isLinkLocalAddress && !it.isAnyLocalAddress && !it.isMulticastAddress }.take(8)) {
            records.put(JSObject().put("groupId",group).put("hostDeviceId",device).put("name",txt("name")).put("peerProtocol","pickdrop-peer-v1").put("baseUrl","http://${address.hostAddress}:${info.port}"))
        }
        if (records.length() > 0) args.events.send(JSObject().put("records",records))
    }
    @android.annotation.TargetApi(34)
    private fun watch(info: NsdServiceInfo, session: Int) {
        val callback = object: NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) { main.post { callbacks.remove(key(info));if(generation==session){waiting.add(info);resolveNext(session)} } }
            override fun onServiceUpdated(info: NsdServiceInfo) { main.post { resolved(info,session) } }
            override fun onServiceLost() {}
            override fun onServiceInfoCallbackUnregistered() {}
        }
        callbacks[key(info)] = callback
        try { manager.registerServiceInfoCallback(info,activity.mainExecutor,callback) } catch (_: Exception) { callbacks.remove(key(info));waiting.add(info);resolveNext(session) }
    }
    @Suppress("DEPRECATION")
    private fun resolveNext(session: Int) {
        if (resolving || waiting.isEmpty() || generation != session) return
        resolving = true
        val info = waiting.removeFirst()
        var finished = false
        fun finish() { if(finished || generation != session)return;finished=true;resolving=false;resolveNext(session) }
        val callback = object: NsdManager.ResolveListener {
            override fun onResolveFailed(info:NsdServiceInfo,errorCode:Int) { main.post { finish() } }
            override fun onServiceResolved(info:NsdServiceInfo) { main.post { resolved(info,session);finish() } }
        }
        main.postDelayed({ if(!finished && generation==session){if(Build.VERSION.SDK_INT>=34)runCatching{manager.stopServiceResolution(callback)};finish()} },8000)
        try { manager.resolveService(info,callback) } catch (_:Exception) { finish() }
    }
    private fun stop() {
        generation++
        listener?.let { runCatching { manager.stopServiceDiscovery(it) } };listener=null
        registrations.forEach { runCatching { manager.unregisterService(it) } };registrations.clear()
        if(Build.VERSION.SDK_INT>=34)callbacks.values.forEach { runCatching { manager.unregisterServiceInfoCallback(it) } }
        callbacks.clear();present.clear();waiting.clear();resolving=false
    }
}
