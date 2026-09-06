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

Plus two subagents from the `impeccable` plugin, used as formal workflow steps (see steps 3–4 below): `impeccable:impeccable-finish-reviewer` — critiques a shipped UI/UX change against `DESIGN.md` and the spec, returning material fixes, before anything is considered finished; `impeccable:impeccable-documenter` — records the post-fix result in `DESIGN.md` from the shipped code, not from the builder's own account of it. Review-with-fixes always comes before documentation, so what gets recorded is what actually shipped, not a pre-fix draft.

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
3. **For anything with a UI-visible change, `impeccable:impeccable-finish-reviewer` critiques the shipped UI/UX** against `DESIGN.md`'s established system and the spec's own UX intent, returning an ordered list of material fixes — not a rubber stamp, and not just a record of what shipped. (Its own description assumes a formal Impeccable pipeline artifact — an "approved comp," a "chosen world" — that GitHydra's incremental feature work doesn't produce per-feature; `DESIGN.md` stands in as that direction/quality bar instead. Noting the adaptation rather than assuming it's a perfect fit.) Real fixes go back through step 2 before moving on — this step has teeth, it isn't a formality.
4. **Once fixes land, `impeccable:impeccable-documenter` records the *finished* state in `DESIGN.md`** — from the actually-shipped code, post-fixes, not from ui-graphics's own summary of its intentions and not from the pre-fix draft. This pairing (critique-with-fixes, then document-what's-actually-true) replaces a habit that used to be the only thing keeping `DESIGN.md` current: compare-commits shipped without an entry at all until a personal, from-scratch review caught both the missing section and a real inconsistency (a raw Unicode glyph where the icon vocabulary calls for a real SVG) that the builder's own summary hadn't surfaced — and that a review step would have caught before merge, not after.
5. **security-reviewer** audits anything that landed, especially if it touches credentials, shelled-out commands, or file paths. This should happen before you consider a feature mergeable, not just before a release.
6. **test-agent** verifies against the PM's acceptance criteria, and — for anything with a UI — actually launches the app rather than trusting `npm test`/`npm run build` alone. On the commit graph feature, a real launch caught a packaging bug (the app didn't run at all) that a fully green test suite and clean build had both missed. Treat an unmet criterion as blocking, not a suggestion.
7. Findings from steps 3–6 often mean one more round through step 2 before anything merges — that's normal, not a failure. Once clean, merge and commit as its own commit (or its own small set of commits) before starting the next feature, so history stays legible feature-by-feature. Building a whole feature in an isolated git worktree (one per background agent run) and merging only once it's reviewed keeps a failed/rejected attempt from ever touching the main branch.

## Where things stand

See `CLAUDE.md`'s Status section for what's shipped, in progress, and next. `PRODUCT.md` and `DESIGN.md` exist at the repo root (via the `impeccable` skill); read those before starting UI work instead of re-deriving product truth or the visual system.

The full pipeline (steps 1–5 above) has caught a real bug or security issue at step 3 or 4 on every feature run through it so far, including UI-only polish passes — a fully green test suite and clean build have never been sufficient signal on their own. Treat steps 3–4 as load-bearing, not a formality.

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
