package app.pickdrop.composer

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues

class PickDropComposerModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val keyboard = KeyboardOverlapObserver { sendEvent("onKeyboardOverlap", it) }
  private var observingKeyboard = false
  override fun definition() = ModuleDefinition {
    Name("PickDropComposer")
    Events("onKeyboardOverlap")
    OnStartObserving {
      observingKeyboard = true
      appContext.currentActivity?.runOnUiThread { keyboard.attach(appContext.currentActivity) }
    }
    OnStopObserving {
      observingKeyboard = false
      main.post { keyboard.detach() }
    }
    OnActivityEntersForeground {
      if (observingKeyboard) appContext.currentActivity?.runOnUiThread { keyboard.attach(appContext.currentActivity) }
    }
    OnDestroy { main.post { keyboard.detach() } }
    AsyncFunction("getKeyboardOverlap") {
      keyboard.attach(appContext.currentActivity)
      keyboard.snapshot()
    }.runOnQueue(Queues.MAIN)
    View(PickDropComposerView::class) {
      Events("onTextChange", "onPasteImage", "onContentHeightChange")
      Prop("value") { view: PickDropComposerView, value: String -> view.pendingValue = value }
      Prop("mostRecentEventCount") { view: PickDropComposerView, count: Int -> view.mostRecentEventCount = count }
      Prop("editable") { view: PickDropComposerView, editable: Boolean -> view.setEditable(editable) }
      OnViewDidUpdateProps { view: PickDropComposerView -> view.applyPendingValue() }
    }
  }
}
