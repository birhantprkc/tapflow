import { useCallback, useEffect, useState } from 'react';
import type { FocusEvent } from 'react';

/**
 * When a pointer last went down, anywhere. Module scope because it is a property of the browser rather
 * than of a viewer, and because a restart unmounts the viewer under the focus it is about to hand back.
 */
let lastPointerDown = 0;
/**
 * What that press landed on. A press suppresses the ring only for the element it actually placed focus
 * on — without this, a click anywhere in the document silenced the next 200ms of arrivals, including the
 * programmatic hand-back after a restart, which is the arrival the ring exists for.
 *
 * Weak because the press that matters most is the one on a **restart button**, whose whole subtree is
 * unmounted before focus comes back; a strong reference here would hold that dead viewer alive until the
 * next click anywhere.
 */
let lastPointerTarget: WeakRef<Node> | null = null;
/** How many hooks are mounted, so the listener is installed once and removed with the last. */
let listeners = 0;

/**
 * How long after a press a focus still counts as placed by it. Focus follows the press synchronously, so
 * this only has to survive a slow frame; long enough to be safe, short enough that an unrelated focus
 * seconds later is not attributed to it.
 */
const POINTER_PLACED_MS = 200;

function onPointerDown(e: PointerEvent) {
  lastPointerDown = Date.now();
  lastPointerTarget = e.target instanceof Node ? new WeakRef(e.target) : null;
}

/**
 * A focus ring that reports how focus *arrived*, rather than what the last key pressed was.
 *
 * **The ring is the only focus indicator these regions have** — `outline-none` is unconditional — so the
 * default is to draw it, and only positive evidence of a pointer takes it away. Asking instead for
 * positive evidence of a *keyboard* leaves every arrival the evidence does not cover with no indicator at
 * all (WCAG 2.4.7): a programmatic hand-back, an assistive technology moving the caret, a restart landing
 * focus on the booting region while the tester is looking elsewhere.
 *
 * Two defects sit behind it. A `tabIndex={-1}` element is out of the tab order and still takes focus from
 * a mouse — a click on anything unfocusable inside it lands here — so a plain `:focus` ring drew itself
 * around the whole viewer on every tap. `:focus-visible` answered that and brought its own: the browser
 * re-evaluates it on every keystroke, and the viewers forward keystrokes to the device from a `window`
 * listener, so a tester who clicked the simulator and then typed watched a ring appear mid-sentence under
 * a focus a pointer had placed. Reading the modality once, when focus lands, answers both — typing moves
 * no focus, so it can no longer reach this at all, and no key has to be classified to say so.
 */
export function useFocusArrivalRing() {
  const [ringed, setRinged] = useState(false);

  useEffect(() => {
    if (listeners++ === 0) window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      if (--listeners === 0) window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  // Only the root itself: focus moving between the controls inside the viewer is their business, and
  // reacting to it here would clear a ring the tester still needs.
  const onFocus = useCallback((e: FocusEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    const pressed = lastPointerTarget?.deref();
    const placedByPointer =
      Date.now() - lastPointerDown <= POINTER_PLACED_MS && !!pressed && e.currentTarget.contains(pressed);
    setRinged(!placedByPointer);
  }, []);
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) setRinged(false);
  }, []);

  /** Spread onto the focusable root. `data-focus-ring` is what the ring styles key off. */
  return {
    ringed,
    focusProps: { onFocus, onBlur, 'data-focus-ring': ringed ? '' : undefined },
  };
}

/** Test seam: the pointer's last press outlives a render, so a suite must be able to forget it. */
export function __resetFocusModality() {
  lastPointerDown = 0;
  lastPointerTarget = null;
}
