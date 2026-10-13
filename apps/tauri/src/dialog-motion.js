// Only occasional, pointer-opened dialogs move. Navigation and keyboard input
// remain immediate; native showModal/close retain focus and top-layer semantics.
const DURATION = 160;
const EASING = 'cubic-bezier(0.23, 1, 0.32, 1)';

export function createDialogMotion(dialog) {
  let pointerActivation = false;
  let activationTimer;
  let animation;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onClick = event => {
    clearTimeout(activationTimer);
    pointerActivation = event.isTrusted && event.detail > 0;
    // Only the current pointer activation qualifies, not a later system event.
    activationTimer = setTimeout(() => { pointerActivation = false; }, 0);
  };
  const cancel = () => {
    animation?.cancel();
    animation = undefined;
  };
  // A close event is queued by the platform; it can arrive after a rapid reopen.
  const onClose = () => { if (!dialog.open) cancel(); };
  document.addEventListener('click', onClick, true);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', onClose);
  reduced.addEventListener('change', cancel);

  return {
    open({ animate = true } = {}) {
      const wasOpen = dialog.open;
      cancel();
      if (wasOpen) return;
      dialog.showModal();
      if (!animate || !pointerActivation || !dialog.animate) return;
      const frames = reduced.matches
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'scale(1)' }];
      const current = dialog.animate(frames, { duration: DURATION, easing: EASING });
      animation = current;
      current.finished.then(() => {
        if (animation === current) animation = undefined;
      }).catch(() => {}); // Closing or retargeting deliberately cancels the entry.
    },
    close() {
      cancel();
      dialog.close();
    },
    dispose() {
      cancel();
      clearTimeout(activationTimer);
      document.removeEventListener('click', onClick, true);
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('close', onClose);
      reduced.removeEventListener('change', cancel);
    },
  };
}
