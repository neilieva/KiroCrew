/**
 * A released reader is held through a WIDTH TRANSITION -- and held exactly once.
 *
 * Dragging the sidebar (or collapsing the rail) re-wraps every mounted row and
 * fires the ResizeObserver for each, while `canMeasure()` is false for the
 * whole drag plus the 200ms width settle: the persisted cache still belongs to
 * the OLD width, so no measurement may land in it. Two invariants are pinned
 * here. On an engine with no native scroll anchoring (WebKit, which this
 * scroller double simulates: nothing adjusts scrollTop but the hook) every
 * re-wrap above the reader must still be compensated, gate or no gate. And the
 * compensation ADDS the raw delta to scrollTop, so each fire must be priced
 * against the height the DOM showed at the previous fire, never against the
 * refused old-width cache: 100 -> 120 -> 140 is credited 20 + 20, not 20 + 40,
 * and a repeated 140 is credited 0, not 40. The old width's heights stay
 * untouched throughout.
 *
 * Drives the real hook through its ResizeObserver and ref seeds, the way
 * `useVirtualChat.repriceSameFrame` does; nothing about heights, the index or
 * the window is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'
import { useVirtualChat, type UseVirtualChatOptions } from '../hooks/virtualizer/useVirtualChat'
import { HeightCache } from '../hooks/virtualizer/HeightCache'
import { HeightIndex } from '../hooks/virtualizer/HeightIndex'

interface Geom { scrollTop: number; scrollHeight: number; clientHeight: number }

/** No native anchoring: only the hook's own writes ever move scrollTop. */
function makeScroller(initial: Geom) {
  const el = document.createElement('div')
  const state: Geom = { ...initial }
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => { state.scrollTop = v },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => state.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => state.clientHeight })
  ;(el as unknown as { scrollTo: (o: { top: number }) => void }).scrollTo = (o) => { state.scrollTop = o.top }
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 400, left: 0, right: 390, width: 390, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return { el, state }
}

/** A row whose height and viewport position both move; a negative `top` is above the fold. */
function makeRow(box: { top: number; h: number }) {
  const node = document.createElement('div')
  Object.defineProperty(node, 'offsetHeight', { configurable: true, get: () => box.h })
  node.getBoundingClientRect = () =>
    ({
      top: box.top, bottom: box.top + box.h, left: 0, right: 390,
      width: 390, height: box.h, x: 0, y: box.top, toJSON: () => ({}),
    }) as DOMRect
  return node
}

interface Item { id: string }
const getKey = (it: Item) => it.id
const mkItems = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))
const N = 30
const OLD_SCOPE = 'width-transition:w1216'
const NEW_SCOPE = 'width-transition:w1024'

describe('useVirtualChat: above-fold compensation during a width transition', () => {
  let origRaf: typeof requestAnimationFrame
  let origRO: typeof ResizeObserver | undefined
  let fire: ((entries: { target: Element }[]) => void) | undefined
  const owners = new Set<HeightIndex>()

  beforeEach(() => {
    localStorage.clear()
    owners.clear()
    origRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0 }) as typeof requestAnimationFrame
    origRO = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        fire = (entries) => cb(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    // Every owner that ever took a write, so the persisted blobs can be flushed
    // and read back per scope without reaching into the hook.
    const setMeasured = HeightIndex.prototype.setMeasured
    vi.spyOn(HeightIndex.prototype, 'setMeasured').mockImplementation(function (this: HeightIndex, index, height) {
      owners.add(this)
      setMeasured.call(this, index, height)
    })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    globalThis.requestAnimationFrame = origRaf
    // jsdom ships no ResizeObserver: put back the absence, not the double.
    if (origRO) globalThis.ResizeObserver = origRO
    else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    fire = undefined
    localStorage.clear()
  })

  function persisted(scope: string, key: string) {
    for (const owner of owners) owner.flush()
    return new HeightCache(scope).peek(key)
  }

  /**
   * Park mid-transcript with follow RELEASED, one measured row above the fold
   * and one inside the viewport, both seeded while the width scope is settled.
   * `gate` is the live `canMeasure()` answer; flipping it is the drag starting.
   */
  function setup(opts: { streamingIndex?: number } = {}, following = false) {
    const parkedAt = following ? 4600 : 2000
    const { el, state } = makeScroller({ scrollTop: parkedAt, scrollHeight: 5000, clientHeight: 400 })
    const ref: RefObject<HTMLDivElement | null> = { current: el }
    const items = mkItems(N)
    const gate = { open: true }
    const canMeasure = () => gate.open
    const props: UseVirtualChatOptions<Item> = {
      items, sessionId: 'width-transition', heightScopeKey: OLD_SCOPE, canMeasure,
      getKey, externalScrollerRef: ref, followOutput: true, ...opts,
    }
    const view = renderHook((p: UseVirtualChatOptions<Item>) => useVirtualChat<Item>(p), { initialProps: props })
    act(() => {
      state.scrollTop = parkedAt
      el.dispatchEvent(new Event('scroll'))
    })
    const above = { top: -900, h: 250 }
    const visible = { top: 40, h: 250 }
    const aboveRow = makeRow(above)
    const visibleRow = makeRow(visible)
    act(() => {
      view.result.current.measureRef(3)(aboveRow)
      view.result.current.measureRef(12)(visibleRow)
    })
    expect(persisted(OLD_SCOPE, 'm3')).toBe(250)
    return { el, state, view, props, gate, above, aboveRow, visible, visibleRow }
  }

  /** The row above the reader re-wraps to `h`; with no native anchor, nothing else moves. */
  function rewrap(state: Geom, row: { top: number; h: number }, visible: { top: number; h: number }, h: number) {
    const delta = h - row.h
    row.h = h
    state.scrollHeight += delta
    visible.top += delta
  }

  it('holds the reader through several re-wraps of a row above the fold while the scope is gated, crediting each fire once', () => {
    const { state, gate, above, aboveRow, visible } = setup()
    const startedAt = state.scrollTop
    gate.open = false

    // 250 -> 270: one re-wrap, one hold.
    rewrap(state, above, visible, 270)
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 20)

    // 270 -> 290: the second fire is priced against 270, not the refused 250.
    rewrap(state, above, visible, 290)
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 40)

    // The observer re-reports an unchanged 290 (the debounce window is full of
    // these): nothing moved, so nothing may be credited.
    act(() => { fire?.([{ target: aboveRow }]) })
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 40)

    // The old width's measurement is untouched by every one of those fires.
    expect(persisted(OLD_SCOPE, 'm3')).toBe(250)
    expect(persisted(NEW_SCOPE, 'm3')).toBeUndefined()
  })

  it('walks the reader back when the width returns, and a settled re-fire at the old height adds nothing', () => {
    const { state, gate, above, aboveRow, visible } = setup()
    const startedAt = state.scrollTop
    gate.open = false
    rewrap(state, above, visible, 290)
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 40)

    // Back to the original width while still gated: the same delta, reversed.
    rewrap(state, above, visible, 250)
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt)

    // The width settles on the ORIGINAL bucket; the observer re-reports 250.
    gate.open = true
    act(() => { fire?.([{ target: aboveRow }]) })
    act(() => { vi.advanceTimersByTime(400) })
    expect(state.scrollTop).toBe(startedAt)
    expect(persisted(OLD_SCOPE, 'm3')).toBe(250)
  })

  it('does not compensate again when the new scope reseeds after the settle, nor when its debounced sync lands', () => {
    const { state, view, props, gate, above, aboveRow, visible } = setup()
    const startedAt = state.scrollTop
    gate.open = false
    rewrap(state, above, visible, 270)
    act(() => { fire?.([{ target: aboveRow }]) })
    rewrap(state, above, visible, 290)
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 40)

    // The bucket settles: a new scope, a new gate identity, and the facade's
    // reseed writes every mounted row's live height into the new owner.
    act(() => { view.rerender({ ...props, heightScopeKey: NEW_SCOPE, canMeasure: () => true }) })
    expect(persisted(NEW_SCOPE, 'm3')).toBe(290)
    expect(persisted(OLD_SCOPE, 'm3')).toBe(250)
    // The reseed is measurements only -- the reader was already held.
    expect(state.scrollTop).toBe(startedAt + 40)

    // A late duplicate fire and the debounced height sync both find the row
    // where it already is.
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 40)
    act(() => { vi.advanceTimersByTime(400) })
    expect(state.scrollTop).toBe(startedAt + 40)
    expect(persisted(NEW_SCOPE, 'm3')).toBe(290)
    expect(persisted(OLD_SCOPE, 'm3')).toBe(250)
  })

  it('classifies a row mounted DURING the transition from the live height seeded at mount', () => {
    const { state, view, gate, visible } = setup()
    const startedAt = state.scrollTop
    gate.open = false

    // Scrolled into during the drag: the seed is refused by the old scope but
    // the node's live height is known from mount, so the observer's first
    // report -- arriving after a re-wrap -- is priced against it rather than
    // taken for a first mount.
    const late = { top: -400, h: 180 }
    const lateRow = makeRow(late)
    act(() => { view.result.current.measureRef(6)(lateRow) })
    expect(persisted(OLD_SCOPE, 'm6')).toBeUndefined()
    rewrap(state, late, visible, 200)
    act(() => { fire?.([{ target: lateRow }]) })
    expect(state.scrollTop).toBe(startedAt + 20)

    // Its next re-wrap above the fold is credited once.
    rewrap(state, late, visible, 230)
    act(() => { fire?.([{ target: lateRow }]) })
    act(() => { fire?.([{ target: lateRow }]) })
    expect(state.scrollTop).toBe(startedAt + 50)
    expect(persisted(OLD_SCOPE, 'm6')).toBeUndefined()

    // A node the pass has never seen at a real height (seeded under a hidden
    // ancestor) is a first mount, not a resize -- the fallback the settled
    // path always had.
    const hidden = { top: -600, h: 0 }
    const hiddenRow = makeRow(hidden)
    act(() => { view.result.current.measureRef(8)(hiddenRow) })
    hidden.h = 120
    act(() => { fire?.([{ target: hiddenRow }]) })
    expect(state.scrollTop).toBe(startedAt + 50)
  })

  it('leaves a released reader alone when the straddling streaming row appends during the transition', () => {
    // Reader inside the streaming reply: top above the fold, bottom far below.
    const { state, view, gate } = setup({ streamingIndex: N - 1 })
    const reply = { top: -3000, h: 8000 }
    const replyRow = makeRow(reply)
    act(() => { view.result.current.measureRef(N - 1)(replyRow) })
    const startedAt = state.scrollTop
    gate.open = false
    for (const px of [27, 54, 27]) {
      reply.h += px
      state.scrollHeight += px
      act(() => { fire?.([{ target: replyRow }]) })
    }
    // Appends move nothing above the reader; the gate must not turn them into
    // re-wraps.
    expect(state.scrollTop).toBe(startedAt)
    expect(persisted(OLD_SCOPE, `m${N - 1}`)).toBe(8000)
  })

  it.each([true, false])('preserves trailing-footer follow=%s while width-cache writes are gated', following => {
    const { state, view, gate } = setup({}, following)
    const wrapper = document.createElement('div')
    ;(view.result.current.trailingRef as { current: HTMLDivElement | null }).current = wrapper
    expect(view.result.current.getFollow()).toBe(following)
    const startedAt = state.scrollTop
    gate.open = false
    state.scrollHeight += 56

    // Only the footer changed: no row or viewport resize can mask a missing
    // trailing-chrome follow signal while row-cache writes stand down.
    act(() => { fire?.([{ target: wrapper }]) })
    expect(state.scrollTop).toBe(following ? state.scrollHeight - state.clientHeight : startedAt)
    expect(view.result.current.getFollow()).toBe(following)
    expect(persisted(OLD_SCOPE, 'm3')).toBe(250)
    expect(view.result.current.farmIsMeasured(0)).toBe(false)
  })

  it('forgets a detached node: a remount is seeded afresh and its first fire credits nothing', () => {
    const { state, view, gate, above, aboveRow, visible } = setup()
    const startedAt = state.scrollTop
    gate.open = false
    rewrap(state, above, visible, 290)
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 40)

    // The row leaves the window and comes back as a NEW node at the re-wrapped
    // height (a slot switch, a window shift): no history, so no credit.
    act(() => { view.result.current.measureRef(3)(null) })
    const remounted = makeRow({ top: -900, h: 290 })
    act(() => { view.result.current.measureRef(3)(remounted) })
    act(() => { fire?.([{ target: remounted }]) })
    expect(state.scrollTop).toBe(startedAt + 40)

    // The ORIGINAL node re-attaching carries no history either: back under a
    // hidden ancestor (seed 0), its first real height is a first mount, not a
    // resize priced against what it showed before it detached.
    act(() => { view.result.current.measureRef(3)(null) })
    above.h = 0
    act(() => { view.result.current.measureRef(3)(aboveRow) })
    above.h = 250
    act(() => { fire?.([{ target: aboveRow }]) })
    expect(state.scrollTop).toBe(startedAt + 40)
    expect(persisted(OLD_SCOPE, 'm3')).toBe(250)
  })
})
