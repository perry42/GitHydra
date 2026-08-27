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

git-core-engineer and security-reviewer are on Opus on purpose — they're the two roles where a wrong answer either loses someone's work or ships a real vulnerability. That costs more per call than Sonnet. If that's a problem for your budget, the cheapest fix is to lower `model: opus` to `model: sonnet` in those two files — not to skip using them.

## How to actually use it

Open the GitHydra folder in VS Code, open the integrated terminal, run `claude`. A few basics:

- `/agents` — lists your subagents. Run this once after any change to `.claude/agents/` to confirm Claude Code picked it up.
- Auto-delegation: you don't have to manually pick an agent most of the time. Claude reads each agent's `description` field and routes the task there itself. That's why every description here starts with "Use PROACTIVELY..." — it's a documented pattern for encouraging Claude to delegate on its own rather than staying in the main conversation.
- Forcing a specific agent: just say it plainly, e.g. "have the product-manager agent write the spec for X" or "get git-core-engineer to implement Y." Useful when you want a specific perspective even if the task is ambiguous.
- Invoking the skill: mention what you're deciding (a project name, a README disclaimer, which license to use) and Claude will pull in `oss-licensing-guardrails` on its own, or ask for it directly: "check this against the licensing skill."

## The workflow for building a feature

Don't run all five agents at once on day one — feed them in order, so each one has what it needs from the last:

1. **product-manager** writes the spec (Problem / Target user / Must-have behavior / Non-goals / Acceptance criteria).
2. **git-core-engineer** and **ui-graphics** build against that spec. If the feature is mostly UI over an existing git operation, ui-graphics can go first; if it needs new git logic, git-core-engineer goes first and ui-graphics builds against what it returns. They don't need to run literally in parallel — sequencing avoids two agents editing overlapping files at once.
3. **security-reviewer** audits anything that landed, especially if it touches credentials, shelled-out commands, or file paths. This should happen before you consider a feature mergeable, not just before a release.
4. **test-agent** writes integration/e2e tests, runs the full suite, and checks the result against the PM's original acceptance criteria. This is your last gate — if it says something's unmet, treat that as blocking, not a suggestion.

## A couple of things worth setting up next

- **A `CLAUDE.md` at the repo root.** Claude Code reads this automatically every session. Once you've made real decisions (Electron vs. Tauri, which git library or CLI wrapper, folder layout), put them there so you're not re-explaining architecture to every agent, every session.
- **Keep this file updated.** If you add a sixth agent later (a build/release agent for cross-platform packaging is the next likely one, once there's something to package), add it to the table above.

## Getting started (Day 0)

This is the actual sequence for a brand-new project like this one, right now:

1. Open the GitHydra folder in VS Code, open the integrated terminal, run `claude`.
2. Ask product-manager for the starting point: type "Using the product-manager agent, write the v1 roadmap — the prioritized feature list and the non-negotiable product principles for GitHydra." Claude should auto-route this to product-manager because of its description; if it doesn't, say "have the product-manager agent do this" explicitly.
3. Read what it gives you, push back in conversation if something's off — this is the cheapest point to change direction.
4. `CLAUDE.md` at the project root already has a starter version (product principles filled in, tech stack marked TBD). Once you decide Electron vs. Tauri, your frontend framework, and your git integration approach, say "update CLAUDE.md with: we're using X, Y, Z" and Claude will fill those sections in. Every subagent reads this file automatically, so decisions only need to be written down once.
5. Get your first real spec: "Have product-manager write the PRD for the commit graph view — that's our first feature."
6. Build it: "Have git-core-engineer implement the commit history reading logic per that spec," then similarly for ui-graphics on the rendering side.
7. From here it's the workflow below on repeat, one feature at a time.

## Recommended plugins & MCP servers

A researched pass turned up a few tools worth adding. Confidence varies — install the first two without much worry, sanity-check the rest before you run them.

**High confidence:**
- **Playwright MCP** — lets ui-graphics and test-agent actually open the running app, click through it, and take screenshots instead of guessing whether UI code works. Useful for both: ui-graphics for visual verification, test-agent for real end-to-end testing.
  ```
  claude mcp add playwright -- npx -y @playwright/mcp@latest
  ```
- **Semgrep MCP** — gives security-reviewer real automated static-analysis scanning (OWASP-style patterns, injection risks, credential leaks) instead of relying purely on manual reading.
  ```
  claude mcp add semgrep -- uvx semgrep-mcp
  ```
  (Requires the `uv` Python package manager — see astral.sh/uv if you don't have it.)

**Worth checking before you rely on them** (found during research, but the exact install command wasn't independently verifiable — check the tool's own current docs first):
- **Figma's Dev Mode MCP server**, if you end up designing in Figma before implementing — Figma exposes this from the desktop app itself rather than a simple install command; check Figma's own documentation for the current setup steps.
- **shadcn/ui's MCP registry**, if you adopt shadcn for React components — check `ui.shadcn.com/docs/mcp` for the current command, since component-tooling CLIs change their setup steps often.

**Not recommended:** nothing for product-manager or git-core-engineer — WebSearch/WebFetch already cover the PM's job, and git-core-engineer's work is pure logic with no external service to connect to. After adding any MCP server, run `claude mcp list` to confirm it connected, and restart your `claude` session to pick it up.

## Credits

The five agents above started from project-specific drafts, then were revised using structural patterns and phrasing borrowed from two MIT-licensed community collections of Claude Code subagents: [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) and [wshobson/agents](https://github.com/wshobson/agents). Worth a look if you want more agent ideas later — there are far more roles in there than we needed here.
