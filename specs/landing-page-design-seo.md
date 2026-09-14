# Landing page — premium design pass + on-page SEO fundamentals

## Problem

`perry42.github.io/GitHydra` (source: the `gh-pages` branch, `index.html`) is GitHydra's only
public-facing surface for anyone who isn't already browsing the repo — the page Search Console,
any social share, and a plain "GitHydra" search result all point at. It exists today purely to
carry Google Search Console verification and a quickly-written functional one-pager (tagline,
download/repo links, a six-item feature list, a principles list) — confirmed live: generic
light-neutral chrome, no analytics/tracking present, no relationship to the app's own visual
language. It was never built through the `impeccable` design skill, has no `DESIGN.md` presence,
and doesn't reflect GitHydra's transit-map thesis or token system at all. It also has none of the
on-page SEO fundamentals (structured data, sitemap, meta tags beyond the verification snippet)
that make a page rankable at all, independent of how good it looks.

Both problems live on the same one page and were deliberately bundled into one item by the
roadmap rather than split into two workstreams — a visual rebuild and an SEO pass would otherwise
touch the same `<head>`/markup twice.

## Target user

Anyone landing on GitHydra's public page for the first time without already knowing the project:
someone who found it via a Google search, a shared link, or a GitHub profile/README click-through.
This is the same developer audience `PRODUCT.md` describes (works in git day to day, evaluating
whether a free desktop git client is worth installing) — the page's job is to get that person to
either download the app or open the repo, honestly, with nothing fabricated to get there.

## Must-have behavior

### Content and structure (the design pass builds against this; exact visual treatment is
`impeccable`'s to decide, not prescribed here)

- **FR-271:** The redesign runs through `impeccable`'s own context-aware routing (no argument
  forcing `new-work` vs. `polish` in advance, per the roadmap's own instruction) and produces a
  documented design record — an extension of `DESIGN.md`, or an equivalent dedicated marketing-page
  design note if `impeccable` scopes it as a separate visual world — capturing the direction,
  token/component choices, and a finish review. Matching this project's own FINISH principle
  ("unreviewed and undocumented is unfinished"), the page does not ship without that record existing.
- **FR-272:** This spec does not prescribe colors, layout, or exact typography — those are
  `impeccable`'s process to run, whether it extends GitHydra's existing transit-map/token system
  (`DESIGN.md`) into a marketing context or establishes a deliberately-designed distinct "own-world"
  for this surface.
- **FR-273:** Hero region: product name, a one-line tagline, and a short (1–2 sentence) positioning
  statement — content drawn from `PRODUCT.md`'s Product Purpose/Positioning sections in substance,
  not reworded into claims those sections don't support.
- **FR-274:** Two primary calls-to-action, reachable without scrolling at common desktop widths:
  "Download" (linking to the latest real GitHub Release) and "View source" (linking to the GitHub
  repo). The download path honestly carries the current unsigned-binary caveat (same substance as
  `release.yml`'s own release-notes disclaimer — SmartScreen/Gatekeeper warnings, how to proceed) —
  never silently omitted because it's an inconvenient fact for a "premium" page.
- **FR-275:** A feature-overview section covering all seven shipped v1 capabilities — commit graph
  visualization, stage/unstage + diff, branch management, merge/rebase + conflict resolution, stash,
  cherry-pick, blame & file history — one short, factual description each. No capability listed that
  isn't actually shipped (checked against `PRODUCT.md`'s Evidence on Hand, not assumed).
- **FR-276:** A "why GitHydra" / principles section stating, plainly: works with any git host or
  none (GitHub/GitLab/Bitbucket/self-hosted/local-only, bare repos, submodules, worktrees); no
  forced account or sign-in; no telemetry by default; no feature paywalls; GPL-3.0-or-later,
  free forever. Every claim here must be true today per `CLAUDE.md`/`PRODUCT.md`, not aspirational.
- **FR-277:** A download/platforms section listing Windows/macOS/Linux, linking to the real
  `v0.1.0`+ GitHub Releases assets, restating the unsigned-installer caveat (FR-274) in context
  next to the actual download buttons, not just once in passing elsewhere on the page.
- **FR-278:** Footer with the repo link, the license (GPL-3.0-or-later, linking to the `LICENSE`
  file), and any attribution/copyright line using the project's public GitHub no-reply address —
  never the maintainer's personal email, per the existing privacy convention documented in
  `ROADMAP.md`'s release-pipeline entry.
- **FR-279:** No fabricated content anywhere: no invented user counts, "trusted by" claims,
  testimonials, or customer logos — matching `PRODUCT.md`'s explicit "No public screenshots, demos,
  testimonials, or case studies exist yet" and "must not fabricate testimonials, benchmarks,
  pricing, or customer references" constraints. A real, self-updating fact (e.g. an actual live
  GitHub star-count badge pulled from GitHub's own API/shield) is acceptable since it isn't
  invented or static; a static made-up number is not.
- **FR-280:** Fully responsive: no horizontal scroll or overlapping content at common breakpoints
  (360px / 768px / 1024px / 1280px / 1920px widths), and no content or link that depends on
  hover-only interaction to be reachable on a touch device.

### On-page SEO fundamentals

- **FR-281:** `<title>` and `<meta name="description">` present and unique — title ≤60 characters,
  including "GitHydra" and a plain descriptor (e.g. "free open-source git client"); description
  120–160 characters, accurately summarizing the product, no keyword stuffing.
- **FR-282:** Open Graph (`og:title`, `og:description`, `og:image`, `og:url`, `og:type`) and Twitter
  Card (`twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`) tags, so a shared
  link (chat, PR description, social post) renders a real preview instead of a blank one. The
  referenced image must be a real existing/newly-produced project asset (app icon/logo, or a real
  captured app screenshot per FR-293) — never a stock photo or an invented mockup.
- **FR-293:** At least one real captured app screenshot appears in the hero and/or feature-overview
  section, per the user's decision (2026-09-14) to include screenshots in this item's scope rather
  than ship without them. Captured against a clean demo/fixture repository — never a real personal
  repo, to avoid exposing private data — in both light and dark theme. Choice of which app state(s)
  to show (commit graph, diff view, etc.) and exact count/placement is left to `impeccable`'s process
  (consistent with FR-272), but at least one real screenshot is required, not optional. Reuse for
  FR-282's `og:image`/`twitter:image` where a suitable screenshot fits that format.
- **FR-294:** The root `README.md`'s existing demo media (`docs/assets/demo.gif`, referenced at
  `README.md` line 19) is refreshed using the same capture pass as FR-293, per the user's mid-scoping
  request — GitHub's repo page and the redesigned landing page should show a consistent, current
  product image rather than one refreshed surface and one stale one. Same demo/fixture-repo
  constraint as FR-293 (never a real personal repo). Format (static screenshot vs. a refreshed GIF)
  matches whatever `README.md` already uses unless there's a good reason to change it.
- **FR-283:** Semantic HTML: exactly one `<h1>`, a heading hierarchy with no skipped levels,
  semantic landmark elements (`<header>`, `<main>`, `<footer>`, `<section>`s, `<nav>` if
  applicable), and real `alt` text on every image describing its actual content — never
  keyword-stuffed alt text.
- **FR-284:** A single `<link rel="canonical">` tag pointing at the page's real published URL.
- **FR-285:** A `SoftwareApplication` JSON-LD structured-data block: name, description,
  `applicationCategory`, `operatingSystem` list, `license` (linking to the GPL-3.0-or-later text),
  and an `offers` node with `price: "0"` reflecting that it's genuinely free. No fabricated
  `aggregateRating`/review-count fields, since none exist.
- **FR-286:** `sitemap.xml` and `robots.txt` at the site root. `robots.txt` allows full crawling and
  references the sitemap; `sitemap.xml` lists the page's real URL(s) with an accurate `lastmod`.
- **FR-287:** A page-speed budget appropriate to a fundamentally static page: no heavy JS
  framework/bundle, optimized/compressed images at real display dimensions, and a small, deliberate
  number of external requests (e.g. a webfont) — each one justified, not accumulated incidentally.
- **FR-288:** Mobile-friendly: a correct `<meta name="viewport">` tag, standard-sized touch targets,
  and no reliance on horizontal scrolling or pinch-zoom to read content or use a link on a
  phone-width viewport.
- **FR-289:** The existing Google Search Console verification mechanism (whatever tag/file is in
  place today) is preserved verbatim through the redesign — not silently dropped as a side effect of
  restructuring the `<head>`.
- **FR-290:** No new analytics/tracking script is added. Search Console's own crawl-only
  verification is not tracking and is unaffected by this rule. The page continues to make zero
  requests to any third-party analytics/tracking endpoint — extending this project's "no telemetry
  by default" principle to its own public page. (This is a default choice, not a silent one — see
  the open question below; the user can override it.)
- **FR-291:** Body copy naturally works in realistic long-tail phrasing a prospective user might
  actually search — e.g. "free open source GitKraken alternative," "GPL-licensed git GUI," "git
  client for GitHub, GitLab, Bitbucket, and self-hosted repos," "visual git client without sign-in"
  — inside real sentences, never a stuffed keyword list or hidden text. No claim, explicit or
  implied, of ranking "first" or beating any specific named competitor in search results.
- **FR-292:** No off-site SEO tactics — paid backlinks, link-farm/directory submissions, cloaking,
  or doorway pages are all out of scope and contrary to the honest-SEO framing this item commits to.

## Non-goals

- Exact color palette, layout grid, or typography choices — `impeccable`'s process decides these
  (FR-271/272), not this spec.
- A demo video/GIF — the user's screenshot decision (FR-293) covers still screenshots only; a video
  walkthrough is a separate, larger ask not scoped here.
- A multi-page site, blog, or separate docs site — this remains one landing page, matching current
  scope; sitemap/structured-data work (FR-285/286) is sized for a single page, not a site architecture.
- Any off-site SEO/backlink-building work (FR-292) — outside this project's control per the
  roadmap's own honesty caveat, and outside a single on-page-fundamentals spec regardless.
- Any promise or implication that GitHydra will rank first, or above any specific named competitor
  (GitHub Desktop, GitKraken, Sourcetree, Fork), for a competitive head term like "git client" or
  "git gui." Not achievable through on-page work alone and not something this spec claims.
- Adding new analytics/tracking beyond what exists today (FR-290's default) — a separate decision if
  the user wants it, not bundled into this item.
- The donate/support link `ROADMAP.md`'s licensing entry already approved in principle but never
  built — tracked separately; flagged below as worth considering while this page is already being
  touched, but not a requirement of this spec.
- The README non-affiliation disclaimer wording `ROADMAP.md` already flags as deferred pending the
  README itself being written — stays deferred; this spec doesn't resolve it either way.
- Code-signing status of the downloadable installers — unaffected by this item, tracked separately
  in `ROADMAP.md`'s release-pipeline entry; this spec only requires the page state the current
  unsigned status honestly (FR-274/277), not that signing itself gets solved here.
- A custom domain — the page stays at `perry42.github.io/GitHydra`; no domain purchase or DNS work.

## Acceptance criteria

1. The shipped page has a documented design record (an appended `DESIGN.md` section, or a
   dedicated equivalent) describing the direction taken and naming a finish review — not shipped
   silently with no record, per FR-271.
2. All seven v1 features (FR-275) are named on the page, each with a description that matches what
   `PRODUCT.md`'s Evidence on Hand actually documents — no capability claimed that isn't shipped.
3. The four principles in FR-276 (any-host, no sign-in, no telemetry by default, no paywalls) plus
   the GPL-3.0-or-later license appear on the page in plain language.
4. Both primary CTAs (Download, View source) are reachable without scrolling at 1280px and 1920px
   desktop widths, and the download path states the unsigned-binary caveat next to the actual
   download links, not only in a separate section.
5. No testimonial, customer logo, static invented number, or "trusted by" claim appears anywhere on
   the page — confirmed by a direct content review against `PRODUCT.md`'s Evidence on Hand section.
6. The page renders with no horizontal scroll and no overlapping content at 360px, 768px, 1024px,
   1280px, and 1920px viewport widths.
7. `<title>` (≤60 chars, contains "GitHydra") and `<meta name="description">` (120–160 chars) are
   present and non-generic; verified by reading the rendered `<head>`, not just the source template.
8. Open Graph and Twitter Card tags are present and a link-preview tool (e.g. a social debugger, or
   manual inspection of the rendered meta tags) shows a real title/description/image, not a blank
   or default preview.
9. Exactly one `<h1>` exists on the page; heading levels never skip (e.g. no `<h2>` directly
   followed by `<h4>`); every `<img>` has non-empty, content-accurate `alt` text.
10. A JSON-LD `SoftwareApplication` block validates with zero errors in Google's Rich Results
    Test / the Schema.org validator, including a `price: "0"` `offers` node and no fabricated
    rating/review fields.
11. `sitemap.xml` and `robots.txt` both exist at the site root; `robots.txt` references the
    sitemap and disallows nothing; `sitemap.xml`'s listed URL(s) resolve to real, live pages.
12. A Lighthouse audit (mobile) against the deployed page scores ≥90 in Performance, Accessibility,
    Best Practices, and SEO categories — run and recorded once, not assumed from reading the markup.
13. The page passes Google's Mobile-Friendly check (or an equivalent automated mobile-usability
    check) with zero flagged issues.
14. The existing Search Console verification (tag or file, whichever mechanism is currently live)
    still verifies successfully after the redesign ships — confirmed, not assumed.
15. Zero requests to any third-party analytics/tracking endpoint fire when loading the page,
    verified via a network-request capture — the Search Console verification tag itself makes no
    outbound request and doesn't count against this.
16. The page's body copy contains at least two of the realistic long-tail phrases named in FR-291,
    used in genuine sentences (not a bullet-stuffed keyword list), and contains no sentence claiming
    or implying a "first"/"best"/"#1" search ranking or an explicit competitor-beating comparison.
17. At least one real captured app screenshot (not a mockup/fabricated image) appears on the page,
    captured against a clean demo/fixture repository in both light and dark theme, per FR-293.
18. The root `README.md`'s existing screenshot (if outdated/stale relative to the app's current
    look) is refreshed using the same real screenshot(s) captured for FR-293, so GitHub's own repo
    page and the landing page show a consistent, current product image rather than two different
    (one current, one stale) impressions of the app.

## Decisions (resolved 2026-09-14)

These were surfaced as open product decisions during scoping and confirmed directly with the user
before handoff to `impeccable`:

1. **Real app screenshots — included in scope.** At least one real screenshot ships with this item
   (FR-293, AC17) rather than being deferred to a fast-follow.
2. **Analytics — no new tracking.** Confirmed: the page adds no analytics/tracking beyond the
   existing Search Console verification (FR-290 stands as written). Search Console remains the only
   visibility into search performance.
3. **Donate/support link — kept separate.** Not folded into this item; stays its own future item per
   `ROADMAP.md`'s licensing entry, unaffected by this redesign touching the footer.
4. **Non-affiliation disclaimer — stays deferred**, per `ROADMAP.md`'s existing note (pending the
   not-yet-written root `README.md`). Unchanged by this spec.
5. **README screenshot — refresh it too (user request, mid-scoping).** The root `README.md` on
   GitHub carries its own existing screenshot, separate from the `gh-pages` landing page, and it's
   gone stale relative to the app's current look. Since FR-293 already captures new real
   screenshots for the landing page, reuse them to update `README.md`'s screenshot in the same pass
   (FR-294, AC18) rather than leaving GitHub's repo page showing an outdated image alongside a newly
   refreshed landing page.

## References

- `ROADMAP.md`'s "Landing page — premium design pass" entry — this spec's origin, including the
  2026-09-13 SEO-bundling note and the honesty caveat this spec's FR-291/292 and Non-goals preserve.
- `PRODUCT.md` — positioning, principles, and the "Evidence on Hand" section this page's content
  must stay inside (no fabricated claims beyond what's actually shipped/true).
- `DESIGN.md` — the app's existing transit-map thesis and token system; `impeccable`'s design pass
  for this page extends or deliberately departs from it (FR-271/272), doesn't silently ignore it.
- `CLAUDE.md`'s Licensing section — GPL-3.0-or-later status, the public no-reply email convention
  (FR-278), and the still-open README-disclaimer/donate-link follow-ups referenced in the open
  questions above.
- `.github/workflows/release.yml` and `ROADMAP.md`'s "Release pipeline" entry — the real download
  artifacts this page links to (FR-274/277) and the unsigned-binary disclaimer language to match.
