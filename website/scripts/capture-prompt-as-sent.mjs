/**
 * Screenshot harness for the "Prompt as sent" section of the chat side-panel
 * Context tab (Developer Mode).
 *
 * Runs the REAL built SPA (website/dist) through the shared transcript harness:
 * a static server over dist, /api/** answered from fixtures, /api/ws bound so
 * the app's socket does not hang. No gateway, no kiro-cli — only the network is
 * stubbed, so the panel, the segment bar and the disclosure rows render exactly
 * as they do in production.
 *
 * The two fixtures are read from files so they can be produced by the BACKEND's
 * own scan (`kiro_crew.context_blocks.block_spans`) rather than hand-typed:
 *   <fixtureDir>/context-trace.json  -- GET /api/telemetry/context-trace body
 *   <fixtureDir>/prompt-trace.json   -- GET /api/telemetry/prompt-trace body
 *
 * Usage:  node scripts/capture-prompt-as-sent.mjs <fixtureDir> [outDir]
 * Output: <outDir> || $KIROCREW_SCRATCH || os.tmpdir()/prompt-as-sent-cap/
 *   prompt-as-sent.png (section collapsed), prompt-as-sent-expanded.png
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTranscriptHarness } from './lib/transcript-harness.mjs'
import { json } from './lib/boot-api.mjs'

const SLOT = 'chat-1'
const PROJECT = '/home/user/workspace/KiroCrew'
const FIXTURES = process.argv[2]
if (!FIXTURES) {
  console.error('usage: node scripts/capture-prompt-as-sent.mjs <fixtureDir> [outDir]')
  process.exit(2)
}
const OUT = process.argv[3] || join(process.env.KIROCREW_SCRATCH || tmpdir(), 'prompt-as-sent-cap')
mkdirSync(OUT, { recursive: true })

const CONTEXT_TRACE = JSON.parse(readFileSync(join(FIXTURES, 'context-trace.json'), 'utf8'))
const PROMPT_TRACE = JSON.parse(readFileSync(join(FIXTURES, 'prompt-trace.json'), 'utf8'))

const now = () => Date.now() / 1000
const slots = [{
  key: SLOT,
  title: 'See the prompt each turn sends to ACP',
  running: false,
  last_message: 'Add outbound recording and show it in the Context tab.',
  messages: 2,
  agent: 'kirocrew',
  memory_mode: 'persistent',
  project: PROJECT,
  modified: Math.floor(now()),
  source_links: [],
  source_links_total: 0,
}]
const detail = {
  running: false,
  has_more: false,
  total: 2,
  queue: [],
  project: PROJECT,
  messages: [
    { role: 'user', ts: now() - 600, content: 'Add outbound recording and show it in the Context tab.' },
    { role: 'assistant', ts: now() - 300, content: 'Done. Open the Context tab in Developer Mode.' },
  ],
}

async function main() {
  const h = await openTranscriptHarness({
    slot: SLOT,
    project: PROJECT,
    slots,
    detail,
    viewport: { width: 640, height: 1180 },
    deviceScaleFactor: 2,
  })
  const { page } = h

  await page.route('**/api/telemetry/context-trace**', route => json(route, CONTEXT_TRACE))
  await page.route('**/api/telemetry/prompt-trace**', route => json(route, PROMPT_TRACE))

  await h.load('dark')

  // Developer Mode on, side panel open on a Context tab; reload so the SPA boots
  // straight into the view (this init script runs LAST on the next navigation,
  // so it wins over the harness's localStorage.clear()).
  await page.addInitScript(([slot]) => {
    localStorage.setItem('mc-dev-mode', '1')
    localStorage.setItem('mc-activity-open:' + slot, 'true')
    localStorage.setItem(
      'mc-panel-tabs:' + slot,
      JSON.stringify({ activeId: 'context', tabs: [{ id: 'context', kind: 'context', title: 'Context' }] }),
    )
  }, [SLOT])
  await page.reload({ waitUntil: 'domcontentloaded' })

  const section = page.getByTestId('prompt-as-sent')
  await section.waitFor({ timeout: 20000 })
  // No first-run gate may sit on top of the frame.
  const dialogs = await page.locator('[role="dialog"]').count()
  if (dialogs) throw new Error(`unexpected dialog open: ${dialogs}`)
  await section.scrollIntoViewIfNeeded()
  await page.waitForTimeout(600)

  const body = await page.locator('body').innerText()
  const required = ['Prompt as sent', 'Developer', 'Copy all', 'Must-follow rules', 'Your message', 'Prompt text kept']
  const dots = await page.locator('[data-prompt-dot]').count()
  if (dots < 1) throw new Error('no prompt dots rendered')
  console.log('prompt dots:', dots)
  const missing = required.filter(t => !body.includes(t))
  if (missing.length) throw new Error(`assert failed: missing=${JSON.stringify(missing)}\n${body.slice(0, 2500)}`)
  console.log('ASSERT OK: section heading, badge, copy button and block rows present')

  await page.screenshot({ path: join(OUT, 'prompt-as-sent.png') })
  console.log('wrote', join(OUT, 'prompt-as-sent.png'))

  // Expand the user's own message row and the lessons row: the text behind a
  // segment is the whole point of the section.
  await section.locator('[data-prompt-segment="your_message"] button').click()
  await section.locator('[data-prompt-segment="critical_rules"] button').click()
  await page.waitForTimeout(400)
  const expanded = await section.innerText()
  if (!expanded.includes('CRITICAL RULES')) throw new Error('expanded text not visible:\n' + expanded.slice(0, 1500))
  await section.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(OUT, 'prompt-as-sent-expanded.png') })
  console.log('wrote', join(OUT, 'prompt-as-sent-expanded.png'))

  // A turn whose prompt fell out of the ring (or predates a gateway restart):
  // the section says so instead of showing a neighbour's text.
  await page.locator('button[data-turn="2"]').click()
  await page.waitForTimeout(400)
  const none = await section.innerText()
  if (!none.includes('No prompt text kept')) throw new Error('expected the none state:\n' + none.slice(0, 800))
  await section.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(OUT, 'prompt-as-sent-none.png') })
  console.log('wrote', join(OUT, 'prompt-as-sent-none.png'))

  await h.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
