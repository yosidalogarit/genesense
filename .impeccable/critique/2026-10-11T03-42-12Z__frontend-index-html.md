---
target_identity: "file:F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
target_fingerprint: "sha256:331393e97e7e03490905badc61f23cd2919ef8e0fd61081fff8a091f0b90dac4"
target_path: "F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
timestamp: 2026-10-11T03-42-12Z
slug: frontend-index-html
---
---
target: "whole app after round 8 (PR #33, commit 39b7ff8)"
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
---
Method: design review only (A), fresh reviewer.

## Design Health Score: 27/40 (Acceptable, top of band)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 2 | Hôm nay "Chỉ số gần nhất" shows only the newest reading; a heart-rate-only reading turns BP, SpO2, glucose into "Chưa đo" |
| 2 | Real world match | 3 | "138,5/86" half-mmHg average; bare sub-scores 87 / 48 / 0 |
| 3 | User control | 3 | Back closes report and dialog; tick undo not hinted |
| 4 | Consistency | 2 | Thuốc / Thuốc và giấy tờ / Giấy tờ; dashed diastolic vs dashed threshold key |
| 5 | Error prevention | 3 | Range checks, 7-day cap |
| 6 | Recognition | 3 | Thuốc can reopen on empty Giấy tờ đã lưu |
| 7 | Flexibility | 2 | Desktop has no persistent nav |
| 8 | Minimalist design | 3 | Di truyền ~4200px on phones |
| 9 | Error recovery | 3 | Specific Vietnamese hints |
| 10 | Help | 3 | Score panel opens below the fold |

## Priority issues
- [P1] Hôm nay latest values per metric, not per reading.
- [P2] Dashed diastolic line runs over the dashed 90 threshold.
- [P2] Thuốc reopens on the empty documents sub-tab.
- [P2] Desktop wayfinding all behind Menu (owner decision).
- [P3] Sub-scores without scale.
