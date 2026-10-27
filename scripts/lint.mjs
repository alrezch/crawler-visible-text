#!/usr/bin/env node
// crawler-visible-ignore-file -- this file describes the patterns it looks for.
/**
 * crawler-visible-text source linter, and the write-time guard.
 *
 * Finds code that hides a site's words from one of the three readers that
 * matter: Google/Bing (render JS, never scroll, very tall viewport), AI
 * crawlers (raw HTML only, no JS), and people/tools without working JS.
 *
 *   node lint.mjs <file-or-dir...> [--json]   lint files, exit 1 on any error
 *   node lint.mjs --hook                      Claude Code PostToolUse hook:
 *                                               stdin = hook payload JSON
 *                                               errors   -> stderr, exit 2
 *                                               warnings -> additionalContext, exit 0
 *   node lint.mjs --rules                     print the rule table
 *
 * Suppress: a comment containing crawler-visible-ignore on the line (or the
 * line above) silences that line; crawler-visible-ignore-file anywhere
 * silences the file. Meant for decorative-only code.
 *
 * Dependency-free. Rules are documented in lint-rules.md next to this file.
 */
import { readFileSync, statSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, extname, basename, dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_DOC = join(HERE, 'lint-rules.md')
const PATTERNS_DOC = join(dirname(HERE), 'references', 'patterns.md')

const WEB_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.vue', '.svelte', '.astro', '.html', '.htm', '.css', '.scss'])
const SKIP_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', 'out', '.git', 'coverage', 'vendor',
  '.open-next', '.vercel', '.svelte-kit', '.astro', '.nuxt', '.output', '.turbo', '.cache', 'bower_components',
  // Not web pages: Storybook stories and transactional e-mail templates (their
  // hidden preheader text is a standard e-mail pattern, not a crawler problem).
  '.storybook', 'stories', '__stories__', 'emails', 'email-templates', 'mail-templates',
])
const SKIP_FILE_RE = /\.min\.(?:js|css|mjs)$|\.d\.ts$|\.(?:test|spec|stories|story)\.(?:[jt]sx?|mdx|vue|svelte)$|\.map$/
const MAX_BYTES = 1_000_000

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

/** @type {{id:string, severity:'error'|'warning', detector:string, message:string, why:string, fix:string}[]} */
export const RULES = [
  {
    id: 'inline-hidden-style',
    severity: 'error',
    detector: 'style={...} / style="..." / :style / style:opacity whose value contains a literal opacity 0 or visibility hidden, on an element that can hold text (not aria-hidden, not img/svg shapes/canvas/input, not a self-closing HTML element).',
    message: 'inline opacity:0 / visibility:hidden reaches the server HTML',
    why: 'without JS the text is blank (no-JS readers, previews); Google only sees it if the reveal fires in its tall, non-scrolling render.',
    fix: 'ship it visible: mark it data-reveal, hide it only under html.js-reveal in CSS, and let the animation write its start state at hydration.',
  },
  {
    id: 'framer-initial-hidden',
    severity: 'error',
    detector: '<motion.x>/<m.x>/motion(Component)/v-motion element whose initial (object, variant name, or ternary branch) has opacity 0. Skipped for initial={false}, a mounted/hydrated condition, inside <AnimatePresence initial={false}>, or when the element is mounted conditionally (&& / ?). With exit= it is reported as a warning (likely tab/slide content).',
    message: 'framer-motion initial has opacity 0, which framer server-renders as an inline style',
    why: 'the server HTML ships the text at opacity 0; whileInView never fires in Google\'s tall render, and no-JS readers see nothing.',
    fix: 'use initial={false} plus a gated reveal (data-reveal + html.js-reveal CSS + start state set at hydration), or animate transform only (y/scale), not opacity.',
  },
  {
    id: 'aos-attribute',
    severity: 'error',
    detector: 'data-aos= attribute in markup.',
    message: 'data-aos: the AOS stylesheet holds [data-aos] at opacity 0 until its script adds aos-animate',
    why: 'no-JS readers get blank text, and Google\'s non-scrolling render never animates anything below the first screen.',
    fix: 'remove AOS; use a gated reveal (content visible in HTML, hidden only under html.js-reveal, end state for windows >= 3000px tall).',
  },
  {
    id: 'css-ungated-hide',
    severity: 'error',
    detector: 'CSS/SCSS (and <style> blocks) rule with opacity:0, visibility:hidden or @apply opacity-0/invisible on a reveal-style selector (reveal, fade, aos, animate-on, in-view, stagger, split...) that has no JS-gate ancestor (html.js, .js-*, [data-js], :not(.no-js), @media (scripting: enabled)). @keyframes, @starting-style, hover/focus/state selectors, enter/leave transition classes, UI chrome (modal, menu, tooltip...) and rules that also run a CSS animation are fine.',
    message: 'CSS hides a reveal selector without a JS gate',
    why: 'the rule applies with or without JavaScript, so no-JS readers and any render where the reveal JS does not run get blank text.',
    fix: 'scope it under the JS gate, e.g. html.js-reveal .reveal:not([data-revealed]) { opacity: 0 }, set by a tiny inline <head> script with a failsafe.',
  },
  {
    id: 'scroll-reveal-no-endstate',
    severity: 'warning',
    detector: 'file uses ScrollTrigger / IntersectionObserver / whileInView / useInView / a reveal library AND sets a hidden start state (opacity/autoAlpha 0, opacity-0, yPercent 100) AND has no tall-viewport or end-state handling (innerHeight >= ..., isNonScrollingTallViewport, .progress(1), data-revealed).',
    message: 'scroll-triggered reveal with no end state for a tall, non-scrolling renderer',
    why: 'Google renders in a viewport as tall as the page and never scrolls; with min-h-screen/100vh sections, every section below the first starts beyond the trigger line and stays hidden.',
    fix: 'if window.innerHeight >= 3000 skip the tween and show the end state; on ScrollTrigger refresh/resize jump reveal tweens to progress(1). Detect by geometry, never user agent.',
  },
  {
    id: 'dynamic-ssr-false',
    severity: 'warning',
    detector: 'next/dynamic call with ssr: false whose name/import path does not look like non-content (studio, editor, map, chart, 3D/canvas, player, cookie banner, modal...).',
    message: 'next/dynamic with ssr:false: nothing of this component is in the server HTML',
    why: 'AI crawlers read raw HTML only, so any text inside is invisible to them.',
    fix: 'render content on the server; keep ssr:false only for truly non-text widgets (3D, maps, editors), or split the text out and SSR it.',
  },
  {
    id: 'mount-gate-null',
    severity: 'warning',
    detector: 'if (!mounted|!hydrated|!isClient) return null/false/<></>, or {mounted && ...}. Files using useTheme/createPortal are skipped.',
    message: 'content renders only after a mounted/hydrated flag flips, so the server sends nothing',
    why: 'AI crawlers and no-JS readers never see what is behind the flag.',
    fix: 'render the content on the server and only gate the animation or the browser-only detail, not the text.',
  },
  {
    id: 'aria-hidden-content',
    severity: 'warning',
    detector: 'aria-hidden with a dynamic value (aria-hidden={!open}, :aria-hidden="!open") on an element with children; static aria-hidden on role="tabpanel"; split-text letters under aria-hidden with the real text only in aria-label.',
    message: 'aria-hidden on real content (closed tab/accordion/panel or split letters)',
    why: 'Readability-style extractors used by AI tools drop aria-hidden subtrees, so this text is lost to them.',
    fix: 'use inert (or hidden="until-found") on closed panels; for split text keep a visually-hidden copy of the full sentence instead of aria-hidden letters.',
  },
  {
    id: 'class-hidden-initial',
    severity: 'warning',
    detector: 'className/class with a bare opacity-0 or invisible (no hover/focus/group/peer/data/aria variant restoring it), either static or behind a visibility-type condition (visible, inView, revealed, mounted, loaded...), on an element that can hold text.',
    message: 'opacity-0 / invisible class in the server HTML, removed later by JS',
    why: 'no-JS readers see blank text, and a scroll/in-view condition never flips in Google\'s tall render.',
    fix: 'ship it visible and hide only under the JS gate (html.js-reveal), or drive the start state from the animation at hydration.',
  },
  {
    id: 'counter-from-zero',
    severity: 'warning',
    detector: 'useState(0) / useMotionValue(0) rendered in JSX in a file with an animation driver (rAF, setInterval, in-view, animate), or react-countup.',
    message: 'animated counter renders 0 in the server HTML',
    why: 'crawlers and no-JS readers record "0" instead of the real figure.',
    fix: 'initialise to the final value so the HTML carries it; start the count-up from 0 only after hydration.',
  },
  {
    id: 'typewriter-state',
    severity: 'warning',
    detector: 'state initialised to "" and grown with slice/substring/charAt/prev + char inside a timer, or a typewriter library (typewriter-effect, react-type-animation, react-simple-typewriter, typed.js).',
    message: 'typewriter text starts empty in the server HTML',
    why: 'crawlers and no-JS readers get an empty headline.',
    fix: 'render the full text in HTML and animate it with a clip/overlay (or a visually-hidden full copy).',
  },
  {
    id: 'effect-set-text',
    severity: 'warning',
    detector: 'state initialised empty/null, rendered as text, and set inside useEffect/onMounted to a literal sentence or a fetched title/text/body.',
    message: 'text is put into state after mount, so the server HTML has an empty element',
    why: 'AI crawlers read the raw HTML only; the sentence does not exist for them.',
    fix: 'initialise the state with the text (or fetch it on the server) so it is in the HTML; update it after mount only if it changes.',
  },
  {
    id: 'active-only-panel',
    severity: 'warning',
    detector: 'inside .map(), an element with text rendered only when it is the active/current/selected one (active === i ? <X/> : null, or active === i && <X/>).',
    message: 'only the active tab/slide/panel is rendered; the others are not in the HTML',
    why: 'closed panels do not exist in the server HTML, so crawlers never see their text; Google indexes closed tabs fully only when the text is in the DOM.',
    fix: 'render every panel and hide the closed ones with hidden="until-found" or inert plus CSS, not by leaving them out.',
  },
  {
    id: 'preloader-cover',
    severity: 'warning',
    detector: 'a loading/preloader/splash state initialised to true in a component that draws a fixed full-screen overlay.',
    message: 'preloader covers the page until JS finishes',
    why: 'no-JS readers and slow devices see only the loader; renderers may snapshot before it lifts.',
    fix: 'do not ship the loader in the server HTML (render it only after hydration), or cap it with a CSS-only timeout and never hide the content under it.',
  },
]
const RULE = Object.fromEntries(RULES.map((r) => [r.id, r]))

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

/** Replace comments with spaces (newlines kept) so offsets and lines still line up. */
function maskJs(src) {
  const out = src.split('')
  const n = src.length
  const stack = [{ t: 'code', d: 0 }]
  let i = 0
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ' }
  while (i < n) {
    const top = stack[stack.length - 1]
    const c = src[i]
    const d = src[i + 1]
    if (top.t === 'tpl') {
      if (c === '\\') { i += 2; continue }
      if (c === '`') { stack.pop(); i++; continue }
      if (c === '$' && d === '{') { stack.push({ t: 'code', d: 0 }); i += 2; continue }
      i++
      continue
    }
    if (c === '/' && d === '/') {
      // `//` right after `:` is a URL (http://), not a comment
      if (src[i - 1] === ':') { i += 2; continue }
      const e = src.indexOf('\n', i)
      const end = e === -1 ? n : e
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e === -1 ? n : e + 2
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      // JS strings cannot span lines; stopping at \n limits JSX-text apostrophes to one line
      i++
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c === '`') { stack.push({ t: 'tpl' }); i++; continue }
    if (c === '{') top.d++
    else if (c === '}') {
      if (top.d === 0 && stack.length > 1) { stack.pop(); i++; continue }
      top.d--
    }
    i++
  }
  return out.join('')
}

function maskHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
}

function maskCss(src, scss) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  if (scss) s = s.replace(/(^|[^:\w"'(])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
  return s
}

function lineIndex(src) {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1)
  return (idx) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1 }
    return { line: lo + 1, col: idx - starts[lo] + 1 }
  }
}

/** Balanced {..} / (..) starting at code[open]; returns [innerStart, closeIdx] or null. */
function balanced(code, open, limit = 20000) {
  const o = code[open]
  const cl = o === '{' ? '}' : o === '(' ? ')' : o === '[' ? ']' : null
  if (!cl) return null
  let depth = 0
  let q = null
  const end = Math.min(code.length, open + limit)
  for (let i = open; i < end; i++) {
    const c = code[i]
    if (q) {
      if (c === '\\') { i++; continue }
      if (c === q || (c === '\n' && q !== '`')) q = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue }
    if (c === o) depth++
    else if (c === cl) { depth--; if (depth === 0) return [open + 1, i] }
  }
  return null
}

/** Attribute value after `=`: {expr}, "str" or 'str'. Returns {value, start, end, kind}. */
function attrValue(code, eqEnd) {
  let i = eqEnd
  while (code[i] === ' ' || code[i] === '\t' || code[i] === '\n') i++
  const c = code[i]
  if (c === '{') {
    const b = balanced(code, i)
    if (!b) return null
    return { value: code.slice(b[0], b[1]), start: i, end: b[1] + 1, kind: 'expr' }
  }
  if (c === '"' || c === "'") {
    const e = code.indexOf(c, i + 1)
    if (e === -1) return null
    return { value: code.slice(i + 1, e), start: i, end: e + 1, kind: 'str' }
  }
  return null
}

function tagEnd(code, start) {
  let depth = 0
  let q = null
  const end = Math.min(code.length, start + 8000)
  for (let i = start + 1; i < end; i++) {
    const c = code[i]
    if (q) {
      if (c === '\\') { i++; continue }
      if (c === q) q = null
      continue
    }
    if (c === '"' || c === "'" || (depth > 0 && c === '`')) { q = c; continue }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (depth === 0 && c === '>' && code[i - 1] !== '=') return i
    else if (depth === 0 && c === '<') return -1
  }
  return -1
}

/** The JSX/HTML opening tag enclosing idx, or null. */
function tagAt(code, idx) {
  let p = idx
  for (let k = 0; k < 60; k++) {
    p = code.lastIndexOf('<', p - 1)
    if (p < 0 || idx - p > 6000) return null
    if (!/[A-Za-z]/.test(code[p + 1] || '')) continue
    const e = tagEnd(code, p)
    if (e > idx) {
      const text = code.slice(p, e + 1)
      const name = (text.match(/^<([A-Za-z][\w.:-]*)/) || [])[1] || ''
      return { start: p, end: e, name, text, selfClosing: /\/\s*>$/.test(text) }
    }
  }
  return null
}

const NON_TEXT_TAGS = new Set([
  'img', 'image', 'picture', 'source', 'video', 'audio', 'canvas', 'iframe', 'input', 'select', 'textarea', 'hr', 'br',
  'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g', 'defs', 'stop', 'lineargradient',
  'radialgradient', 'mask', 'clippath', 'use', 'filter', 'fegaussianblur', 'feturbulence', 'fedisplacementmap', 'pattern', 'symbol',
])
const DECORATIVE_ATTR_RE = /(?<![\w-])aria-hidden(?:\s*=\s*(?:\{\s*true\s*\}|["']true["']))?(?=[\s/>])|role\s*=\s*["'](?:presentation|none)["']/

function isNonTextTag(tag) {
  const bare = tag.name.replace(/^(?:motion|m)\./, '')
  const low = bare.toLowerCase()
  if (NON_TEXT_TAGS.has(low) || low === 'svg') return true
  if (/Icon$|^Icon|Illustration$|^Image$|^Img$|Svg$|Lottie|Canvas$|Video$/.test(bare)) return true
  return false
}
function isDecorativeTag(tag) {
  return DECORATIVE_ATTR_RE.test(tag.text) || isNonTextTag(tag)
}
/** Index of the matching </name> for an opening tag, or -1. */
function closeIndex(code, tag) {
  if (tag.selfClosing) return -1
  const esc = tag.name.replace(/[.$]/g, '\\$&')
  const re = new RegExp(`<(/?)${esc}(?=[\\s>/])`, 'g')
  re.lastIndex = tag.end + 1
  let depth = 1
  let m
  let guard = 0
  while ((m = re.exec(code)) && guard++ < 500) {
    if (m[1]) { if (--depth === 0) return m.index; continue }
    const e = tagEnd(code, m.index)
    if (e > 0 && !/\/\s*>$/.test(code.slice(m.index, e + 1))) depth++
  }
  return -1
}

// Components whose whole subtree is a picture, not reading text
const DECOR_NAME_RE = /Illustration|Decor|Backdrop|Ornament|Particles|Background|Graphic|Artwork|Icon$|^Icon|Lottie|Canvas$|Scene$|Glow$|Blob$|Orb$/

/** [start, end] ranges of subtrees that are decorative: aria-hidden="true", svg, illustration components. */
function decorativeRanges(code) {
  const ranges = []
  const re = /<([A-Za-z][\w.:-]*)(?=[\s>/])/g
  let m
  while ((m = re.exec(code))) {
    const bare = m[1].replace(/^(?:motion|m)\./, '')
    const quick = bare === 'svg' || DECOR_NAME_RE.test(bare)
    const e = tagEnd(code, m.index)
    if (e < 0) continue
    const text = code.slice(m.index, e + 1)
    if (!quick && !DECORATIVE_ATTR_RE.test(text)) continue
    const tag = { start: m.index, end: e, name: m[1], text, selfClosing: /\/\s*>$/.test(text) }
    const c = closeIndex(code, tag)
    if (c > 0) ranges.push([m.index, c])
  }
  return ranges
}

/** True when an element's only child is a decorative component or an image (<Illustration />, <svg>, <img>). */
function childrenOnlyDecorative(code, tag) {
  const c = closeIndex(code, tag)
  if (c < 0) return false
  const inner = code.slice(tag.end + 1, c).trim().replace(/^\{\s*|\s*\}$/g, '')
  const one = inner.match(/^<([A-Za-z][\w.]*)[^]*?\/>$/)
  if (one && !/<[A-Za-z][^]*<[A-Za-z]/.test(inner)) {
    const bare = one[1].replace(/^(?:motion|m)\./, '')
    return DECOR_NAME_RE.test(bare) || NON_TEXT_TAGS.has(bare.toLowerCase()) || /^(?:Image|Img|Picture|Video)$/.test(bare)
  }
  return /^<svg[\s>][^]*<\/svg>$/.test(inner)
}

/** False when the element's subtree is only tags with no text and no {expressions} (an empty box, a toggle, a bar). */
function hasTextContent(code, tag) {
  if (tag.selfClosing) return true // a component could render anything
  const c = closeIndex(code, tag)
  if (c < 0) return true
  let rest = ''
  for (let i = tag.end + 1; i < c; i++) {
    if (code[i] === '<' && /[A-Za-z/>]/.test(code[i + 1] || '')) {
      const e = code[i + 1] === '/' || code[i + 1] === '>' ? code.indexOf('>', i) : tagEnd(code, i)
      if (e < 0) return true
      // a child component may render text; a decorative one or an image does not
      const nm = (code.slice(i + 1, i + 80).match(/^([A-Z][\w.]*)/) || [])[1]
      if (nm && !DECOR_NAME_RE.test(nm) && !/^(?:Image|Img|Picture|Video|Motion\w*)$/.test(nm)) return true
      i = e
      continue
    }
    rest += code[i]
  }
  return /[A-Za-z0-9]/.test(rest.replace(/\{\s*\}/g, ''))
}

const DECOR_FILE_RE = /Illustration|Decor|Backdrop|Ornament|Particles|Background|Graphic|Artwork|Icons?$|Icon[A-Z]/

/** Fixed-position chrome (floating buttons, sticky CTAs, cookie bars): not reading content. */
function isChromeTag(tag) {
  return /(?:className|class)\s*=\s*[{"'`][^>]*?(?<![\w:-])fixed(?![\w-])/.test(tag.text)
}

function decorativeCtx(ctx) {
  if (!ctx._deco) ctx._deco = decorativeRanges(ctx.code)
  return ctx._deco
}
/** Shared skip test for element-level rules. */
function skipElement(ctx, tag) {
  return ctx.decorFile || isDecorativeTag(tag) || inRanges(decorativeCtx(ctx), tag.start) || isChromeTag(tag) ||
    childrenOnlyDecorative(ctx.code, tag) || !hasTextContent(ctx.code, tag)
}

// Literal opacity 0 / visibility hidden inside a JS object expression
const OBJ_OPACITY0_RE = /(?:^|[{,(\s?:])(?:opacity|autoAlpha|['"]opacity['"])\s*:\s*(?:0(?:\.0+)?|['"]0(?:\.0+)?['"])(?=\s*(?:[,})]|$))/m
const OBJ_VIS_RE = /(?:visibility|['"]visibility['"])\s*:\s*['"]hidden['"]/
// Same, inside a CSS declaration string
const CSS_OPACITY0_RE = /(?:^|;|\{)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:!important\s*)?(?:;|$|\})/i
const CSS_VIS_RE = /(?:^|;|\{)\s*visibility\s*:\s*hidden/i

function hidesInObj(s) { return OBJ_OPACITY0_RE.test(s) || OBJ_VIS_RE.test(s) }
// State-driven reveal: opacity: shown ? 1 : 0 / visibility: inView ? 'visible' : 'hidden'.
// The state starts false on the server, so the HTML ships the hidden branch.
const OBJ_TERNARY_RE = /(?:opacity|autoAlpha|visibility|['"](?:opacity|visibility)['"])\s*:\s*(!?\s*[\w.$]+)\s*\?\s*(?:1|['"]1['"]|['"]visible['"])\s*:\s*(?:0(?:\.0+)?|['"]0['"]|['"]hidden['"])(?=\s*[,})]|\s*$)/m
const OBJ_DISPLAY_NONE_RE = /(?:display|['"]display['"])\s*:\s*['"]none['"]|(?:^|;)\s*display\s*:\s*none/
function hidesInCss(s) { return CSS_OPACITY0_RE.test(s) || CSS_VIS_RE.test(s) }

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectInlineHiddenStyle(ctx) {
  const { code, report } = ctx
  const re = /(?<![\w:.-])(:style|style)\s*=\s*(?=[{"'])/g
  let m
  while ((m = re.exec(code))) {
    const v = attrValue(code, m.index + m[0].length)
    if (!v) continue
    const objLike = m[1] === ':style' || v.kind === 'expr'
    let hidden = objLike
      ? (v.kind === 'expr' ? hidesInObj(v.value) : hidesInObj(v.value) || hidesInCss(v.value))
      : hidesInCss(v.value)
    let ternary = null
    if (!hidden && objLike) {
      const t = OBJ_TERNARY_RE.exec(v.value)
      // Only a visibility-type state (shown, inView, revealed, loaded...);
      // open/active/selected ternaries are menus, tabs and modals.
      if (t && VIS_STATE_RE.test(t[1].replace(/^!\s*/, '').split('.').pop()) && !/^!/.test(t[1].trim())) ternary = t[1].trim()
    }
    if (!hidden && !ternary) continue
    // display:none alongside: an intentionally absent element (an e-mail
    // preheader, a template stub), not a reveal waiting for JS.
    if (OBJ_DISPLAY_NONE_RE.test(v.value)) continue
    const tag = tagAt(code, m.index)
    if (!tag) continue
    if (skipElement(ctx, tag)) continue
    if (tag.selfClosing && /^[a-z][\w-]*$/.test(tag.name)) continue
    if (ternary) {
      report('inline-hidden-style', m.index, tag.start, { severity: 'warning', note: `opacity/visibility follows "${ternary}", which is false in the server HTML, so the text ships hidden` })
      continue
    }
    // visibility:hidden alone on a short literal inline label (a spinner
    // caption reserving its space) is an ambiguous UI state: warn, do not block.
    const visOnly = !OBJ_OPACITY0_RE.test(v.value) && !CSS_OPACITY0_RE.test(v.value)
    if (visOnly && /^(?:span|small|em|i|b|strong|label)$/.test(tag.name)) {
      const c = closeIndex(code, tag)
      const inner = c > 0 ? code.slice(tag.end + 1, c) : ''
      if (inner && !/[<{]/.test(inner) && inner.trim().split(/\s+/).length <= 4) {
        report('inline-hidden-style', m.index, tag.start, { severity: 'warning', note: 'visibility:hidden on a short inline label: fine if it only reserves space for a UI state, an error if it is page copy' })
        continue
      }
    }
    report('inline-hidden-style', m.index, tag.start)
  }
  // Svelte style directive
  const sv = /(?<![\w-])style:(opacity|visibility)\s*=\s*(?:\{\s*(['"]?)(0(?:\.0+)?|hidden)\2\s*\}|"(0(?:\.0+)?|hidden)"|'(0(?:\.0+)?|hidden)')/g
  while ((m = sv.exec(code))) {
    const val = m[3] || m[4] || m[5]
    if ((m[1] === 'opacity' && val === 'hidden') || (m[1] === 'visibility' && val !== 'hidden')) continue
    const tag = tagAt(code, m.index)
    if (tag && skipElement(ctx, tag)) continue
    report('inline-hidden-style', m.index, tag ? tag.start : m.index)
  }
}

function animatePresenceFalseRanges(code) {
  const ranges = []
  const re = /<AnimatePresence\b/g
  let m
  while ((m = re.exec(code))) {
    const e = tagEnd(code, m.index)
    if (e < 0) continue
    if (!/initial\s*=\s*\{\s*false\s*\}/.test(code.slice(m.index, e))) continue
    const close = code.indexOf('</AnimatePresence>', e)
    ranges.push([e, close === -1 ? code.length : close])
  }
  return ranges
}
function presenceRanges(code) {
  const ranges = []
  const re = /<AnimatePresence\b/g
  let m
  while ((m = re.exec(code))) {
    const close = code.indexOf('</AnimatePresence>', m.index)
    ranges.push([m.index, close === -1 ? code.length : close])
  }
  return ranges
}
const inRanges = (rs, i) => rs.some(([a, b]) => i > a && i < b)

const GATE_COND_RE = /^\s*!?\s*\(?\s*[\w.]*(?:mount|hydrat|isclient|hasjs|jsready|jsenabled)\w*/i

function variantHides(code, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[\\s{,])['"]?${esc}['"]?\\s*:\\s*\\{([^{}]*)\\}`, 'g')
  let m
  while ((m = re.exec(code))) if (hidesInObj('{' + m[1] + '}')) return true
  return false
}

/** Source of the element's variants={...}: inline object or a const in the file. null if none. */
function ownVariants(code, tagText) {
  const at = tagText.search(/(?<![\w-])variants\s*=\s*\{/)
  if (at < 0) return null
  const v = attrValue(tagText, tagText.indexOf('=', at) + 1)
  if (!v) return null
  const val = v.value.trim()
  if (/^\{/.test(val)) return val
  const id = (val.match(/^([A-Za-z_$][\w$]*)$/) || [])[1]
  if (!id) return val
  const d = new RegExp(`(?:const|let|var)\\s+${id}\\b[^=]*=\\s*\\{`).exec(code)
  if (!d) return null
  const b = balanced(code, d.index + d[0].length - 1)
  return b ? code.slice(b[0] - 1, b[1] + 1) : null
}

function detectFramerInitial(ctx) {
  const { code, report } = ctx
  const motionNames = new Set()
  let m
  const created = /\b(?:const|let|var)\s+([A-Z]\w*)\s*=\s*(?:motion|m)(?:\.create)?\s*\(/g
  while ((m = created.exec(code))) motionNames.add(m[1])
  const hasMotion = /\b(?:motion|m)\.[a-z]\w*\b/.test(code) || motionNames.size > 0 || /\bv-motion\b|<Motion\b/.test(code)
  if (!hasMotion) return
  const falseRanges = animatePresenceFalseRanges(code)
  const presRanges = presenceRanges(code)
  const names = ['(?:motion|m)\\.[a-z]\\w*', 'Motion', ...[...motionNames]].join('|')
  const tagRe = new RegExp(`<(${names})(?=[\\s>/])`, 'g')
  const seen = new Set()
  const check = (tag) => {
    const iRe = /(?<![\w-])(:initial|initial)\s*=\s*(?=[{"'])/g
    let im
    while ((im = iRe.exec(tag.text))) {
      const v = attrValue(tag.text, im.index + im[0].length)
      if (!v) continue
      const val = v.value.trim()
      if (val === 'false') continue
      if (v.kind === 'expr' && GATE_COND_RE.test(val) && /\?/.test(val)) continue
      // A variant label resolves against this element's own variants prop only;
      // labels on a parent without variants just propagate (hover states etc.).
      const own = ownVariants(code, tag.text)
      const labelHides = (n) => own !== null && variantHides(own, n)
      let hides = false
      if (v.kind === 'str' && im[1] === 'initial') hides = labelHides(val)
      else if (v.kind === 'str') hides = hidesInObj(val)
      else {
        hides = hidesInObj(val)
        if (!hides) hides = [...val.matchAll(/['"`](\w+)['"`]/g)].some((x) => labelHides(x[1]))
      }
      if (!hides) continue
      if (inRanges(falseRanges, tag.start)) continue
      // Mounted conditionally ({open && <motion.div>} / cond ? <motion.div> : ...): not in the first HTML
      const before = code.slice(Math.max(0, tag.start - 200), tag.start).replace(/[\s(]+$/, '')
      if (/(?:&&|\?|:)$/.test(before)) continue
      if (skipElement(ctx, tag)) continue
      const hasExit = /(?<![\w-])exit\s*=/.test(tag.text)
      const hasKey = /(?<![\w-])key\s*=/.test(tag.text)
      // exit without key: a modal/lightbox mounted by its parent. exit with key: swapped tab/slide content.
      if (hasExit && !hasKey) continue
      const sev = hasExit || inRanges(presRanges, tag.start) ? 'warning' : null
      report('framer-initial-hidden', tag.start + im.index, tag.start, sev ? { severity: sev, note: 'mounted inside AnimatePresence/with exit: an error if this is the panel shown on first load' } : undefined)
    }
  }
  while ((m = tagRe.exec(code))) {
    const e = tagEnd(code, m.index)
    if (e < 0 || seen.has(m.index)) continue
    seen.add(m.index)
    check({ start: m.index, end: e, name: m[1], text: code.slice(m.index, e + 1), selfClosing: /\/\s*>$/.test(code.slice(m.index, e + 1)) })
  }
  // Vue @vueuse/motion: any element with v-motion
  const vm = /<([a-zA-Z][\w-]*)[^<>]*\bv-motion\b/g
  while ((m = vm.exec(code))) {
    if (seen.has(m.index)) continue
    const e = tagEnd(code, m.index)
    if (e < 0) continue
    seen.add(m.index)
    check({ start: m.index, end: e, name: m[1], text: code.slice(m.index, e + 1), selfClosing: false })
  }
}

// The AOS recipe (references/recipes.md section 3) keeps data-aos but lifts
// AOS's hide for no-JS readers with html:not(.js-reveal) [data-aos] {...} and
// adds aos-animate in a tall window. Once that override exists anywhere in the
// project, data-aos is downgraded to a warning.
const AOS_OVERRIDE_RE = /html:not\(\s*\.js-reveal\s*\)\s+\[data-aos\]/
const aosCache = new Map()
function projectRoot(file) {
  let d = dirname(resolve(file))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'package.json')) || existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return dirname(resolve(file))
}
function findAosOverride(file, raw) {
  if (AOS_OVERRIDE_RE.test(raw)) return file
  const root = projectRoot(file)
  if (aosCache.has(root)) return aosCache.get(root)
  let found = null
  let budget = 4000
  const stack = [root]
  while (stack.length && !found && budget > 0) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (found || budget <= 0) break
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!WALK_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p); continue }
      if (!/\.(?:css|scss|sass|less|html?|astro|vue|svelte|[jt]sx?)$/i.test(e.name)) continue
      budget--
      try { if (statSync(p).size < MAX_BYTES && AOS_OVERRIDE_RE.test(readFileSync(p, 'utf8'))) found = p } catch {}
    }
  }
  aosCache.set(root, found)
  return found
}

function detectAos(ctx) {
  const { code, report } = ctx
  const re = /(?<![\w-])data-aos\s*=/g
  let m
  let override
  while ((m = re.exec(code))) {
    const tag = tagAt(code, m.index)
    if (tag && skipElement(ctx, tag)) continue
    if (override === undefined) override = findAosOverride(ctx.file, ctx.raw)
    report('aos-attribute', m.index, tag ? tag.start : m.index, override
      ? { severity: 'warning', note: `no-JS override found in ${basename(override)}; make sure a window >= 3000px tall gets aos-animate on load and resize` }
      : undefined)
  }
}

const NONCONTENT_RE = /studio|sanity|editor|monaco|codemirror|map|leaflet|mapbox|chart|recharts|graph|plot|three|3d|canvas|webgl|r3f|fiber|spline|lottie|video|player|confetti|particle|globe|scene|model|pdf|analytics|cookie|consent|toast|modal|dialog|drawer|cursor|devtools|debug|admin|dashboard|shader|noise|blob|orb|captcha|turnstile|embed|widget|chat|intercom|crisp|calendly|qr|signature|camera|webcam|terminal|playground|sandpack|stackblitz/i

function detectDynamicSsrFalse(ctx) {
  const { code, report, file } = ctx
  if (!/\bdynamic\s*\(/.test(code) || NONCONTENT_RE.test(file.replace(/\\/g, '/').split('/').slice(-3).join('/'))) return
  const re = /\bdynamic\s*\(/g
  let m
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index)
    const b = balanced(code, open)
    if (!b) continue
    const inner = code.slice(b[0], b[1])
    if (!/\bssr\s*:\s*false\b/.test(inner)) continue
    const name = (code.slice(Math.max(0, m.index - 80), m.index).match(/(\w+)\s*=\s*$/) || [])[1] || ''
    const path = (inner.match(/import\(\s*['"`]([^'"`]+)/) || [])[1] || ''
    const then = (inner.match(/\.then\(\s*\(?\s*\w*\s*\)?\s*=>\s*[\w.]*?\.?(\w+)\s*\)/) || [])[1] || ''
    if (NONCONTENT_RE.test(`${name} ${path} ${then}`)) continue
    report('dynamic-ssr-false', m.index)
  }
}

function detectMountGate(ctx) {
  const { code, report, ext } = ctx
  if (ext === '.css' || ext === '.scss' || ext === '.html' || ext === '.htm') return
  if (/\buseTheme\b|createPortal|next-themes/.test(code)) return
  // Theme / colour-scheme toggles gate on mount to avoid a hydration mismatch;
  // they hold a control, not page copy.
  if (/theme|dark-?mode|color-?scheme/i.test(basename(ctx.file)) || /\b(?:setTheme|theme|darkMode|colorScheme|prefers-color-scheme)\b/.test(code)) return
  if (!/<[A-Za-z]/.test(code)) return
  const flag = '(\\w*(?:[mM]ounted|[hH]ydrated)\\w*|isClient|hasJs)'
  const a = new RegExp(`if\\s*\\(\\s*!\\s*${flag}\\s*\\)\\s*(?:\\{\\s*)?return\\s*(?:null|false|undefined|<>\\s*</>|''|""|;|\\})`, 'g')
  const b = new RegExp(`\\{\\s*${flag}\\s*&&`, 'g')
  let m
  for (const re of [a, b]) while ((m = re.exec(code))) report('mount-gate-null', m.index)
}

function detectAriaHidden(ctx) {
  const { code, report } = ctx
  let m
  const dyn = /(?<![\w-])(:aria-hidden|aria-hidden)\s*=\s*(?=[{"'])/g
  while ((m = dyn.exec(code))) {
    const v = attrValue(code, m.index + m[0].length)
    if (!v) continue
    const val = v.value.trim()
    const isStaticTrue = /^(?:true|'true'|"true"|`true`)$/.test(val) || (v.kind === 'str' && m[1] === 'aria-hidden')
    const tag = tagAt(code, m.index)
    if (!tag) continue
    if (tag.selfClosing || isNonTextTag(tag)) continue
    if (isStaticTrue) {
      if (/role\s*=\s*["']tabpanel["']/.test(tag.text) && val !== 'false') report('aria-hidden-content', m.index, tag.start)
      continue
    }
    if (/^(?:false|'false'|"false")$/.test(val)) continue
    report('aria-hidden-content', m.index, tag.start)
  }
  // Split-text letters hidden, real text only in aria-label
  if (/\.split\(\s*(?:''|""|``)\s*\)|Array\.from\(\s*[\w.]+\s*\)\s*\.map|\[\s*\.\.\.\s*[\w.]+\s*\]\s*\.map/.test(code) &&
      /aria-label\s*=/.test(code) && !/sr-only|visually-?hidden|VisuallyHidden/.test(code)) {
    const re = /<(?:span|motion\.span|m\.span|div|motion\.div)\b[^<>]*?(?<![\w-])aria-hidden(?:\s*=\s*(?:\{\s*true\s*\}|["']true["']))?(?=[\s/>])/g
    if ((m = re.exec(code))) report('aria-hidden-content', m.index, m.index, { note: 'split-text: the letters are aria-hidden and the sentence lives only in aria-label' })
  }
}

const TRIGGER_RE = /\bScrollTrigger\b|\bscrollTrigger\s*:|new\s+IntersectionObserver\b|\bwhileInView\b|\buseInView\s*\(|<InView\b|\binView\s*\(|from\s+['"](?:react-awesome-reveal|react-reveal|scrollreveal|sal\.js|wowjs|aos)['"]|ScrollReveal\(\)\s*\.reveal/
const HIDE_SIGNAL_RE = /(?:^|[{,\s])(?:opacity|autoAlpha)\s*:\s*['"]?0(?:\.0+)?['"]?(?=\s*[,}\n])|(?<![\w:-])opacity-0(?![\w-])|(?<![\w:-])invisible(?![\w-])|\byPercent\s*:\s*-?100\b|from\s+['"](?:react-awesome-reveal|react-reveal|scrollreveal|sal\.js|wowjs|aos)['"]/
const END_STATE_RE = /innerHeight\s*>=?|isNonScrollingTallViewport|TALL_VIEWPORT|\.progress\(\s*1\s*\)|REVEALED_ATTR|data-revealed/
const FULL_VH_RE = /\b(?:min-)?h-(?:screen|dvh|svh|lvh)\b|\b100[dsl]?vh\b/

function detectScrollReveal(ctx) {
  const { code, raw, report } = ctx
  if (ctx.decorFile) return
  const t = TRIGGER_RE.exec(code)
  if (!t) return
  if (END_STATE_RE.test(raw)) return
  const deco = decorativeCtx(ctx)
  const hs = new RegExp(HIDE_SIGNAL_RE.source, 'g')
  let h, live = false
  while ((h = hs.exec(code))) if (!inRanges(deco, h.index)) { live = true; break }
  if (!live) return
  report('scroll-reveal-no-endstate', t.index, t.index, FULL_VH_RE.test(code) ? { note: 'this file also has full-viewport sections (100vh / h-screen): the exact trap' } : undefined)
}

const VIS_STATE_RE = /visible|inview|in_view|revealed|shown|^show$|entered|animat|loaded|ready|hydrated|mounted|seen|intersect|started|active?In/i

function detectClassHidden(ctx) {
  const { code, report } = ctx
  const re = /(?<![\w:.-])(className|class|:class)\s*=\s*(?=[{"'`])/g
  let m
  while ((m = re.exec(code))) {
    const v = attrValue(code, m.index + m[0].length)
    if (!v) continue
    if (!/(?<![\w:-])(?:(?:sm|md|lg|xl|2xl|max-\w+|min-\w+):)*(?:opacity-0|invisible)(?![\w-])/.test(v.value)) continue
    // A variant restoring it: hover/focus/group/peer/aria/open-state = interactive
    // UI (tooltip, hover card, menu), not a reveal. A reveal variant
    // (data-[in], data-[visible], [&.is-revealed]...) is exactly what JS toggles.
    const restores = [...v.value.matchAll(/(\S+):(?:opacity-(?:[1-9]\d*|\[[^\]]+\])|visible)(?![\w-])/g)].map((x) => x[1])
    let revealVariant = false
    if (restores.length) {
      if (restores.some((vr) => !REVEAL_VARIANT_RE.test(vr))) continue
      revealVariant = true
    }
    const tag = tagAt(code, m.index)
    if (!tag || skipElement(ctx, tag) || (tag.selfClosing && /^[a-z]/.test(tag.name))) continue
    let fire = false
    if (v.kind === 'str') fire = true
    else {
      // find each string literal holding the class and decide static vs conditional
      const lit = /(['"`])([^'"`]*?(?<![\w:-])(?:(?:sm|md|lg|xl|2xl):)*(?:opacity-0|invisible)(?![\w-])[^'"`]*)\1/g
      let l
      while ((l = lit.exec(v.value))) {
        const before = v.value.slice(0, l.index)
        const cond = before.match(/([!\w.$]+)\s*(?:\?|&&)\s*(?:['"`][^'"`]*['"`]\s*:\s*)?$/)
        if (!cond) {
          // no condition right before: static piece (cn('base opacity-0', ...)) unless a ternary is open
          if (!/[?:]\s*$/.test(before)) { fire = true; break }
          const c2 = before.match(/([!\w.$]+)\s*\?[^?]*$/)
          if (c2 && VIS_STATE_RE.test(c2[1].replace(/^!/, ''))) { fire = true; break }
          continue
        }
        if (VIS_STATE_RE.test(cond[1].replace(/^!/, '').split('.').pop())) { fire = true; break }
      }
    }
    if (revealVariant) fire = true
    if (fire) report('class-hidden-initial', m.index, tag.start, revealVariant ? { note: 'the class that makes it visible is a reveal variant that only JS sets' } : undefined)
  }
  // Vue v-show on a visibility-type flag: SSR renders display:none until it flips
  const vs = /(?<![\w-])v-show\s*=\s*"\s*([\w.$]+)\s*"/g
  while ((m = vs.exec(code))) {
    if (!VIS_STATE_RE.test(m[1].split('.').pop())) continue
    const tag = tagAt(code, m.index)
    if (!tag || skipElement(ctx, tag)) continue
    report('class-hidden-initial', m.index, tag.start, { note: `v-show="${m[1]}" renders display:none in the server HTML until the flag flips` })
  }
}

// Tailwind variants that JS sets to reveal (as opposed to user interaction or
// component open state, which are fine).
const REVEAL_VARIANT_RE = /data-\[?(?:in|inview|in-view|visible|is-visible|revealed|reveal|shown|show|entered|animated?|appeared?|intersect\w*|ready|loaded|mounted)(?:=[^\]]*)?\]?$|\[&\.(?:is-)?(?:in|inview|in-view|visible|revealed|shown|show|animated?|appeared?|loaded|ready)\]$|^(?:in-view|inview|revealed|intersect)$/i

const IDX_NAME_RE = /index|idx|step|page|tab|slide|active|current|selected|attempt|retr|tick|width|height|offset|scroll|progress|pos|^x$|^y$|len|size|time|elapsed|second|minute|timer|key|version|^i$|^j$|^k$|hover|cursor|frame|round|level|zoom|rotation|angle|delay|phase|stage|mode|focus|error|click|like|vote|quantity|qty|cart|item|unread|notif/i
const ANIM_DRIVER_RE = /requestAnimationFrame|setInterval|IntersectionObserver|useInView|whileInView|ScrollTrigger|\banimate\s*\(|\bgsap\b|onViewportEnter/

function detectCounter(ctx) {
  const { code, report } = ctx
  let m
  const cu = /<CountUp\b/g
  while ((m = cu.exec(code))) report('counter-from-zero', m.index)
  if (!ANIM_DRIVER_RE.test(code)) return
  const st = /const\s*\[\s*(\w+)\s*,\s*set\w*\s*\]\s*=\s*(?:React\.)?useState(?:<[^>]*>)?\(\s*0\s*\)/g
  while ((m = st.exec(code))) {
    const name = m[1]
    if (IDX_NAME_RE.test(name)) continue
    // A count-up runs toward a final figure: the setter is bounded (Math.min,
    // >= to, a target/end/value). An unbounded tick (c => c + 1) is a live
    // timer or click counter, not a figure the page is hiding.
    const setter = (m[0].match(/,\s*(set\w*)/) || [])[1]
    if (setter) {
      const calls = [...code.matchAll(new RegExp(`${setter}\\s*\\(`, 'g'))].map((c) => {
        const b = balanced(code, c.index + c[0].length - 1)
        return b ? code.slice(b[0], b[1]) : ''
      })
      const bounded = calls.some((c) => /Math\.(?:min|max|round|floor|ceil)|(?<![=-])[<>]=?|\b(?:to|target|end|final|goal|max|value|total|amount)\b|\*\s*(?:p|t|progress|eased?)\b/.test(c))
      if (!bounded) continue
    }
    const rendered = new RegExp(`\\{\\s*(?:[\\w.]+\\()?\\s*${name}\\b(?:\\.(?:toLocaleString|toFixed)\\([^)]*\\))?\\s*\\)?\\s*\\}`)
    if (rendered.test(code)) report('counter-from-zero', m.index)
  }
  const mv = /const\s+(\w+)\s*=\s*useMotionValue\(\s*0\s*\)/g
  while ((m = mv.exec(code))) {
    if (IDX_NAME_RE.test(m[1]) && !/count|num|value|stat/i.test(m[1])) continue
    if (/\banimate\s*\(/.test(code) && /useTransform\([^)]*Math\.round|\.toLocaleString|Math\.round/.test(code)) report('counter-from-zero', m.index)
  }
}

function detectTypewriter(ctx) {
  const { code, report } = ctx
  let m
  const lib = /from\s+['"](typewriter-effect|react-type-animation|react-simple-typewriter|typed\.js|react-typed|t-writer\.js)['"]/g
  while ((m = lib.exec(code))) report('typewriter-state', m.index)
  if (!/setInterval|setTimeout|requestAnimationFrame/.test(code)) return
  const st = /const\s*\[\s*(\w+)\s*,\s*(set\w+)\s*\]\s*=\s*(?:React\.)?useState(?:<[^>]*>)?\(\s*(?:''|""|``)\s*\)/g
  while ((m = st.exec(code))) {
    const setter = m[2]
    const grow = new RegExp(`${setter}\\s*\\(\\s*(?:[\\w.]+\\.(?:slice|substring|substr)\\(\\s*0\\s*,|\\(?\\s*\\w+\\s*\\)?\\s*=>\\s*\\w+\\s*\\+|[\\w.]+\\.charAt\\(|[\\w.]+\\[\\s*\\w+\\s*\\])`)
    if (grow.test(code)) report('typewriter-state', m.index)
  }
}

function detectEffectSetText(ctx) {
  const { code, report } = ctx
  if (!/useEffect|useLayoutEffect|onMounted|onMount\b/.test(code)) return
  const st = /const\s*\[\s*(\w+)\s*,\s*(set\w+)\s*\]\s*=\s*(?:React\.)?useState(?:<[^>]*>)?\(\s*(?:''|""|``|null|undefined)?\s*\)/g
  let m
  while ((m = st.exec(code))) {
    const [, name, setter] = m
    // rendered as text somewhere
    if (!new RegExp(`\\{\\s*${name}\\s*\\}`).test(code)) continue
    const effects = /\b(?:useEffect|useLayoutEffect|onMounted|onMount)\s*\(/g
    let e
    while ((e = effects.exec(code))) {
      const b = balanced(code, e.index + e[0].length - 1)
      if (!b) continue
      const body = code.slice(b[0], b[1])
      // setX('a sentence of real copy') or setX(data.title) after a fetch
      const lit = new RegExp(`${setter}\\s*\\(\\s*(['"\`])[^'"\`]*\\s[^'"\`]*\\s[^'"\`]*\\1\\s*\\)`).exec(body)
      const fetched = /\bfetch\s*\(|axios|\.get\(/.test(body) && new RegExp(`${setter}\\s*\\(\\s*[\\w.]*(?:title|text|body|content|copy|description|intro|heading|name)\\b`, 'i').test(body)
      if (lit || fetched) {
        report('effect-set-text', b[0] + (lit ? lit.index : body.search(new RegExp(`${setter}\\s*\\(`))))
        break
      }
    }
  }
}

function detectActiveOnlyPanel(ctx) {
  const { code, report } = ctx
  const re = /\.map\(\s*\(?\s*(\w+)\s*(?:,\s*(\w+))?\s*\)?\s*=>/g
  let m
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index + 4)
    const b = balanced(code, open)
    if (!b) continue
    const body = code.slice(b[0], b[1])
    const params = [m[1], m[2]].filter(Boolean)
    // active === i ? <p>...</p> : null   /   active === item.id && <p>...</p>
    const c = /([\w.$]+)\s*===?\s*([\w.$]+)\s*(\?|&&)\s*\(?\s*</.exec(body)
    if (!c) continue
    const sides = [c[1], c[2]]
    const other = sides.find((x) => !params.some((p) => x === p || x.startsWith(p + '.')))
    if (!other || !sides.some((x) => params.some((p) => x === p || x.startsWith(p + '.')))) continue
    if (!/active|current|selected|open|tab|index|idx|slide|step|expanded|panel/i.test(other)) continue
    if (c[3] === '?' && !/:\s*(?:null|undefined|false|''|""|<>\s*<\/>)\s*\)?\s*\)?\s*$/.test(body.trim())) continue
    const at = b[0] + c.index + c[0].length - 1
    const tag = tagAt(code, at + 1)
    if (!tag || skipElement(ctx, tag)) continue
    report('active-only-panel', b[0] + c.index)
  }
}

function detectPreloader(ctx) {
  const { code, report, file } = ctx
  if (!/preload|loader|loading|splash|intro/i.test(basename(file)) && !/Preloader|LoadingScreen|SplashScreen|PageLoader/.test(code)) return
  if (!/\bfixed\b|position\s*:\s*['"]?fixed/.test(code)) return
  if (!/inset-0|100vh|h-screen|100dvh|inset\s*:\s*0/.test(code)) return
  const st = /const\s*\[\s*(\w*(?:[lL]oad|[pP]reload|[sS]plash|[iI]ntro|[sS]howLoader)\w*)\s*,\s*set\w*\s*\]\s*=\s*(?:React\.)?useState(?:<[^>]*>)?\(\s*true\s*\)/g
  let m
  if ((m = st.exec(code))) report('preloader-cover', m.index)
}

// --- CSS -------------------------------------------------------------------

const REVEAL_SEL_RE = /reveal|fade|(?<![\w])aos\b|data-aos|scroll-?anim|on-?scroll|appear|in-?view|inview|observe|(?<![\w-])\.?sal(?![\w-])|data-sal|(?<![\w-])\.wow(?![\w-])|stagger|slide-?(?:in|up)|animate-?(?:on|in|me)|will-?animate|to-?animate|anim-?(?:in|item|el|text)|text-?anim|split-?(?:text|line|word|char)|js-hidden|hidden-until|before-?reveal|not-?visible|data-animat|data-scroll|(?<![\w-])\.(?:char|word|line)s?(?![\w-])/i
const STATE_SEL_RE = /\.fade:not\(\.(?:show|in)\)|(?:^|[-_.])(?:on-?)?hover(?:[-_]|$|(?![\w]))|hover-|:hover|:focus|:active|:checked|:disabled|:empty|:placeholder|::?(?:before|after|placeholder|marker|selection|backdrop|-webkit|-moz)|\[data-(?:state|headlessui|leaving|entering|closed|starting-style|ending-style|exiting|expanded|open)|\[aria-|\[open\]|\[hidden|\.(?:is-)?(?:open|closed|hidden|collapsed)(?![\w-])|-(?:enter|leave|exit)(?:-(?:from|to|active|done))?(?![\w-])|-appear-from/i
const CHROME_SEL_RE = /modal|dropdown|tooltip|popover|toast|menu|dialog|drawer|tab-pane|collapse|offcanvas|overlay|backdrop|lightbox|cursor|loader|spinner|skeleton|carousel-item|swiper|slick|marquee|ripple|scrollbar/i
// A loading-screen class on an ancestor hiding the page itself:
// .preloader-active main, body.is-loading #content, html.loading body
const LOADER_ANCESTOR_RE = /(?:pre-?load|loading|loader|splash)/i
const PAGE_SUBJECT_RE = /^(?:html|body|main|section|article|#(?:content|main|app|root|page|site|wrapper|__next|__nuxt)|\.(?:content|page|site|main|wrapper|site-content|page-content|main-content))(?:$|[.#:\[])/i
function preloaderHidesPage(sel) {
  const parts = sel.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean)
  if (parts.length < 2) return false
  const subject = parts[parts.length - 1]
  return PAGE_SUBJECT_RE.test(subject) && parts.slice(0, -1).some((p) => LOADER_ANCESTOR_RE.test(p))
}
const GATE_SEL_RE = /\.(?:js|has-js|[\w-]*-js|js-[\w-]+|hydrated|fx-ready)(?![\w-])|:not\(\s*\.no-js\s*\)|\[data-(?:js|fx|hydrated|scripting)[\w-]*/i

function cssFindings(css, offset, ctx) {
  const stack = [] // {type:'sel'|'at', text, selectors?}
  let buf = ''
  let bufStart = 0
  let block = null // current innermost selector block: {decls:[], hasAnim}
  const blocks = []
  const flushDecl = (endIdx) => {
    const d = buf.trim()
    buf = ''
    if (!d) return
    const top = stack[stack.length - 1]
    if (!top || top.type !== 'sel') return
    if (stack.some((s) => s.type === 'at' && /^@(?:-\w+-)?keyframes|^@starting-style/i.test(s.text))) return
    top.decls.push({ d, idx: bufStart })
  }
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '"' || c === "'") {
      const e = css.indexOf(c, i + 1)
      if (e === -1) break
      if (!buf.trim()) bufStart = i
      buf += css.slice(i, e + 1)
      i = e
      continue
    }
    if (c === '{') {
      const prelude = buf.trim()
      buf = ''
      if (prelude.startsWith('@')) stack.push({ type: 'at', text: prelude })
      else {
        const parent = [...stack].reverse().find((s) => s.type === 'sel')
        const parts = prelude.split(',').map((s) => s.trim()).filter(Boolean)
        let sels = parts
        if (parent) {
          sels = []
          for (const p of parent.selectors) for (const s of parts) sels.push(s.includes('&') ? s.replace(/&/g, p) : `${p} ${s}`)
        }
        const node = { type: 'sel', text: prelude, selectors: sels.slice(0, 200), decls: [], idx: bufStart, ats: stack.filter((s) => s.type === 'at').map((s) => s.text) }
        stack.push(node)
        blocks.push(node)
      }
      continue
    }
    if (c === '}') { flushDecl(i); stack.pop(); continue }
    if (c === ';') { flushDecl(i); continue }
    if (!buf.trim() && !/\s/.test(c)) bufStart = i
    buf += c
  }
  for (const b of blocks) {
    const hide = b.decls.find(({ d }) => /^opacity\s*:\s*0(?:\.0+)?\s*(?:!important)?$/i.test(d) || /^visibility\s*:\s*hidden\b/i.test(d) || /^@apply\b.*(?<![\w:-])(?:opacity-0|invisible)(?![\w-])/.test(d))
    if (!hide) continue
    if (b.decls.some(({ d }) => /^animation(?:-name)?\s*:/i.test(d) && !/\bnone\b/.test(d) && !/paused/.test(d))) continue
    if (b.ats.some((a) => /scripting\s*:\s*enabled/i.test(a) || /keyframes|starting-style/i.test(a))) continue
    let bad = b.selectors.find((s) => REVEAL_SEL_RE.test(s) && !STATE_SEL_RE.test(s) && !CHROME_SEL_RE.test(s) && !GATE_SEL_RE.test(s))
    if (!bad) {
      const pre = b.selectors.find((s) => preloaderHidesPage(s) && !GATE_SEL_RE.test(s))
      if (pre) {
        ctx.report('css-ungated-hide', offset + hide.idx, offset + b.idx, { note: `preloader: "${pre.slice(0, 80)}" hides the page until a script removes the loading class` })
        continue
      }
    }
    if (!bad) continue
    const noJsFallback = /\.no-js\b/.test(css)
    ctx.report('css-ungated-hide', offset + hide.idx, offset + b.idx, noJsFallback ? { severity: 'warning', note: 'a .no-js fallback exists in this file; the hide still applies when JS runs but the reveal never fires' } : { note: `selector: ${bad.slice(0, 80)}` })
  }
}

function detectCss(ctx) {
  const { code, ext } = ctx
  if (ext === '.css' || ext === '.scss') return cssFindings(code, 0, ctx)
  if (!['.html', '.htm', '.vue', '.svelte', '.astro'].includes(ext)) return
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  let m
  while ((m = re.exec(code))) cssFindings(m[1], m.index + m[0].indexOf('>') + 1, ctx)
}

const JS_DETECTORS = [
  detectInlineHiddenStyle, detectFramerInitial, detectAos, detectDynamicSsrFalse, detectMountGate,
  detectAriaHidden, detectScrollReveal, detectClassHidden, detectCounter, detectTypewriter, detectPreloader, detectCss,
  detectEffectSetText, detectActiveOnlyPanel,
]

// ---------------------------------------------------------------------------
// Lint one file
// ---------------------------------------------------------------------------

export function lintSource(file, raw) {
  const ext = extname(file).toLowerCase()
  if (/crawler-visible-ignore-file/.test(raw)) return []
  let code
  if (ext === '.css') code = maskCss(raw, false)
  else if (ext === '.scss') code = maskCss(raw, true)
  else if (['.html', '.htm', '.vue', '.svelte', '.astro'].includes(ext)) code = maskJs(maskHtmlComments(raw))
  else code = maskJs(raw)
  const pos = lineIndex(raw)
  const rawLines = raw.split('\n')
  const ignored = new Set()
  rawLines.forEach((l, i) => { if (l.includes('crawler-visible-ignore')) { ignored.add(i + 1); ignored.add(i + 2) } })
  const findings = []
  const seen = new Set()
  const report = (id, idx, anchorIdx = idx, extra) => {
    const rule = RULE[id]
    const { line, col } = pos(idx)
    const anchorLine = pos(anchorIdx).line
    if (ignored.has(line) || ignored.has(anchorLine)) return
    const key = `${id}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({
      file, line, col, anchorLine, severity: extra?.severity || rule.severity, rule: id,
      message: rule.message + (extra?.note ? ` (${extra.note})` : ''), why: rule.why, fix: rule.fix,
      snippet: (rawLines[line - 1] || '').trim().slice(0, 160),
    })
  }
  const decorFile = DECOR_FILE_RE.test(basename(file).replace(/\.[^.]+$/, ''))
  const ctx = { file, ext, raw, code, report, decorFile }
  const detectors = ext === '.css' || ext === '.scss' ? [detectCss] : JS_DETECTORS
  for (const d of detectors) {
    try { d(ctx) } catch (e) { if (process.env.CVT_DEBUG) process.stderr.write(`${d.name} on ${file}: ${e.stack}\n`) /* never take the guard down */ }
  }
  findings.sort((a, b) => a.line - b.line || a.col - b.col)
  return findings
}

function shouldSkipFile(p) {
  const b = basename(p)
  if (!WEB_EXTS.has(extname(p).toLowerCase())) return true
  if (SKIP_FILE_RE.test(b)) return true
  if (p.split(/[\\/]/).some((s) => SKIP_DIRS.has(s) || s === '__tests__')) return true
  return false
}

export function lintFile(p) {
  let st
  try { st = statSync(p) } catch { return [] }
  if (!st.isFile() || st.size > MAX_BYTES) return []
  const raw = readFileSync(p, 'utf8')
  // minified/generated: one giant line
  if (raw.length > 20000 && raw.indexOf('\n') === -1) return []
  return lintSource(p, raw)
}

// Also skipped while walking (not in hook mode): agent worktrees are copies of the project.
const WALK_SKIP_DIRS = new Set([...SKIP_DIRS, '.claude', '.worktrees'])

function walk(p, out, root = true) {
  let st
  try { st = statSync(p) } catch { return }
  if (st.isDirectory()) {
    if (!root && WALK_SKIP_DIRS.has(basename(p))) return
    for (const e of readdirSync(p)) walk(join(p, e), out, false)
  } else if (!WEB_EXTS.has(extname(p).toLowerCase()) || SKIP_FILE_RE.test(basename(p))) {
    /* not a web source file */
  } else out.push(p)
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function rel(p, base = process.cwd()) {
  const r = relative(base, p)
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : p
}

function formatHuman(findings) {
  return findings.map((f) =>
    `${rel(f.file)}:${f.line}:${f.col}  ${f.severity.padEnd(7)}  ${f.rule}  ${f.message}\n` +
    `    ${f.snippet}\n    why: ${f.why}\n    fix: ${f.fix}`).join('\n')
}

function hookText(findings, base, kind) {
  const lines = []
  const shown = findings.slice(0, 8)
  for (const f of shown) {
    lines.push(`${rel(f.file, base)}:${f.line} [${f.rule}] ${f.message}`)
    lines.push(`  why: ${f.why}`)
    lines.push(`  fix: ${f.fix}`)
  }
  if (findings.length > shown.length) lines.push(`(+${findings.length - shown.length} more; run: node ${join(HERE, 'lint.mjs')} ${rel(findings[0].file, base)})`)
  lines.push(`Rules and recipes: ${RULES_DOC} and ${PATTERNS_DOC}. Decorative-only code: add a "crawler-visible-ignore" comment on the line above.`)
  const head = kind === 'error'
    ? `crawler-visible-text: this edit hides words from search engines / AI crawlers / no-JS readers. Fix before moving on:`
    : kind === 'pre-existing'
      ? `crawler-visible-text: this file already had these errors before this edit (not caused by it; shown once per session). Fix them when you are working on this part of the page, or mark decorative code with crawler-visible-ignore:`
      : `crawler-visible-text warnings on the lines this edit wrote (check these; they can hide words from crawlers):`
  return [head, ...lines].join('\n')
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

/** Lines of the file that this Write/Edit/MultiEdit wrote, or null for "all" (a Write). */
function writtenLines(fp, ti) {
  if (typeof ti.content === 'string') return null
  const pieces = [ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : [])].filter((x) => typeof x === 'string')
  if (!pieces.length) return null
  let src
  try { src = readFileSync(fp, 'utf8') } catch { return null }
  const pos = lineIndex(src)
  const lines = new Set()
  for (const w of pieces) {
    if (!w.trim()) continue
    let i = src.indexOf(w)
    let guard = 0
    while (i !== -1 && guard++ < 200) {
      const a = pos(i).line
      const b = pos(i + w.length).line
      for (let l = a; l <= b; l++) lines.add(l)
      i = src.indexOf(w, i + w.length)
    }
  }
  return lines
}

// Pre-existing errors (on lines this edit did not write) are mentioned once
// per session and file, as context, instead of blocking every later edit.
const SEEN_FILE = join(tmpdir(), 'crawler-visible-text-hook-seen.json')
function seenState() {
  try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')) } catch { return {} }
}
function saveSeen(st) {
  const keys = Object.keys(st)
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete st[k]
  try { writeFileSync(SEEN_FILE, JSON.stringify(st)) } catch {}
}

async function hookMode() {
  let payload
  try { payload = JSON.parse(await readStdin()) } catch { process.exit(0) }
  const ti = payload?.tool_input || {}
  let fp = ti.file_path || ti.path
  if (typeof fp !== 'string' || !fp) process.exit(0)
  const base = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  if (!isAbsolute(fp)) fp = resolve(base, fp)
  if (shouldSkipFile(fp)) process.exit(0)
  const findings = lintFile(fp)
  if (!findings.length) process.exit(0)
  const lines = writtenLines(fp, ti)
  const written = [ti.new_string, ti.content, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : [])].filter((x) => typeof x === 'string')
  const touches = (f) => {
    if (lines === null) return true
    if (lines.size) return lines.has(f.line) || lines.has(f.anchorLine)
    // the written text was not found (file changed since): fall back to the snippet
    return written.some((w) => f.snippet && w.includes(f.snippet.slice(0, 60)))
  }
  const newErrors = findings.filter((f) => f.severity === 'error' && touches(f))
  const warnings = findings.filter((f) => f.severity === 'warning' && touches(f))
  const session = typeof payload.session_id === 'string' ? payload.session_id : 'nosession'
  const st = seenState()
  const key = (f) => createHash('sha1').update(`${session}|${fp}|${f.rule}|${f.snippet}`).digest('hex').slice(0, 16)
  const oldErrors = findings.filter((f) => f.severity === 'error' && !touches(f) && !st[key(f)])
  for (const f of oldErrors) st[key(f)] = 1
  if (oldErrors.length) saveSeen(st)
  const oldNote = oldErrors.length
    ? '\n' + hookText(oldErrors, base, 'pre-existing')
    : ''
  if (newErrors.length) {
    process.stderr.write(hookText(newErrors, base, 'error') + (warnings.length ? `\n(also ${warnings.length} warning(s) on lines this edit wrote: run the linter on this file)` : '') + oldNote + '\n')
    process.exit(2)
  }
  if (warnings.length || oldErrors.length) {
    const ctxText = [warnings.length ? hookText(warnings, base, 'warning') : '', oldNote.trim()].filter(Boolean).join('\n')
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctxText },
    }))
  }
  process.exit(0)
}

function cliMode(args) {
  const json = args.includes('--json')
  const targets = args.filter((a) => !a.startsWith('--'))
  if (!targets.length) {
    process.stderr.write(USAGE)
    process.exit(64)
  }
  const files = []
  for (const t of targets) {
    const p = resolve(t)
    try {
      if (statSync(p).isFile()) { if (WEB_EXTS.has(extname(p).toLowerCase())) files.push(p) } else walk(p, files)
    } catch { process.stderr.write(`not found: ${t}\n`) }
  }
  const findings = files.flatMap(lintFile)
  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.length - errors
  if (json) {
    process.stdout.write(JSON.stringify({ files: files.length, errors, warnings, findings }, null, 2) + '\n')
  } else {
    if (findings.length) process.stdout.write(formatHuman(findings) + '\n\n')
    process.stdout.write(`crawler-visible-text: ${files.length} file(s), ${errors} error(s), ${warnings} warning(s)${findings.length ? `  (rules: ${RULES_DOC})` : ''}\n`)
  }
  process.exit(errors ? 1 : 0)
}

const USAGE = `usage:
  node lint.mjs <file-or-dir...> [--json]   lint files; exit 1 on any error, 0 otherwise
  node lint.mjs --hook                      Claude Code PostToolUse hook (payload JSON on stdin):
                                              new errors on lines the edit wrote -> stderr, exit 2
                                              warnings on those lines, and pre-existing errors
                                              (once per session) -> additionalContext, exit 0
  node lint.mjs --rules                     print the rule table
Suppress one line with a crawler-visible-ignore comment on it or the line above;
a whole file with crawler-visible-ignore-file. Rules: ${RULES_DOC}
`
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) process.stdout.write(USAGE)
else if (argv.includes('--hook')) hookMode()
else if (argv.includes('--rules')) {
  for (const r of RULES) process.stdout.write(`${r.id}  [${r.severity}]\n  detects: ${r.detector}\n  message: ${r.message}\n  why: ${r.why}\n  fix: ${r.fix}\n\n`)
} else cliMode(argv)
