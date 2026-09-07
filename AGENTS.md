# GitHydra — Agent Team Manual

This is the how-to for the Claude Code subagent team set up for this project. Keep it in the repo — it's useful to you and to anyone else who ever works on GitHydra with Claude Code.

## The team

| Agent | File | Job | Model | Tools |
|---|---|---|---|---|
| product-manager | `.claude/agents/product-manager.md` | Scopes features, writes PRDs, prioritizes, decides what's in/out of v1 | sonnet | read + web only, no code |
| git-core-engineer | `.claude/agents/git-core-engineer.md` | Owns all actual git logic: staging, diff, merge/rebase, conflicts, edge cases | opus | full read/write/bash |
| ui-graphics | `.claude/agents/ui-graphics.md` | Frontend, commit graph rendering, theming, the app shell | sonnet | full read/write/bash |
| security-reviewer | `.claude/agents/security-reviewer.md` | Read-only audit of anything touching credentials, shell commands, file paths | opus | read-only |
| test-agent | `.claude/agents/test-agent.md` | Integration/e2e tests, full suite runs, final acceptance-criteria gate | sonnet | full read/write/bash |

Plus one skill: `.claude/skills/oss-licensing-guardrails/SKILL.md` — licensing, naming, and trademark guardrails for going open source (not legal advice, see the file itself for the caveat).

Plus a situational skill set, not part of the default pipeline — four subagents from the `impeccable` plugin, called only when a feature actually warrants them (see "When to reach for the impeccable skill set" below):

| Agent | Job |
|---|---|
| `impeccable:impeccable-finish-reviewer` | Critiques a shipped UI/UX change against `DESIGN.md` and the spec, returning an ordered list of material fixes — not a rubber stamp. |
| `impeccable:impeccable-documenter` | Records the post-fix result in `DESIGN.md` from the shipped code, not from the builder's own account of it. |
| `impeccable:impeccable-asset-producer` | Produces clean, reusable raster/icon assets (a new SVG for the icon vocabulary, app-icon variants, illustration work) from an approved visual reference, without redesigning the direction on its own authority. |
| `impeccable:impeccable-manual-edit-applier` | Applies a batch of live manual copy-edits (made through Impeccable's own live-edit tooling, if that's ever used against a GitHydra surface) back into source, returning a canonical record of what was applied. |

When finish-reviewer and documenter are both used, review-with-fixes always comes before documentation, so what gets recorded is what actually shipped, not a pre-fix draft.

git-core-engineer and security-reviewer are on Opus on purpose — they're the two roles where a wrong answer either loses someone's work or ships a real vulnerability. That costs more per call than Sonnet. If that's a problem for your budget, the cheapest fix is to lower `model: opus` to `model: sonnet` in those two files — not to skip using them.

## How to actually use it

Open the GitHydra folder in VS Code, open the integrated terminal, run `claude`. A few basics:

- `/agents` — lists your subagents. Run this once after any change to `.claude/agents/` to confirm Claude Code picked it up.
- Auto-delegation: you don't have to manually pick an agent most of the time. Claude reads each agent's `description` field and routes the task there itself. That's why every description here starts with "Use PROACTIVELY..." — it's a documented pattern for encouraging Claude to delegate on its own rather than staying in the main conversation.
- Forcing a specific agent: just say it plainly, e.g. "have the product-manager agent write the spec for X" or "get git-core-engineer to implement Y." Useful when you want a specific perspective even if the task is ambiguous.
- Invoking the skill: mention what you're deciding (a project name, a README disclaimer, which license to use) and Claude will pull in `oss-licensing-guardrails` on its own, or ask for it directly: "check this against the licensing skill."

## The workflow for building a feature

Feed the agents in order, so each one has what it needs from the last:

1. **product-manager** writes the spec (Problem / Target user / Must-have behavior / Non-goals / Acceptance criteria).
2. **git-core-engineer** and **ui-graphics** build against that spec. If the feature is mostly UI over an existing git operation, ui-graphics can go first; if it needs new git logic, git-core-engineer goes first and ui-graphics builds against what it returns. They don't need to run literally in parallel — sequencing avoids two agents editing overlapping files at once.
3. **security-reviewer** audits anything that landed, especially if it touches credentials, shelled-out commands, or file paths. This should happen before you consider a feature mergeable, not just before a release.
4. **test-agent** verifies against the PM's acceptance criteria, and — for anything with a UI — actually launches the app rather than trusting `npm test`/`npm run build` alone. On the commit graph feature, a real launch caught a packaging bug (the app didn't run at all) that a fully green test suite and clean build had both missed. Treat an unmet criterion as blocking, not a suggestion.
5. **Before calling any of this done, the orchestrating Claude session (you, running this workflow — not another subagent) personally spot-checks a sample of what steps 2–4 claimed**: read an actual diff, re-run a test yourself, grep for a cited file:line, don't just relay a summary. This is not optional and it is not delegable to yet another agent — compare-commits shipped without a `DESIGN.md` entry and with a raw-glyph icon inconsistency that four separate subagents' own summaries never surfaced, and later, a recommended one-line fix would have shipped two broken test assertions if it had been applied and reported done without actually re-running the suite. Then **state a short, honest self-rating of the verification you just did**: was it proportionate to this change's size and risk, did it actually catch something or just confirm the obvious, would a lighter or heavier pass have served better. Say this plainly, even when the answer is "this was probably more than the change needed" — the point is keeping the pipeline's weight calibrated by evidence over time, not defaulting to maximum scrutiny on everything or quietly skipping it on the next feature.
6. **Always build on a feature branch, never directly against `main`** — open the branch before an implementation subagent starts, land the work as its own small commit (or small set of commits) on that branch, and merge to `main` only after steps 3–5 are clean. This is a hard rule, not a default: on 2026-09-07 an implementation subagent's own sandbox/checkpoint layer committed mid-run directly onto `main` (placeholder authorship, a throwaway message) before review had even happened — working on a branch the whole time would have kept that contained and out of `main`'s history regardless of what triggered it. Prefer dispatching implementation subagents into an isolated git worktree (one per background agent run, via the Agent tool's `isolation: "worktree"` option) over a bare feature-branch checkout in the main working directory — it keeps a failed/rejected attempt, *and* anything an agent's own tooling does outside its visible tool calls, from ever touching `main`. Findings from steps 3–5 often mean one more round through step 2 before anything merges — that's normal, not a failure. **Push order, per the user's standing instruction:** push the feature/fix branch to `origin` first (so it exists on GitHub even before it lands on `main`), then merge to `main` locally and push `main` too — never merge-and-push `main` directly without the branch having been pushed on its own first.
7. **Log the result in `process-metrics.local.md`** (repo root, gitignored — a personal record, not project documentation, so it stays out of the public history): how many real issues steps 3–5 (and your own step-5 spot-check) actually caught, and roughly how much time the review/fix cycle added versus the initial build. Reviewed together every 10 entries to check the pipeline's weight is still earning its cost, not assumed forever from two early examples. If the file doesn't exist yet, create it — see its own header for the exact format two prior entries already established.

## When to reach for the impeccable skill set

These four are real, proven-useful tools (see the compare-commits history in `DESIGN.md`'s own component-language entry) — but none of them are a default step on every feature. They're called on judgment, per-agent, when a feature actually warrants that specific kind of help:

- **`impeccable-finish-reviewer` + `impeccable-documenter`** (used together, review before documentation) — for what counts as "a big UI update" worth the pair: introduces a new persistent UI surface or component (a new panel, a new modal, a new graph-chrome element) rather than a small tweak to an existing one; deliberately deviates from an established `DESIGN.md` convention and that deviation needs a second opinion before it sets a precedent; or the user asks for a design pass directly. For a small, low-risk UI change (copy text, spacing, a disabled-state tooltip), step 5's personal spot-check is very likely enough on its own — running the full pass on every change is process weight without proportionate value.
- **`impeccable-asset-producer`** — when a big UI update needs a genuinely new visual asset, not just a class-name/layout change: a new icon added to the shared `Icon.tsx` vocabulary (the right fix for the Swap-glyph situation, if a second caller for that affordance ever shows up — see `DESIGN.md`'s note), a new app-icon variant, or illustration/empty-state artwork. Not needed for a feature that only rearranges or restyles assets that already exist.
- **`impeccable-manual-edit-applier`** — only relevant if a GitHydra surface is ever actually edited through Impeccable's own live-edit tooling (a human tweaking a live preview rather than an agent writing code directly). Not applicable to this project's normal workflow today — noted here so it isn't forgotten if that tooling ever gets used against GitHydra specifically, not because it's expected to come up soon.

When genuinely unsure which of these a feature calls for, say so and ask, rather than silently defaulting to either "run everything" or "run nothing."

## Where things stand

See `CLAUDE.md`'s Status section for what's shipped, in progress, and next. `PRODUCT.md` and `DESIGN.md` exist at the repo root (via the `impeccable` skill); read those before starting UI work instead of re-deriving product truth or the visual system.

The full pipeline (steps 1–4 above) has caught a real bug or security issue at step 3 or 4 on every feature run through it so far, including UI-only polish passes — a fully green test suite and clean build have never been sufficient signal on their own. Treat steps 3–5 as load-bearing, not a formality.

## Recommended plugins & MCP servers

A researched pass turned up a few tools worth adding. Confidence varies — the first two are set up already (one working, one needs a fix); sanity-check the rest before you install them.

**Installed:**
- **Playwright MCP** — connected (`claude mcp list` shows it healthy as of the stage/unstage + diff feature). Lets ui-graphics and test-agent actually open the running app, click through it, and take screenshots instead of guessing whether UI code works.
- **Semgrep MCP** — configured but currently failing to connect (`claude mcp list` shows `CONNECTION_CLOSED`). It was meant to give security-reviewer automated static-analysis scanning (OWASP-style patterns, injection risks, credential leaks) on top of manual reading; until it's reconnected, security-reviewer is still doing everything by hand — which has been enough to catch real critical issues (see "Where things stand" above), but is more effort per review than it needs to be. Worth debugging before the next feature: confirm `uv`/`uvx` (astral.sh/uv) is on PATH, then `claude mcp add semgrep -- uvx semgrep-mcp` again.

**Worth checking before you rely on them** (found during research, but the exact install command wasn't independently verifiable — check the tool's own current docs first):
- **Figma's Dev Mode MCP server**, if you end up designing in Figma before implementing — Figma exposes this from the desktop app itself rather than a simple install command; check Figma's own documentation for the current setup steps.
- **shadcn/ui's MCP registry**, if you adopt shadcn for React components — check `ui.shadcn.com/docs/mcp` for the current command, since component-tooling CLIs change their setup steps often.

**Not recommended:** nothing for product-manager or git-core-engineer — WebSearch/WebFetch already cover the PM's job, and git-core-engineer's work is pure logic with no external service to connect to. After adding any MCP server, run `claude mcp list` to confirm it connected, and restart your `claude` session to pick it up.

## Credits

The five agents above started from project-specific drafts, then were revised using structural patterns and phrasing borrowed from two MIT-licensed community collections of Claude Code subagents: [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) and [wshobson/agents](https://github.com/wshobson/agents). Worth a look if you want more agent ideas later — there are far more roles in there than we needed here.
