# Fix recipes

Minimal, working fixes, stack by stack. Each keeps the animation a visitor sees and makes the words readable to crawlers and no-JS readers. Read section 0 first; the others build on it.

## Contents

0. The gate, in one paragraph (all stacks)
1. Next.js App Router + GSAP / ScrollTrigger (the full gate)
2. framer-motion / motion
3. AOS
4. Plain IntersectionObserver + CSS (static HTML, Astro, Vue/Nuxt, Svelte/SvelteKit, anything)
5. Tabs, accordions, FAQs, carousels
6. Counters, typewriters, scramble and split text
7. Client-only content
8. Webflow, Framer, WordPress (code that is not ours)
9. Verifying any fix

---

## 0. The gate, in one paragraph

The server sends content **visible**. A tiny synchronous script in `<head>` adds `js-reveal` to `<html>` before first paint. CSS hides `[data-reveal]:not([data-revealed])` only under `html.js-reveal`, only when motion is allowed. At hydration the animation code writes its own start state inline (before paint) and stamps `data-revealed`, which lifts the CSS rule with no visible change. A window 3,000px or taller (Google's non-scrolling renderer; no real screen is that tall) gets the end state. A failsafe in the head script removes `js-reveal` if the app's scripts fail, or if hydration never signals `data-fx-ready`. Detection is always by geometry and events, never by user agent.

The head script (plain JS, framework-agnostic). Set `ASSET` to the path your bundles load from: `/_next/` (Next.js), `/_nuxt/` (Nuxt), `/_astro/` (Astro), `/assets/` (Vite), `/_app/` (SvelteKit), `/wp-content/` (WordPress).

```js
(function (w, d) {
  var ASSET = '/_next/'
  var h = d.documentElement, c = 'js-reveal', t
  h.classList.add(c)
  function ok() { return h.hasAttribute('data-fx-ready') }
  function off() { h.classList.remove(c); w.removeEventListener('error', err, true); clearTimeout(t) }
  function err(e) {
    if (ok()) return
    var s = e && e.target
    var u = (s && s.tagName === 'SCRIPT' && s.src) || (e && e.filename) || ''
    if (u.indexOf(ASSET) > -1) off()           // a site script failed to load or threw
  }
  w.addEventListener('error', err, true)       // capture: catches <script> load errors too
  w.addEventListener('load', function () { t = setTimeout(function () { if (!ok()) off() }, 5000) })
  setTimeout(function () { if (!ok()) off() }, 12000)
})(window, document)
```

Minified, for inlining:

```js
(function(w,d){var A='/_next/',h=d.documentElement,c='js-reveal',t;h.classList.add(c);function ok(){return h.hasAttribute('data-fx-ready')}function off(){h.classList.remove(c);w.removeEventListener('error',err,true);clearTimeout(t)}function err(e){if(ok())return;var s=e&&e.target,u=(s&&s.tagName==='SCRIPT'&&s.src)||(e&&e.filename)||'';if(u.indexOf(A)>-1)off()}w.addEventListener('error',err,true);w.addEventListener('load',function(){t=setTimeout(function(){if(!ok())off()},5000)});setTimeout(function(){if(!ok())off()},12000)})(window,document)
```

It must be a plain inline `<script>` in `<head>` (not `defer`, not `async`, not Next's `<Script>`), so it runs before `<body>` is parsed. If the site has a Content-Security-Policy, add the script's hash or a nonce.

---

## 1. Next.js App Router + GSAP / ScrollTrigger

Generalised from shapeshifters.dev v0.47.0, where it took hidden words to 0 on every page with no visible change.

### 1a. `lib/reveal.ts`

```ts
export const REVEAL_TWEEN_TAG = 'reveal'        // carried in each reveal tween's `data`
export const FX_READY_ATTR = 'data-fx-ready'
export const REVEALED_ATTR = 'data-revealed'
export const TALL_VIEWPORT_MIN_HEIGHT = 3000     // no real window is this tall

export function isNonScrollingTallViewport(): boolean {
  return typeof window !== 'undefined' && window.innerHeight >= TALL_VIEWPORT_MIN_HEIGHT
}

// useReducedMotion-style hooks still return the server snapshot (false) at hydration.
export function prefersReducedMotionNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Hydration arrived after the failsafe lifted the gate and this block is already on
// screen: the visitor is reading it, so do not hide it to fade it back in.
export function shownByFailsafe(el: Element): boolean {
  return !document.documentElement.classList.contains('js-reveal') &&
    el.getBoundingClientRect().top < window.innerHeight
}

export const REVEAL_GATE_SCRIPT = `/* the minified head script from section 0, ASSET='/_next/' */`
```

### 1b. `app/layout.tsx`

```tsx
import { REVEAL_GATE_SCRIPT } from '@/lib/reveal'
import { FxReady } from '@/components/FxReady'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The head script changes <html>'s class before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: REVEAL_GATE_SCRIPT }} />
      </head>
      <body>
        <FxReady>{children}</FxReady>
      </body>
    </html>
  )
}
```

### 1c. `globals.css`

Outside every `@layer` and without `!important`, so GSAP's inline styles always win.

```css
@media (prefers-reduced-motion: no-preference) {
  html.js-reveal [data-reveal]:not([data-revealed]) { opacity: 0; }
}
/* Stagger grids animate their children; drop the media query if yours animates under reduced motion too. */
@media (prefers-reduced-motion: no-preference) {
  html.js-reveal [data-reveal-stagger]:not([data-revealed]) > * { opacity: 0; }
}
```

### 1d. The reveal component

```tsx
'use client'
import { useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { REVEAL_TWEEN_TAG, REVEALED_ATTR, isNonScrollingTallViewport,
  prefersReducedMotionNow, shownByFailsafe } from '@/lib/reveal'

gsap.registerPlugin(ScrollTrigger)

export function Reveal({ children, y = 40, delay = 0, duration = 0.7, start = 'top 85%',
  priority = false, className }: {
  children: React.ReactNode; y?: number; delay?: number; duration?: number
  start?: string; priority?: boolean; className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  // useGSAP runs in a layout effect: everything below happens before the browser paints.
  useGSAP(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotionNow()) { el.setAttribute(REVEALED_ATTR, ''); return }

    // Above the fold: slide only, never opacity - keeps the LCP element painted.
    if (priority) { gsap.from(el, { y, duration, delay }); return }

    if (isNonScrollingTallViewport() || shownByFailsafe(el)) {
      el.setAttribute(REVEALED_ATTR, '')      // end state; no real window takes this branch
      return
    }

    // fromTo's immediateRender writes opacity 0 inline now; only then lift the CSS gate.
    gsap.fromTo(el, { opacity: 0, y }, {
      opacity: 1, y: 0, duration, delay, ease: 'power2.out',
      data: REVEAL_TWEEN_TAG,
      scrollTrigger: { trigger: el, start, toggleActions: 'play none none none' },
    })
    el.setAttribute(REVEALED_ATTR, '')
  }, { scope: ref, dependencies: [priority] })

  // Served visible. `data-reveal` lets the CSS gate hide it only when JS is confirmed.
  return <div ref={ref} className={className} data-reveal={priority ? undefined : ''}>{children}</div>
}
```

A stagger grid is the same shape: render `<div data-reveal-stagger>`, in `useGSAP` return early with `data-revealed` for tall/failsafe, otherwise `gsap.fromTo(container.children, { opacity: 0, y: 30 }, { ..., stagger: 0.12, data: REVEAL_TWEEN_TAG, scrollTrigger: { trigger: container, start: 'top 85%' } })` and then stamp `data-revealed` on the container.

### 1e. `FxReady` - failsafe stand-down and tall-viewport catch-up

```tsx
'use client'
import { useEffect } from 'react'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { FX_READY_ATTR, REVEAL_TWEEN_TAG, isNonScrollingTallViewport } from '@/lib/reveal'

export function FxReady({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // A parent's effect runs after all its children's layout effects: every reveal is set up.
    document.documentElement.setAttribute(FX_READY_ATTR, '')

    // Google grows its window to the page height after load. Sections sized 100vh grow
    // with it, so nothing below the first ever crosses its trigger. For that window only,
    // jump each reveal tween to its end. Real windows never pass the check.
    const catchUp = () => {
      if (!isNonScrollingTallViewport()) return
      ScrollTrigger.getAll().forEach((st) => {
        const tw = st.animation
        if (tw && tw.data === REVEAL_TWEEN_TAG) tw.progress(1)
      })
    }
    window.addEventListener('resize', catchUp)
    ScrollTrigger.addEventListener('refresh', catchUp)
    catchUp()
    return () => {
      window.removeEventListener('resize', catchUp)
      ScrollTrigger.removeEventListener('refresh', catchUp)
    }
  }, [])
  return <>{children}</>
}
```

Put `FxReady` high enough that it wraps every reveal (the root layout body, or the site route group's layout).

**Verify:** audit shows 0 READING hidden in nojs and googlebot; in a normal browser, the first frame and every reveal look as before; with reduced motion on, nothing animates and nothing is hidden; block `/_next/static/chunks/*.js` in DevTools and the page is readable at once.

---

## 2. framer-motion / motion

The problem is `initial={{ opacity: 0 }}` (or a variant with opacity 0): it is server-rendered as an inline style.

**On-load entrance (`animate`)** - two options that keep the motion:

```tsx
// 1. Slide only: the text is painted from frame one, only its position animates.
<motion.h1 initial={{ y: 24 }} animate={{ y: 0 }}>...</motion.h1>

// 2. Keep the fade: the gated component below with trigger="load" (same gate,
//    fades in at hydration instead of when scrolled into view).
<InViewReveal trigger="load" delay={0.2}><h1>...</h1></InViewReveal>
```

Do **not** "fix" it with `initial={false} animate={{ opacity: 1 }}`: that renders visible on the server but then starts at 1 and ends at 1, which silently deletes the approved fade.

**Scroll reveal (`whileInView`)** - use the gate from section 0 (head script, CSS, `data-fx-ready`) and a small component that writes the start state after hydration:

```tsx
'use client'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAnimate, useInView } from 'motion/react'   // or 'framer-motion'
import { REVEALED_ATTR, isNonScrollingTallViewport, prefersReducedMotionNow,
  shownByFailsafe } from '@/lib/reveal'

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function InViewReveal({ children, y = 24, delay = 0, trigger = 'inView' }: {
  children: React.ReactNode; y?: number; delay?: number; trigger?: 'inView' | 'load'
}) {
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const inView = useInView(scope, { once: true, margin: '0px 0px -15% 0px' })
  const armed = useRef(false)

  useIsoLayoutEffect(() => {
    const el = scope.current
    if (!el) return
    if (!(prefersReducedMotionNow() || isNonScrollingTallViewport() || shownByFailsafe(el))) {
      el.style.opacity = '0'                       // before paint, then lift the CSS gate
      el.style.transform = `translateY(${y}px)`
      armed.current = true
    }
    el.setAttribute(REVEALED_ATTR, '')
    const onResize = () => {                       // Google's window grows after load
      if (armed.current && isNonScrollingTallViewport()) {
        armed.current = false
        el.style.opacity = ''; el.style.transform = ''
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, at hydration
  }, [])

  const go = trigger === 'load' || inView
  useEffect(() => {
    if (!go || !armed.current || !scope.current) return
    armed.current = false
    animate(scope.current,
      { opacity: [0, 1], transform: [`translateY(${y}px)`, 'translateY(0px)'] },
      { duration: 0.6, delay, ease: 'easeOut' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once when it becomes due
  }, [go])

  return <div ref={scope} data-reveal="">{children}</div>
}
```

Replace `<motion.div initial={{opacity:0,y:24}} whileInView={{opacity:1,y:0}}>` with `<InViewReveal>`. Keep the same duration, delay and easing so the motion is unchanged.

A framer-only project (no GSAP) still needs something to set `data-fx-ready` so the head script's failsafe stands down. `FxReady` in 1e imports ScrollTrigger; use this instead, rendered once in the root layout:

```tsx
'use client'
import { useEffect } from 'react'

export function FxReady() {
  useEffect(() => { document.documentElement.setAttribute('data-fx-ready', '') }, [])
  return null
}
```

**Verify:** `curl -s <url> | grep -c 'opacity:0'` drops to only decorative elements; audit passes; visual check.

---

## 3. AOS

AOS's stylesheet hides every `[data-aos]` until its script adds `aos-animate`.

**Preferred:** replace AOS with section 4 (about 15 lines) and map `data-aos="fade-up"` to `data-reveal`.

**If AOS must stay** - keep its CSS for JS visitors, lift it for everyone else, and handle the tall window:

```css
/* After aos.css. Applies only when the head script did not run, or its failsafe fired. */
html:not(.js-reveal) [data-aos] { opacity: 1 !important; transform: none !important; }
```

```js
AOS.init({ once: true })
const tall = () => window.innerHeight >= 3000
const showAll = () => document.querySelectorAll('[data-aos]').forEach((el) => el.classList.add('aos-animate'))
if (tall()) showAll()
window.addEventListener('resize', () => { if (tall()) showAll() })
document.documentElement.setAttribute('data-fx-ready', '')
```

Plus the section 0 head script.

**Verify:** nojs audit 0 READING hidden; googlebot audit 0; scroll the page normally - fades unchanged.

---

## 4. Plain IntersectionObserver + CSS (any stack)

Head script from section 0, then:

```css
@media (prefers-reduced-motion: no-preference) {
  [data-reveal] { transition: opacity .6s ease, transform .6s ease; }
  html.js-reveal [data-reveal]:not(.is-revealed) { opacity: 0; transform: translateY(24px); }
}
```

```js
// Load as a module or with defer.
const els = document.querySelectorAll('[data-reveal]')
const show = (el) => el.classList.add('is-revealed')
const tall = () => window.innerHeight >= 3000
if (tall() || !('IntersectionObserver' in window)) {
  els.forEach(show)
} else {
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { show(e.target); io.unobserve(e.target) }
  }), { rootMargin: '0px 0px -10% 0px' })
  els.forEach((el) => io.observe(el))
}
window.addEventListener('resize', () => { if (tall()) els.forEach(show) })
document.documentElement.setAttribute('data-fx-ready', '')
```

No late-hydration flash is possible here: if the failsafe already removed `js-reveal`, the CSS rule never re-applies.

Where the pieces go:
- **Static HTML:** head script inline in `<head>`; the JS in a `<script type="module">`.
- **Astro:** `<script is:inline set:html={GATE}></script>` in the layout `<head>`; the JS in a normal `<script>` in the layout (Astro bundles it). Prefer `client:load`/`client:visible` islands over `client:only`.
- **Nuxt:** `nuxt.config` → `app: { head: { script: [{ innerHTML: GATE }] } }`; the observer as a `v-reveal` directive or in a plugin's `app:mounted` hook, setting `data-fx-ready` there.
- **SvelteKit:** head script in `src/app.html`; a `use:reveal` action that observes the node; set `data-fx-ready` in the root `+layout.svelte` `onMount`.
- **Vue SPA / plain React SPA:** the content is not in the HTML at all - fix section 7 first (prerender or SSR), then apply this.

**Verify:** audit both modes; DevTools → disable JavaScript → page fully readable; normal scroll unchanged.

---

## 5. Tabs, accordions, FAQs, carousels

Render every panel on the server. Hide closed ones in a way crawlers treat as disclosure, never with `aria-hidden` and never by not rendering them.

**Accordion / FAQ - best is native:**
```html
<details><summary>How long does a website take?</summary><p>Usually four to eight weeks...</p></details>
```
Chrome's find-in-page opens closed `<details>`, and the text is in the HTML for every reader.

**Accordion with custom animation (plain HTML):**
```html
<button aria-expanded="false" aria-controls="a1">Question</button>
<div id="a1" hidden="until-found">Answer text</div>
<script>
  a1.addEventListener('beforematch', () => { a1.hidden = false; btn.setAttribute('aria-expanded', 'true') })
</script>
```
In React, check that the rendered HTML really contains `hidden="until-found"` (React 19 supports it; older React turns `hidden` into a boolean) - if not, use `<details>` or the tabs pattern below.

**Tabs:**
```tsx
{tabs.map((t) => (
  <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`}
       hidden={t.id !== active}>
    {t.body}
  </div>
))}
```
If panels cross-fade (stacked, opacity-animated) instead of `hidden`, mark the closed ones `inert` (React 19: `inert={t.id !== active}`; React 18: `{...(closed ? { inert: '' } : {})}`) - not `aria-hidden`. `inert` removes them from focus and the accessibility tree for users while leaving the text for extractors.

**Carousels:** render all slides in the HTML; hide off-screen ones with transform/overflow and `inert`, never by rendering only `slides[index]`.

**Verify:** `curl -s <url> | grep -c '<text from a closed panel>'` is 1+; audit reports those words as DISCLOSURE, not READING.

---

## 6. Counters, typewriters, scramble and split text

**Counter** - final value in the HTML, count up only for counters not yet seen:

```tsx
'use client'
import { useEffect, useRef } from 'react'
import { isNonScrollingTallViewport, prefersReducedMotionNow } from '@/lib/reveal'

export function Counter({ value, suffix = '' }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const label = `${value.toLocaleString('en-US')}${suffix}`
  useEffect(() => {
    const el = ref.current
    const node = el?.firstChild                       // the text node React owns; update it in place
    if (!el || !node || prefersReducedMotionNow() || isNonScrollingTallViewport()) return
    if (el.getBoundingClientRect().top < window.innerHeight) return   // already on screen: leave it
    node.nodeValue = `0${suffix}`
    let raf = 0
    const finish = () => { cancelAnimationFrame(raf); node.nodeValue = label }
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      const t0 = performance.now()
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / 1200)
        node.nodeValue = `${Math.round(value * (1 - (1 - p) ** 3)).toLocaleString('en-US')}${suffix}`
        if (p < 1) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    })
    io.observe(el)
    const onResize = () => { if (isNonScrollingTallViewport()) { io.disconnect(); finish() } }
    window.addEventListener('resize', onResize)
    return () => { io.disconnect(); window.removeEventListener('resize', onResize); finish() }
  }, [value, suffix, label])
  return <span ref={ref} className="tabular-nums">{label}</span>
}
```

**Typewriter** - full text in the HTML; reveal it with a clip that starts only after hydration (single line):

```css
.tw-run { display: inline-block; white-space: nowrap; clip-path: inset(0 100% 0 0);
          animation: tw var(--tw-dur, 2s) steps(var(--tw-n, 20)) forwards; }
@keyframes tw { to { clip-path: inset(0 0 0 0); } }
```
In an effect: if not reduced motion and not a tall viewport, set `--tw-n` to the character count and add `tw-run`. The text node never changes, so every reader gets it. For multi-line or cycling phrases, render all phrases in the HTML (the non-active ones visually hidden with `inert`) and cycle visibility.

**Scramble** - render the real text; start scrambling only after hydration, and always end on the real string. Never initialise state to random characters.

**Split text** - the words must stay readable text. Split into word or character spans that are not aria-hidden, or, if the letters must be aria-hidden, place a real-text copy beside them (a visually-hidden span), since extractors drop aria-hidden and ignore `aria-label`. GSAP SplitText 3.13+ defaults to `aria: "auto"` (aria-label on the parent, aria-hidden children): check its output and adjust as above. Start the split after hydration; the server HTML should hold the unsplit sentence.

**Verify:** `curl -s <url>` shows the final numbers and full sentences; audit samples contain no "0+" or empty headings.

---

## 7. Client-only content

Server-render real content; keep client-only code for genuinely browser-only widgets and give those a text fallback.

- **`next/dynamic` with `ssr: false`:** remove `ssr: false` for anything with words. If the component touches `window` at import or render, move those calls into `useEffect`; keep `ssr: false` only for maps, 3D, charts - and render their heading and summary outside them.
- **Mounted flag (`if (!mounted) return null`):** render the content always; gate only the one theme- or browser-dependent detail (an icon, a date) and use `suppressHydrationWarning` on that element if the text differs.
- **Text set in `useEffect` / fetched on the client:** fetch in a Server Component (or `getStaticProps`/loader) and pass it as props. Client fetching is fine for personalisation, not for body copy.
- **Vue/Nuxt `<ClientOnly>`, Astro `client:only`:** wrap only the widget; use `#fallback` / a sibling with the real text. Prefer Astro `client:visible`, which server-renders first.
- **SPA with an empty root:** prerender (Vite SSG, Astro, Next static export) or SSR. There is no CSS trick for this one.
- **Infinite scroll / "load more":** first page in HTML, and real `<a href="?page=2">` links the button enhances.
- **Consent-gated content:** gate tracking scripts on consent, never text.

**Verify:** raw word count within about 10% of the googlebot count on each page; key phrases present in `curl` output.

---

## 8. Webflow, Framer, WordPress (code that is not ours)

Diagnose from the published HTML first: `curl -sA 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' <url> | grep -o 'style="[^"]*opacity:0[^"]*"' | wc -l`, plus the audit. Class and attribute names below change between versions - confirm them in the HTML before writing overrides.

**Webflow**
- In Interactions, for headings and text, avoid page-load / scroll-into-view animations whose *initial state* is opacity 0 (Webflow writes that into the HTML as `style="opacity:0"` on elements with `data-w-id`). Use move/scale for text, keep fades for images and decoration.
- If the client wants the fades kept exactly: add the head script (section 0, `ASSET` = `webflow`) in Site settings → Custom code → Head, plus
  ```html
  <style>html:not(.js-reveal) [data-w-id][style*="opacity:0"]{opacity:1!important;transform:none!important}</style>
  <script>window.Webflow=window.Webflow||[];Webflow.push(function(){document.documentElement.setAttribute('data-fx-ready','');addEventListener('resize',function(){if(innerHeight>=3000)document.querySelectorAll('[data-w-id][style*="opacity"]').forEach(function(e){e.style.opacity='1';e.style.transform='none'})})})</script>
  ```
- Tabs render all panes (hidden) - fine.

**Framer (site builder)**
- Appear and scroll effects on text layers server-render their start opacity. For text, animate position/scale/blur only, or start opacity at 1. Keep opacity fades for images.
- If effects must stay: Site settings → Custom code → start of `<head>`: the section 0 script (`ASSET` = `framer`), plus a `<style>` override for `html:not(.js-reveal)` targeting the appear attribute you see in the HTML (e.g. `[data-framer-appear-id]`), and set `data-fx-ready` from an end-of-body script.

**WordPress**
- **Elementor:** on text widgets, Advanced → Motion Effects → Entrance Animation → None. Otherwise the widget ships with `elementor-invisible` (visibility hidden) until its script runs. To keep them: head gate + `html:not(.js-reveal) .elementor-invisible{visibility:visible!important}`.
- **Divi:** module Animation → None on text (`et_animated` elements start at opacity 0). **WPBakery:** CSS Animation → None (`wpb_animate_when_almost_visible`). **WOW.js / AOS plugins:** section 3 override.
- Turn off theme preloaders, or make them `js-reveal`-gated.
- Add the head gate with a small plugin or `functions.php` (`ASSET` = `/wp-content/`):
  ```php
  add_action('wp_head', function () { echo '<script>/* minified head script */</script>'; }, 0);
  add_action('wp_footer', function () { echo '<script>addEventListener("load",function(){document.documentElement.setAttribute("data-fx-ready","")})</script>'; }, 100);
  ```

When the builder is not ours and we cannot change it, write the proposal instead: which elements, which setting, and the before/after the audit predicts.

---

## 9. Verifying any fix

1. `node ~/.claude/skills/crawler-visible-text/scripts/audit.mjs <each page>` → 0 READING hidden in nojs and googlebot. ARIA-HIDDEN READING should also be 0.
2. `node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs <project-dir>` → no unexplained findings.
3. Normal browser, scroll the whole page: every animation looks and times exactly as before.
4. Reduced motion on (OS setting or DevTools rendering panel): nothing animates, nothing stays hidden.
5. DevTools → block the main bundle, reload: readable at once or within the failsafe time, never blank.
