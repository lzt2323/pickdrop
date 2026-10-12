package app.pickdrop.composer

import android.app.Activity
import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.uimanager.RootView
import kotlin.math.max

/** Measures only keyboard pixels still covering React after the system's resize.
 * Does not replace the activity's insets listener, change soft-input mode, or
 * mutate native padding (React remains the single owner of content layout).
 */
internal class KeyboardOverlapObserver(private val emit: (Map<String, Any>) -> Unit) {
  private var activity: Activity? = null
  private var decor: View? = null
  private var last: Map<String, Any>? = null
  private val listener = ViewTreeObserver.OnGlobalLayoutListener { report() }

  fun attach(next: Activity?) {
    if (next == null) return
    if (activity === next && decor != null) { report(); return }
    detach()
    activity = next
    decor = next.window.decorView
    decor?.viewTreeObserver?.addOnGlobalLayoutListener(listener)
    decor?.post { report() }
  }

  fun detach() {
    decor?.viewTreeObserver?.let { if (it.isAlive) it.removeOnGlobalLayoutListener(listener) }
    decor = null
    activity = null
    last = null
  }

  private fun reactRoot(view: View): View? {
    if (view is RootView) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) {
      reactRoot(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  fun snapshot(): Map<String, Any> {
    val host = activity ?: return mapOf("overlap" to 0.0, "visible" to false)
    val window = decor ?: return mapOf("overlap" to 0.0, "visible" to false)
    val root = reactRoot(window) ?: return mapOf("overlap" to 0.0, "visible" to false)
    val insets = ViewCompat.getRootWindowInsets(window)
    val visible = insets?.isVisible(WindowInsetsCompat.Type.ime()) == true
    val imeHeight = insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
    val position = IntArray(2)
    root.getLocationOnScreen(position)
    val rootBottom = position[1] + root.height
    // WindowMetrics bounds stay full-window under adjustResize; subtracting IME
    // from the resized decor height would double-count the keyboard.
    val keyboardTop = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      host.windowManager.currentWindowMetrics.bounds.bottom - imeHeight
    } else {
      val visibleFrame = Rect()
      window.getWindowVisibleDisplayFrame(visibleFrame)
      visibleFrame.bottom
    }
    val density = root.resources.displayMetrics.density
    return mapOf(
      "overlap" to if (visible) max(0, rootBottom - keyboardTop) / density.toDouble() else 0.0,
      "visible" to visible,
      "rootBottom" to rootBottom / density.toDouble(),
      "keyboardTop" to keyboardTop / density.toDouble()
    )
  }

  private fun report() {
    val next = snapshot()
    if (next != last) { last = next; emit(next) }
  }
}
