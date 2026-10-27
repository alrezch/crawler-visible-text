# Failure patterns

Every pattern below has been seen on real sites. For each: how it looks in code, which reader it hurts and how badly, and how the tools report it. Fixes are in `recipes.md`.

Readers: **G** = Google/Bing renderer (JS on, tall viewport, no scroll). **AI** = AI crawlers (raw HTML, no JS, ignore CSS, drop aria-hidden). **NJ** = no-JS people and tools (raw HTML with CSS).

Tool reports: **lint** = `scripts/lint.mjs` (and the write-time hook); **raw / nojs / googlebot** = the three `scripts/audit.mjs` modes. Exact wording of messages may differ; the category is what matters.

## Contents

1. Inline opacity:0 / visibility:hidden in server HTML
2. framer-motion / motion `initial` with opacity 0
3. AOS (`data-aos`)
4. Utility classes (`opacity-0`, `invisible`) toggled by JS
5. Scroll-triggered reveal + full-viewport-height sections
6. JS that hides visible content at hydration and never reveals it
7. Client-only content
8. Tabs, carousels and accordions that render only the open panel
9. aria-hidden on real content
10. Text only in canvas, WebGL, Lottie, images, video or aria-hidden SVG
11. Typewriter, scramble and counter effects
12. Preloaders and loading screens
13. Content behind scroll, "load more" or consent
14. Page-builder entrance animations

---

## 1. Inline opacity:0 / visibility:hidden in server HTML

**Looks like**
```tsx
<div ref={ref} style={{ opacity: 0, transform: 'translateY(40px)' }}>{children}</div>
// useEffect(() => gsap.to(ref.current, { opacity: 1, y: 0, scrollTrigger: ... }))
```
or `gsap.set(el, { autoAlpha: 0 })` in a server-rendered template, or a CMS rich-text wrapper with `style="visibility:hidden"`.

**Hurts** NJ: blank block, often a blank page (every blog post's H1 and body on shapeshifters.dev). G: hidden unless the reveal fires in the tall render (usually only the first screen does - see pattern 5). AI: unaffected (reads text nodes, ignores CSS).

**Reported** lint: inline style with `opacity: 0` / `visibility: hidden` / `autoAlpha: 0`. raw: risk marker "inline opacity:0" or "visibility:hidden" with a count. nojs and googlebot: READING words hidden, with sample phrases from the block.

## 2. framer-motion / motion `initial` with opacity 0

**Looks like**
```tsx
<motion.h2 initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
<motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
```
framer-motion (and `motion/react`) server-renders the `initial` values as an inline style: the HTML carries `style="opacity:0;transform:translateY(20px)"`. Variants (`initial="hidden"` with `hidden: { opacity: 0 }`) do the same.

**Hurts** NJ: hidden. G: `animate` usually completes after hydration, so mostly fine; `whileInView` fails below the first screen in the tall render with 100vh sections, and anything whose `viewport.amount` never gets met stays hidden. AI: unaffected by opacity.

**Reported** lint: `initial` containing `opacity: 0` (or a variant name whose variant has opacity 0) - error; a warning when the element has `exit` and a `key` or sits inside `AnimatePresence`. raw: marker "framer-motion initial (opacity:0 + transform)" plus "inline opacity:0". nojs: READING hidden. googlebot: READING hidden for `whileInView` blocks that never entered the band.

## 3. AOS (`data-aos`)

**Looks like** `<div data-aos="fade-up">` plus `import 'aos/dist/aos.css'` and `AOS.init()`. AOS's stylesheet sets `[data-aos^=fade]` (and zoom/flip variants) to opacity 0 until the script adds `aos-animate`.

**Hurts** NJ: every `data-aos` block hidden (the stylesheet loads, the script does not). G: AOS computes offsets from scroll position; in the tall render some blocks fire, blocks below 100vh sections often do not. AI: unaffected.

**Reported** lint: the `data-aos` attribute - an error, downgraded to a warning once the project contains the recipe's `html:not(.js-reveal) [data-aos]` override. An `aos.css` import alone is not linted; the audit catches it. raw: marker "data-aos" with count. nojs: READING hidden. googlebot: READING hidden below the first screen.

## 4. Utility classes toggled by JS

**Looks like**
```tsx
<section className={cn('transition-opacity duration-700', visible ? 'opacity-100' : 'opacity-0')}>
```
with `visible` starting `false` on the server; or static `class="reveal opacity-0 invisible"` that JS swaps.

**Hurts** Same as pattern 1: NJ hidden, G hidden unless the trigger fires, AI unaffected.

**Reported** lint (warning): `opacity-0` / `invisible` on an element that holds text, when it is static, behind a visibility-type condition (`visible`, `inView`, `revealed`, `loaded`...), or restored only by a reveal variant (`data-[in]:opacity-100`, `[&.is-visible]:opacity-100`); Vue `v-show` on such a flag; `style={{ opacity: shown ? 1 : 0 }}` and Vue `:style` ternaries. Not linted: the `hidden` class and `display:none` (too common in legitimate UI; the audit catches them). Hover/focus/group/peer/aria/open-state variants are treated as interactive UI and skipped. raw: markers "opacity-0 class" / "invisible class". nojs/googlebot: READING hidden.

## 5. Scroll-triggered reveal + full-viewport-height sections

**Looks like** ScrollTrigger `start: 'top 85%'`, IntersectionObserver with `rootMargin: '0px 0px -15% 0px'`, `whileInView`, or AOS, on content inside sections with `min-h-screen`, `min-h-[100dvh]`, `height: 100vh`.

**Why it fails** Google's renderer grows the viewport to the page height and never scrolls. Every section is at least one viewport tall, so as the viewport grows the sections grow with it: section two always starts at or below the bottom of the viewport, below any trigger line. It never reveals. On shapeshifters.dev this left 54-96% of words hidden per page in Google's snapshot while the page looked perfect in every normal browser.

**Hurts** G: severely - often everything below the hero. NJ/AI: depends on how the hidden state is set (patterns 1-4).

**Reported** lint: scroll-trigger code (ScrollTrigger, `whileInView`, IntersectionObserver reveal, `data-aos`) - it cannot see section heights, so treat any hit as "check the tall render". googlebot: large READING hidden count concentrated below the first section, and a document height near the growth cap (sections kept growing). nojs may pass if the hidden state is gated correctly - that is why both modes must pass.

## 6. JS that hides visible content at hydration and never reveals it

**Looks like** Server HTML fine, then at hydration:
```ts
gsap.fromTo(grid.children, { opacity: 0, y: 30 }, { opacity: 1, y: 0, stagger: 0.1, scrollTrigger: { trigger: grid, start: 'top 85%' } })
```
immediateRender writes opacity 0 at once; the scroll trigger never fires in the tall render. Also `gsap.from(...)` with a scroll trigger, and `gsap.set(els, {opacity: 0})` before registering observers.

**Hurts** G: hidden (the JS made it worse than the HTML). NJ/AI: fine (their copy is the server HTML).

**Reported** lint: `gsap.from`/`fromTo`/`set` with opacity or autoAlpha 0 plus a scroll trigger. nojs: passes. googlebot: READING hidden. A nojs-pass / googlebot-fail split on the same block is the signature of this pattern.

## 7. Client-only content

**Looks like**
```tsx
const Services = dynamic(() => import('./Services'), { ssr: false })
if (!mounted) return null
const [text, setText] = useState(''); useEffect(() => setText(copy), [])
useEffect(() => { fetch('/api/faq').then(r => r.json()).then(setFaqs) }, [])
```
Also SPA shells (`<div id="root"></div>`), Vue/Svelte components mounted only on the client, Astro islands with `client:only`.

**Hurts** AI: the text does not exist for them. NJ: absent. G: usually renders it, but late fetches may be cut off and it costs render budget.

**Reported** lint (warnings): next/dynamic `ssr: false`, a mounted-flag `return null` / `{mounted && ...}`, and text put into state in `useEffect` (a literal sentence, or a fetched title/text/body). Not linted: Astro `client:only` and client-side data fetching in general - the audit finds those. raw: low word count; the googlebot line lists "visible words not in the served HTML" with the texts. nojs: the words are simply absent (not counted as hidden).

## 8. Tabs, carousels and accordions that render only the open panel

**Looks like**
```tsx
{tabs.map(t => t.id === active && <Panel key={t.id} {...t} />)}
<Slide>{slides[index]}</Slide>
{open && <div className="answer">{faq.answer}</div>}
```

**Hurts** Everyone: the closed panels' text is not in the HTML at all. Google gives full weight to text in closed tabs/accordions under mobile-first indexing - but only if it is in the DOM.

**Reported** lint (warning): inside `.map()`, an element with text rendered only when it is the active/current/selected item (`active === i ? <X/> : null`, `active === i && <X/>`). Other shapes (a separate `{tab === "a" && <PanelA/>}` per panel, a carousel library that virtualises slides) are audit only: the googlebot line lists them as words not in the served HTML only if they render later, so check the raw HTML for each panel's text. When all panels render with proper hiding, the audit reports their words as DISCLOSURE, which is correct.

## 9. aria-hidden on real content

**Looks like**
```tsx
<div role="tabpanel" aria-hidden={!isActive}>...</div>
<h1 aria-label="Build faster"><span aria-hidden="true">B</span><span aria-hidden="true">u</span>...</h1>
```
The second is what split-text effects produce, including GSAP SplitText's default `aria: "auto"` mode in 3.13+.

**Hurts** AI: Readability-style extractors drop aria-hidden subtrees and ignore aria-label, so the words vanish. Screen readers also skip it. G: sees the text.

**Reported** lint (warning): `aria-hidden` with a dynamic value on an element with text, static `aria-hidden` on a tab panel, and split-text letters under aria-hidden with the sentence only in `aria-label`. audit: hidden text under aria-hidden counts as ARIA-HIDDEN READING (it takes precedence over DISCLOSURE, and each word is counted once); on-screen text under aria-hidden (split-text headings) is shown as "(+N on screen)" and named in the warning. Use `inert` for closed panels instead.

## 10. Text only in canvas, WebGL, Lottie, images, video or aria-hidden SVG

**Looks like** hero headline drawn in a Three.js scene, a Lottie with the tagline baked in, an `<img>` of text, `<svg aria-hidden="true"><text>Our services</text></svg>`, a video with burned-in captions and no transcript.

**Hurts** Everyone: no text node exists (or it is aria-hidden). Alt text helps a little for images only.

**Not linted** - audit and eye only. audit: text inside an SVG or aria-hidden illustration is DECORATIVE; text drawn in canvas, WebGL, Lottie, images or video is not text at all, so nothing is counted. Check by eye that each such visual has a real HTML heading or paragraph carrying the same words.

## 11. Typewriter, scramble and counter effects

**Looks like**
```tsx
const [shown, setShown] = useState('')           // typewriter starts empty
<span>{scrambled}</span>                          // "x#9!q" until it resolves
const [n, setN] = useState(0); <span>{n}+</span>  // counter renders 0
```

**Hurts** AI and NJ: they read an empty string, garbage, or "0+ clients". G: usually sees the end state if the effect is time-based; scroll-triggered counters stay at 0.

**Reported** lint (warnings): `useState(0)` rendered as text and driven toward a final value by a timer, rAF or in-view hook (an unbounded tick like `c => c + 1` is a live counter and is skipped); `useMotionValue(0)` shown rounded; `<CountUp>`; state initialised to `''` and grown with slice/charAt in a timer; typewriter libraries. raw: marker "empty heading" when a heading ships empty. googlebot: the real phrase or number is listed under "visible words not in the served HTML".

## 12. Preloaders and loading screens

**Looks like** a full-screen overlay `<div class="preloader">` removed on `load`, `body { opacity: 0 }` or `html.loading main { visibility: hidden }` until a script runs, a React state `loading` that renders a spinner instead of the page.

**Hurts** NJ: the overlay never leaves - a blank or logo-only page. G: fine if it clears, but an overlay present at snapshot time covers everything and slows rendering. AI: fine if content is in the HTML behind it; nothing if the page renders only after `loading` is false.

**Reported** lint: a CSS rule hiding `body`, `main`, `section`, `article` or `#content`/`#app`/`#root` under a loader/loading/preload/splash class (error, `css-ungated-hide` with a "preloader" note), and a loading state initialised to `true` in a fixed full-screen loader component (warning). raw: "loader/preloader element" marker next to "inline visibility:hidden". nojs: nearly everything hidden (or covered). googlebot: depends on timing.

## 13. Content behind scroll, "load more" or consent

**Looks like** infinite scroll loading posts on scroll, a "Load more" button that fetches with no paginated URL, content rendered only after the cookie banner is accepted, "Read more" that fetches the rest of the article.

**Hurts** Everyone: crawlers do not scroll, click or accept. Only the first batch exists.

**Not linted** - audit only. audit: the words are missing from the render (compare raw with what a scrolled browser shows). Provide real `<a href="?page=2">` pagination and render content regardless of consent (consent should gate tracking, not text).

## 14. Page-builder entrance animations

**Looks like** Webflow elements with `data-w-id` and inline `style="opacity:0"` (an interaction's initial state), Framer sites with appear/scroll effects that server-render opacity 0, WordPress Elementor `elementor-invisible` (visibility hidden) on widgets with entrance animations, Divi `et_animated`, WPBakery `wpb_animate_when_almost_visible`, theme preloaders, AOS or WOW.js plugins (`wow` class, `visibility: hidden` inline).

**Hurts** Same as patterns 1-5: NJ hidden, G hidden below the first screen, AI unaffected by CSS but affected by anything client-only.

**Reported** raw: inline opacity/visibility markers and the builder classes; nojs/googlebot: READING hidden. Class names change between builder versions, so confirm in the served HTML rather than trusting this list.
