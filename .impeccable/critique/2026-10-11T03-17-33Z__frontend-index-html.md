---
target_identity: "file:F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
target_fingerprint: "sha256:c343f5fde82ba89ba71e3bae2a322e1859c00fe95baeadd5c345e918c3692a73"
target_path: "F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
timestamp: 2026-10-11T03-17-33Z
slug: frontend-index-html
---
---
target: "whole app after round 7 (PR #33, commit e76e931)"
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
---
Method: design review only (A); detector B from the run of the same day still applies (no markup patterns changed).

## Design Health Score: 27/40 (Acceptable, top of band). A fresh reviewer; the run before scored 29.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 3 | "Giờ khác…" opened its field under the sticky save bar on phones (fixed in b5dfe7f) |
| 2 | Real world match | 3 | "Phân nhóm theo giờ ghi nhận", "Tối đa 30 lần đo gần nhất" read like jargon |
| 3 | User control | 2 | Back does not close the report; Back or Esc in the measuring dialog drops typed values |
| 4 | Consistency | 3 | BP chart uses dashed lines, others a pale band; "Lập phiếu  tổng hợp" double gap |
| 5 | Error prevention | 3 | Hints only after Lưu |
| 6 | Recognition | 3 | Chart key below the fourth chart; Giấy tờ hidden under "Thuốc" |
| 7 | Flexibility | 2 | No faster path to log one value |
| 8 | Minimalist design | 3 | Hồ sơ has 8 sections; Lịch sử repeats tips plus a coach line |
| 9 | Error recovery | 3 | Good Vietnamese amber hints |
| 10 | Help | 2 | Nothing explains the zone bars on Hôm nay or how to measure |

## Priority issues
- [P1] Back does not close the report or dialogs.
- [P2] "Giờ khác…" field under the save bar (fixed).
- [P2] Chart encoding: two zone styles, systolic/diastolic only by shade, key after the last chart.
- [P2] Hồ sơ catch-all; share-medicines checkbox reads as a step after the code.
- [P3] Giấy tờ hard to find; subtitle describes documents on the schedule sub-tab.
