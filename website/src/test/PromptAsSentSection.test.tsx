/**
 * "Prompt as sent" — the developer view of a turn's exact text under the
 * Context Breakdown panel.
 *
 *  - adjacent same-label spans merge into one row; a gap never merges across.
 *  - a turn is matched to the newest prompt recorded before its usage row and
 *    after the previous turn's row, so a failed turn is skipped, not credited.
 *  - the panel omits the section until the prompt trace has loaded, marks the
 *    turns that still have text with a dot, and says plainly when the selected
 *    turn has none.
 *  - a segment row opens to the raw slice of the prompt it names.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'

import { ContextBreakdownPanel, type ContextTrace, type ContextTurn } from '../pages/ContextBreakdownPanel'
import { mergeSpans, promptForTurn, type PromptRecord, type PromptTrace } from '../pages/PromptAsSentSection'

afterEach(cleanup)

const TEXT =
  '[CRITICAL RULES -- always follow these]\nrule\n[END CRITICAL RULES]\n\n' +
  '[CURRENT USER REQUEST -- respond to this]\nhello there\n\n(If presenting choices, end with x.)'

const END_RULES = TEXT.indexOf('[END CRITICAL RULES]') + '[END CRITICAL RULES]\n'.length
const HEADER = TEXT.indexOf('[CURRENT USER REQUEST')
const USER = TEXT.indexOf('hello there')

const record = (over: Partial<PromptRecord> = {}): PromptRecord => ({
  ts: '2026-08-04T00:00:00Z',
  backend: '',
  chars: TEXT.length,
  text: TEXT,
  spans: [
    // The body and the blank line after its closer are two spans, as the
    // backend emits them; the view merges them into one row.
    { start: 0, end: END_RULES, label: 'critical_rules' },
    { start: END_RULES, end: HEADER, label: 'critical_rules' },
    { start: HEADER, end: USER, label: 'request_header' },
    { start: USER, end: USER + 'hello there'.length, label: 'your_message' },
    { start: USER + 'hello there'.length, end: TEXT.length, label: 'reply_format_rules' },
  ],
  ...over,
})

const turn = (over: Partial<ContextTurn> = {}): ContextTurn => ({
  ts: '2026-08-04T00:00:30Z',
  phase: 'per_turn',
  blocks: { request_header: 42, your_message: 11, critical_rules: 63, reply_format_rules: 40 },
  total_chars: 156,
  context_used: 2000,
  context_window: 200000,
  model: 'auto',
  ...over,
})

const trace = (turns: ContextTurn[]): ContextTrace => ({
  slot: 'chat-1',
  turns,
  totals: {},
  injected_chars: 0,
  user_chars: 0,
  peak_context_used: 0,
  context_window: 0,
  window_days: 14,
})

const prompts = (turns: PromptRecord[]): PromptTrace => ({ slot: 'chat-1', turns, max_turns: 12 })

describe('mergeSpans', () => {
  it('merges adjacent spans with one label and keeps a gap apart', () => {
    const merged = mergeSpans(record().spans)
    expect(merged.map(s => s.label)).toEqual([
      'critical_rules',
      'request_header',
      'your_message',
      'reply_format_rules',
    ])
    expect(merged[0]).toEqual({ label: 'critical_rules', start: 0, end: HEADER })
  })

  it('does not merge same-label spans that are not contiguous', () => {
    const merged = mergeSpans([
      { start: 0, end: 5, label: 'a' },
      { start: 5, end: 7, label: 'b' },
      { start: 7, end: 9, label: 'a' },
    ])
    expect(merged).toHaveLength(3)
  })
})

describe('promptForTurn', () => {
  const p1 = record({ ts: '2026-08-04T00:00:00Z', text: 'one' })
  const p2 = record({ ts: '2026-08-04T00:01:00Z', text: 'two' })
  const p3 = record({ ts: '2026-08-04T00:02:00Z', text: 'three' })

  it('picks the newest prompt stamped before the turn row', () => {
    expect(promptForTurn([p1, p2, p3], '2026-08-04T00:01:30Z', undefined)?.text).toBe('two')
  })

  it('never reaches back past the previous turn row', () => {
    // p2's turn produced no usage row (it failed); the next row must not adopt it.
    expect(promptForTurn([p1, p2], '2026-08-04T00:01:30Z', '2026-08-04T00:01:10Z')).toBeNull()
  })

  it('is null when nothing was recorded before the row', () => {
    expect(promptForTurn([p3], '2026-08-04T00:00:30Z', undefined)).toBeNull()
  })
})

describe('ContextBreakdownPanel with a prompt trace', () => {
  it('omits the section while the prompt trace is not loaded', () => {
    render(<ContextBreakdownPanel trace={trace([turn()])} />)
    expect(screen.queryByTestId('prompt-as-sent')).toBeNull()
  })

  it('shows the selected turn text by segment and marks the turn with a dot', () => {
    const { container } = render(<ContextBreakdownPanel trace={trace([turn()])} prompts={prompts([record()])} />)
    const section = screen.getByTestId('prompt-as-sent')
    expect(within(section).getByText('Prompt as sent')).toBeTruthy()
    const rows = section.querySelectorAll('[data-prompt-segment]')
    expect(Array.from(rows).map(r => r.getAttribute('data-prompt-segment'))).toEqual([
      'critical_rules',
      'request_header',
      'your_message',
      'reply_format_rules',
    ])
    expect(container.querySelectorAll('[data-prompt-dot]').length).toBe(1)
    expect(screen.getByTestId('prompt-kept-legend')).toBeTruthy()
  })

  it('opens a segment to the raw slice of the prompt', () => {
    render(<ContextBreakdownPanel trace={trace([turn()])} prompts={prompts([record()])} />)
    const row = screen.getByTestId('prompt-as-sent').querySelector('[data-prompt-segment="your_message"] button')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    expect(screen.getByText('hello there')).toBeTruthy()
  })

  it('says plainly when the selected turn has no text kept', () => {
    const t1 = turn({ ts: '2026-08-04T00:00:30Z' })
    const t2 = turn({ ts: '2026-08-04T00:05:30Z' })
    // Only the SECOND turn's prompt is still in the ring.
    const kept = record({ ts: '2026-08-04T00:05:00Z' })
    const { container } = render(<ContextBreakdownPanel trace={trace([t1, t2])} prompts={prompts([kept])} />)
    expect(container.querySelectorAll('[data-prompt-dot]').length).toBe(1)
    // Newest is selected by default and has text; pick turn 1.
    fireEvent.click(container.querySelector('button[data-turn="1"]')!)
    expect(within(screen.getByTestId('prompt-as-sent')).getByText(/No prompt text kept/)).toBeTruthy()
  })
})
