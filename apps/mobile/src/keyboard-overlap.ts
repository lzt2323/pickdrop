import { requireOptionalNativeModule } from 'expo';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Metrics = { overlap: number; visible: boolean };
type NativeKeyboard = {
  getKeyboardOverlap(): Promise<Metrics>;
  addListener(name: 'onKeyboardOverlap', listener: (metrics: Metrics) => void): { remove(): void };
};
const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeKeyboard>('PickDropComposer') : null;

/** Android edge-to-edge may overlay the IME without resizing React's root.
 * Native reports residual overlap, so adjustResize and split-screen never get
 * a second full keyboard-height padding. Existing SafeArea bottom counts once.
 */
export function useKeyboardOverlap() {
  const safeArea = useSafeAreaInsets();
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    if (!native?.getKeyboardOverlap) return;
    let alive = true;
    const update = (event: Metrics) => { if (alive) setOverlap(event.visible && Number.isFinite(event.overlap) ? Math.max(0, event.overlap) : 0); };
    const listener = native.addListener('onKeyboardOverlap', update);
    void native.getKeyboardOverlap().then(update).catch(() => {});
    return () => { alive = false; listener.remove(); };
  }, []);
  return Math.max(0, overlap - safeArea.bottom);
}
