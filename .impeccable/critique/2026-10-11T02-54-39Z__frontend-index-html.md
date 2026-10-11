---
target_identity: "file:F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
target_fingerprint: "sha256:74420c39efef54ee3e4b0782dd663933739c68ba93920e9a673fc50b0e17a15e"
target_path: "F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
timestamp: 2026-10-11T02-54-39Z
slug: frontend-index-html
---
---
target: "whole app after polish rounds 2 to 6 (PR #33)"
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
---
Method: dual-agent, one after the other on one Playwright browser (A: design review · B: detector and browser evidence)

Target: whole app on branch feat/polish-round-2 (cache genesense-v59), demo account with family history, 7 readings over 7 days and 3 medicines, 1100x900 and 375x812.

## Design Health Score: 29/40 (Good)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 3 | "Chi tiết lần đo" shows "Cần chú ý" without the per-value marks the list card has |
| 2 | Real world match | 3 | Blood sugar has no fasting / after-meal context; one range for all readings |
| 3 | User control | 3 | Evening dose can be ticked in the morning |
| 4 | Consistency | 3 | Level words on Di truyền are 27px on phones, 20px on desktop (cascade bug, styles.css:710 over :243) |
| 5 | Error prevention | 3 | Ticking a dose before its time of day |
| 6 | Recognition | 3 | Chart key sits below all four charts; heart-rate chart has no dashed line the key mentions |
| 7 | Flexibility | 2 | A reading is always stamped "now"; no back-dating |
| 8 | Minimalist design | 3 | Phone pages long: Lịch sử ~4000px, Di truyền ~4350px |
| 9 | Error recovery | 3 | Field hint appears only after "Lưu chỉ số", not on leaving the field |
| 10 | Help | 3 | No "how to measure" at the point of entry |

## Priority issues
- [P1] Level words shout on phones: `.status-word` 1.5rem in the phone media query overrides `.risk-level`. Fix: keep `.risk-level` at 1.11rem there.
- [P2] Doses can be ticked before their time of day (Metformin Tối at 09:40).
- [P2] Blood sugar has no meal context.
- [P2] Thuốc action row ragged on phones (solid, outline, bare link on two lines).
- [P3] Lịch sử repeats Hôm nay's advice cards and a filler line.

## Detector (B)
5 findings in index.html, all judged false positives or soft: broken-image x2 (JS-filled img in closed dialog / hidden preview), thin-border-wide-shadow (active drawer link, styles.css:137), dark-glow and radial-halo (light page misread as dark). No findings in frontend/js. Overlay skipped (CSP). Text below 16px: 0. Small targets: only raw checkboxes inside 44px labels. No uppercase tracking, no horizontal overflow, no console errors.

## Owner decisions the reviewer disagrees with (not scored)
Desktop side menu behind "☰ Menu" at 1100px; Di truyền as the second card on Hồ sơ on phones.
