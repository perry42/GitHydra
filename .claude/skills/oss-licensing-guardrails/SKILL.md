---
description: Use when making licensing, naming, branding, or contributor-related decisions for the open-source git client project — choosing an OSS license, avoiding trademark/branding issues with existing products like GitKraken, writing a NOTICE/disclaimer, or setting up contributor agreements. This is informational guidance, not legal advice, and cannot guarantee freedom from lawsuits.
---

# OSS Licensing & IP Guardrails

This is a checklist, not a lawyer. It catches the common, avoidable mistakes open-source projects make. It cannot guarantee freedom from lawsuits, and nothing here substitutes for a real intellectual-property attorney once the project has real users, contributors, or funding.

## Naming and branding
- Do not name the project "GitKraken" or anything confusingly similar ("GitKraken Free", "GitKrakenX", etc.). Trademark risk is driven by name/logo confusion far more than by code or feature similarity — pick your own original name.
- Do not reuse GitKraken's logo, icon set, or color identity as your brand. General UI patterns (a commit graph, a three-pane layout, drag-to-rebase) are common across the whole category of git GUIs and are not what trademark law protects — a copied brand identity is.
- Add a plain disclaimer in the README: "Not affiliated with, endorsed by, or sponsored by Axosoft or GitKraken." This costs nothing and forecloses confusion claims proactively.

## Choosing a license
- MIT or Apache-2.0: maximum adoption, fully permissive, businesses can embed it freely. Apache-2.0 also includes an explicit patent grant, which adds a layer of protection if patent risk worries you.
- GPL-3.0 or AGPL-3.0: copyleft — anyone who distributes a modified version must open-source their changes too (AGPL extends this to network/SaaS use). Pick one of these if guaranteeing the project and all forks stay open forever matters more to you than maximizing adoption.
- Whichever you pick: add a LICENSE file at the repo root and an SPDX header in source files. This is what actually makes the license enforceable and unambiguous for contributors and downstream users — an unlicensed public repo is legally murkier than people assume.

## Contributor safety
- Add a CONTRIBUTING.md that requires a Developer Certificate of Origin sign-off ("Signed-off-by:" in commit messages) rather than a full CLA. It's lighter-weight for a hobby project and still establishes that contributors have the right to submit what they're submitting.
- Never merge a contribution that itself contains copy-pasted GitKraken (or any other proprietary) source code. This is the single most common way an otherwise-clean open-source project inherits real legal risk.

## What this skill cannot do
- It cannot confirm the project doesn't infringe some specific patent — that needs a real attorney doing a landscape review.
- It cannot make the project "free of any lawsuit." No document can. The steps above (original branding, clean-room implementation, a clear license, DCO sign-off) bring the realistic risk for a hobby/OSS project down to roughly the baseline for any independent software project — not to zero.
- If the project starts generating real revenue, gets significant adoption, or Axosoft (GitKraken's owner) ever sends any communication at all — stop and get an actual lawyer before responding to anything.
