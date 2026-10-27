# crawler-visible-text

**Your website can look perfect and still be nearly blank to Google.**

I built my site with an AI agent. Every section faded in as you scrolled, exactly how I wanted. Then I tested it the way Google renders it: out of 2,368 words on the homepage, **127 were visible**. The rest were there, just at `opacity: 0`, waiting for a scroll that Google never does.

Nobody noticed, because everyone who looked at the site scrolled.

This repo is the fix I turned into a [Claude Code](https://docs.claude.com/en/docs/claude-code) skill, so it gets checked on every site I build. It keeps your animations exactly as they are and makes every word readable by:

| Reader | What it does | What hides your words from it |
|---|---|---|
| **Google and Bing** | Render the page in one very tall window, take a snapshot, never scroll | Scroll-triggered fade-ins, reveals and staggers that never fire |
| **AI search** (ChatGPT, Claude, Perplexity crawlers) | Mostly read the raw HTML and run no JavaScript | Text that only exists after JavaScript: client-only rendering, counters that ship `0`, typewriters that start empty, text under `aria-hidden` |
| **People without JavaScript** | Link previews, reader modes, failed bundles, slow phones | Anything shipped at `opacity: 0` in the HTML |

After the fix: **0 hidden words** on every page, with the same animation for visitors.

## What's inside

- **`SKILL.md`**: instructions Claude Code follows whenever it builds or reviews a page with animations, scroll effects, tabs, counters or typewriters, even when nobody mentions SEO.
- **`scripts/audit.mjs`**: measures how many words each kind of reader actually gets from a live page, and points at the element hiding them. No dependencies: Node and a local Chrome.
- **`scripts/lint.mjs`**: flags the code patterns that hide words (`opacity: 0` in server HTML, framer-motion `initial` opacity 0, `data-aos`, `ssr: false` around content, empty counters...). It can run as a Claude Code hook so the problem is caught the moment it's written.
- **`references/`**: the eight patterns that hide text and a recipe for each: GSAP / ScrollTrigger, framer-motion, AOS, CSS, Webflow and Framer, tabs and accordions, counters and typewriters.

## Install

Clone it into your Claude Code skills folder:

```bash
git clone https://github.com/alrezch/crawler-visible-text ~/.claude/skills/crawler-visible-text
```

That's it. Claude Code picks the skill up on its own. Ask it things like:

- "Can Google see everything on my homepage?"
- "Audit https://my-site.com before launch."
- "Add a fade-in to these sections." (it'll do it the safe way)

**Requirements:** Node 22 or newer, and Chrome, Chromium, Edge or Brave installed (set `CHROME_PATH` if it isn't found).

## Run the audit yourself

No Claude needed:

```bash
node ~/.claude/skills/crawler-visible-text/scripts/audit.mjs https://your-site.com/
```

Every page in a sitemap:

```bash
node ~/.claude/skills/crawler-visible-text/scripts/audit.mjs --sitemap https://your-site.com/sitemap.xml
```

It reads each page three ways:

- **raw**: the HTML as served, which is roughly what AI crawlers read
- **nojs**: headless Chrome with JavaScript off
- **googlebot**: JavaScript on, 412px wide, the window grown to the page's height, never scrolled

Every hidden word is classed as real content (the failure), a closed tab or accordion (fine), or decoration (fine). Example from my homepage after the fix:

```
https://shapeshifters.dev/
  raw        2,444 words in served HTML (2,269 in <main>) | HTTP 200
  nojs       visible 1,028 | hidden reading 0 | disclosure 1,280 | decorative 30
  googlebot  visible 1,028 | hidden reading 0 | disclosure 1,280 | decorative 30
             viewport 412x30,000
PASS: 1 of 1 page pass
```

Exit code `0` means pass, `1` means hidden words were found and `2` means a tool error, so it drops straight into CI. Run `audit.mjs --help` for the rest of the options.

You can also confirm it with Google directly: in Search Console, inspect a URL, click **Test live URL**, then **View tested page** and open the screenshot.

## Lint your code

Scan a project:

```bash
node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs ./src
```

To catch it while Claude Code writes, add this hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node ~/.claude/skills/crawler-visible-text/scripts/lint.mjs --hook", "timeout": 15 }]
      }
    ]
  }
}
```

Purely decorative code (a background glow, an illustration with no words) can be skipped with a comment:

```tsx
{/* crawler-visible-ignore: decorative gradient, no text */}
```

## How the fix works

You don't need to give up your animations:

1. The server sends every word **visible**.
2. A tiny script in `<head>` adds a class before the first paint, and CSS hides reveal blocks only under that class. A visitor with JavaScript sees exactly the same frames as before.
3. In a very tall window (Google's renderer), reveals jump straight to their end state. This is detected by **window size, never by user agent**: showing bots a different page is cloaking.
4. A failsafe lifts the class if your scripts fail, so nobody ends up with a blank page.

The full recipes for each library are in [`references/recipes.md`](references/recipes.md).

## License

MIT. Built by [Alireza Chamanrouy](https://shapeshifters.dev) (@builtbyalizz on Instagram). If it found something on your site, a star helps other people find it.
