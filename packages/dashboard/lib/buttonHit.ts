import type { ChromeButton } from '@tapflowio/protocol'

/**
 * Where a physical side button sits when nothing is hovering it, in 2× composite px.
 *
 * **These are the numbers `IOSViewer` draws the button at**, and they have to stay that way: a hit
 * area computed from a different position than the pixels the user is aiming at is a target that
 * lies about where it is. The renderer's resting placement is
 * `left: rolloverOffset.x - buttonW / 2`, and a top-anchored button (the home button) takes its
 * `top` from `rolloverOffset.y` while every other anchor measures from `normalOffset.y`.
 *
 * `normalOffset` is the retracted position and `rolloverOffset` the extended one; this UI draws
 * buttons extended at rest, which is why the horizontal centre comes from the rollover pair.
 */
export function buttonHitRect(btn: ChromeButton): { left: number; top: number; right: number; bottom: number } {
  const left = btn.rolloverOffset.x - btn.buttonW / 2
  const top = btn.anchor === 'top' ? btn.rolloverOffset.y : btn.normalOffset.y - btn.buttonH / 2
  return { left, top, right: left + btn.buttonW, bottom: top + btn.buttonH }
}

/**
 * Distance from a point to a rectangle — 0 anywhere inside it.
 *
 * The zero is the point. A press inside a button's own rectangle can never lose to a neighbour
 * whose margin happens to reach the same pixel, which is the whole defect this replaces: catchment
 * measured from centres, with the first match in array order winning the overlap.
 */
export function distanceToRect(
  x: number,
  y: number,
  r: { left: number; top: number; right: number; bottom: number },
): number {
  const dx = Math.max(r.left - x, 0, x - r.right)
  const dy = Math.max(r.top - y, 0, y - r.bottom)
  return Math.hypot(dx, dy)
}

/**
 * Which physical button a point presses, or `null` for none — the nearest one whose rectangle the
 * point is within `margin` of.
 *
 * **Nearest, not the first in range.** Neighbouring catchment areas overlap whenever the margin is
 * more than half the gap between two buttons, and taking the first match hands that entire band to
 * whichever button the agent listed earlier. Measured on 2026-09-11: on an iPhone 15 Pro the upper
 * half of Volume Up pressed the Action button, because Action is listed first and the old catchment
 * was a fixed radius around each *centre*. Nearest-by-rectangle puts the boundary midway between the
 * two, and a point inside a button always scores 0.
 *
 * Ties go to the earlier button, which only happens on the exact midline.
 */
export function pickButton(
  x: number,
  y: number,
  buttons: readonly ChromeButton[],
  margin: number,
): string | null {
  let hit: string | null = null
  let best = Infinity
  for (const btn of buttons) {
    const d = distanceToRect(x, y, buttonHitRect(btn))
    if (d < best) { best = d; hit = btn.name }
  }
  return best <= margin ? hit : null
}
