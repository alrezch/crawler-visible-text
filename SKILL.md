---
name: crawler-visible-text
description: Keeps every word of a website readable by Google, Bing, AI crawlers and no-JavaScript readers, even when the design uses animations. Use this skill whenever you build, edit, redesign or review a website, landing page, marketing page, portfolio, blog template or any page with animations, scroll effects, reveal or fade-in effects, framer-motion / motion, GSAP or ScrollTrigger, AOS, Lottie, SplitText, parallax, preloaders, tabs, accordions, FAQs, carousels, sliders, counters or typewriter effects - even when the user never mentions SEO. Also use it whenever SEO, indexing, "Google can't see my content", AI search visibility (ChatGPT, Perplexity, Claude), a pre-launch or go-live check, or a site audit comes up, and always before any client site or page is declared finished. Text hidden by animation code silently costs a client rankings and traffic, so err on the side of using this skill.
---

# Crawler-visible text

A page can look perfect to a visitor and be nearly blank to a search engine. On shapeshifters.dev, scroll-reveal animations left 54-96% of the words at opacity 0 in Google's rendered snapshot (the homepage showed 127 words and hid 2,241), and every blog post's title and body were blank without JavaScript. Nobody saw it, because every human who looked had JavaScript and scrolled. This skill exists so that never ships again on any site we build.

The goal is simple to state: **every reading word is present in the server HTML and visible without scrolling, clicking or running JavaScript - while visitors still get exactly the animation the client approved.** Those two things are not in tension; the fix is how the animation is wired, not whether it exists.

## 1. The three readers

Keep all three in mind, because each one fails for a different reason.

1. **Google and Bing** render JavaScript, mobile first (about 412px wide), but never scroll or click. Their renderer makes the viewport as tall as the whole page. Scroll-triggered reveals (IntersectionObserver, ScrollTrigger, `whileInView`, AOS) only fire for elements inside the trigger band, and sections sized `min-height: 100vh`/`100dvh` grow with that giant viewport, so section two starts below any "top 85%" line and never reveals. Text left at opacity 0 is treated as hidden.
2. **AI crawlers** (GPTBot, ClaudeBot, PerplexityBot, CCBot) mostly read raw HTML and run no JavaScript. They ignore CSS, so opacity tricks do not hurt them - but anything not in the server HTML is simply absent: client-only rendering, text set after load, typewriters that start empty, counters rendered as 0, tabs that render only the active panel. Their Readability-style extractors also drop `aria-hidden="true"` subtrees, so real text marked aria-hidden is lost.
3. **People and tools without working JavaScript** - a failed or blocked bundle, a slow phone not yet hydrated, reader modes, link-preview renderers that apply CSS. An inline `opacity:0` in the served HTML gives them a blank page.

## 2. While building: make text safe by default

Apply these as you write the code, not as a cleanup pass. Working code for each is in `references/recipes.md` (read the section for the stack you are in). The full catalogue of failure patterns, with how each looks in code, is in `references/patterns.md`.

- **Ship content visible; hide it only once JavaScript is confirmed.** A tiny synchronous script in `<head>` adds a class (e.g. `js-reveal`) to `<html>` before first paint, and CSS hides not-yet-revealed blocks only under that class and only under `prefers-reduced-motion: no-preference`. Why: the server HTML then has every word visible, while a JavaScript visitor's first frame is identical to before.
- **Let the animation library take over at hydration, then lift the CSS gate.** Write the start state inline in a layout effect (GSAP `fromTo` with immediateRender does this before paint), then stamp `data-revealed` so the stylesheet rule stops applying. Why: no frame where content flashes visible then hidden.
- **Never let a component server-render `opacity: 0`.** framer-motion `initial={{ opacity: 0 }}`, AOS's stylesheet, `opacity-0`/`invisible` utility classes, and hand-written `style={{opacity:0}}` all put the hidden state into the HTML. Why: that is exactly what no-JS readers and Google's tall render get stuck on.
- **Show the end state in a non-scrolling tall window.** If `window.innerHeight >= 3000` (no real screen is that tall; a portrait 4K monitor is about 2,100-2,400 CSS px), skip reveal tweens and jump any scroll-triggered reveals to their end on refresh/resize. Why: that is Google's renderer, and it will never scroll to trigger them. Detect by geometry only - never by user agent.
- **Add a failsafe.** The head script removes the gate class if a site script fails or throws before hydration, 5s after `load` if hydration never happens, and after 12s regardless; the app sets `data-fx-ready` on `<html>` at hydration to stand it down. If hydration arrives after the failsafe fired, leave on-screen content alone instead of hiding it to fade it back in. Why: a broken bundle must never mean a blank page.
- **Read reduced motion with `matchMedia` at hydration.** Hooks like `useReducedMotion` still return their server snapshot (false) at that moment, so trusting them starts motion for someone who asked for none.
- **Disclosure UI keeps every panel in the HTML.** Tabs, accordions, FAQs, "read more": render all panels on the server; hide closed ones with `<details>`, `hidden="until-found"`, `inert` plus CSS, or `hidden` on an element marked as a panel (`role="tabpanel"`, or the target of a control's `aria-controls` with `aria-expanded`/`aria-selected="false"`) - not `aria-hidden`, and never by not rendering them. A bare `<div hidden>` with none of those marks is indistinguishable from lost content, and the audit counts it as READING. Why: Google gives full weight to text in tabs and accordions under mobile-first indexing once it is in the DOM, and extractors drop aria-hidden.
- **Counters render their final value** in the HTML and count up only after hydration, and only if the counter is still below the fold. **Typewriters and scramble effects render the full real text** and animate with a clip or overlay. Why: the HTML is what AI crawlers read.
- **Server-render real content.** No `next/dynamic` with `ssr: false`, no `if (!mounted) return null`, no text set into state in `useEffect`, no client-side fetch for body copy, no carousel that renders only the active slide. Keep client-only code for genuinely browser-only widgets (maps, 3D, charts) and give those a text equivalent.
- **Text belongs in text nodes.** Headlines drawn in canvas, WebGL, Lottie, images or video need a real HTML heading. Split-text effects must leave the real words readable: the visual letters can be aria-hidden only if a real-text copy sits beside them, not just an `aria-label`.
- **No preloaders that cover or hide the page until JS finishes**, no content that only appears on scroll, "load more" or after a consent click without a crawlable fallback (real paginated links, content rendered behind the banner).

## 3. Before calling a site done

Run both tools. They are dependency-free Node scripts (Node 18+; the audit needs a local Chrome, Chromium, Edge or Brave, or `CHROME_PATH`). Run either with `--help` for all options.

```bash
# Source check: flags risky patterns in the code
node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs <project-dir>

# Rendered check: every page that matters, on the running site
node ~/.claude/skills/crawler-visible-text/scripts/audit.mjs http://localhost:3000/ http://localhost:3000/about http://localhost:3000/blog/some-post

# Or every page in a sitemap (exit code 1 means a page failed)
node ~/.claude/skills/crawler-visible-text/scripts/audit.mjs --sitemap https://preview.example.com/sitemap.xml
```

Audit the local dev server, a production build, or a preview URL - production builds are the truest, because dev-mode React can hydrate differently. Include at least the home page, one of each template (service page, blog post, case study, landing page), and any page with tabs or counters.

The audit measures three ways: **raw** (the HTML fetched with a Googlebot smartphone user agent, plus risk markers such as inline `opacity:0`, `data-aos`, framer initial styles), **nojs** (headless Chrome with scripts disabled), and **googlebot** (JS on, 412px wide, viewport grown to the page height, never scrolled). Each hidden word is classified:

- **READING** - real content hidden. This is the failure.
- **DISCLOSURE** - inside a closed `<details>`, tab, accordion, `inert` or `hidden="until-found"` panel. Fine; reported for information.
- **DECORATIVE** - inside an aria-hidden illustration with no reading content. Fine; reported.
- **ARIA-HIDDEN READING** - hidden real text under `aria-hidden` (a closed tab panel marked aria-hidden). It takes precedence over DISCLOSURE, and every word is counted in exactly one class. On-screen text under aria-hidden (split-text headings whose sentence is only in `aria-label`) is shown as "(+N on screen)". A warning: Google sees it, AI extractors drop it. Fix it.

The googlebot line also lists **visible words not in the served HTML** (typewriters that start empty, counters that ship 0, injected or client-fetched text) with the texts themselves: AI crawlers never get them. A page with only these warnings prints "PASS with warnings"; treat them as work to do on a client site.

**Done means 0 hidden READING words in both nojs and googlebot on every audited page, and the animation unchanged for visitors.** Also compare the raw word count to the googlebot count: a large gap means content that exists only after JavaScript, which AI crawlers never see. After fixing, open the page in a normal browser and scroll through it to confirm the motion looks exactly as before.

## 4. Auditing an existing or someone else's site

1. **Measure first.** Run the audit on the live or preview URLs before touching anything, and keep the numbers.
2. **Map each hidden sample to its source.** The audit prints sample phrases; grep the codebase for them, find the wrapping component, and match it to a pattern in `references/patterns.md`. Usually a handful of shared components (a reveal wrapper, a stagger grid, a tabs component) account for nearly all hidden words, so fix the component, not each page.
3. **Fix or propose.** If we own the code, fix it with the matching recipe and re-run the audit until it passes. If the code is not ours or the user asked only for a review, write the proposal: which component, what to change, expected result. For Webflow, Framer or WordPress builders, see the page-builder section of `references/recipes.md`.
4. **Report in plain language.** The owner reads short, plain answers. Say how many pages were checked, how many words Google and no-JS readers could not see before and after, what changed in a sentence or two, and anything left for a person to decide. No jargon tables.

Example report:
> Checked 9 pages. Before: Google could not see 6,400 of 8,100 words; without JavaScript the blog posts were blank. After: every word visible in both. The fade-ins still look the same - the text now ships visible and is hidden only once the animation code is ready to play. One thing for you: the pricing page tabs hide their text from AI tools; I can change that if you agree.

## 5. Hard lines

- **Never serve crawlers something different based on user agent.** Showing Googlebot one page and visitors another is cloaking and can get a site removed from the index. Every fix here works for every client; the tall-window check is geometry, not identity.
- **Never change what a real visitor sees without saying so.** If a fix alters a frame, a timing or a layout, say exactly what and why, and prefer the version that changes nothing.
- **Never delete an animation the client approved.** Keep it and gate it. Removing motion to pass the audit is the wrong fix; the recipes exist so you never have to.

## 6. The write-time guard

A PostToolUse hook runs `scripts/lint.mjs --hook` on every file Claude writes or edits (registration: `scripts/lint-rules.md`, "Hook mode"). The edit has already happened when it runs; when the lines the edit wrote contain an error-level pattern, it sends Claude a message (exit 2) naming the file, line and pattern - for example an inline `opacity: 0` that will reach the server HTML, a framer-motion `initial` with opacity 0, `data-aos`, `ssr: false` around content, `aria-hidden` on a text block, or a counter/typewriter starting empty. It means: this code, as written, will hide words from at least one reader. Fix it with the matching recipe before moving on, rather than planning to clean up later. Warnings on the written lines arrive as extra context without blocking. Errors that were already in the file on lines the edit did not touch (a client's legacy code) are listed once per session as context, not as a block: fix them when you work on that part of the page.

If the flagged code really is decorative only (a background blob, a cursor effect, an illustration with no words), mark it so the guard skips it, with a reason:

```tsx
{/* crawler-visible-ignore: decorative gradient, no text */}
<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="blob" aria-hidden />
```

In JS/CSS use `// crawler-visible-ignore: <reason>` or `/* crawler-visible-ignore: <reason> */` on the line above. Do not use it on anything that contains words a reader should see; the audit will catch it later anyway.
