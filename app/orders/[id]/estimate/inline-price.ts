/**
 * Inline service price (Job screen) — what a typed amount means, decided in one pure place.
 *
 * The price box beside a service is a second door to the SAME edit the item editor's Price field sends
 * (`set_service_price` on the estimate route), so it uses the editor's own planner (planServiceSave):
 * identical parsing, identical validation, identical "a blank price stays unpriced, never $0" rule.
 * Nothing here prices anything — it only says whether there is something to send.
 */
import type { EstimateEdit, ServiceView } from './save-feedback'
import { dollars, planServiceSave, serviceDraftFrom } from './item-draft'

/** What the box shows for a saved price: "125.50", or empty while unpriced. */
export const priceBoxText = (cents: number | null | undefined): string => (cents != null ? dollars(cents) : '')

export type InlinePricePlan =
  /** Nothing to send (untouched, blank on an unpriced line, or the same amount as saved). */
  | { kind: 'none' }
  | { kind: 'save'; cents: number; edit: EstimateEdit }
  /** Not a usable amount. `restore` = put the saved price back in the box (a saved price can't be cleared). */
  | { kind: 'invalid'; error: string; restore: boolean }

export function planInlinePrice(s: ServiceView, typed: string): InlinePricePlan {
  const plan = planServiceSave(s, { ...serviceDraftFrom(s), price: typed }, false)
  if (!plan.ok) return { kind: 'invalid', error: plan.error, restore: typed.trim() === '' && s.priceCents != null }
  const edit = plan.edits.find((e) => e.action === 'set_service_price')
  return edit ? { kind: 'save', cents: edit.cents as number, edit } : { kind: 'none' }
}

/**
 * The server's copy of the price changed (this row's save landed, or another screen changed it). The box
 * follows it unless the user has typed something else since: text that was untouched, or that means the
 * same amount ("25" once $25.00 is saved), becomes the server's text; anything else stays as typed.
 */
export function rebasePriceText(typed: string, prevServer: string, nextServer: string, s: ServiceView): string {
  if (typed === prevServer) return nextServer
  return planInlinePrice(s, typed).kind === 'none' ? nextServer : typed
}

/**
 * Run tasks strictly one after another, in the order they were queued. Price saves for consecutive rows
 * are sent this way: the second request leaves only after the first one has been answered, so two saves
 * can never recalculate the Job's totals at the same time, and the answers arrive in order.
 * A failed task never blocks the ones behind it.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

/** The price box after `from` in document order (or before it) — where Tab / Shift+Tab goes. */
export function neighbourPriceBox<T>(boxes: readonly T[], from: T, back: boolean): T | null {
  const i = boxes.indexOf(from)
  if (i < 0) return null
  return boxes[i + (back ? -1 : 1)] ?? null
}
