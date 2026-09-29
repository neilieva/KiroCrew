/**
 * Screenshot harness for the composer dock's STATUS STACK as Liquid Glass: the
 * task-progress bar, the sub-agent wave chip, the workflow progress bar, the
 * Command Center dock, the held-delivery line and the queued-message card, all
 * raised at once above the composer over a dense transcript. Photographs the
 * REAL built SPA (website/dist) over a stubbed dashboard API in both
 * polarities, and asserts that every one of those panes renders a backdrop
 * blur layer -- the thing the old `bg-accent/10` / `bg-card` boxes never had.
 * A second frame per polarity scrolls the transcript up so its text and code
 * pass UNDER the stack, which is the case the material exists for.
 * Nothing in CI runs this file.
 *
 * Usage: node scripts/capture-glass-status-stack.mjs [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/glass-status-stack'
const SLOT = 'chat-glass-stack'
const PROJECT = '/home/user/workspace/notes'

mkdirSync(OUT, { recursive: true })

const slots = [{
  key: SLOT,
  title: 'Glass for the status stack',
  running: true,
  last_message: 'Working through the stack.',
  messages: 40,
  agent: 'kirocrew',
  memory_mode: 'persistent',
  project: PROJECT,
  folder_id: '',
  modified: Math.floor(Date.now() / 1000),
  source_links: [],
  source_links_total: 0,
}]

/** A dense transcript, so text and code sit under every pane of the stack. */
const LONG_PARA = '玻璃永远浮在内容层之上。内容滚过去的时候，模糊、着色和上下两条高光要一起把文字压住，但又不能把它盖死。这一段的目的就是给底下垫足够多的字，看看 --glass-tint 在真实文字上是什么密度。The quick brown fox jumps over the lazy dog while the frosted pane keeps every glyph half-visible beneath it.'
const detail = {
  running: true,
  has_more: false,
  total: 40,
  queue: [],
  project: PROJECT,
  messages: Array.from({ length: 40 }, (_, i) => i % 2 === 0
    ? { role: 'user', ts: Date.now() / 1000 - (40 - i) * 60, content: `第 ${i / 2 + 1} 个问题：${LONG_PARA.slice(0, 60)}` }
    : { role: 'assistant', ts: Date.now() / 1000 - (40 - i) * 60, content: `${LONG_PARA}\n\n\`\`\`ts\nexport function specularRing(peak: number, radius: number) {\n  const r1 = radius * 0.7\n  return \`linear-gradient(to bottom, ...)\`\n}\n\`\`\`\n\n- 底色 tint 跟主题走\n- 高光沿上下边均匀` }),
}

const now = () => Date.now() / 1000
/** Frames pushed over the (otherwise swallowed) websocket to raise each pane. */
const FRAMES = {
  todo: { type: 'todo_update', data: { slot: SLOT, todo: { description: 'Glass the status stack', current: 'sub-agent bar', completed: 2, total: 5, tasks: [
    { id: 't1', text: 'Read the Glass primitive', completed: true },
    { id: 't2', text: 'Convert the task bar', completed: true },
    { id: 't3', text: 'Convert the sub-agent bar', completed: false },
    { id: 't4', text: 'Convert the workflow bar', completed: false },
    { id: 't5', text: 'Photograph the stack', completed: false },
  ] } } },
  spawnA: { type: 'subagent_spawn', data: { slot: SLOT, id: 'ag-1', task: 'Review the dock from a new-user perspective', agent: 'kirocrew' } },
  spawnB: { type: 'subagent_spawn', data: { slot: SLOT, id: 'ag-2', task: 'Measure the tint over the transcript', agent: 'kirocrew' } },
  toolA: { type: 'subagent_tool', data: { slot: SLOT, id: 'ag-1', tool: 'read website/src/components/Glass.tsx', turns: 3, tool_count: 7 } },
  wfStart: { type: 'workflow_run_event', data: { run_id: 'wf-glass', session_key: SLOT, type: 'run_started', ts: now(), data: { name: 'Glass status stack review' } } },
  wfPhase: { type: 'workflow_run_event', data: { run_id: 'wf-glass', session_key: SLOT, type: 'phase_started', ts: now(), data: { title: 'Photograph both polarities' } } },
  queued: { type: 'queue_push', data: { slot: SLOT, content: '等你这轮跑完，把浅色也截一遍。', ts: new Date().toISOString(), queue_id: 'q-glass-1' } },
  delivered: { type: 'queue_push', data: { slot: SLOT, content: '[Subagent completion event] ag-0 finished: the dock reads as one material now.', ts: new Date().toISOString(), queue_id: 'q-glass-2' } },
}
const ORDER = ['todo', 'spawnA', 'spawnB', 'toolA', 'wfStart', 'wfPhase', 'queued', 'delivered']

/** Every pane of the stack, by the test id (or root) its own source exposes. */
const PANES = [
  ['task bar', '[data-testid="todo-pill"]'],
  ['sub-agent bar', '[data-testid="subagent-histogram"]'],
  ['workflow bar', '[data-testid="workflow-progress-bar"]'],
  ['command center dock', '[data-testid="command-center-dock"]'],
  ['delivery line', '[data-testid="subagent-delivery-progress"]'],
  ['queue card', '[data-testid="composer-status-stack"] .glass-warn'],
]

/** The pane is live glass when it, or its nearest `.liquid-glass` host, carries a backdrop-blur layer. */
async function assertGlass(page, selector, label) {
  const filters = await page.evaluate(sel => {
    const hit = document.querySelector(sel)
    if (!hit) return null
    const host = hit.closest('.liquid-glass') ?? hit.querySelector('.liquid-glass')
    if (!host) return []
    return Array.from(host.querySelectorAll('*')).map(n => getComputedStyle(n).backdropFilter).filter(f => f && f !== 'none')
  }, selector)
  if (filters === null) throw new Error(`${label}: not rendered (${selector})`)
  if (!filters.some(f => /blur\(/.test(f))) throw new Error(`${label}: no backdrop blur layer rendered (${filters.join(' | ') || 'none'})`)
  console.log(label, 'backdrop layers:', filters.join(' | '))
}

/** The dock's box, widened a little each side and topped with a strip of transcript. */
async function dockClip(page, label) {
  const dock = await page.locator('[data-testid="composer-dock-root"]').boundingBox()
  if (!dock) throw new Error(`${label}: composer-dock-root missing`)
  return { x: Math.max(0, dock.x + (dock.width - 980) / 2), y: Math.max(0, dock.y - 40), width: 980, height: dock.height + 60 }
}

async function main() {
  const { srv, base } = await serveDist()
  const browser = await chromium.launch()
  const extra = async (path, route) => {
    if (path.startsWith('/api/chat/slots/')) { await json(route, detail); return true }
    return false
  }
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    logPageProblems(page)
    await stubDashboardApi(page, { slots, theme, extra })
    // Registered AFTER the stub's swallow route so it wins: the socket opens
    // against nothing and we push the frames into it once the page is up.
    await page.routeWebSocket(/\/api\/ws/, ws => { ORDER.forEach((k, i) => setTimeout(() => ws.send(JSON.stringify(FRAMES[k])), 1500 + i * 400)) })
    await page.addInitScript(slot => { localStorage.setItem('mc-active-slot', slot) }, SLOT)
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500 + ORDER.length * 400 + 1500)
    for (const [label, sel] of PANES) await assertGlass(page, sel, `stack/${theme}/${label}`)
    await page.screenshot({ path: `${OUT}/stack-${theme}.png` })
    console.log('wrote', `${OUT}/stack-${theme}.png`)
    await page.screenshot({ path: `${OUT}/stack-${theme}-crop.png`, clip: await dockClip(page, `stack/${theme}`) })
    console.log('wrote', `${OUT}/stack-${theme}-crop.png`)

    // At the live end the scroller's bottom padding keeps the last line clear
    // of the dock, so nothing is under the glass yet. Scroll the transcript up
    // by most of the dock's height: the rows that were just above it now sit
    // under every pane, and the frame shows the tint and blur doing their job
    // on real text and code. The jump-to-bottom pill appears too; it is glass.
    const dockH = (await page.locator('[data-testid="composer-dock-root"]').boundingBox()).height
    const scrolled = await page.evaluate(by => {
      const sc = document.querySelector('.chat-container')
      if (!sc) return null
      const before = sc.scrollTop
      sc.scrollTop = before - by
      return before - sc.scrollTop
    }, Math.round(dockH * 0.8))
    if (!scrolled) throw new Error(`stack/${theme}/over-text: transcript did not scroll (${scrolled})`)
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${OUT}/stack-${theme}-over-text-crop.png`, clip: await dockClip(page, `stack/${theme}/over-text`) })
    console.log('wrote', `${OUT}/stack-${theme}-over-text-crop.png`)
    await context.close()
  }
  await browser.close()
  srv.close()
}

main().catch(err => { console.error(err); process.exit(1) })
