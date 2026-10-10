---
target: "whole app after PR #25"
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
target_fingerprint: "sha256:b516746561e64edeae1301308450e047722f2ea52a1bff87dabf22e5df450ae5"
target_path: "F:\\CLAUDE CODE\\GeneSense-share\\frontend\\index.html"
timestamp: 2026-10-10T10-17-34Z
slug: frontend-index-html
---
Method: dual-agent (A: design review sub-agent · B: detector and browser evidence sub-agent)

Target: whole app after PR #25 (the friend's redesign), frontend/index.html, demo account with family history, 22 readings and 3 medicines, 1100x900 and 375x812.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | No phone-bar item is highlighted while on Di truyền |
| 2 | Match System / Real World | 3 | Blunt "Béo phì" label; a mouse and arrow-key hint shown on phones |
| 3 | User Control and Freedom | 2 | Report "Quay lại" lands on Lịch sử đo when opened from Hôm nay; no way back from Di truyền on phones |
| 4 | Consistency and Standards | 2 | One feature has three names (Di truyền / Tiền sử gia đình / Di truyền & tiền sử gia đình); "Đã uống" flips to "Đã ghi nhận"; "Cần chú ý" vs "Cần theo dõi" |
| 5 | Error Prevention | 3 | Ranges and review-before-save work |
| 6 | Recognition Rather Than Recall | 2 | On desktop the logo is the only way to open navigation, with no menu icon or label |
| 7 | Flexibility and Efficiency | 3 | Several paths; keyboard on charts |
| 8 | Aesthetic and Minimalist Design | 2 | Hôm nay repeats actions; decorative eyebrow, sun badge, glow blob and slogan |
| 9 | Error Recovery | 2 | A stale red "enter at least one value" stays after typing; English browser range bubble |
| 10 | Help and Documentation | 3 | In-context "Cách tính kết quả" and "Cách đọc mức nguy cơ" |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict

Split. The product-native parts are authored: Di truyền levels with shape, word and meter; the monochrome doctor's report; shape-coded reading cards; the four-times-of-day schedule. The redesign's layer (eyebrow "SỨC KHỎE CỦA BẠN", sun badge, six pastel action tiles, KPI cards with range bars, drawer glow and slogan) is generic wellness-app template work.

Detector: 8 warnings in frontend/index.html. Real: kicker-above-heading x2 (login "CHĂM SÓC SỨC KHỎE TẠI NHÀ", Hôm nay "SỨC KHỎE CỦA BẠN"), wide-tracking and tiny-text on `.eyebrow`. False positives: broken-image x2 (src set at runtime), dark-glow and radial-halo (light page, ordinary elevation). The in-page overlay was refused by the page's Content-Security-Policy.

Browser measurements: text under 16px on every screen (worst Hôm nay at 375px: 23 of 64 elements; smallest the eyebrow at 12.96px, "An toàn" tags at 13.5px, units and phone-bar labels at 14.04px, "Đã uống" at 15.12px). No horizontal overflow, no console errors. The "Hiệu ứng kính mờ" row was 29px tall (fixed in PR #27).

## Priority Issues

- **[P1] Navigation hidden on desktop, Di truyền buried on phones.** The logo is the only nav at 1100px; on phones Di truyền is a small card about 1257px down Hồ sơ with no active bar item and no back link. Fix: visible menu label or permanent rail on wide screens; move the Di truyền link to the top of Hồ sơ, keep Hồ sơ active, add a back link. Command: layout, then adapt.
- **[P1] Hôm nay overloaded and repetitive.** "Bạn muốn làm gì?" with six tiles repeats Ghi chỉ số, the medicine link and Xem lịch sử, against the owner's "no new blocks on Hôm nay" rule; the phone page is 2618px tall. Fix: remove the grid. Command: distill.
- **[P1] Text under 16px and an uppercase eyebrow**, against the owner's 16px minimum and the low-vision brief. Fix: 16px floor on tags, units, phone-bar labels, tiles and the tick label; delete the eyebrows. Command: typeset.
- **[P2] Measuring dialog errors contradict themselves.** Stale red message after a value is typed; English native range bubble; red used for a non-danger error. Fix: clear on input, Vietnamese range text, neutral or amber tone. Command: harden.
- **[P2] 7-day blood-pressure average reads as missing data.** "Chưa có số đo" for both morning and evening above a chart of 22 readings. Fix: hide when empty or say why. Command: clarify.

## Persona Red Flags

- Older low-vision user (68): cannot read 13.5px tags or 14px bar labels; translucent phone bar lowers contrast over moving content; does not find the menu behind the logo; taps the decorative sun badge; sees "Béo phì" unexplained and an English validation bubble.
- First-timer: three names for the family feature; "Tải lại" unexplained; "Lưu chỉ số" greyed out with no reason on the Bluetooth path; an unticked "Đã uống" reads like a statement.
- Accessibility user: active menu item and focus ring look alike; the measuring dialog focuses the close button, not the first field.

## Minor Observations

SpO₂ and glucose share one icon; drawer subtitle differs from the header's; drawer slogan and glow blob; on the schedule tab the primary button is "Thêm giấy tờ", not "Thêm thuốc"; mismatched tip photos (vegetables for weight, sprinter for brisk walking); range bars return on metric cards; the URL stays #dashboard while the report is open.

## Questions to Consider

- If an older user only opens Hôm nay, what do six tiles give that one "Ghi chỉ số" button does not?
- Should Di truyền, the product's namesake, ever be more than one tap away on a phone?
- For a low-vision audience, should "Hiệu ứng kính mờ" default to off?
- With 1100px of width, why does desktop hide its navigation?
