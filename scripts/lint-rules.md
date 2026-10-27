# crawler-visible-text lint rules

`lint.mjs` reads source code and flags patterns that hide a page's words from one of three readers:

| Reader | What it does | What hides words from it |
|---|---|---|
| **Google / Bing** | Runs JavaScript, mobile first (~412px wide), in a viewport grown to the page's full height. Never scrolls, never clicks. | Reveals that wait for scroll or an in-view event, especially below `min-h-screen` / `100vh` sections, which grow as tall as that viewport. |
| **AI crawlers** (GPTBot, ClaudeBot, PerplexityBot, CCBot) | Fetch raw HTML and do not run JavaScript. They mostly ignore CSS. Readability-style extractors drop `aria-hidden` subtrees. | Text missing from the server HTML: client-only rendering, text added after load, counters that start at 0, typewriters that start empty, and real content under `aria-hidden`. |
| **People and tools without working JS** (failed bundle, slow phone before hydration, reader mode, link previews) | Apply CSS but no JavaScript. | Inline `opacity:0` / `visibility:hidden`, `opacity-0` classes, and CSS that hides elements without first checking that JS is running. |

The linter is a fast first check. It does not prove a page is clean. Run the rendered audit before calling a site finished.

## Usage

```bash
node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs src            # human output; exit 1 if any error
node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs src app --json # machine output
node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs --rules        # print the rule table
node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs --help         # usage
```

It checks `.tsx .jsx .ts .js .mjs .vue .svelte .astro .html .htm .css .scss` files. It skips `node_modules`, `.next`, `dist`, `build`, `out`, `.git`, `coverage`, `vendor` and other build-output folders, plus minified files, `.d.ts` files, test files and Storybook stories (`*.stories.*`, `.storybook/`, `stories/`). It also skips e-mail template folders (`emails/`, `email-templates/`, `mail-templates/`): a hidden e-mail preheader is a standard e-mail pattern, not a web page. When it walks a directory it also skips `.claude` and `.worktrees` (agent worktrees are copies of the project). You can still pass one of those folders directly.

### Hook mode (the write-time guard)

`node lint.mjs --hook` runs as a Claude Code **PostToolUse** command hook on `Write|Edit|MultiEdit`. It reads the hook payload JSON from stdin, takes `tool_input.file_path` (a relative path is resolved against the payload's `cwd`), and lints only that file.

- If the file is not a web file, or the payload is not JSON, it exits 0 with no output. This takes about 70ms, which is mostly Node startup.
- Only findings on **lines this edit wrote** count as the edit's own: every line for a `Write`, the lines where `new_string` (or each MultiEdit `new_string`) now sits for an `Edit`.
- **Errors on those lines** exit with code 2. The message goes to stderr, and Claude Code shows it to Claude. PostToolUse cannot undo the edit; the message tells Claude to fix it before moving on. Each finding lists `file:line [rule] what`, then one `why:` line and one `fix:` line, plus pointers to this file and `references/patterns.md`.
- **Warnings on those lines** exit with code 0. stdout carries `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`, which Claude sees as extra context and which does not block anything.
- **Pre-existing errors** (on lines this edit did not write, e.g. a client's legacy file) do not block. They are listed once per session and file as additionalContext, labelled as already in the file before this edit, and then stay quiet. The "seen" list is kept in `$TMPDIR/crawler-visible-text-hook-seen.json`.

Suggested registration (added separately, in `~/.claude/settings.json`):

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit",
  "hooks": [ { "type": "command", "command": "node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs --hook", "timeout": 15 } ] } ] } }
```

### Silencing

- A comment containing `crawler-visible-ignore` silences findings on the same line and on the next line. Add a reason: `{/* crawler-visible-ignore: decorative glow, no text */}`. A finding is also silenced when the comment sits just above the element's opening tag.
- `crawler-visible-ignore-file` anywhere in a file silences the whole file.
- These are meant only for decorative code. If the element holds words a reader should get, fix the code instead.

### What the linter already treats as safe (so it stays quiet)

- Elements marked `aria-hidden="true"` or `role="presentation"`, and everything inside them. The same goes for everything inside `<svg>`, `<…Illustration>`, `<…Icon>` and similar decorative components in the same file.
- Files whose name marks them as decorative (`*Illustration*`, `*Background*`, `*Decor*`, `*Graphic*`, `*Icon*`...), for the element-level rules.
- `img`, `video`, `canvas`, `input` and SVG shape elements. Self-closing HTML elements (`<div style={{opacity:0}} />`) hold no text.
- Elements with no text inside: no text, no `{expression}`, no child component.
- Elements whose only child is a decorative component or an image.
- Fixed-position chrome (`className` contains `fixed`), such as floating buttons, sticky CTAs and cookie bars.
- Inline styles that also set `display: none` (an intentionally absent element, e.g. an e-mail preheader).

---

## The safe pattern (what every fix points to)

1. **The server sends content visible.** Never ship `opacity:0` in HTML.
2. **A tiny synchronous script in `<head>`** adds `js-reveal` to `<html>` before first paint. CSS hides reveal blocks only under that class, and only inside `@media (prefers-reduced-motion: no-preference)`:
   `html.js-reveal [data-reveal]:not([data-revealed]) { opacity: 0 }`
3. **At hydration** the animation library writes its own inline start state (for example GSAP `fromTo` with `immediateRender` in a layout effect). The component then sets `data-revealed`, which takes the CSS rule off. A visitor with JS sees the same frames as before.
4. **Failsafe.** The head script removes the class if a site script fails, 5s after `load` if hydration never happens, and after 12s in any case. The app sets `data-fx-ready` on `<html>` at hydration to cancel the failsafe.
5. **Tall renderer.** If `window.innerHeight >= 3000`, skip the tweens and show the end state. On ScrollTrigger refresh or resize, jump reveal tweens to `progress(1)`. **Detect by geometry, never by user agent.** Serving crawlers different content based on user agent is cloaking.
6. **Reduced motion.** Read `matchMedia` directly at hydration. Hooks still return their server snapshot at that moment.
7. **Disclosure** (tabs, accordions, FAQ): keep every panel in the HTML. Use `inert` or `hidden="until-found"` on closed panels, not `aria-hidden`.
8. **Counters** render the final value. **Typewriters** render the full text and animate with a clip or overlay.

Reference implementation: shapeshifters.dev v0.47.0, in `src/lib/reveal.ts`, `ScrollReveal.tsx`, `StaggerChildren.tsx`, `AnimationProvider.tsx` and `globals.css`. Recipes are in `../references/patterns.md`.

---

## Rules

### `inline-hidden-style` (error)

**Catches:** `style={{ opacity: 0 }}`, `style={cond ? undefined : { opacity: 0 }}`, `style={{ visibility: 'hidden' }}`, and HTML `style="opacity:0"`. It also catches Vue `:style="{ opacity: 0 }"` and Svelte `style:opacity={0}` on an element that can hold text.

Reported as a **warning**:
- A state-driven reveal: `style={{ opacity: shown ? 1 : 0 }}` (and Vue `:style`, and `visibility: inView ? 'visible' : 'hidden'`) when the flag is visibility-type (`shown`, `visible`, `inView`, `revealed`, `loaded`, `mounted`...). The flag is false on the server, so the HTML ships the hidden branch. `open ? 1 : 0` (menus, modals) is not reported.
- `visibility: hidden` alone on a short literal inline label (`<span style={{ visibility: 'hidden' }}>Uploading...</span>`), which usually reserves space for a UI state.

**Why:** the served HTML carries the text at opacity 0.
- People and tools without JS get a blank block.
- Google sees the text only if the reveal JS runs and its trigger fires inside a tall render that never scrolls.

On shapeshifters.dev this is how every blog post's H1 and body ended up blank.

**Fix:** remove the inline style. Mark the element `data-reveal`, hide it only under `html.js-reveal` in CSS, and let the animation set its start state at hydration.

**False positive:** a glow wrapper `<div style={{ opacity: 0 }}>{glowLayers}</div>` whose `{glowLayers}` expression holds only shapes, which the linter cannot prove is text-free. Add `aria-hidden="true"`, which is correct for decoration anyway, or put `// crawler-visible-ignore: decorative glow` on the line above.

### `framer-initial-hidden` (error; warning for swapped panels)

**Catches:** `<motion.x>`, `<m.x>`, components made with `motion(Comp)` / `motion.create(Comp)`, and Vue `v-motion`, when `initial` has opacity 0. The opacity 0 can be written inline, in a ternary branch (`reduced ? false : { opacity: 0 }`), or through a variant label that resolves to opacity 0 in the element's own `variants`.

**Why:** framer-motion **server-renders `initial` as an inline style**. The HTML ships the text at opacity 0, which means no-JS readers see nothing. With `whileInView`, the element never animates in Google's non-scrolling render. `useReducedMotion()` does not help, because it returns `false` on the server.

**Fix:** use `initial={false}` and move the reveal to the gated pattern. The other option is to animate transform only (`y`, `scale`) and never opacity.

**Not reported:**
- `initial={false}`.
- A ternary gated on a mounted/hydrated flag.
- Anything inside `<AnimatePresence initial={false}>`.
- Elements mounted conditionally (`{open && <motion.div …>}`).
- Modals and lightboxes (`exit=` with no `key`).
- Decorative or text-free elements.

It is a **warning** when the element has `exit=` and a `key` or sits inside `<AnimatePresence>`. That is usually swapped tab or slide content, and it is an error only if that panel is the one shown on first load.

**False positive:** a toast that is always in the tree and slides in on an event (`initial={{ opacity: 0 }} animate={shown ? … : …}`). Silence it with `// crawler-visible-ignore: toast, not page content`.

### `aos-attribute` (error)

**Catches:** any `data-aos="…"` attribute.

**Why:** the AOS stylesheet sets `[data-aos]` to opacity 0 until its script adds `aos-animate` on scroll.
- No-JS readers see blank text.
- Google's render never scrolls, so nothing below the first screen animates in.

**Fix:** remove AOS and use the gated reveal. This is usually a one-line swap to a `<Reveal>` wrapper.

**Downgraded to a warning** once the project contains the AOS recipe's override (`html:not(.js-reveal) [data-aos] { opacity: 1 !important; ... }`, recipes.md section 3) in any CSS, HTML or component file under the project root (the nearest folder with `package.json` or `.git`). The warning reminds you that a window 3,000px or taller still needs `aos-animate` on load and resize.

**False positive:** `data-aos` on a purely decorative shape. Mark it `aria-hidden="true"` (the linter then skips it) or add `crawler-visible-ignore`.

### `css-ungated-hide` (error)

**Catches:** a CSS/SCSS rule, or a `<style>` block in `.html`, `.vue`, `.svelte` or `.astro`, that sets `opacity: 0`, `visibility: hidden` or `@apply opacity-0|invisible` on a reveal-style selector. Reveal-style means the selector contains `reveal`, `fade`, `aos`, `animate-on/in`, `in-view`, `appear`, `stagger`, `slide-in/up`, `split-*`, `.wow`, `data-animate`, `data-scroll` and similar. The rule is reported only when no JS gate sits above the selector.

**Counts as a gate:**
- `html.js`, `.js`, `.js-*` (for example `html.js-reveal`), `.has-js`, `.hydrated`, `.fx-ready`
- `:not(.no-js)`, `[data-js…]`, `[data-fx…]`
- `@media (scripting: enabled)`

**Not reported:**
- `@keyframes` and `@starting-style`.
- Hover, focus and other state selectors (`:hover`, `[data-state…]`, `[aria-…]`, `.is-open`), and class names that say hover (`.appear-on-hover`, `.hover-reveal`).
- Bootstrap's `.fade:not(.show)` (modals, tabs, alerts).

**Also reported (preloader):** a rule hiding `body`, `main`, `section`, `article`, `#content`, `#app`, `#root` (and similar page wrappers) under an ancestor class that says loader, loading, preload or splash, e.g. `.preloader-active main { visibility: hidden }`. Loader chrome itself (`.loader`, `.spinner`) stays exempt.
- Vue/React transition classes (`-enter-from`, `-leave-to`).
- UI chrome (modal, dropdown, tooltip, menu, drawer, overlay, loader, carousel internals).
- Rules that also run a CSS `animation` (a CSS-only entrance runs without JS).

If the file also has a `.no-js` fallback, the finding drops to a warning.

**Why:** the rule applies whether or not JS runs, so the no-JS reader always gets a blank block. If the reveal script fails or never fires (the tall render), everyone does.

**Fix:** `html.js-reveal .reveal:not([data-revealed]) { opacity: 0 }`, plus the head script and failsafe.

**False positive:** `.fade-panel { opacity: 0 }` for an off-canvas panel that a button opens. Rename it to something that says what it is (`.drawer-panel`) or add `/* crawler-visible-ignore: off-canvas panel */` above it.

### `scroll-reveal-no-endstate` (warning)

**Catches:** one finding per file. The file uses a scroll or in-view trigger (GSAP `ScrollTrigger`/`scrollTrigger:`, `new IntersectionObserver`, `whileInView`, `useInView`, `<InView>`, or react-awesome-reveal / react-reveal / scrollreveal / sal / wow / aos). It also sets a hidden start state (`opacity`/`autoAlpha: 0`, `opacity-0`, `invisible`, `yPercent: 100`) outside decorative subtrees. And nothing handles the tall renderer: no `innerHeight >= …`, `isNonScrollingTallViewport`, `.progress(1)` or `data-revealed`. If the file also has `min-h-screen` / `h-screen` / `100vh` / `dvh`, the message names that trap.

**Why:** Google grows its viewport to the page height and never scrolls. A `min-height: 100vh` section then becomes as tall as that viewport, so section two starts below any `top 85%` trigger line and never reveals. On shapeshifters.dev this left 54–96% of words at opacity 0 in Google's snapshot.

**Fix:** when `window.innerHeight >= 3000`, show the end state and skip the tween. On `ScrollTrigger` `refresh` and `resize`, run `tween.progress(1)` for reveal tweens. Never branch on user agent.

**False positive:** an IntersectionObserver that only lazy-loads an image in a file that also has an unrelated `opacity-0` hover overlay. Put `// crawler-visible-ignore` on the observer line.

### `dynamic-ssr-false` (warning)

**Catches:** `dynamic(() => import('…'), { ssr: false })`. It stays quiet when the variable name, import path or file path says the component is not content: studio, sanity, editor, monaco, map, chart, graph, three, 3d, canvas, webgl, spline, lottie, video, player, globe, scene, particles, confetti, cookie, consent, toast, modal, dialog, captcha, chat widget, analytics and similar.

**Why:** the component is absent from the server HTML. AI crawlers never see its text, and neither do no-JS readers.

**Fix:** server-render it. If it truly needs the browser, split the text out into a server-rendered part and keep only the widget client-side.

**False positive:** `const Testimonials = dynamic(…, { ssr: false })` where Testimonials is a pure canvas animation. Rename it (`TestimonialsCanvas`) or add `// crawler-visible-ignore: canvas only`.

### `mount-gate-null` (warning)

**Catches:** `if (!mounted) return null` (also `!hydrated`, `!isMounted`, `!hasMounted`, `!isClient`, returning `null`, `false`, `<></>` or `''`), and `{mounted && …}`. Files that use `useTheme`, `next-themes`, `setTheme`, `theme`/`darkMode`/`colorScheme` or `createPortal`, and files named `*theme*`/`*dark-mode*`, are skipped, because those gates are expected there.

**Why:** the server renders nothing behind the flag, so AI crawlers and no-JS readers miss that text.

**Fix:** render the content on the server. Gate only the browser-specific detail (a date in local time, a theme icon) or the animation, never the words.

**False positive:** a cursor follower gated on mount that has no text. Add `// crawler-visible-ignore: no text`.

### `aria-hidden-content` (warning)

**Catches:**
- `aria-hidden` with a dynamic value (`aria-hidden={!isActive}`, `:aria-hidden="!open"`) on an element with children.
- A static `aria-hidden="true"` on `role="tabpanel"`.
- Split-text components where letters are `aria-hidden` and the sentence exists only in `aria-label`, with no `sr-only` copy.

**Why:** Readability-style extractors used by AI tools drop `aria-hidden` subtrees, so closed tab and accordion text is lost to them. `aria-label` text is not page text.

**Fix:** use `inert={!isActive}`, or `hidden="until-found"` when the browser should be able to find-in-page and open it. `inert` already removes the element from the accessibility tree and the tab order. For split text, keep a visually-hidden (`sr-only`) copy of the whole sentence.

**False positive:** a duplicate "pull quote" that repeats a sentence already on the page, hidden from screen readers to avoid reading it twice. That is intentional. Add `{/* crawler-visible-ignore: duplicate of the text above */}`.

### `class-hidden-initial` (warning)

**Catches:** `className`/`class` containing a bare `opacity-0` or `invisible`. That includes responsive prefixes, since `md:opacity-0` still hides the element on desktop. It is reported when the class is either static or sits behind a visibility-type condition (`isVisible`, `inView`, `revealed`, `mounted`, `loaded`, `animate…`). It is skipped when an interaction or open-state variant restores it on the same element (`group-hover:opacity-100`, `data-[state=open]:opacity-100`, `data-open:opacity-100`, `aria-expanded:opacity-100`, `focus:visible`), and for decorative or text-free elements. A **reveal** variant does not exempt it, because that is exactly what JS toggles: `data-[in]:opacity-100`, `data-[visible]`, `data-[inview]`, `data-[revealed]`, `data-[shown]`, `[&.is-visible]:opacity-100`.

It also reports Vue `v-show="loaded"` (or another visibility-type flag) on an element with text: SSR renders `display:none` until the flag flips.

**Why:** the class is in the server HTML. No-JS readers see blank text, and an in-view condition never flips in Google's tall render.

**Fix:** ship the element visible. Hide it only under the JS gate, or let the animation apply its start state at hydration.

**False positive:** a status message that is always in the DOM and only shows after a form submit (`isVisible ? 'opacity-100' : 'opacity-0'`). Add `crawler-visible-ignore`, or better, render the message only once there is one.

### `counter-from-zero` (warning)

**Catches:**
- `const [value, setValue] = useState(0)` rendered as `{value}`, `{value.toLocaleString()}` or `{fmt(value)}`, in a file with an animation driver (`requestAnimationFrame`, `setInterval`, IntersectionObserver, `useInView`, `whileInView`, ScrollTrigger, `animate(…)`, gsap), when the setter runs toward a final figure (`Math.min`, a comparison, `to`/`target`/`end`/`value`/`total`, `* progress`). An unbounded tick (`setCount(c => c + 1)`) is a live timer or click counter and is skipped.
- `<CountUp …>` from react-countup.
- `useMotionValue(0)` shown through a rounding transform.

Names that look like indexes, steps, timers or sizes (`activeIndex`, `step`, `seconds`, `width`…) are ignored.

**Why:** the HTML says "0". That is what AI crawlers and no-JS readers record, and it is what Google indexes if the count never starts in its render.

**Fix:** initialise to the final value so the HTML carries the real number. After hydration, reset to 0 and count up, only for a real visitor who can see it.

**False positive:** a live "items in cart" badge that genuinely starts at 0. Rename it (`cartCount` is ignored, since `cart` is in the index-like list) or add `crawler-visible-ignore`.

### `typewriter-state` (warning)

**Catches:**
- `useState('')` grown with `setX(full.slice(0, i))`, `substring(0, …)`, `charAt`, `text[i]` or `prev => prev + …` inside a timer.
- Imports of typewriter-effect, react-type-animation, react-simple-typewriter, typed.js or react-typed.

**Why:** the headline starts empty in the HTML, so crawlers and no-JS readers get nothing, and a scramble effect gives them garbage.

**Fix:** render the full text in the HTML and animate it with a clip-path or an overlay. Alternatively, keep an `sr-only` full copy and mark the animated one `aria-hidden`.

**False positive:** a chat demo that types a decorative bot reply inside an illustration. Mark the container `aria-hidden="true"` or name the file `*Illustration*`.

### `effect-set-text` (warning)

**Catches:** state initialised empty (`useState('')`, `useState()`, `useState(null)`), rendered as `{text}`, and set inside `useEffect` / `useLayoutEffect` / `onMounted` to a literal sentence (`setIntro('We help companies ship faster.')`) or to a fetched `title`/`text`/`body`/`content`/`description`.

**Why:** the server HTML has an empty element; AI crawlers never see the sentence.

**Fix:** initialise the state with the text, or fetch it on the server.

**False positive:** a greeting that depends on the visitor's local time. Render a neutral version on the server, or add `crawler-visible-ignore`.

### `active-only-panel` (warning)

**Catches:** inside `.map()`, an element with text rendered only for the active item: `tabs.map((t, i) => active === i ? <p>{t.body}</p> : null)` or `active === t.id && <Panel …/>`, where the other side is named like `active`, `current`, `selected`, `open`, `tab`, `index`, `slide`, `step`.

**Why:** the closed panels are not in the HTML at all, so crawlers never see their text.

**Fix:** render every panel; hide closed ones with `hidden="until-found"`, `<details>`, or `inert` plus CSS (recipes.md section 5).

**Not caught:** one conditional per panel (`{tab === 'a' && <PanelA/>}`) and carousel libraries that virtualise slides; use the audit.

### `preloader-cover` (warning)

**Catches:** a component whose file or name says preloader, loader, loading, splash or intro, which holds a `useState(true)` loading-type flag and draws a fixed full-screen overlay (`fixed inset-0`, `100vh`, `h-screen`).

**Why:** the overlay is in the server HTML. No-JS readers and slow phones see only the loader, and renderers may take their snapshot before it lifts.

**Fix:** do not server-render the loader. Show it only after hydration, if at all. Never hide page content underneath it, and give it a CSS-only timeout.

**False positive:** a full-screen loader inside a logged-in dashboard, which crawlers never reach. Add `crawler-visible-ignore-file` to that component.

---

## What the linter cannot see (use the rendered audit)

- Content fetched on the client in general (`effect-set-text` only catches a fetched title/text/body put into state), and "load more" or infinite scroll.
- Astro `client:only` islands, consent-gated content.
- Text that exists only in canvas, WebGL, images or video.
- Text hidden by a component defined in another file, such as a third-party reveal wrapper, unless its import matches a known library.
- JS that hides content that was visible in the HTML (`gsap.fromTo` at hydration with no end state). The `scroll-reveal-no-endstate` warning covers the usual case.
- Whether a flagged element really holds reading text after data is filled in.

The audit renders the page in raw, no-JS and Googlebot-like modes and counts every hidden word. A site is done when it shows **0 hidden READING words in both the no-JS and the Googlebot modes** on every audited page, with the animation unchanged for visitors.
