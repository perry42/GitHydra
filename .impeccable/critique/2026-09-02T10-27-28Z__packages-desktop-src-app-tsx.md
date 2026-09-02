---
target: packages/desktop screenshot vs GitKraken reference
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-09-02T10-27-28Z
slug: packages-desktop-src-app-tsx
---
Method: dual-agent (A: a38f390f6e45f1b1d · B: a92f02cda70e189b1)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Solid — named loading states, live count badges |
| 2 | Match System / Real World | 3 | Git-native vocabulary is correct for this audience |
| 3 | User Control and Freedom | 3 | Explicit close/collapse controls throughout |
| 4 | Consistency and Standards | 3 | Consistent styling, but doesn't distinguish action roles |
| 5 | Error Prevention | 3 | Not exercised in the shot; scored on visible pattern |
| 6 | Recognition Rather Than Recall | 2 | Commit subjects and row header truncated mid-word |
| 7 | Flexibility and Efficiency | 2 | No visible keyboard-shortcut affordance anywhere |
| 8 | Aesthetic and Minimalist Design | 2 | Restraint without hierarchy |
| 9 | Error Recovery | 3 | Not exercised; scored on the pattern family that exists |
| 10 | Help and Documentation | 1 | Zero discoverability aids |
| Total | | 25/40 | Acceptable |

Design specificity: graph is authored/specific; surrounding chrome reads as unstyled scaffolding.
Detector: clean ([] across plain/layout/type scoped runs, verified not suppression-related).
Browser overlay: unavailable, no browser-automation tool reachable.

Priority issues:
P0 toolbar no visual hierarchy (six identical gray buttons) -> /impeccable layout
P1 page/surface tokens nearly invisible (#f9f9f7 vs #fcfcfb) -> /impeccable layout
P1 commit message column truncates mid-word -> /impeccable layout
P2 zero iconography outside graph -> /impeccable bolder
P3 dead whitespace under toolbar -> /impeccable layout

Persona red flags: Alex (truncated subjects, no shortcuts), Sam (hue-only active-state signal, light-mode contrast WARN).
