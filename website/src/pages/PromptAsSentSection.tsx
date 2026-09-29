import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'

import { fmtNumber } from '../i18n/format'
import { i18nT } from '../i18n/t'
import { CATEGORY_FILL } from './contextSourceColors'

/** One recorded prompt, as GET /api/telemetry/prompt-trace returns it. */
export interface PromptSpan {
  start: number
  end: number
  label: string
}

export interface PromptRecord {
  ts: string
  backend: string
  chars: number
  text: string
  spans: PromptSpan[]
}

export interface PromptTrace {
  slot: string
  turns: PromptRecord[]
  max_turns: number
}

/** A run of adjacent spans sharing one label, merged for display. */
export interface PromptSegment {
  label: string
  start: number
  end: number
}

/**
 * Merge adjacent same-label spans into one segment. The backend keeps a block's
 * body and the whitespace gap after it as separate spans; a reader wants one
 * row per block.
 */
export function mergeSpans(spans: readonly PromptSpan[]): PromptSegment[] {
  const out: PromptSegment[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && last.label === s.label && last.end === s.start) last.end = s.end
    else out.push({ label: s.label, start: s.start, end: s.end })
  }
  return out.filter(s => s.end > s.start)
}

/**
 * The prompt record that produced a context-trace turn.
 *
 * The two come from different stores: the prompt is recorded as the turn
 * STARTS (before the transport write), the usage row that carries `ctx_blocks`
 * is written when the turn ENDS. So the prompt for a turn is the newest record
 * stamped at or before the turn's row, and no earlier than the previous turn's
 * row (a turn that produced no usage row — a failed one — is skipped over
 * rather than credited to its successor). `null` when nothing matches: the
 * ring only holds the newest few turns and empties on a gateway restart.
 */
export function promptForTurn(
  prompts: readonly PromptRecord[],
  turnTs: string,
  previousTurnTs: string | undefined,
): PromptRecord | null {
  let best: PromptRecord | null = null
  for (const p of prompts) {
    if (p.ts > turnTs) continue
    if (previousTurnTs !== undefined && p.ts <= previousTurnTs) continue
    if (!best || p.ts > best.ts) best = p
  }
  return best
}

const fmtN = (n: number): string => fmtNumber(Math.round(n))

function SegmentRow({
  seg,
  text,
  fill,
  name,
}: {
  seg: PromptSegment
  text: string
  fill: string
  name: string
}) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="border-b border-border last:border-b-0" data-prompt-segment={seg.label}>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 py-2 text-left bg-transparent border-0 appearance-none cursor-pointer text-[12px] text-text hover:text-text-strong rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Chevron size={14} className="lucide-inline shrink-0 text-muted" aria-hidden="true" />
          <i className="w-2.5 h-2.5 rounded-[2px] shrink-0" style={{ background: fill }} aria-hidden="true" />
          <span className="truncate">{name}</span>
        </span>
        <span className="font-mono text-[11px] text-muted tabular-nums shrink-0">{fmtN(seg.end - seg.start)}</span>
      </button>
      {open ? (
        <pre className="m-0 mb-2 p-2.5 max-h-60 overflow-auto rounded-md border border-border bg-[var(--bg)] text-[11px] leading-[1.5] text-text whitespace-pre-wrap break-words font-mono">
          {text.slice(seg.start, seg.end)}
        </pre>
      ) : null}
    </div>
  )
}

function CopyAllButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(id)
  }, [copied])
  const Icon = copied ? Check : Copy
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-transparent text-[12px] text-text hover:bg-[var(--card-hl)] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true))
      }}
    >
      <Icon size={13} className="lucide-inline" aria-hidden="true" />
      {copied ? i18nT('pages.contextBreakdown.prompt_copied') : i18nT('pages.contextBreakdown.prompt_copy')}
    </button>
  )
}

/**
 * The exact text one turn handed the agent, under the turn's size breakdown.
 *
 * Developer-mode only by placement: the Context tab it lives in is itself gated
 * on Developer Mode. Reads nothing itself — the tab fetches the prompt trace
 * and the card passes the matched record (or `null`) down, so this stays a
 * pure view: a segment bar in reading order, then one disclosure row per block
 * with the block's raw text behind it.
 */
export function PromptAsSentSection({
  record,
  categoryOf,
  displayName,
}: {
  record: PromptRecord | null
  categoryOf: (label: string) => keyof typeof CATEGORY_FILL
  displayName: (label: string) => string
}) {
  const segments = record ? mergeSpans(record.spans) : []
  return (
    <div className="mx-4 mt-4 pt-4 border-t border-border" data-testid="prompt-as-sent">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 min-w-0">
          <strong className="text-[14px] text-text-strong">{i18nT('pages.contextBreakdown.prompt_heading')}</strong>
          <span className="text-[10px] uppercase tracking-wide text-muted border border-border rounded-full px-1.5 py-px shrink-0">
            {i18nT('pages.contextBreakdown.prompt_badge')}
          </span>
        </span>
        {record ? <CopyAllButton text={record.text} /> : null}
      </div>
      {record ? (
        <>
          <div className="flex h-2 rounded-sm overflow-hidden mt-2.5 mb-2" aria-hidden="true">
            {segments.map(seg => (
              <i
                key={`${seg.start}-${seg.label}`}
                className="min-w-[2px]"
                style={{ flexGrow: seg.end - seg.start, background: CATEGORY_FILL[categoryOf(seg.label)] }}
              />
            ))}
          </div>
          <div className="ml-1 pl-3 border-l-2 border-border">
            {segments.map(seg => (
              <SegmentRow
                key={`${seg.start}-${seg.label}`}
                seg={seg}
                text={record.text}
                fill={CATEGORY_FILL[categoryOf(seg.label)]}
                name={displayName(seg.label)}
              />
            ))}
          </div>
          <p className="m-0 mt-2 text-[11px] text-muted">
            {i18nT('pages.contextBreakdown.turn_button_chars', { chars: fmtN(record.chars) })} · {i18nT('pages.contextBreakdown.prompt_note')}
          </p>
        </>
      ) : (
        <p className="m-0 mt-2 text-[12px] text-muted">{i18nT('pages.contextBreakdown.prompt_none')}</p>
      )}
    </div>
  )
}
