#!/usr/bin/env node
/**
 * crawler-visible-text audit
 *
 * Measures how many words of a page each kind of reader actually gets:
 *
 *   raw        The served HTML, fetched with the Googlebot smartphone user agent.
 *              This is what most AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
 *              CCBot) read: they do not run JavaScript, so anything not in the
 *              server HTML does not exist for them. Also lists risk markers.
 *   nojs       Headless Chrome with script execution disabled: a failed or
 *              blocked bundle, an unhydrated slow phone, reader modes, link
 *              previews. Inline opacity:0 in the served HTML means blank text.
 *   googlebot  Headless Chrome with JavaScript, Googlebot smartphone user agent,
 *              412px wide, viewport grown to the page height, never scrolled.
 *              This is how Google's (and Bing's) renderer sees the page.
 *
 * Every hidden word is classified:
 *   READING      real content a reader cannot see                 -> FAILURE
 *   DISCLOSURE   inside a closed <details>, tab panel, accordion, dialog, inert
 *                or hidden=until-found region                    -> reported
 *   DECORATIVE   inside an aria-hidden illustration or duplicate  -> reported
 *   SR_ONLY      visually-hidden screen-reader text (1px + clip)  -> reported
 *   ARIA_HIDDEN_READING  hidden reading text under aria-hidden="true" (a closed
 *                tab panel hidden with aria-hidden); takes precedence over
 *                DISCLOSURE                                       -> warning
 * These classes and `visible` partition the words: each word is counted once.
 * ARIA_HIDDEN_VISIBLE is an overlay on `visible`: on-screen reading text under
 * aria-hidden (split-text headings whose sentence is only in aria-label).
 * Readability-style extractors used by AI tools drop aria-hidden subtrees, so
 * both aria-hidden counts are lost to them -> warning.
 *
 * Dependency-free: Node 18+ (global fetch; WebSocket is global from Node 22,
 * see getWebSocket below) and a local Chrome / Chromium / Edge / Brave driven
 * over the DevTools protocol.
 *
 * Exit codes: 0 pass, 1 a page has more hidden READING words than --max-hidden
 * in nojs or googlebot mode, 2 tool error (Chrome missing, page failed to load).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join, delimiter } from 'node:path'

const HELP = `Usage: node audit.mjs <url...> [options]

Options:
  --sitemap <url>      also audit every URL in this sitemap (sitemap indexes are followed)
  --limit N            max URLs taken from sitemaps (default 50)
  --modes list         comma list of raw,nojs,googlebot (default all three)
  --max-hidden N       hidden READING words allowed per page and mode (default 0)
  --json <file>        write the full machine-readable result to <file>
  --wait ms            settle time after load in googlebot mode (default 4000)
  --samples N          sample groups printed per failing mode (default 6)
  --help               this text

Environment:
  CHROME_PATH          browser binary to use (Chrome, Chromium, Edge or Brave)
  CVT_TMPDIR           parent directory for the throwaway browser profile (default: OS temp)

Exit code: 0 pass, 1 hidden reading words found, 2 tool error.`

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = { urls: [], sitemaps: [], limit: 50, modes: ['raw', 'nojs', 'googlebot'], maxHidden: 0, json: null, wait: 4000, samples: 6 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      return v
    }
    const num = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`${a} needs a non-negative number, got "${v}"`)
      return n
    }
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--sitemap') o.sitemaps.push(normalizeUrl(next()))
    else if (a === '--limit') o.limit = num(next())
    else if (a === '--modes') {
      o.modes = next().split(',').map((s) => s.trim()).filter(Boolean)
      for (const m of o.modes) if (!['raw', 'nojs', 'googlebot'].includes(m)) throw new UsageError(`unknown mode "${m}"`)
    } else if (a === '--max-hidden') o.maxHidden = num(next())
    else if (a === '--json') o.json = next()
    else if (a === '--wait') o.wait = num(next())
    else if (a === '--samples') o.samples = num(next())
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`)
    else o.urls.push(normalizeUrl(a))
  }
  return o
}

class UsageError extends Error {}

function normalizeUrl(u) {
  let v = u.trim()
  if (!/^https?:\/\//i.test(v)) v = (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(v) ? 'http://' : 'https://') + v
  let parsed
  try { parsed = new URL(v) } catch { throw new UsageError(`not a valid URL: "${u}" (pass each URL as its own argument)`) }
  if (!parsed.hostname || /\s/.test(v)) throw new UsageError(`not a valid URL: "${u}" (pass each URL as its own argument)`)
  return parsed.href
}

// ---------------------------------------------------------------- constants

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Googlebot smartphone. W.X.Y.Z is replaced with the local Chrome version, the
// way Google fills in its evergreen Chromium version.
const GOOGLEBOT_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
// Used only when a server refuses the Googlebot UA from a non-Google IP (bot
// verification at a CDN). The page is then measured as an ordinary phone.
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36'

const MOBILE_W = 412
const MOBILE_H = 915
const TALL_CAP = 30000 // Google's renderer caps the grown viewport; ~30k px is a safe stand-in

// ---------------------------------------------------------------- browser discovery

function findBrowser() {
  const env = process.env.CHROME_PATH
  if (env) {
    if (existsSync(env)) return env
    throw new Error(`CHROME_PATH is set to "${env}" but no file exists there.`)
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates = []
  const os = platform()
  if (os === 'darwin') {
    for (const base of ['/Applications', join(home, 'Applications')]) {
      candidates.push(
        join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
        join(base, 'Chromium.app/Contents/MacOS/Chromium'),
        join(base, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        join(base, 'Brave Browser.app/Contents/MacOS/Brave Browser'),
        join(base, 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'),
      )
    }
  } else if (os === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean)
    for (const r of roots) {
      candidates.push(
        join(r, 'Google/Chrome/Application/chrome.exe'),
        join(r, 'Chromium/Application/chrome.exe'),
        join(r, 'Microsoft/Edge/Application/msedge.exe'),
        join(r, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      )
    }
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/brave-browser', '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
    )
  }
  for (const c of candidates) if (existsSync(c)) return c
  // Last resort: anything on PATH.
  const names = os === 'win32' ? ['chrome.exe', 'msedge.exe', 'brave.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
  for (const dir of (process.env.PATH || '').split(delimiter)) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n)
  throw new Error('No Chrome, Chromium, Edge or Brave found. Install one, or set CHROME_PATH to the browser binary.')
}

// Node 22+ has a global WebSocket. Older Node: fail clearly rather than pull in a dependency.
function getWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  throw new Error(`This Node (${process.version}) has no built-in WebSocket; use Node 22 or newer for the browser modes (raw mode works on Node 18).`)
}

// ---------------------------------------------------------------- browser lifecycle

let chromeProc = null
let profileDir = null

/** Kill Chrome and remove its throwaway profile. Synchronous so it can run in 'exit'. */
function cleanup() {
  if (chromeProc && chromeProc.exitCode === null && !chromeProc.killed) {
    try { chromeProc.kill('SIGKILL') } catch {}
  }
  chromeProc = null
  if (profileDir) {
    const dir = profileDir
    profileDir = null
    // Chrome may still be flushing files for a moment after the kill; retry quietly.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143) })
}

async function launchBrowser() {
  const bin = findBrowser()
  const parent = process.env.CVT_TMPDIR || tmpdir()
  mkdirSync(parent, { recursive: true })
  profileDir = mkdtempSync(join(parent, 'cvt-chrome-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--mute-audio',
    '--hide-scrollbars',
    // A throttled background renderer skips requestAnimationFrame and slows
    // timers, which freezes GSAP / framer mid-tween. Keep every page running.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    // Port 0: Chrome picks a free port of its own and writes it to DevToolsActivePort.
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${MOBILE_W},${MOBILE_H}`,
  ]
  if (platform() === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
  args.push('about:blank')
  chromeProc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  chromeProc.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d })
  const exited = new Promise((r) => chromeProc.once('exit', (code) => r(code)))
  const portFile = join(profileDir, 'DevToolsActivePort')
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    if (chromeProc.exitCode !== null) break
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n')
      if (port && path) return { bin, wsUrl: `ws://127.0.0.1:${port.trim()}${path.trim()}`, exited }
    }
    await sleep(100)
  }
  throw new Error(`Chrome did not start (${bin}).${stderr ? ' stderr: ' + stderr.trim().slice(0, 500) : ''}`)
}

// ---------------------------------------------------------------- minimal CDP client

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = new Set() }
  async connect() {
    const WS = getWebSocket()
    this.ws = new WS(this.wsUrl)
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('DevTools WebSocket failed to open')) })
    this.ws.onmessage = (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString())
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`))
        else p.resolve(m.result)
      } else if (m.method) {
        for (const l of this.listeners) l(m)
      }
    }
    this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('DevTools connection closed')); this.pending.clear() }
  }
  send(method, params = {}, sessionId, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      const msg = { id, method, params }
      if (sessionId) msg.sessionId = sessionId
      this.ws.send(JSON.stringify(msg))
    })
  }
  /** Resolves with the next event `method` on `sessionId`, or null after timeoutMs. */
  waitFor(method, sessionId, timeoutMs) {
    return new Promise((resolve) => {
      const l = (m) => { if (m.method === method && m.sessionId === sessionId) done(m.params) }
      const done = (v) => { clearTimeout(t); this.listeners.delete(l); resolve(v) }
      const t = setTimeout(() => done(null), timeoutMs)
      this.listeners.add(l)
    })
  }
  close() { try { this.ws.close() } catch {} }
}

// ---------------------------------------------------------------- in-page measurement
//
// Runs inside the page (serialised with toString). Walks every text node and
// decides, through every ancestor, whether a reader of the rendered page can
// see it. Must work with page scripts disabled (DevTools evaluation still runs).

function measureInPage(opts) {
  const SKIP_SEL = 'script,style,noscript,template,title,head'
  const FORM_SEL = 'select,option,optgroup,datalist,textarea'
  const root = document.querySelector('main, [role="main"]') || document.body
  const de = document.documentElement
  const docW = Math.max(de.scrollWidth, innerWidth)
  const docH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight)

  const styles = new Map()
  const cs = (e) => { let s = styles.get(e); if (!s) { s = getComputedStyle(e); styles.set(e, s) } return s }
  const rects = new Map()
  const rectOf = (e) => { let r = rects.get(e); if (!r) { r = e.getBoundingClientRect(); rects.set(e, r) } return r }
  const countWords = (t) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

  // A CSS-ish label a developer can grep for: tag#id.class.class[data-attr]
  const desc = (e) => {
    if (!e || e.nodeType !== 1) return ''
    let s = e.tagName.toLowerCase()
    if (e.id) s += '#' + e.id
    const cls = (typeof e.className === 'string' ? e.className : e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)
    for (const c of cls.slice(0, 3)) s += '.' + (c.length > 32 ? c.slice(0, 32) + '…' : c)
    if (cls.length > 3) s += '…'
    const data = [...e.attributes].filter((a) => a.name.startsWith('data-') && !/^data-(v-|reactroot|sentry)/.test(a.name)).slice(0, 3)
    for (const a of data) s += `[${a.name}${a.value && a.value.length < 24 ? '="' + a.value + '"' : ''}]`
    for (const a of ['role', 'aria-hidden', 'inert', 'hidden']) if (e.hasAttribute(a)) s += `[${a}${e.getAttribute(a) ? '="' + e.getAttribute(a) + '"' : ''}]`
    return s
  }
  const pathOf = (e, depth = 3) => {
    const parts = []
    for (let x = e; x && x.nodeType === 1 && x !== document.body && parts.length < depth; x = x.parentElement) parts.unshift(desc(x))
    return parts.join(' > ')
  }
  // Nearest section-ish ancestor with its first heading: tells a developer where on the page this is.
  const sectionOf = (e) => {
    for (let x = e; x && x !== document.body; x = x.parentElement) {
      if (x.tagName === 'SECTION' || x.tagName === 'ARTICLE' || x.tagName === 'ASIDE' || (x.parentElement && x.parentElement === root)) {
        const h = x.querySelector('h1,h2,h3')
        const ht = h ? h.textContent.replace(/\s+/g, ' ').trim().slice(0, 50) : ''
        return x.tagName.toLowerCase() + (x.id ? '#' + x.id : '') + (ht ? ` "${ht}"` : '')
      }
    }
    return ''
  }

  // Site chrome: nav anywhere, and header/footer that are not part of an
  // article or section (an article's own <header> holds its H1 - that is content).
  const isChrome = (el) => {
    if (el.closest('nav,[role="navigation"],[role="banner"],[role="contentinfo"]')) return true
    const hf = el.closest('header,footer')
    return !!(hf && !hf.parentElement?.closest('article,section,main,[role="main"]'))
  }

  // Ids of regions a collapsed control points at (accordions, tabs).
  const collapsedIds = new Set()
  for (const c of document.querySelectorAll('[aria-controls]')) {
    if (c.getAttribute('aria-expanded') === 'false' || c.getAttribute('aria-selected') === 'false') {
      for (const id of c.getAttribute('aria-controls').split(/\s+/)) collapsedIds.add(id)
    }
  }
  const DISCLOSURE_CLASS = /(^|[-_])(accordion|collapse|collapsible|faq|tab-?panel|tabs?-content|tab-pane|dropdown|drawer|modal|dialog|popover|tooltip|submenu|mega-?menu|flyout|offcanvas|disclosure)([-_]|$)/i
  // Strong: the HTML/ARIA says this region is a closed disclosure. Weak: only a class name suggests it.
  const disclosureKind = (e, textNode) => {
    if (e === root || !root.contains(e)) return null
    const t = e.tagName
    if (t === 'DETAILS' && !e.open) {
      const sum = e.querySelector(':scope > summary')
      if (!(sum && sum.contains(textNode))) return 'strong'
    }
    if (t === 'DIALOG' && !e.open) return 'strong'
    if (e.getAttribute('hidden') === 'until-found' || e.hasAttribute('inert') || e.hasAttribute('popover')) return 'strong'
    const role = e.getAttribute('role')
    if (role && /^(tabpanel|tablist|dialog|alertdialog|menu|listbox|tooltip)$/.test(role)) return 'strong'
    if (e.getAttribute('aria-modal') === 'true' || e.getAttribute('aria-expanded') === 'false') return 'strong'
    const st = e.getAttribute('data-state')
    if (st && /^(closed|inactive|hidden|collapsed)$/.test(st)) return 'strong'
    if (e.id && collapsedIds.has(e.id)) return 'strong'
    if (t === 'SELECT' || t === 'DATALIST' || t === 'OPTION' || t === 'TEXTAREA') return 'strong'
    const cls = typeof e.className === 'string' ? e.className : ''
    if (cls && cls.split(/\s+/).some((c) => DISCLOSURE_CLASS.test(c))) return 'weak'
    return null
  }

  const isZeroMatrix = (tr) => {
    const m = /matrix\(([^)]+)\)/.exec(tr)
    if (!m) return false
    const [a, b, c, d] = m[1].split(',').map(Number)
    return (a === 0 && b === 0) || (c === 0 && d === 0)
  }
  const clipPathHides = (cp) => {
    if (!cp || cp === 'none') return false
    if (/circle\(\s*0(px|%)?[\s)]/.test(cp) || /ellipse\(\s*0(px|%)?\s+0/.test(cp)) return true
    const m = /inset\(([^)]*)\)/.exec(cp)
    if (!m) return false
    const v = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/).map((x) => (x.endsWith('%') ? parseFloat(x) : NaN))
    const [t, r = t, b = t, l = r] = v
    return (t + b >= 99.9) || (l + r >= 99.9)
  }

  const nodes = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let n
  while ((n = walker.nextNode())) {
    const text = n.nodeValue.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const p = n.parentElement
    if (!p || p.closest(SKIP_SEL)) continue
    const words = countWords(text)
    if (!words) continue
    const chrome = isChrome(p)
    if (!chrome && !root.contains(n)) continue // outside <main>: cookie banners, portals

    // --- why is it hidden? a list of [element, kind, detail]
    const hiders = []
    let op = 1
    const faded = [] // every ancestor with opacity < 1 (for a product that crosses the threshold)
    if (cs(p).visibility !== 'visible') {
      // visibility inherits: blame the element where it starts
      let o = p
      while (o.parentElement && cs(o.parentElement).visibility !== 'visible') o = o.parentElement
      hiders.push([o, 'visibility', 'visibility:' + cs(p).visibility])
    }
    for (let e = p; e; e = e.parentElement) {
      const s = cs(e)
      if (s.display === 'none') hiders.push([e, 'display', 'display:none'])
      const o = parseFloat(s.opacity)
      if (o < 1) { op *= o; faded.push(e); if (o < 0.1) hiders.push([e, 'opacity', 'opacity:' + Math.round(o * 100) / 100]) }
      if (s.contentVisibility === 'hidden') hiders.push([e, 'collapsed', 'content-visibility:hidden'])
      if ((s.position === 'absolute' || s.position === 'fixed') && /rect\(\s*0(px)?,?\s+0(px)?,?\s+0(px)?,?\s+0(px)?\s*\)/.test(s.clip)) hiders.push([e, 'clip', 'clip:rect(0 0 0 0)'])
      if (clipPathHides(s.clipPath)) hiders.push([e, 'clip', 'clip-path:' + s.clipPath.slice(0, 40)])
      if (s.transform && s.transform !== 'none' && isZeroMatrix(s.transform)) hiders.push([e, 'transform', 'transform:scale(0)'])
    }
    if (op < 0.1 && !hiders.some((h) => h[1] === 'opacity') && faded.length) {
      hiders.push([faded[faded.length - 1], 'opacity', 'opacity product ' + Math.round(op * 100) / 100])
    }
    // Closed <details> and hidden=until-found hide their content through a
    // content-visibility rule on a shadow slot, which is not in the ancestor
    // chain above; checkVisibility() sees it.
    if (!hiders.length && typeof p.checkVisibility === 'function' && !p.checkVisibility()) hiders.push([p, 'collapsed', 'not rendered (closed <details> / content-visibility)'])
    const ps = cs(p)
    if (parseFloat(ps.fontSize) === 0) hiders.push([p, 'transparent', 'font-size:0'])
    const fill = ps.webkitTextFillColor || ps.color
    if (/rgba\([^)]*,\s*0\)$/.test(fill) || fill === 'transparent') {
      let gradient = false
      for (let e = p; e && !gradient; e = e.parentElement) {
        const s = cs(e)
        if ((s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') && s.backgroundImage !== 'none') gradient = true
        // outlined text (transparent fill + stroke) is visible too
        if (parseFloat(s.webkitTextStrokeWidth) > 0) gradient = true
      }
      if (!gradient) hiders.push([p, 'transparent', 'transparent text colour'])
    }

    // --- geometry: zero-size, far off-screen, or collapsed inside an overflow box
    range.selectNodeContents(n)
    const boxes = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
    const notes = []
    if (!boxes.length) {
      if (!hiders.length) hiders.push([p, 'collapsed', 'zero-size box'])
    } else {
      const b = range.getBoundingClientRect()
      const L = b.left + scrollX, T = b.top + scrollY
      // Only clearly deliberate off-screen placement (left:-9999px, text-indent)
      // counts; a small slide-in offset is not hiding.
      if (b.right + scrollX < -5000 || b.bottom + scrollY < -5000 || L > docW + 5000 || T > docH + 5000) hiders.push([p, 'offscreen', 'positioned off-screen'])
      for (let e = p; e && e !== de; e = e.parentElement) {
        const s = cs(e)
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
        const a = rectOf(e)
        const visW = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const visH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (visH <= 0.5 && (visW > 0.5 || a.height <= 1)) {
          hiders.push([e, 'collapsed', `clipped by overflow (box height ${Math.round(a.height)}px)`])
          break
        }
        // Horizontally outside a scroller or marquee: reachable by swiping and
        // fully in the DOM, so not hidden. Noted only.
        if (visW <= 0.5) { notes.push('outside horizontal scroller ' + desc(e)); break }
      }
    }

    const hidden = hiders.length > 0
    const ariaRoot = (() => { let r = null; for (let e = p; e; e = e.parentElement) if (e.getAttribute('aria-hidden') === 'true') r = e; return r })()
    nodes.push({ n, p, text, words, chrome, hidden, hiders, ariaRoot, notes })
  }

  // The page's visible reading text outside aria-hidden. Used to recognise
  // duplicates: a marquee's aria-hidden second copy, ghost text reserving space
  // for a typewriter, or a desktop-only variant of a heading the phone layout
  // shows elsewhere. Hiding a duplicate loses no words.
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const corpus = norm(nodes.filter((x) => !x.ariaRoot && !x.hidden).map((x) => x.text).join(' '))

  // Is this aria-hidden subtree real reading text, or an illustration?
  // Reading text under aria-hidden is dropped by Readability-style extractors
  // (the ones AI tools use), so it is a warning even when it is on screen.
  // Mock-UI illustrations (tiny labels in a drawn dashboard) are decorative.
  const readingCache = new Map()
  // Split text: a heading/paragraph whose words are all in aria-hidden letter or
  // word spans, with the sentence only in the element's aria-label and no
  // visually-hidden copy. Returns the labelled element, or null.
  const splitLabelOf = (a) => {
    const lab = a.parentElement
    if (!lab || !lab.hasAttribute('aria-label')) return null
    const label = norm(lab.getAttribute('aria-label') || '')
    if (!label || label.split(' ').length < 2) return null
    const w = document.createTreeWalker(lab, NodeFilter.SHOW_TEXT)
    let tn
    while ((tn = w.nextNode())) {
      if (!norm(tn.nodeValue)) continue
      let under = false
      for (let e = tn.parentElement; e && e !== lab.parentElement; e = e.parentElement) if (e.getAttribute('aria-hidden') === 'true') { under = true; break }
      if (!under) return null // a readable copy exists inside the element
    }
    return lab
  }
  const ariaIsReading = (a) => {
    if (readingCache.has(a)) return readingCache.get(a)
    const t = norm(a.textContent || '')
    let v
    if (t && /\p{L}/u.test(t) && splitLabelOf(a)) v = true // split text: words only in the parent's aria-label
    else if (!t || !/\p{L}/u.test(t) || t.split(' ').length <= 2 || a.closest('svg') || corpus.includes(t)) v = false // icon, glyph, number, drawing, duplicate
    else if (/^H[1-6]$/.test(a.tagName) || a.querySelector('h1,h2,h3,h4,h5,h6')) v = true
    else if (disclosureKind(a, null) === 'strong') v = true // a closed tab/accordion panel hidden with aria-hidden instead of inert
    else if (a.hasAttribute('aria-label') || (a.parentElement && a.parentElement.hasAttribute('aria-label'))) v = true // split text: words only in an aria-label
    else {
      // A run of prose at a readable size. Illustrations use small labels.
      v = false
      const w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT)
      let tn
      while (!v && (tn = w.nextNode())) {
        if (tn.parentElement && countWords(tn.nodeValue) >= 8 && parseFloat(cs(tn.parentElement).fontSize) >= 12) v = true
      }
    }
    readingCache.set(a, v)
    return v
  }

  // The six classes partition the words: every word is counted exactly once
  // (visible, READING, DISCLOSURE, DECORATIVE, SR_ONLY or ARIA_HIDDEN_READING).
  // ARIA_HIDDEN_READING holds HIDDEN reading text under aria-hidden (it takes
  // precedence over DISCLOSURE: a closed tab hidden with aria-hidden is lost to
  // extractors even when opened). ARIA_HIDDEN_VISIBLE is an overlay on
  // `visible`: on-screen reading text under aria-hidden (split-text headings).
  const tally = () => ({ visible: 0, READING: 0, DISCLOSURE: 0, DECORATIVE: 0, SR_ONLY: 0, ARIA_HIDDEN_READING: 0, ARIA_HIDDEN_VISIBLE: 0 })
  const content = tally()
  const chrome = tally()
  const groups = { READING: new Map(), DISCLOSURE: new Map(), DECORATIVE: new Map(), SR_ONLY: new Map(), ARIA_HIDDEN_READING: new Map(), ARIA_HIDDEN_VISIBLE: new Map(), CHROME: new Map() }
  const visibleTexts = []

  const addSample = (bucket, key, x, info) => {
    const g = groups[bucket]
    let s = g.get(key)
    if (!s) { s = { words: 0, nodes: 0, ...info, element: pathOf(x.p), section: sectionOf(x.p), text: '' }; g.set(key, s) }
    s.words += x.words
    s.nodes++
    if (s.text.length < 90) s.text = (s.text + ' ' + x.text).trim().slice(0, 120)
  }

  for (const x of nodes) {
    const t = x.chrome ? chrome : content
    // Real text under aria-hidden is a warning whether or not it is on screen.
    const ariaReading = x.ariaRoot && ariaIsReading(x.ariaRoot)
    if (!x.hidden) {
      t.visible += x.words
      if (!x.chrome) visibleTexts.push(x.text)
      if (ariaReading) {
        t.ARIA_HIDDEN_VISIBLE += x.words
        const lab = splitLabelOf(x.ariaRoot)
        if (!x.chrome) {
          if (lab) addSample('ARIA_HIDDEN_VISIBLE', desc(lab), x, { reason: 'split text: each word/letter is aria-hidden and the sentence is only in aria-label', hiddenBy: pathOf(lab, 2) })
          else addSample('ARIA_HIDDEN_VISIBLE', desc(x.ariaRoot), x, { reason: 'on screen but under aria-hidden', hiddenBy: pathOf(x.ariaRoot, 2) })
        }
      }
      continue
    }
    if (ariaReading) {
      t.ARIA_HIDDEN_READING += x.words
      if (!x.chrome) addSample('ARIA_HIDDEN_READING', desc(x.ariaRoot), x, { reason: 'hidden and under aria-hidden', hiddenBy: pathOf(x.ariaRoot, 2) })
      continue
    }
    // The outermost hiding element is the one a developer has to change.
    let outer = x.hiders[0]
    for (const h of x.hiders) if (h[0].contains(outer[0]) && h[0] !== outer[0]) outer = h
    const inline = (() => {
      const st = (outer[0].getAttribute && outer[0].getAttribute('style')) || ''
      return (outer[1] === 'opacity' && /opacity\s*:/.test(st)) || (outer[1] === 'visibility' && /visibility\s*:/.test(st)) || (outer[1] === 'display' && /display\s*:/.test(st))
    })()

    let bucket = 'READING'
    // DISCLOSURE: every hiding element sits inside (or is) a closed disclosure
    // region. A class-name-only match does not excuse opacity/visibility hiding,
    // which is the fingerprint of a reveal animation rather than a closed panel.
    for (let e = x.p; e && e !== root; e = e.parentElement) {
      const k = disclosureKind(e, x.n)
      if (!k) continue
      const allInside = x.hiders.every((h) => e.contains(h[0]))
      const kindsOk = k === 'strong' || x.hiders.every((h) => h[1] === 'display' || h[1] === 'collapsed')
      if (allInside && kindsOk) { bucket = 'DISCLOSURE'; break }
    }
    if (bucket === 'READING') {
      const tiny = (e) => { const r = rectOf(e); return r.width <= 2 && r.height <= 2 }
      if (x.hiders.every((h) => h[1] === 'clip' && tiny(h[0]))) bucket = 'SR_ONLY'
      else if (x.ariaRoot && !ariaIsReading(x.ariaRoot)) bucket = 'DECORATIVE'
      // Text drawn inside an SVG illustration.
      else if (!x.ariaRoot && x.p.closest('svg')) bucket = 'DECORATIVE'
      // Responsive duplicate: a display:none variant whose words are visible elsewhere.
      else if (x.hiders.every((h) => h[1] === 'display') && corpus.includes(norm(outer[0].textContent || ''))) bucket = 'DECORATIVE'
    }
    t[bucket] += x.words
    const info = { reason: outer[2] + (inline ? ' (inline style)' : ''), kind: outer[1], inline, hiddenBy: pathOf(outer[0], 2) }
    if (x.chrome) addSample('CHROME', desc(outer[0]) + outer[2], x, info)
    else addSample(bucket, desc(outer[0]) + '|' + outer[2], x, info)
  }

  const top = (m) => [...m.values()].sort((a, b) => b.words - a.words).slice(0, opts.maxSamples)
  const samples = {}
  for (const [k, m] of Object.entries(groups)) if (m.size) samples[k] = top(m)

  // Animation frames actually run? (a frozen tab silently freezes every tween)
  return {
    url: location.href,
    title: document.title,
    root: root === document.body ? 'body' : desc(root),
    viewport: { width: innerWidth, height: innerHeight },
    docHeight: docH,
    visibilityState: document.visibilityState,
    content,
    chrome,
    samples,
    visibleTexts: opts.collectTexts ? visibleTexts.slice(0, 3000) : undefined,
  }
}

// ---------------------------------------------------------------- per-page rendering

let browser = null // { cdp, uaVersion }
let browserProduct = null

async function startBrowser() {
  const { bin, wsUrl } = await launchBrowser()
  const cdp = new CDP(wsUrl)
  await cdp.connect()
  const v = await cdp.send('Browser.getVersion')
  const uaVersion = (/(\d+\.\d+\.\d+\.\d+)/.exec(v.product) || [])[1] || '131.0.0.0'
  browser = { cdp, uaVersion, bin, product: v.product }
  browserProduct = v.product
}

async function stopBrowser() {
  if (!browser) return
  try { await browser.cdp.send('Browser.close', {}, undefined, 3000) } catch {}
  browser.cdp.close()
  browser = null
  // Give Chrome a moment to exit on its own before cleanup() force-kills it.
  if (chromeProc && chromeProc.exitCode === null) await Promise.race([new Promise((r) => chromeProc.once('exit', r)), sleep(3000)])
  cleanup()
}

/**
 * Renders one URL in a fresh browser context (no cache, cookies or service
 * workers carried between pages) and measures it.
 */
async function renderPage(url, mode, opts, ua) {
  const { cdp } = browser
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
  let targetId, sessionId
  try {
    ;({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId }))
    ;({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }))
    const s = (m, p, t) => cdp.send(m, p, sessionId, t)
    await s('Page.enable')
    await s('Runtime.enable')
    await s('Network.enable')
    await s('Network.setCacheDisabled', { cacheDisabled: true })
    await s('Emulation.setUserAgentOverride', { userAgent: ua.replace('W.X.Y.Z', browser.uaVersion), platform: 'Android' })
    await s('Emulation.setDeviceMetricsOverride', { width: MOBILE_W, height: MOBILE_H, deviceScaleFactor: 1, mobile: true })
    await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    if (mode === 'nojs') await s('Emulation.setScriptExecutionDisabled', { value: true })
    // The page must be the foreground, focused target. A background tab gets no
    // requestAnimationFrame callbacks, so GSAP and framer-motion would sit frozen
    // at their start state and the audit would report hidden text that a real
    // renderer shows (or, worse, miss a real failure).
    await cdp.send('Target.activateTarget', { targetId })
    await s('Page.bringToFront')
    await s('Emulation.setFocusEmulationEnabled', { enabled: true })

    const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 45000)
    const nav = await s('Page.navigate', { url }, 45000)
    if (nav.errorText) throw new Error(`could not load ${url}: ${nav.errorText}`)
    const loadOk = await loaded
    const ev = async (expression, awaitPromise = false) => {
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, 120000)
      if (r.exceptionDetails) throw new Error('in-page evaluation failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    }
    const status = await ev("(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0")

    const extra = { loadEvent: !!loadOk, status }
    // An error page: report the status at once instead of growing and waiting.
    if (status >= 400) return { status }
    if (mode === 'nojs') {
      await sleep(Math.min(opts.wait, 1000))
    } else {
      await sleep(Math.min(opts.wait, 2500))
      // Google's renderer does not scroll; it lays the whole page out in one
      // very tall viewport. Grow the viewport to the document height, let the
      // page react (100vh sections grow with it, so repeat) until the height
      // stops changing or hits the cap. Anything that only reveals when it
      // enters a scroll trigger band stays hidden here - exactly the failure
      // this mode exists to catch.
      let h = MOBILE_H
      const steps = []
      for (let i = 0; i < 12; i++) {
        const H = await ev('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)')
        const target = Math.min(Math.max(H, MOBILE_H), TALL_CAP)
        if (target <= h + 2) break
        h = target
        steps.push(h)
        await s('Emulation.setDeviceMetricsOverride', { width: MOBILE_W, height: h, deviceScaleFactor: 1, mobile: true })
        await sleep(1000)
      }
      extra.grownTo = h
      extra.growSteps = steps
      await sleep(opts.wait)
      // Proof that animation frames run in this tab (see bringToFront above).
      extra.animationFrames = await ev(
        'new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 500) requestAnimationFrame(f); else r(n) }; requestAnimationFrame(f); setTimeout(() => r(n), 1500) })',
        true,
      )
    }
    const res = await ev(`(${measureInPage.toString()})(${JSON.stringify({ maxSamples: 12, collectTexts: mode === 'googlebot' })})`)
    return { ...res, ...extra }
  } finally {
    if (targetId) { try { await cdp.send('Target.closeTarget', { targetId }, undefined, 5000) } catch {} }
    try { await cdp.send('Target.disposeBrowserContext', { browserContextId }, undefined, 5000) } catch {}
  }
}

// Statuses a CDN or WAF uses to refuse a spoofed Googlebot (a non-Google IP
// sending the Googlebot UA). Only these are retried with a phone UA; a 404 or
// 410 is the page's real answer and is reported at once.
const BOT_BLOCK_STATUS = new Set([401, 403, 406, 429, 451, 503])

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} for ${url}`); this.status = status }
}

/** Googlebot UA first; if the server refuses it (CDN bot verification), measure as a phone. */
async function renderWithFallback(url, mode, opts) {
  const r = await renderPage(url, mode, opts, GOOGLEBOT_UA)
  if (r.status >= 400) {
    if (!BOT_BLOCK_STATUS.has(r.status)) throw new HttpError(r.status, url)
    const r2 = await renderPage(url, mode, opts, PHONE_UA)
    if (r2.status && r2.status < 400) {
      r2.note = `server answered ${r.status} to the Googlebot user agent from this machine (likely bot verification); measured with a phone user agent`
      return r2
    }
    throw new HttpError(r.status, url)
  }
  return r
}

// ---------------------------------------------------------------- raw mode

const BLOCK_TAGS = 'address|article|aside|blockquote|br|button|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|option|label|img'

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', middot: '·', bull: '•' }
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp) } catch { return m } }
    return named[e.toLowerCase()] ?? m
  })
}

/** Visible-text approximation of served HTML: what a no-JS crawler extracts. */
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, (m, t) => (t.toLowerCase() === 'noscript' || t.toLowerCase() === 'svg' ? m.replace(/<[^>]+>/g, ' ') : ' '))
      .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), ' ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s+/g, ' ').trim()
}

const countWords = (t) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

async function fetchRaw(url, ua) {
  let res
  try {
    res = await fetch(url, { headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
  } catch (e) {
    // Node's fetch says only "fetch failed"; the reason is in e.cause.
    const c = e && e.cause
    const why = c ? [c.code, c.message].filter(Boolean).join(' ') : e && e.name === 'TimeoutError' ? 'timed out after 30s' : ''
    throw new Error(`fetch failed for ${url}${why ? ': ' + why : ''}`)
  }
  return { res, html: await res.text() }
}

async function runRaw(url, uaVersion) {
  let note
  let { res, html } = await fetchRaw(url, GOOGLEBOT_UA.replace('W.X.Y.Z', uaVersion))
  if (res.status >= 400) {
    if (!BOT_BLOCK_STATUS.has(res.status)) throw new HttpError(res.status, url)
    const second = await fetchRaw(url, PHONE_UA.replace('W.X.Y.Z', uaVersion))
    if (second.res.status < 400) {
      note = `server answered ${res.status} to the Googlebot user agent from this machine (likely bot verification); fetched with a phone user agent`
      ;({ res, html } = second)
    } else throw new HttpError(res.status, url)
  }
  // Comments, scripts and styles out first: a comment or a script string that
  // mentions <body> or <main> must not be taken for the real tag, and their
  // text is not page text.
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(clean) || /<body\b[^>]*>([\s\S]*)$/i.exec(clean) || [, clean])[1]
  const mainHtml = (/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body) || [])[1]
  const text = htmlToText(body)

  // Risk markers: patterns that ship text hidden in the served HTML.
  const styles = [...clean.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => decodeEntities(m[2] ?? m[3] ?? ''))
  const opacity0 = (s) => /(^|;)\s*opacity\s*:\s*0*(\.0+)?\s*(!important)?\s*(;|$)/i.test(s)
  const classTokens = [...clean.matchAll(/\sclass\s*=\s*("([^"]*)"|'([^']*)')/gi)].flatMap((m) => (m[2] ?? m[3] ?? '').split(/\s+/))
  const robotsMeta = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).filter((m) => /name\s*=\s*["']?(robots|googlebot)["']?/i.test(m))
  const xRobots = res.headers.get('x-robots-tag') || ''
  const markers = {
    inlineOpacity0: styles.filter(opacity0).length,
    inlineVisibilityHidden: styles.filter((s) => /visibility\s*:\s*hidden/i.test(s)).length,
    framerInitial: styles.filter((s) => opacity0(s) && /(transform|will-change)\s*:/i.test(s)).length,
    dataAos: (clean.match(/\sdata-aos(\s*=|[\s>/])/gi) || []).length,
    opacity0Class: classTokens.filter((c) => /(^|:)opacity-0$/.test(c)).length,
    invisibleClass: classTokens.filter((c) => /(^|:)invisible$/.test(c)).length,
    ariaHiddenTrue: (clean.match(/\saria-hidden\s*=\s*["']?true/gi) || []).length,
    // <h1></h1>: a heading that ships empty and is filled by JS (typewriter, injected title)
    emptyHeading: (body.match(/<h([1-6])\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/h\1\s*>/gi) || []).length,
    // An element named like a loading screen: if the page also ships hidden, it is a preloader cover
    preloader: [...body.matchAll(/<[a-z][\w-]*\b[^>]*\s(?:id|class)\s*=\s*["'][^"']*(?:(?<![a-z])(?:pre-?)?loader(?![a-z])|loading-?(?:screen|overlay)|splash-?screen)[^"']*["'][^>]*>/gi)].length,
  }
  const noindex = []
  if (robotsMeta.some((m) => /content\s*=\s*["'][^"']*\b(noindex|none)\b/i.test(m))) noindex.push('meta robots')
  if (/\b(noindex|none)\b/i.test(xRobots)) noindex.push('X-Robots-Tag header')
  return {
    status: res.status,
    finalUrl: res.url,
    words: countWords(text),
    mainWords: mainHtml !== undefined ? countWords(htmlToText(mainHtml)) : null,
    markers,
    noindex,
    xRobotsTag: xRobots || undefined,
    note,
    // For the JS-only comparison every tag is a boundary, as it is between
    // rendered text nodes: <span>Team</span><time>June</time> is "team june",
    // not "teamjune".
    _normText: norm(decodeEntities(body.replace(/<[^>]+>/g, ' '))),
  }
}

// ---------------------------------------------------------------- sitemaps

async function readSitemap(url, limit, out, depth = 0) {
  if (out.length >= limit || depth > 3) return
  const res = await fetch(url, { headers: { 'user-agent': 'crawler-visible-text-audit' }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`sitemap ${url}: HTTP ${res.status}`)
  const xml = await res.text()
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]))
  if (/<sitemapindex\b/i.test(xml)) {
    for (const l of locs) { if (out.length >= limit) break; await readSitemap(l, limit, out, depth + 1) }
  } else {
    for (const l of locs) { if (out.length >= limit) break; if (!out.includes(l)) out.push(l) }
  }
}

// ---------------------------------------------------------------- reporting

const fmt = (n) => Number(n).toLocaleString('en-US')

const HINTS = {
  opacity: 'Text ships or stays at opacity 0. Send it visible in the server HTML and hide it only under a class a head script sets before paint; in a tall non-scrolling viewport (innerHeight >= 3000) jump reveals to their end state.',
  visibility: 'visibility:hidden waiting for JavaScript. Same fix as opacity: visible by default, hidden only under a JS-set class.',
  display: 'display:none on reading content. If it is a closed tab or accordion, mark it inert / hidden="until-found" or give the panel role="tabpanel"; otherwise render it visible.',
  collapsed: 'Collapsed to zero size. If this is a closed disclosure, mark it (details, role="tabpanel", aria-expanded on the control, inert, hidden="until-found"); otherwise it is lost.',
  clip: 'Clipped away (clip-path / clip), often a wipe reveal that never ran. Start the wipe only after hydration.',
  transform: 'Scaled to 0. Start the scale only after hydration.',
  transparent: 'Transparent or zero-size text. Give it a real colour and size in the served CSS.',
  offscreen: 'Positioned far off-screen. Keep reading content in the layout.',
}

function modeLine(name, r, maxHidden) {
  if (r.error) return `  ${name.padEnd(10)} ERROR  ${r.error}${r.skipped ? ' (not rendered: the server already answered with this error)' : ''}`
  const c = r.content
  let line = `  ${name.padEnd(10)} visible ${fmt(c.visible)} | hidden reading ${fmt(c.READING)}${c.READING > maxHidden ? ' <-' : ''} | disclosure ${fmt(c.DISCLOSURE)} | decorative ${fmt(c.DECORATIVE)} | aria-hidden reading ${fmt(c.ARIA_HIDDEN_READING)}${c.ARIA_HIDDEN_VISIBLE ? ` (+${fmt(c.ARIA_HIDDEN_VISIBLE)} on screen)` : ''}`
  if (c.SR_ONLY) line += ` | sr-only ${fmt(c.SR_ONLY)}`
  return line
}

function printPage(page, opts) {
  const out = []
  out.push(page.url)
  if (page.raw) {
    const r = page.raw
    if (r.error) out.push(`  ${'raw'.padEnd(10)} ERROR  ${r.error}`)
    else {
      const m = r.markers
      const list = [
        m.inlineOpacity0 && `inline opacity:0 x${m.inlineOpacity0}`,
        m.framerInitial && `framer-motion initial (opacity:0 + transform) x${m.framerInitial}`,
        m.inlineVisibilityHidden && `inline visibility:hidden x${m.inlineVisibilityHidden}`,
        m.dataAos && `data-aos x${m.dataAos}`,
        m.opacity0Class && `opacity-0 class x${m.opacity0Class}`,
        m.invisibleClass && `invisible class x${m.invisibleClass}`,
        m.emptyHeading && `empty heading x${m.emptyHeading}`,
        m.preloader && `loader/preloader element x${m.preloader}`,
        m.ariaHiddenTrue && `aria-hidden="true" x${m.ariaHiddenTrue}`,
      ].filter(Boolean)
      // Markers are hints, not verdicts. When the no-JS render shows every
      // reading word, the inline hides sit on decorative or gated elements.
      const nojsClean = page.nojs && !page.nojs.error && page.nojs.content.READING === 0
      const label = !list.length ? 'no risk markers' : (nojsClean ? 'markers (nojs finds 0 hidden reading words, so none of these hides reading text): ' : 'risk markers: ') + list.join(', ')
      out.push(`  ${'raw'.padEnd(10)} ${fmt(r.words)} words in served HTML${r.mainWords !== null ? ` (${fmt(r.mainWords)} in <main>)` : ''} | HTTP ${r.status} | ${label}`)
      if (r.noindex.length) out.push(`             NOINDEX via ${r.noindex.join(' and ')}: search engines are told not to index this page`)
      if (r.note) out.push(`             note: ${r.note}`)
    }
  }
  for (const mode of ['nojs', 'googlebot']) {
    const r = page[mode]
    if (!r) continue
    out.push(modeLine(mode, r, opts.maxHidden))
    if (r.error) continue
    const extras = []
    if (mode === 'googlebot') extras.push(`viewport ${r.viewport.width}x${fmt(r.viewport.height)}`)
    if (r.chrome && (r.chrome.READING + r.chrome.DISCLOSURE) > 0) extras.push(`site nav/header/footer hidden ${fmt(r.chrome.READING + r.chrome.DISCLOSURE)} (menus; not counted)`)
    if (extras.length) out.push(`             ${extras.join(' | ')}`)
    if (mode === 'googlebot' && r.growSteps && r.grownTo >= TALL_CAP && r.growSteps.length >= 3 && r.content.READING > 0) {
      out.push(`             note: the page height grows with the viewport (100vh / 100dvh / h-screen sections), so every section after the first starts below any scroll-trigger line in a tall render`)
    }
    if (mode === 'googlebot' && r.jsOnlyWords) {
      out.push(`             warning: ${fmt(r.jsOnlyWords)} visible words are not in the served HTML (AI crawlers and no-JS readers never see them):`)
      for (const t of r.jsOnlySamples || []) out.push(`               "${t.slice(0, 90)}"`)
      out.push(`             fix: render this text on the server (full typewriter text, final counter value, SSR the fetched/injected content)`)
    }
    if (mode === 'googlebot' && r.animationFrames !== undefined && r.animationFrames < 2) out.push('             warning: animation frames did not run in the audit tab; animated results may be wrong')
    if (r.note) out.push(`             note: ${r.note}`)
  }
  const rawOnly = !page.nojs && !page.googlebot
  const warned = ['nojs', 'googlebot'].some((m) => page[m] && !page[m].error && (page[m].content.ARIA_HIDDEN_READING || page[m].content.ARIA_HIDDEN_VISIBLE)) || !!(page.googlebot && page.googlebot.jsOnlyWords)
  out.push(`  ${page.error ? 'ERROR' : page.pass ? (warned ? 'PASS with warnings (see below)' : 'PASS') : 'FAIL'}${page.error ? '  ' + page.error : rawOnly ? '  (raw only: hidden words are measured in nojs and googlebot modes)' : ''}`)

  // Samples: everything failing, then warnings.
  const seenHints = new Set()
  for (const mode of ['nojs', 'googlebot']) {
    const r = page[mode]
    if (!r || r.error || r.content.READING <= opts.maxHidden) continue
    out.push(`  hidden reading words, ${mode}:`)
    for (const s of (r.samples.READING || []).slice(0, opts.samples)) {
      out.push(`    ${fmt(s.words).padStart(5)} words  ${s.reason} on ${s.hiddenBy}`)
      out.push(`           ${s.section ? 'in ' + s.section + ' | ' : ''}"${s.text.slice(0, 90)}"`)
      seenHints.add(s.kind)
    }
  }
  for (const k of seenHints) if (HINTS[k]) out.push(`  fix (${k}): ${HINTS[k]}`)
  if (page.raw && !page.raw.error && page.raw.markers.preloader && (seenHints.has('visibility') || seenHints.has('opacity'))) {
    out.push('  fix (preloader): a loading screen ships with the content hidden until JS lifts it. Never hide the content under the loader; render the loader only after hydration, or cap it with a CSS-only animation.')
  }
  const g = page.googlebot && !page.googlebot.error ? page.googlebot : page.nojs && !page.nojs.error ? page.nojs : null
  if (g && (g.content.ARIA_HIDDEN_READING > 0 || g.content.ARIA_HIDDEN_VISIBLE > 0)) {
    out.push(`  warning, reading text under aria-hidden: ${fmt(g.content.ARIA_HIDDEN_READING)} hidden + ${fmt(g.content.ARIA_HIDDEN_VISIBLE)} on screen (AI extractors drop it; use inert or hidden="until-found" for closed panels, and a visually-hidden full copy for split text):`)
    for (const s of [...(g.samples.ARIA_HIDDEN_READING || []).slice(0, 3), ...(g.samples.ARIA_HIDDEN_VISIBLE || []).slice(0, 3)]) out.push(`    ${fmt(s.words).padStart(5)} words  ${s.hiddenBy} | ${s.reason} | "${s.text.slice(0, 70)}"`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- main

async function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) {
    if (e instanceof UsageError) { console.error(e.message + '\n\n' + HELP); return 2 }
    throw e
  }
  if (opts.help) { console.log(HELP); return 0 }

  const urls = [...opts.urls]
  const sitemapUrls = []
  for (const sm of opts.sitemaps) {
    try { await readSitemap(sm, opts.limit, sitemapUrls) } catch (e) { console.error(`error: ${e.message}`); return 2 }
  }
  for (const u of sitemapUrls) {
    let h = u
    try { h = new URL(u).href } catch {}
    if (!urls.includes(h)) urls.push(h)
  }
  if (!urls.length) { console.error('No URLs given.\n\n' + HELP); return 2 }

  const needBrowser = opts.modes.includes('nojs') || opts.modes.includes('googlebot')
  let uaVersion = '131.0.0.0'
  if (needBrowser) {
    try { await startBrowser(); uaVersion = browser.uaVersion } catch (e) { console.error(`error: ${e.message}`); return 2 }
  }

  const pages = []
  let anyError = false
  let anyFail = false
  try {
    for (const url of urls) {
      const page = { url }
      for (const mode of opts.modes) {
        // The served page is a real error (404, 410, 500...): rendering it
        // twice more only repeats the answer, slowly.
        if (mode !== 'raw' && page.raw && page.raw.httpStatus && !BOT_BLOCK_STATUS.has(page.raw.httpStatus)) {
          page[mode] = { error: page.raw.error, skipped: true }
          continue
        }
        try {
          if (mode === 'raw') page.raw = await runRaw(url, uaVersion)
          else page[mode] = await renderWithFallback(url, mode, opts)
        } catch (e) {
          page[mode] = { error: e.message }
          if (e instanceof HttpError) page[mode].httpStatus = e.status
          page.error = page.error || `${mode}: ${e.message}`
        }
      }
      // Rendered reading text that the served HTML does not contain: client-only
      // content that AI crawlers (no JavaScript) never receive.
      if (page.raw && !page.raw.error && page.googlebot && !page.googlebot.error) {
        const raw = ' ' + page.raw._normText + ' '
        let missing = 0
        const missingSamples = []
        const seenT = new Set()
        for (const t of page.googlebot.visibleTexts || []) {
          const nt = norm(t)
          // Every visible text node counts, however short: a counter that
          // ships "0" and renders "250", or an injected 3-word heading.
          if (!nt || seenT.has(nt)) continue
          seenT.add(nt)
          if (!raw.includes(' ' + nt + ' ')) { missing += countWords(t); if (missingSamples.length < 8) missingSamples.push(t.slice(0, 100)) }
        }
        page.googlebot.jsOnlyWords = missing
        page.googlebot.jsOnlySamples = missingSamples
      }
      if (page.raw) delete page.raw._normText
      if (page.googlebot) delete page.googlebot.visibleTexts
      const failing = ['nojs', 'googlebot'].some((m) => page[m] && !page[m].error && page[m].content.READING > opts.maxHidden)
      page.pass = !page.error && !failing
      if (page.error) anyError = true
      if (failing) anyFail = true
      pages.push(page)
      console.log(printPage(page, opts) + '\n')
    }
  } finally {
    await stopBrowser()
  }

  const passed = pages.filter((p) => p.pass).length
  const verdict = anyError ? 'ERROR' : anyFail ? 'FAIL' : 'PASS'
  console.log(`${verdict}: ${passed} of ${pages.length} page${pages.length === 1 ? '' : 's'} pass (hidden reading words allowed per mode: ${opts.maxHidden})`)

  if (opts.json) {
    const result = {
      tool: 'crawler-visible-text audit',
      date: new Date().toISOString(),
      browser: browserProduct,
      options: { modes: opts.modes, maxHidden: opts.maxHidden, wait: opts.wait, limit: opts.limit },
      verdict,
      pages,
    }
    writeFileSync(opts.json, JSON.stringify(result, null, 2))
  }
  return anyError ? 2 : anyFail ? 1 : 0
}

main().then(
  (code) => { cleanup(); process.exit(code) },
  (e) => { console.error(`error: ${e && e.stack ? e.stack : e}`); cleanup(); process.exit(2) },
)
