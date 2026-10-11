# GeneSense handoff (updated 2 October 2026)

Read this before doing anything. It describes the current state only. The longer history, with the reason for each change, is on the Notion page "GeneSense: UI redesign change log and handoff (30 Sep 2026)": https://app.notion.com/p/3ebf775108a281aa8805d7a4f21b4cb9

## 1. Current state

- **Project folder:** `F:\CLAUDE CODE\GeneSense-share` (Windows 11).
- **Repository:** https://github.com/yosidalogarit/genesense (private).
- **Branch:** `master` is at `df2bbfa` (PR #31 merged). Old merged branches stay: the owner chose to keep them (3 October 2026).
- **Pull requests:** #1 to #31 are merged; #32 (phone menu icon and back link) is open. Never branch from merged feature branches, always from an up-to-date `master`.
- **Tests:** 37 backend tests pass with a plain `pytest` run.
- **Service worker cache name:** `genesense-v53` on the live site; `genesense-v54` in PR #32.
- **Design critique scores so far:** 24, 25, 27 out of 40 for the whole app; 25 out of 40 for the "Di truyền" tab alone (1 October 2026); **27 out of 40 for the medicine schedule** (2 October 2026). The findings of the last two runs were fixed afterwards, but neither critique was re-run, so there is no newer score. Reports are in `.impeccable/critique/`. A session may list a bundled `anthropic-skills:impeccable`; invoking it loads the instructions, but its script folder did not exist on disk. Run the scripts from the local copy at `F:\CLAUDE CODE\.agents\skills\impeccable` (same instructions, with the binary).
- **Hosting:** the app is **live at https://genesense-five.vercel.app** (Vercel team "GeneSense", project `genesense`, free Hobby plan) with a **Neon** PostgreSQL database (Neon project id `fragrant-glade-42196249`, branch `production`). Vercel redeploys on every push to `master`. The Vercel connector in this setup cannot read that team, so check the site over plain HTTP.
- **In progress (11 October 2026):** raising the design-review score to 30+. PRs #32 and #33 are merged and live (checked 11 October, cache `genesense-v63`). Round 10 (`feat/polish-round-10`, cache `genesense-v64`) shortens Di truyền and Hồ sơ on phones, adds help for the range bars and for measuring, and records when blood sugar was measured. Design-review scores (sub-agent A): 25 → 27 → 27 → 28 → 29 → 27 → 27/40; each fresh reviewer finds new issues, so scores move about ±2 between runs; snapshots are in `.impeccable/critique/`. Owner said no to: a "Hủy" button in the measuring dialog, blue for the "✓ Đã uống" tick, moving the medicine tick under the name on phones, latest value per card on Hôm nay, a key in each chart card, a denser side-menu panel.
- **Live 3-day cleanup verified (10 October 2026):** a trial account made on 3 October answered 401 after a new trial login ran the cleanup. The helper `.tools/cleanup_test.py` (git-ignored) can repeat it: `create`, wait 3 days, `check`.
- **Servers on this PC:** none running (checked 3 October 2026: ports 8000, 8001 and 8002 free, no Python or `cloudflared` process). A session starts the development server itself with the preview tool (`genesense`, port 8000). If port 8000 is ever taken by a server from another chat, see "The dev server's `--reload` can hang" in section 3. Start a public tunnel only when the owner asks.
- **The Notion page is up to date through PR #21.**
- **Waiting on the owner:** Vietnamese prescription samples for a second handwriting test (the first used three English samples).
- **No competition date is recorded.** The owner has not given one; ask before ordering section 6 by deadline.

## 2. What the product is

GeneSense AI Core is a web app (PWA) for chronic-disease screening and home vital-sign tracking. FastAPI backend in `backend/app/`, vanilla JavaScript frontend in `frontend/` (no build step, no framework), SQLite for the demo, Neon PostgreSQL for production. The UI is in Vietnamese.

`PRODUCT.md` in the project root is the product brief. Read it before any design work. Key points:

- **Users:** Vietnamese adults tracking their own chronic-disease risk at home, often with a family history. Many have low tech literacy; some are older with poor eyesight.
- **Stage:** competition demo. Polish and a convincing end-to-end flow matter more than launch readiness.
- **Hard constraints:** not a medical device; no diagnostic claims; nothing is shown as measured when it was not; sample readings keep their "Dữ liệu mẫu" source label; manual entry must work without Bluetooth or AI; AI features need consent; emergency vitals override the score and point to emergency services (115).
- **Accessibility:** large text, high contrast, mobile first, plain language, status never by colour alone.

## 3. How to run and test

- **Python:** `.venv` in the project root (Python 3.14). Run things with `.venv/Scripts/python`.
- **The server runs on port 8000.** The local `.env` (not in git) has `APP_ENV=development`, `APP_BASE_URL=http://localhost:8000`, `CORS_ORIGINS=http://localhost:8000,http://127.0.0.1:8000` (both addresses in the one variable), `AI_PROVIDER=google`, the model names, and **the owner's Gemini key** (`GOOGLE_AI_API_KEY`). Never print or paste that key. With it, document reading works locally and each real scan uses the owner's free quota. There is **no Google sign-in client**, locally or on the live site, so Google sign-in and AI-written advice (which needs a Google account with AI consent) cannot be tested. The app reads `.env` by itself, so no `--env-file` flag is needed.
- **Start the server:** use the repo's `.claude/launch.json`, server name `genesense` (uvicorn from `.venv`, port 8000, with `--reload`). Start the session in `F:\CLAUDE CODE\GeneSense-share`, so this file is the one the preview tool picks up. Equivalent command:
  `.venv/Scripts/python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000`
- **A second, older launch file** exists at `F:\CLAUDE CODE\.claude\launch.json` (parent folder, port 8010). It is only picked up when a session starts in the parent folder. Do not use it; with `.env` on 8000 its origin would not match.
- **Run tests:** `.venv/Scripts/python -m pytest backend/tests -q`. The log shows `AuthlibDeprecationWarning: The httpx module is deprecated`; it is harmless.
- **Database:** SQLite file `healthpredict.db` in the project root (not in git). It is not tied to a port. Extra demo accounts created while testing are harmless and can stay. The hosted site uses Neon instead; the temporary tunnel uses `public-trial.db`.
- **Demo login:** on the login screen choose "Dùng thử với hồ sơ mẫu". Each demo login creates a new account, and logging out of a demo account loses access to it for good.
- **Existing demo accounts in the local database:**
  - "Bác Hùng" (62, male, hypertension) and "Chị Lan" (caregiver linked to him), made by an earlier session. Their login cookies were expected in the Claude browser pane but **were not there on 1 October 2026** (the pane showed the login screen). Treat them as unreachable; the data is still in the database.
  - The owner's own trial account, "Phan Thiên Bảo", in the owner's Edge browser.
  - **Playwright's Edge profile holds signed-in test accounts** (cookies are per host name): at `http://127.0.0.1:8000` "Kiểm thử phiếu" (rich family history, 100 readings from manual, Bluetooth and sample sources), at `http://localhost:8000` "Kiểm thử" (every relative unknown; also a caregiver linked to "Kiểm thử phiếu"), and on the live site a trial account "Bà Kiểm Tra". Use them for read-only checks. Do not log them out and do not write test data into them. Sessions last 7 days (the two local ones expire around 8 October 2026). The live trial account's creation date is unknown; it already existed on 2 October and still answered on 3 October. A trial account older than 3 days is deleted only when someone requests a new trial account (cleanup runs then, not on a timer), so it can outlive its 3 days. When a test account is gone, make a fresh trial account.
  - **For tests that write data, use a throwaway server:** start a second server on port 8002 in the background with `APP_BASE_URL=http://localhost:8002 CORS_ORIGINS=http://localhost:8002 DATABASE_URL=sqlite+aiosqlite:///<scratchpad>/e2e.db`, create a trial account there with `fetch('/api/auth/demo')` and `PUT /api/profile` from the page, and stop the server afterwards. To test a scan without spending quota, replace `window.fetch` in the page for `/api/medical-records/analyze` with a canned answer.
- **The dev server's `--reload` can hang after a backend edit** (it logs "Reloading..." and keeps serving old code). After changing Python files, stop and start the server instead of trusting the reload. **Port 8000 may be held by a server from another chat:** the preview tool then refuses to start. List the Python processes with their command lines and start times (`Get-CimInstance Win32_Process`), compare the worker's start time with the last backend edit, and ask the owner before stopping a server that this session did not start. After killing the parent, an orphaned `spawn_main` worker can still hold the port; stop it too.
- **After any frontend change:** bump `CACHE` in `frontend/sw.js`. The server sends `Cache-Control: no-cache` for `/assets` and `/js`, so a normal refresh picks up new files. A browser that still holds files from before that header existed needs one hard refresh (Ctrl+Shift+R).
- **Content-Security-Policy (PR #16):** the page (`/`) is served with `default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` (`CONTENT_SECURITY_POLICY` in `main.py`). Consequences for frontend work:
  - **Never write `style="…"` in `index.html` or in a JS template**, no `<style>` blocks, no inline `<script>`, no `onclick=`-style handlers: the browser silently ignores them. Use a class, or set `element.style.…` from JS (allowed). The range bars do this through `placeRanges()`. A test (`test_page_sends_a_strict_content_security_policy`) fails if any of these come back.
  - A new outside resource (a CDN script, another font host, an image host, an API on another domain) needs its host added to the policy, or the browser refuses it and logs "Refused to…" in the console.
  - When testing a frontend change in Playwright, listen for `securitypolicyviolation` events or read the console; a blocked style or script does not throw.
  - The policy is sent with the page only, so the development API pages at `/docs` keep working.
  - `img-src` has no `data:` on purpose: a search of `frontend/` finds no `data:` URI (icons are inline SVG built by `icons.js`, charts are SVG built through the DOM, the manifest icon is `/assets/favicon.svg`). **Verified under the policy, locally and on the live site:** page load, the font, tip photos, range bars, charts, the report, and service worker registration, with no violation. **Not verified:** installing the app as a PWA, Safari and Firefox.
- **If the browser shows an old loading screen that never finishes** ("Đang mở không gian sức khỏe của bạn..."), the server is not running: the service worker is serving an old saved page. Start the server and refresh.
- **Before committing:** `node --check` on changed JS files and run the tests.

### Hosting and public access

- **Vercel (the stable public link).** The whole FastAPI app runs as one serverless function:
  - `api/index.py` is the entry point. It creates the tables on cold start (startup events may not run there) and refuses to start when `DATABASE_URL` is still SQLite or `SESSION_SECRET` is shorter than 32 characters.
  - `vercel.json` rewrites every path to that function. The empty `public/` folder stops Vercel from serving the repo's files as static content. `.vercelignore` keeps tests and docs out of the bundle.
  - **Root `requirements.txt` is Vercel's package list.** Vercel cannot follow `-r` includes, so it repeats `backend/requirements.txt` without pytest and uvicorn and without extras syntax (`sqlalchemy` plus `greenlet`). **Add any new runtime package to both files.**
  - On Vercel the database engine uses no connection pool (`database.py`, when `VERCEL` is set), and `APP_BASE_URL` defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL` (`config.py`).
  - Environment variables set by the owner on Vercel: `DATABASE_URL` (Neon **direct** connection string, not the pooled one), `SESSION_SECRET`, `APP_ENV=production`, `DEMO_PUBLIC=true`. Never ask for these values in chat.
  - Only the production address works; preview deployments have other host names and the host check refuses them.
  - **Checked on the live site (1 October 2026), API and browser at 375px:** trial login, onboarding with its validation, manual and sample readings, history, detail dialog, delete with confirmation, Di truyền, report, profile, sharing code, feedback, family sharing between two accounts, revoking access, the 5-wrong-codes lock; source files (`/backend/…`, `/requirements.txt`, `/api/index.py`) and the API pages (`/docs`, `/redoc`, `/openapi.json`) return 404; no JavaScript errors. **Not checked there, on purpose:** the hourly cap (proving it would use up the hour's 10 trial accounts for real visitors) and the 3-day cleanup (it needs accounts older than 3 days; none exist yet, so look after 4 October 2026). Both are covered by a backend test, and the cap was proven on a throwaway server. **Not checked there for lack of time:** the emergency flow; it is safe to test with one trial account. **Checked after PR #16:** the page sends the policy, and Hôm nay, Lịch sử đo, Di truyền and Hồ sơ load with no violation and no console error. **Checked after PR #17:** the new build is served (header account link, crop dialog, `/api/avatar` answers 401 without login); the logged-in profile-picture flow was not checked there.
  - **Speed:** the function runs in **Singapore (`"regions": ["sin1"]` in `vercel.json`)**, next to the Neon database (Singapore, ap-southeast-1, confirmed by the owner). Measured on 1 October 2026: requests with the database take about 0.2 s (trial login 0.3 s, saving a reading 0.2 s); with the function in Washington they took about 2.7 s and the app needed about 13 s to open. If the site ever feels slow again, time `/api/health` (no database) against `/api/auth/me` (database) and read the `x-vercel-id` response header, which names the function region.
  - **Only `master` deploys** (`git.deploymentEnabled` in `vercel.json`). Branch pushes create no preview: previews could not work anyway (the variables are Production-only and the host check refuses preview names). To see what Vercel did with a commit without the dashboard: `gh api repos/yosidalogarit/genesense/commits/<sha>/status` and `gh api repos/yosidalogarit/genesense/deployments`. A `Vercel: failure (GitHub couldn't verify an account for the commit)` status means the commit email is not on a GitHub account; that is why commits use the owner's GitHub email (see Working style).
  - The API pages `/docs`, `/redoc` and `/openapi.json` exist only when `APP_ENV=development`.
  - Vercel limits a request body to about 4.5 MB. The browser shrinks document photos below that before sending; only a photo the browser cannot decode goes up at its original size.
  - **AI features on the live site:** document reading is on (key set by the owner on Vercel). Google sign-in is not configured. A real scan took about 12 s on a local server; the function's time limit on Vercel was never looked up, so a timeout there would show as a plain "Chưa thể hoàn tất" error. No real scan was run on the live site by an agent; the owner scans there.
- **Trial login settings** (`config.py`, `auth.py`): local PC only by default. `DEMO_PUBLIC=true` opens it to anyone who can reach the site, with a site-wide cap of `DEMO_ACCOUNTS_PER_HOUR` (10) new trial accounts per rolling hour and deletion of trial accounts older than `DEMO_RETENTION_DAYS` (3, counted from creation) with all their data. Cleanup runs when a trial account is requested and only while the switch is on. **Do not set `DEMO_PUBLIC=true` in the main `.env`**: it would delete the local trial accounts once they are 3 days old.
- **Temporary link from this PC (Cloudflare quick tunnel):** run `.\start-public.ps1` in PowerShell from the project folder. It starts `.tools/cloudflared-windows-amd64.exe` (v2026.9.3, local only), reads the new `https://….trycloudflare.com` address from `.tools/tunnel.log`, writes `.env.public`, prints the address and runs a second server on port 8001 with its own database, `public-trial.db`. Ctrl+C stops both. The address changes on every run and the PC must stay on. From an agent session, run the script as a background PowerShell command and read the address from the first line of `.env.public`; stop that background task to end it. **A quick tunnel dies after some hours while its process keeps running:** `.tools/tunnel.log` then repeats `Unauthorized: Tunnel not found`, the old address stops answering, and the server on port 8001 still holds the code it was started with. Before trusting a running tunnel, read the end of that log; to renew, stop the `cloudflared` process and the Python process listening on 8001, then run the script again (new address). The public server reads the Gemini key from `.env`, so scans made through the link use the owner's quota. `.env.public`, `public-trial.db` and `.tools/` are git-ignored. To start only the local server for the owner's own use: `.venv\Scripts\python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000`.
- **Render was tried and dropped** because it needs a payment card. Neon's own command-line setup (`neon` npm package, Neon Auth) was not used: the app only needs the connection string.

### Tools on this PC

- **GitHub CLI:** installed and signed in as `yosidalogarit`. In Git Bash it is at `"/c/Program Files/GitHub CLI/gh.exe"`. Use it for pull requests. The GitHub MCP connector returned 404 for this private repo and the Vercel connector returned 403 for the team "GeneSense" (last tried 1 October 2026). These are permission limits of the connectors, not outages; one retry is cheap, but do not depend on them. `gh` and plain HTTP requests to the live site work.
- **Playwright MCP:** configured in `.mcp.json` in the project root (`cmd /c npx -y @playwright/mcp@latest --browser msedge`). The file is local only (listed in `.git/info/exclude`). It works (navigate, snapshot and screenshot were tested). Use its tools (names starting with `mcp__playwright__`) for screenshots; they work even when the Claude window is minimized. It writes snapshots, logs and screenshots into `.playwright-mcp/` inside the project; that folder is listed in `.git/info/exclude` and its contents can be deleted at any time.
- **Claude browser pane:** works, but screenshots time out and animations freeze when the Claude window is minimized. Fallback: DOM and geometry checks, or headless Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` against a temporary page (delete the page afterwards).
- **The `claude` terminal command is not installed** on this PC. The owner uses the desktop app.
- **PDF pages cannot be rendered here** (no `pdftoppm`), so printed layouts cannot be inspected by eye from a session.
- **Design skills:** `F:\CLAUDE CODE\.agents\skills\impeccable` (run `scripts/impeccable context` from the project folder first; a critique is two independent sub-agents, a design review and a detector scan), plus `design-taste-frontend`, `redesign-existing-projects` and `minimalist-ui` in the same skills folder. A `dataviz` skill is available for charts. With the Content-Security-Policy in place, the critique's in-page overlay (a script injected from `http://localhost:<port>`) is refused by the browser; the CLI detector still works, and the report should say the overlay was blocked.

## 4. Owner's decisions (do not reverse without asking)

### Design direction

- Professional, uncluttered, **not AI-looking**, credible as a Vietnamese public-service app. Since 10 October 2026 the visual style is the lighter, glassier one in "Design language" below; keep its restraint (no decorative extras, slogans or eyebrow labels).
- No uppercase letter-spaced labels above headings, decorative icons, slogans or "coach" copy, or em-dashes in UI text. **Glass and blur are now allowed** (owner, 10 October 2026, after the friend's redesign): the header, the side menu and the phone bar are see-through and blurred by default, and Hồ sơ has a "Hiển thị" panel with a "Hiệu ứng kính mờ" checkbox that makes them solid white (`body.no-glass`, kept per browser in `localStorage` key `genesense-glass`). The friend's redesign also brought gradients (status panel, login screen, menu icons) and hover effects; the owner has not ruled on those separately.
- Text is never smaller than 16px. Green, amber and red are only for health status and always come with a word or shape.
- Safe status wording: **"An toàn"** everywhere (status word, tags, per-value words). The owner shortened it from "Trong ngưỡng an toàn" on 2 October 2026; never "Bình thường".
- Features that are switched off (Google sign-in, document scanning) **stay visible**, reworded to "… sẽ có trong bản chính thức". Never mention "máy chủ".
- The score is hidden behind "Cách tính kết quả"; the status word is the main result.
- Numbers use the Vietnamese format: decimal comma, no space before %.
- **The owner finds the app too wordy and the home page already confusing.** New text must be short: one sentence, no explanation of how a feature works. Do not add blocks to Hôm nay; a new feature gets its own place and at most one link line there. On 2 October 2026 the owner had 24 notes and hints shortened or removed, and kept three as they were: the "Chưa rõ" hint in onboarding, the page footer, and (shortened to its first sentence only) the AI-consent line. The emergency instructions, the "not official" line on the report and the amber "Chữ viết không rõ" warning stay in full.

### Design language (the owner's choice from 10 October 2026)

The look the friend's redesign introduced (PR #24, merged through #25) is the design language from now on. New screens and changes follow it; the rules in "Design direction" above still apply on top of it. Tokens are the CSS variables at the top of `frontend/assets/styles.css`.

- **Feel:** light, airy and blue, calm rather than clinical. Pale blue page (`--bg` #f4f8ff), white panels (`--surface`) with a 1px `--line` (#dbe5f1) border, **16px corners** (`--radius`) and a soft blue-tinted shadow (`.panel`: `0 9px 24px #16345e0d`).
- **Colour:** brand blue `--blue` (#0756ce) for primary actions, links and the active menu item; text `--ink` (#10264b) and `--ink-2` (#52627a); navy (`--navy`, `--navy-2`) for strong surfaces. Green, amber and red stay reserved for health status and always come with a word or shape. Input mistakes are not danger: the measuring dialog shows them in amber, as a Vietnamese hint under the field ("▲ Số trên thường từ 50 đến 260. Hãy kiểm tra lại."), never the browser's own English bubble, and clears them as the user types (owner, 10 October 2026).
- **Glass:** the header (`.app-site-header`), the side menu (`.nav-drawer`, with `.nav-scrim` behind it) and the phone bar (`.mobile-nav`) are translucent with a backdrop blur. On by default; the "Hiệu ứng kính mờ" switch in Hồ sơ makes them solid white (`body.no-glass`).
- **Gradients:** soft, light blue gradients only, on the header, the status panel (`.status-panel`, white to #eef7ff), the login screen and the menu's icon tiles. No dark or saturated gradients, no gradient text.
- **Controls:** buttons are 52px tall with 12px corners and bold labels; the primary button is solid blue with a soft blue shadow; inputs have 12px corners; choice chips are 48px tall. Touch targets stay at least 44px.
- **Navigation:** the header button with a visible "☰ Menu" cue (on phones only the three navy lines, no box or word; owner, 10 October 2026) and the GeneSense logo opens a left side menu with an icon tile per destination (owner added the cue on 10 October 2026 so older users find it). On desktop the current page's name sits beside the Menu cue (owner, 11 October 2026). On phones a bottom bar holds Hôm nay, Lịch sử, Thuốc, Hồ sơ; Di truyền opens from a full-width "Di truyền và sơ đồ gia đình" button right after the name panel in Hồ sơ (or from the side menu), has a quiet grey back control on phones (chevron icon plus "Hồ sơ", no underline), and keeps Hồ sơ lit in the bar. Icons are the line icons from `frontend/js/icons.js`, set in rounded tiles; they lift slightly on hover or press.
- **Type:** Be Vietnam Pro, 18px base (`font-size: 112.5%`), line height 1.6. **No app text below 16px** (`.889rem`); the printed report keeps its own sizes. No uppercase letter-spaced labels: the redesign's "SỨC KHỎE CỦA BẠN" and "CHĂM SÓC SỨC KHỎE TẠI NHÀ" labels and the sun badge were removed (owner, 10 October 2026).
- **Hôm nay stays short:** status panel (status word, summary, "Ghi chỉ số", the medicine link line, "Cách tính kết quả"), latest readings, two tips. The redesign's six-tile "Bạn muốn làm gì?" grid was removed (owner, 10 October 2026) because it repeated those buttons; other places are reached from the menu.
- **Motion:** the "Motion" rules below, plus first-view animations for metric cards and charts (off under `prefers-reduced-motion`).
- **Report:** the doctor's report stays monochrome and form-like; the design language does not apply to it.
- **Charts:** the diastolic line and its key are dashed; threshold lines are thin grey dots ("Nét chấm: ngưỡng cao"); readings over a threshold are amber triangles; the key stays under the last chart (owner, 10 and 11 October 2026).
- **Phone Back:** every dialog and the doctor's report open one history entry, so Back closes the top layer (a confirmation above a dialog first) instead of leaving the page. Open dialogs only through `openDialog()` in app.js (owner, 11 October 2026).
- **Readings and doses (owner, 11 October 2026):** the measuring dialog has "Đo lúc" ("Vừa xong" or "Giờ khác…", up to 7 days back, never in the future). Ticking a dose for a later time of day asks once ("Đánh dấu liều Tối đã uống?"). Hôm nay keeps showing the newest reading only, so a reading with one value leaves the other cards "Chưa đo" (owner chose this over the latest value per card). Blood sugar has "Lúc đói / Sau ăn / Không rõ", stored as `vitals.glucose_context` and shown on Hôm nay, Lịch sử and the report; the safety ranges stay 70–180 mg/dL for every context until a clinician decides (item in CLINICAL_REVIEW_CHECKLIST.md).
- **Smaller choices (owner, 11 October 2026):** level words on Di truyền keep their desktop size on phones; on Thuốc, "Thêm thuốc" and "Chụp đơn" are two equal buttons on phones and "In lịch" sits beside "Tất cả thuốc"; on the sharing card "Cho xem cả lịch uống thuốc" comes before "Tạo mã chia sẻ" and "Xem hồ sơ của người thân" is folded until used; Lịch sử shows only the tips Hôm nay does not, without the "all fine" follow-up; part scores in "Cách tính kết quả" show "/100". On phones Di truyền lists the relatives on one line and folds "Nên làm" per card; Hồ sơ shows the facts two per row; "Góp ý" is folded on every width. Hôm nay has a one-line key above the range bars, and the measuring dialog a folded "Cách đo huyết áp đúng". The side menu keeps its see-through glass even though the blue "Ghi chỉ số" shows through (owner said no to a denser panel).

### Account header and profile picture

- The header shows a small circular profile picture next to the name; on phones only the picture. Clicking it opens Hồ sơ (the user's own, also while viewing a relative).
- The picture is the first letter of the given name by default; the user can upload a photo in Hồ sơ ("Đổi ảnh đại diện", "Xóa ảnh"). It sits inside the name panel, not in a panel of its own (the owner read a separate "Ảnh đại diện" heading as the name being replaced). Choosing a photo opens a crop dialog (drag, zoom slider, arrow keys). The browser sends only a 256px JPEG; it is stored in the `avatars` table and served by `GET /api/avatar` (own account only, not shared with caregivers).
- "Đăng xuất" is at the very bottom of Hồ sơ: an outline button in **red** (owner's explicit choice, an exception to "red is only for health status"), and it **asks for confirmation first**, with a stronger text for trial accounts. This replaces the earlier decision of no warning before a trial account logs out.

### Giấy tờ: scanned documents feed the profile

- Reader: **Gemini API, free tier** (owner's choice over on-device OCR). A key is set in the local `.env` and on Vercel (`GOOGLE_AI_API_KEY`); without one the feature shows as coming later. The consent text says the AI provider may use the content to improve its service and advises covering the name and ID numbers.
- **Models:** documents are read with **`gemini-3.1-flash-lite` first** and `gemini-3.6-flash` as the fallback (`fast_first=True` in `analyze_document`). Measured on handwritten samples: 3.6 Flash took 23 to 84 s (the app gives up at 65 s) and its free tier allows 20 requests a day; Flash Lite took 3 to 10 s and allows 500 a day (15 a minute). The owner agreed to the lighter model for prescriptions; that it applies to every document was written in PR #20 and merged without objection. AI-written advice still uses 3.6 Flash first. A used-up quota (429) goes straight to the other model; a provider outage is retried. The owner was advised not to rotate keys from several Google projects to get around the quota (against Google's terms).
- The AI returns, besides the summary, `vitals` (blood pressure, heart rate, SpO₂, glucose in mg/dL, converted by the model from mmol/L), `own_conditions` and `family_conditions`. Scope for now is hereditary and cardiovascular data only.
- Nothing enters the profile without review: the review step lists each item with a checkbox (ticked by default), editable numbers and the document date. Readings go to Lịch sử đo with source **"Từ giấy tờ"** and the document's date; diagnoses go to the profile; family history goes to Di truyền. Only items not already in the profile are offered.
- Document readings are **history**: they never set the Hôm nay status, the emergency panel, the 24-hour hold, the live score or the caregiver's list, whatever their date. They appear in the readings list, charts and report. Their details show the values, the level and a note that the data is old, with no "Gọi cấp cứu 115" button and no advice.
- The original photo is kept **on the device only** (IndexedDB `genesense-scans`, keyed by record id), shown through "Xem ảnh gốc". **"Lưu ảnh"** in that dialog downloads it as a file named `giay-to-<date>` (the document's date, or the day it was saved). The owner chose saving over a print link so that it works the same on a PC and on a phone; do not bring back a print or open-in-new-tab control without asking. It is not stored by GeneSense, not shared with caregivers, and is lost when the browser data is cleared. A trial account's scans are deleted at sign-out; an account that can sign in again keeps them.
- The browser shrinks photos to 2000px JPEG before sending (Vercel's 4.5 MB limit; this also drops camera location data). A PNG that needs no shrinking and is under 3 MB is sent untouched.
- Gemini is not told the schema's formats and length limits (`_gemini_schema` strips them), so `_medical_analysis_from_json` repairs the answer instead of failing the scan: day-first dates are converted (`_document_date`), long text, extra keys and blank rows are cut (`_clamp`). A rejected answer is logged with field names only, and an early stop is logged with Gemini's `finishReason`.
- Deleting a document from Giấy tờ does not remove the reading or the profile entries it produced. Scanning the same document twice adds its reading twice; for medicines the app asks first (see the medicine section).
- To test without a key: run a second server on another port with `GOOGLE_AI_API_KEY` set to any dummy value and stub the `/api/medical-records/analyze` response in the page. A second server needs `APP_BASE_URL`, `CORS_ORIGINS` and `DATABASE_URL` set for its port and a scratch database.
- To reproduce a failed scan: call `AIInsightService.analyze_document` on the image from a short script with `PYTHONPATH=.`; never print the key.
- Checks belong in Playwright (Edge), not in the Claude browser pane: while the pane is hidden it does not fire a dialog's `close` event and does not open new tabs, which looks like app bugs.

### Medicine schedule ("Lịch uống thuốc")

- **Goal (owner):** scan a prescription, also a handwritten one, and get a schedule an older adult can follow. Simple and easy to understand comes first.
- **Where it lives:** the tab is "Thuốc và giấy tờ" (the phone bar keeps the label "Giấy tờ"), with two sub-tabs, "Lịch uống thuốc" and "Giấy tờ đã lưu". It opens on the schedule when the account has a medicine. Hôm nay has **one link line** inside the status panel ("Hôm nay có 4 loại thuốc. Xem lịch uống thuốc"), shown only when there is a medicine to take and hidden while the emergency panel shows.
- **Four fixed times of day:** Sáng, Trưa, Chiều, Tối (owner chose these over clock times). "Khi cần" is a fifth box that excludes the four; one choice is required, in the dialog and on scanned medicines, so a medicine never lands in "Khi cần" by accident. The server enforces it too (owner asked for the simplest effective way, 3 October 2026): `MedicationInput.as_needed` is checked but not stored, and exactly one of "Khi cần" or a time of day must be chosen; a stored medicine with no time ticked is "Khi cần".
- **"Bây giờ" tag** follows Sáng before 11:00, Trưa before 14:00, Chiều before 18:00, Tối after (approved by the owner on 3 October 2026; `renderMedicines()`).
- **Same medicine scanned again:** when a ticked scanned medicine has the same name (case-insensitive) as a medicine already in the schedule and not finished, a question "Thuốc đã có trong lịch" asks "Vẫn thêm" or "Không thêm" (owner's choice of a pop-up, 3 October 2026). "Không thêm" and Esc untick the copies and save the rest. Readings from a rescanned document are still added twice.
- **"Thuốc hôm nay":** one block per time of day that has a medicine, the block for the current time tagged "Bây giờ", plus "Khi cần". A finished course drops out by itself. Under it, "Tất cả thuốc (n)" is folded; each row has one "Sửa" button, and "Xóa thuốc này" is inside the edit dialog.
- **By hand:** "Thêm thuốc" works without any scan or AI. The dialog keeps "Hủy" and "Lưu thuốc" in view on a phone and hides start date, number of days and note under "Thêm chi tiết".
- **From a scan:** the review step shows one card per medicine with name, strength, amount, the time boxes, before or after meals and number of days, all editable. A name the AI is unsure of starts **unticked** with an amber warning. The course starts on the document's date, or today when the document has none.
- **The AI copies, the code decides the times.** A handwriting test on three English samples showed names in legible handwriting are read correctly, scribble is flagged unsure, and **times of day are often wrong**. So Gemini returns the prescription's own wording (`frequency`), and `medication_slots()` in `ai_service.py` ticks boxes only for "1-0-1" patterns (four numbers add the afternoon) and the words sáng, trưa, chiều, tối. "tối đa", "tối thiểu" and "ánh sáng" are ignored. Anything else leaves the boxes empty for the user. The owner agreed to both rules.
- **Safety:** the app only copies the prescription. No dose advice, no interaction checks, no suggested drugs. The schedule says to follow the paper prescription and the doctor when they differ.
- **Phases agreed with the owner:** phase 1 (done) is the above. **Phase 2, built by the friend (PR #24, 6 October 2026):** "Đã uống" ticks per time of day stored on the server (`medication_intakes` table, `GET /api/medications/intakes`, `PUT /api/medications/{id}/intakes/{slot}`; deleting a medicine deletes its ticks), a printable schedule, and the caregiver's read-only view of the schedule and ticks, shown only when the patient turns on `share_medications`. **Phase 3:** reminders (needs notifications).
- Medicines are shared with caregivers only when the patient turns on `share_medications`. They are on the doctor's report; while viewing a relative the report still leaves its "Thuốc đang dùng" section out (revisit now that sharing exists).

### Readings list ("Các lần đo")

- Each reading is a **card** on every screen size: date and source, the status tag, then **one line per value** with a mark (circle in range, triangle needs attention, octagon dangerous) and the word for screen readers. The owner chose this over a values grid and over range bars. The card label for blood oxygen is "SpO₂" (Hôm nay and the detail dialog keep "Oxy trong máu (SpO₂)").
- Only the newest readings show at first: **2 on a phone, 3 on a wide screen**, then "Hiển thị thêm (n)", which shows all the rest at once. Changing the "Hiển thị" filter folds the list again.
- The doctor's report keeps its own table.

### Motion (standing rule)

- **Every element and every new feature must have a smooth, simple animation.** Nothing should appear or disappear abruptly. A new screen, dialog, panel or list item is not finished until it has its animation.
- Use the existing patterns in `frontend/assets/styles.css`; do not invent new ones:
  - tab views: `view-in` (fade from 40% and rise 6px, 0.22s);
  - full screens (edit wizard, report, login): `screen-in` (fade and rise 14px, 0.26s);
  - the app shell when returning to it: `fade-in` only, because a transform on it would detach the fixed bottom nav;
  - dialogs: `dialog-in` on open and `dialog-out` on close, always through `closeDialog()` in `app.js`;
  - blocks that appear in place (alerts, banners, wizard steps, inline messages, new rows): `view-in`;
  - toasts: `toast-in`, then the `leaving` class.
- Short (0.16s to 0.26s), ease-out via `var(--ease-out)`, one movement per interaction, opacity and transform only. No bounce, no looping or decorative motion.
- All motion is off under `prefers-reduced-motion` and in print. The global rules already cover this; new animations must not override them.

### Emergency behaviour

- Dangerous readings show a red panel with a "Gọi cấp cứu 115" button, and nothing else competes with it (the score and the normal record button are hidden).
- For 24 hours after a dangerous reading from **any source, sample readings included**, Today **holds amber "Cần theo dõi"** even if a newer reading is normal.
- Red is reserved for dangerous readings. Family-history levels stop at amber (see "Family risk" below).

### Advice ("Lời khuyên")

- The owner asked for **stock photos on advice cards** and said the current photos are **fine for now**. Do not replace them unless asked.
- Every tip must have a photo that **matches its content**.
- Advice must be **dynamic**: based on the person's own readings, profile and family history, plus **one daily suggestion** (for example, drink enough water).
- No explanatory subtitle under "Lời khuyên cho bạn".
- Photos are self-hosted in `frontend/assets/tips/` (Pexels, free licence) so no third party learns which advice a user sees.

### Family tree

- A relative with a known disease is shown in **amber** (owner chose to keep amber).
- The tree lives on the "Di truyền" tab; Hồ sơ keeps a short summary and a link.

### Sample readings

- Sample readings (the "Dùng dữ liệu mẫu" button in the measuring dialog) are **treated like any other reading**: they set the status on Hôm nay, can trigger the emergency panel and the 24-hour hold, and appear in charts, the report and the caregiver list. Only the source label "Dữ liệu mẫu" marks them.
- The button is shown **only to trial accounts**. The owner expects to remove the sample feature later.

### Family risk ("Di truyền" tab)

- A tab of its own on wide screens. **On phones it lives inside Hồ sơ** (friend's change, kept by the owner on 10 October 2026): the phone bar has Hôm nay, Lịch sử, Giấy tờ, Hồ sơ, and Di truyền opens from a link in Hồ sơ or from the side menu.
- Result per condition is a **level with reasons, never a percentage**: Rất cao, Cao, Trung bình, Chưa ghi nhận, Chưa đủ thông tin, Đã được chẩn đoán.
- **Levels stop at amber.** "Rất cao" and "Cao" are both amber triangles and differ by the word and a 3-step meter; "Trung bình" is a dark diamond; diagnosed is a blue square. No red on this tab.
- Conditions tracked: hypertension, diabetes, cardiovascular disease, stroke, dyslipidemia, breast cancer, colorectal cancer. The last three were added at the owner's request. The owner declined collecting age at diagnosis.
- The form records **how many siblings** are affected.
- The 0 to 100 score keeps its formula; only its inputs were fixed (live from the profile, unknown relatives flagged, BMI from 23, cancers do not move it).
- On phones the bottom bar label is "Lịch sử" (the page heading stays "Lịch sử đo") so five items fit on one line.

### Public access

- Judges must be able to open the app from their own devices through a **public link**; anyone with the link may create a trial account.
- Trial accounts: **site-wide cap of 10 per hour** (the owner accepted that one visitor can use up the hour) and **deletion 3 days after creation**, not after last use.
- Host: **Vercel** (no payment card, repo stays private), chosen over Hugging Face Spaces (code would be public) and over relying on the tunnel alone. The tunnel stays as a quick fallback.

### Doctor's report

- Professional and **monochrome**, like a Vietnamese hospital form.
- Must **clearly state it is not official**, and must not imitate a real institution: no national motto, ministry or hospital name, stamp or signature block.
- Produced through the browser's print dialog ("In / Lưu PDF"), not a server-made file.
- **Medicines on the report** (owner's request, 3 October 2026): section "Thuốc đang dùng" after the family history, one row per medicine active today (name and strength, time of day and amount, course). Finished and not yet started courses are left out. While viewing a relative the section is left out, because their medicines are not shared and `state.medications` holds the viewer's own; revisit this with phase 2. Section numbers are counted in `renderReport()` (`heading()`).
- Contents: user details, family history (relatives' conditions only, so the doctor judges for themselves; the family-risk levels are deliberately left out), summary table, charts, full readings table. When more than the latest 100 readings fall in the period, the sheet says it covers only the latest 100.

### Family sharing (caregiver view)

- A parent shares a **one-time code**; an adult child signs in with their own account and sees the parent's data **read-only**; the parent can revoke at any time.
- Shared: status, readings, charts, **profile and family tree**, and the medicine schedule with its ticks when the patient allows it (`share_medications`). Not shared: email, free-text notes, consents, scanned documents.

### Working style

- Work **one step at a time** and keep things **simple and fast**. The owner is conscious of API usage.
- **Lay out the plan before implementing** a new feature, and **ask the owner for their opinion** on taste or product decisions, with concrete options.
- **Ask before** downloading any file (list file name, source and size), and before anything visible outside the PC. Merging pull requests is the owner's action.
- Commit when asked. The owner's phrase is "Commit the working tree changes with a sensible message".
- **Before committing, do a round of bug-finding** on the whole change and fix what it finds; list the fixes in the reply. The owner asks for this by name ("do a round of bug-finding", "check for oversights").
- **Check whether the pull request is still open before pushing to its branch** (`gh pr view <n> --json state`). The owner merges quickly, sometimes before the last commits are pushed; commits pushed to a merged branch reach nothing. Then branch from an up-to-date `master`, cherry-pick the unmerged commits and open a new pull request.
- **When the owner asks for options, present them and wait.** A small inline mockup (the visualize tool) worked well for a layout choice. For a wording clean-up, give a numbered list with the proposed replacement for each item and let the owner pick by number.
- **A Notion entry is written like a person telling a colleague what happened** (the owner calls this "the human speech part"): informal Vietnamese, first person, in the order things happened, with the reason for each decision and short code examples. Not a bullet list of commit titles.
- New work goes on its own branch with a pull request (the owner then merges it). When work is done: push to GitHub and add a note to the Notion page.
- Chat replies use "caveman lite" mode (tight, no filler). A session hook may start in "full"; the owner switches with `/caveman lite`. Documents, code comments, commit messages and Notion pages are written in normal prose.
- Commits use the owner's GitHub identity: name `TBB`, email `phanthienbao7a3ltk@gmail.com` (set in this repo's local git config on 1 October 2026, so a plain `git commit` works). Commits end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Pull request descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commits before PR #16 carry `huynhnhu.9a17@gmail.com`, which is not on the GitHub account.
- Critique reports in `.impeccable/critique/` are committed to the repo.
- `.mcp.json` and `.playwright-mcp/` stay local (listed in `.git/info/exclude`). **`HANDOFF.md` is in git** (owner's request, 5 October 2026) and must stay in sync: every change to it goes into the branch of the work it describes, and the post-merge update goes in through a small `docs/…` pull request.
- The owner often uses the app's **"Create PR" button**; it commits whatever is in the working tree. If a PR for that branch is already merged, open a new PR from the same branch instead of pushing onto the merged one.
- The owner pastes screenshots when something looks wrong. Treat "it is broken" as a report to diagnose first (the 1 October "broken UI" was a stale cached stylesheet, not a code fault).
- The owner declined one suggestion on 1 October 2026: **the report preview stays a true A4 sheet** that scrolls sideways on phones.
- When the owner says "commit" after work on a branch, they mean commit, push and open the pull request. When asked to check for oversights, they expect the found problems to be fixed and listed, not only reported.
- **Outside such a requested review, change only what was asked.** After answering open questions the owner wrote "Dont change anything else (ask me first)" (1 October 2026): anything further, including wording and small polish, is raised as a question first.
- Handoff notes must describe the current state only: no recency bias, every relevant decision included, no fixed bugs or abandoned attempts.

### Added by the friend's work (PR #24, 6 October 2026)

- **Navigation:** the GeneSense logo opens a side menu (`setNavDrawer()`, `#app-nav-drawer`, `.nav-scrim`), with an overlay, focus kept inside and Esc to close.
- **Readings sent twice are saved once:** manual readings carry a `client_id`; `POST /api/assessments` returns the existing reading for a repeated id (unique index on `user_id, client_id`, added in `migrations.py`).
- **7-day blood-pressure summary** split into morning and evening on Lịch sử (`state.weeklyBP`).
- **Chart and vital-card animations** the first time they scroll into view, off under `prefers-reduced-motion`.
- **`CLINICAL_REVIEW_CHECKLIST.md`** in the project root: what a clinician should review before any claim beyond a demo.
- The friend's own notes say none of this was checked on a real phone, on Safari, with a Bluetooth device, or on a deployed copy.

## 5. What the app does now (map of the code)

### Screens

- **Login:** Google sign-in (shown as coming later when not configured) and "Dùng thử với hồ sơ mẫu".
- **Onboarding / edit profile:** 3-step wizard (personal details, parents and siblings with a "Số anh chị em mắc bệnh" field, grandparents and consents). In edit mode it is titled "Sửa hồ sơ sức khỏe", or "Sửa tiền sử gia đình" when opened from the Di truyền tab (it then opens on the second of the three pages, "Bước 2 trên 3"); the exit reads "Quay lại" and returns to the tab it came from.
- **Hôm nay:** greeting; family danger notices; emergency panel when needed; status word, summary, one "Ghi chỉ số" button and the medicine link line; "Cách tính kết quả" (scores live from the profile, a note about unknown relatives, a link to Di truyền); latest readings with range bars; "Lời khuyên cho bạn" with two cards (the highest-priority personal tip plus "Gợi ý hôm nay"), hidden while the emergency panel shows; list of relatives being followed.
- **Lịch sử đo:** reading cards (2 or 3 newest, then "Hiển thị thêm") with details and delete; four trend charts; the full "Lời khuyên cho bạn" set (up to four tips plus "Gợi ý hôm nay"); "Tải lại" text link; "Lập phiếu tổng hợp" opens the doctor's report.
- **Thuốc và giấy tờ** (phone bar: "Giấy tờ"): sub-tab "Lịch uống thuốc" ("Thuốc hôm nay" blocks, "Thêm thuốc", folded "Tất cả thuốc") and sub-tab "Giấy tờ đã lưu" (saved documents with "Xem nội dung đã lưu", "Xem ảnh gốc" where this device holds the scan, and "Xóa"). "Thêm ảnh giấy tờ" opens the upload dialog: per-scan consent, AI reading, then a review step "Đưa vào hồ sơ" with readings, diagnoses, family history and medicines to apply.
- **Di truyền:** lead sentence and a reassurance line; "Bệnh có người thân mắc" (one card per condition: level strip, affected relatives, "Nên làm"), with the key "Cách đọc mức nguy cơ" under the cards; "Bệnh đã được chẩn đoán"; "Các bệnh khác"; "Sơ đồ gia đình" with the "Sửa tiền sử gia đình" button. When every relative is unknown it shows one panel with a primary "Cập nhật tiền sử gia đình" button instead.
- **Hồ sơ:** profile picture with "Đổi ảnh đại diện" inside the name panel, personal facts, the "Di truyền và sơ đồ gia đình" button, family summary, "Hiển thị" panel with "Hiệu ứng kính mờ", "Chia sẻ với người thân" panel, feedback form, and the red "Đăng xuất" button at the very bottom.
- **Report screen:** A4 monochrome sheet with a 7, 30 or 90 day selector and "In / Lưu PDF".
- **Viewing mode:** the same screens (including Di truyền, without Giấy tờ) showing a linked relative's data read-only, with a banner and "Về hồ sơ của tôi".

### Files

- **`frontend/index.html`:** all screens and dialogs (measuring, reading details, document upload, scan viewer, medicine, profile-picture crop, confirm).
- **`frontend/assets/styles.css`:** the whole visual system (see "Design language" in section 4). Be Vietnam Pro, 18px base, CSS variables for colours at the top, white panels with 1px borders, 16px corners and soft shadows, glass header, side menu and phone bar (`body.no-glass` turns the blur off), yellow focus ring with a dark outer ring, `scrollbar-gutter: stable`, the animations listed in section 4, `.report-*` and `@page` rules for printing, `.ft-*` for the family tree, `.risk-*` and `.genetics-section` for the Di truyền tab, `body.viewing .own-only` to hide write controls.
- **`frontend/js/app.js`:** all UI logic. Useful names:
  - Status: `LEVELS`, `statusOf()`, `isEmergency()`, `levelOf()`, `recentEmergency()` (24-hour amber hold, level `watch`), `pickCurrent()` (the latest reading), `renderDashboard()`, `renderEmergency()`, `renderScores()` (score panel, live from `state.risk`).
  - Readings: `renderMetrics()`, `rangeBar()` and `ZONES`, `renderHistory()` (cards, `state.historyAll`), `showResult()`, `deleteAssessment()`, `vitalsProblem()` (the three reading rules, shared by manual entry and documents), `fromDocument()` and `when()`.
  - Documents: `analyzeMedicalDocument()`, `shrinkImage()`, `applyMarkup()`, `applyMedicineMarkup()`, `syncApplyMedicines()`, `applyDocument()`, `saveMedicalRecord()`, `scanRequest()` (IndexedDB), `viewScan()`.
  - Medicines: `SLOTS`, `medicineActive()`, `renderRecordsTab()`, `renderMedicines()`, `renderMedicineLink()`, `openMedicine()`, `saveMedicine()`, `deleteMedicine()`, `keepSlotChoice()` ("Khi cần" excludes the four times).
  - Profile picture: `renderAvatar()`, `chooseAvatar()`, `drawCrop()`, `saveAvatar()`.
  - Charts: `TRENDS`, `renderTrends()` (called directly, not through `requestAnimationFrame`; also on window resize, because a chart keeps the pixel width it was drawn at).
  - Advice: `renderTips()`, `TIP_IMAGES` and `tipImage()` (keyword to photo; a tip's own `image` key wins; fallback is the logbook photo), `DAILY_TIPS` and `dailyTip()` (one per calendar day), `tipCard()`.
  - Profile: `renderProfile()`, `familyNode()`, `familySummary()`, `bmiLabel()` (Asian cut-offs), `editProfile(step)` (the argument is zero-based: 0 is the personal page, 1 the first family page, so `editProfile(1)` shows "Bước 2 trên 3"; `state.editReturn` is the tab to go back to).
  - Family risk: `refreshRisk()` (fills `state.risk`, sets `state.riskFailed`), `renderGenetics()`, `RISK_LEVELS` (tone, label, meter bars), `riskLevel()`, `riskMeter()`, `riskWho()`.
  - Report: `openReport()`, `renderReport()`, `reportRows()`, `reportSummary()`.
  - Family sharing: `refreshCare()`, `renderCare()`, `patientRow()`, `patientLevel()`, `createCareCode()`, `acceptCareCode()`, `removeCareLink()`, `viewPatient()`, `exitViewing()`, `reader()` (picks the care endpoints while viewing). Viewing swaps the relative's data into `state`, keeps the user's own in `state.own`, and adds `body.viewing`; write functions return early while `state.viewing` is set.
  - Helpers: `num()` and `withUnit()` (Vietnamese number format), `toDate()` (trims microseconds), `closeDialog()`, `confirmAction(title, body, okLabel)`, `screen()`, `navigate()` plus a `hashchange` listener.
- **`frontend/js/chart.js`:** `TrendChart`, an SVG line chart with one axis, a reference band or dashed threshold lines, round ticks, a hover and keyboard tooltip, and an optional `dash` per series.
- **`frontend/js/api.js`:** API client. `history()` loads up to 100 readings. `risk()` and `careRisk()` load the family-risk overview. Care calls start with `care`. `medications()`, `saveMedication(body, id)`, `deleteMedication(id)`; `avatar()`, `saveAvatar()`, `removeAvatar()`.
- **`frontend/sw.js`:** service worker; caches the app shell and the 14 tip photos.
- **`backend/app/main.py`:** API routes, including `DELETE /api/assessments/{id}` (own readings only), `GET /api/risk` (live scores plus per-condition levels), `/api/avatar`, `/api/medical-records` (analyze, save, list, delete) and `/api/medications` (list, add, change, delete; 60 per account). `POST /api/assessments` accepts `source: "document"` with `measured_on`. The `privacy_and_csrf` middleware sets `no-store` for `/`, `/sw.js` and `/api/`, and `no-cache` for `/assets/` and `/js/`.
- **`backend/app/care.py`:** family sharing router at `/api/care` (create code, accept code, list links, revoke, read a linked person's profile, readings and risk overview). Codes are 8 characters, valid 24 hours, stored hashed, single use, replaced by a newer code. `linked_patient()` guards every read and returns 404 without an active link. Wrong codes are limited to 5 per 15 minutes, counted in the `care_code_failures` table. The caregiver list looks at the patient's latest 30 readings.
- **`backend/app/models.py`:** `User`, `Avatar`, `LoginSession`, `Assessment`, `Feedback`, `MedicalRecord`, `Medication`, `CareInvite`, `CareCodeFailure`, `CareLink`. New tables are created by `Base.metadata.create_all` in `migrations.py` (and on cold start on Vercel); a new column on an existing table needs its own `ALTER TABLE` there. A table that holds a `user_id` must be added to the trial-account cleanup loop in `auth.py`.
- **`backend/app/services/risk_engine.py`:** scoring, alerts (`_build_alerts()`) and rule-based advice (`_rule_tips()`). Advice uses the actual blood pressure, glucose, SpO₂ and heart-rate values, diagnosed conditions, family history, smoking, activity and BMI (cut-off 23); each reason quotes the triggering number; tips are sorted by priority and capped at 4. Also `family_risk()` (level per condition), `FAMILY_ADVICE`, `risk_overview()` (live scores fused with the latest reading's vital score) and `fuse()`.
- **`backend/app/schemas.py`:** `Condition` has seven values; `FamilyHistoryInput.affected_count` (default 1) is the number of affected siblings; `MeasurementCreate` (sources manual, ble, simulation, document); `MedicalDocumentAnalysis` with `vitals`, `own_conditions`, `family_conditions` and `medications`; `MedicationInput`.
- **`backend/app/services/ai_service.py`:** `enrich()` lets Gemini write the tips instead of the rules when the user allowed AI; `analyze_document()` reads a photo; `_gemini_generate()` tries the two models with retries; `_medical_analysis_from_json()` repairs and validates the answer (`_document_date`, `_clamp`, `medication_slots`).

### Behaviours worth knowing

- **Advice is stored with each saved reading.** Readings saved before a wording change keep their old advice text.
- **The report and the charts use the readings already loaded** (the latest 100).
- **Family-risk level rules** (`family_risk()`): Rất cao = two or more of parents and siblings, or one of them plus a grandparent; Cao = one parent or sibling, or two grandparents on the same side; Trung bình = a grandparent only; Chưa đủ thông tin = nobody affected but a parent or the siblings are still unknown; otherwise Chưa ghi nhận; a condition in the person's own profile is Đã được chẩn đoán. The rules follow common family-history practice and are **not clinically validated**.
- **The score on each saved reading is frozen**, but the score panel and the Di truyền tab are computed live from the current profile.
- **One sibling count covers every condition on the sibling entry.** No age at diagnosis and no sex-specific rules, except that the breast-cancer advice text differs for men.
- **Dialogs close after a short animation** (`closeDialog()`, about 0.16 s). While a modal dialog is open the page behind it cannot take focus, and when it closes the browser gives focus back to the element that opened it. Anything that must move focus after a dialog (as the emergency heading does after a dangerous reading, PR #16) has to do it on the dialog's `close` event.
- **Family danger notices are not real-time.** The child sees them when they open or reload the app.

## 6. What is left to do

Ask the owner which one to do next. Rough priority order:

1. **Test the emergency flow on the live site** with one trial account (dangerous reading, red panel, focus on the heading, 24-hour hold, detail dialog).
2. **Family tree on phones:** the lines from grandparents to parents are hidden at phone width, so it reads as a grid of boxes. Restore connectors within each family-side column and remove the gap above the children row.
3. **Check one printed report by eye.** The report was verified on screen and a 70-row test produced a 5-page A4 PDF, but page breaks were never inspected visually.
4. **Have a clinician review the family-risk rules and advice text** before any claim beyond a demo.
5. **Check the friend's work in the browser** (PR #24): side menu and phone bar at 375px, "Đã uống" ticks, the printable schedule, `share_medications` in the caregiver view, the 7-day morning and evening blood-pressure summary, chart animations under `prefers-reduced-motion`, and the document photo flow. Then phase 3 of the medicine schedule, reminders.
6. **Second handwriting test** with Vietnamese prescriptions once the owner sends them (script idea: call `_gemini_generate` per model with a small medicines schema and compare with a human reading). Vietnamese hospital prescriptions are mostly printed, which should read better than the English handwritten samples.
7. **Features the owner has seen and may want next:**
   - context tags for readings (before or after meals, after rest or activity) plus a short symptom note;
   - (done by the friend: 7-day blood-pressure summary with a morning and evening split)
   - entering family history by tapping the family tree;
   - offline entry;
   - Zalo or phone-number sign-in (written up on the Notion page; recommendation: Zalo first, phone OTP later; HTTPS hosting now exists on Vercel, so what is still missing is the owner registering a Zalo app, or a paid message provider for phone codes);
   - weight tracking; data export and account deletion;
   - measurement reminders (needs notifications; would also give family members real-time alerts);
   - a "call parent" button in the caregiver view (needs a phone number on the profile);
   - editing a saved reading instead of only deleting it;
   - a glucose unit choice (the app assumes mg/dL; mmol/L is common on Vietnamese meters);
   - cleanup of old trial accounts in the **local** database (the 3-day cleanup only runs where `DEMO_PUBLIC=true`, that is on the live site and the tunnel).
8. **Mobile app direction (discussed, nothing built):** Android first, by wrapping the existing site; iOS later because Safari has no Web Bluetooth. Before any store release the app needs PNG icons (192 and 512px) and an `apple-touch-icon`, notifications, offline entry, and a privacy policy page. HTTPS hosting with Neon is done.
9. **Paging for readings beyond 100** (the report note is a stopgap).
10. **Smaller polish items:**
   - on a 375×812 screen, "Ghi chỉ số" and "Đo lại" sit partly under the bottom tab bar until the user scrolls;
   - the blood-pressure chart has no 180/120 danger line;
   - "Nên đi khám sớm" and "Nguy hiểm" use the same red tag. This is an open polish item, not an accepted exception; the owner has not chosen the fix, so ask (options: amber for "Nên đi khám sớm", or a different shape);
   - range-bar zone colours are low contrast (the value text carries the meaning);
   - "Dùng dữ liệu mẫu" is hidden for non-trial accounts in the UI only; the API still accepts `source: "simulation"` from any account, and the hiding was never checked on a real Google account;
   - unused icons remain in `frontend/js/icons.js`;
   - "25,6 Béo phì" on the profile is accurate under the Asian cut-off but blunt;
   - on the Di truyền tab, the loading and failed-load panels were never triggered live, and the rich-history layout at 375px and the caregiver view were not re-checked after the last round of changes;
   - the family tree summary counts affected siblings ("Đái tháo đường (5 người)") while the card shows one label per relative entry;
   - a used-up quota and a provider outage both show "Tính năng đọc ảnh đang quá tải. Hãy thử lại sau ít phút." (owner's wording). The remaining Gemini messages (wrong key, unknown model, refused request, no connection) still name Gemini and speak to a developer; they appear only when the setup is wrong, and the owner has not been asked about them;
   - the onboarding screen's "Đăng xuất" has no confirmation, unlike the one in Hồ sơ; the owner was told and has not asked for a change;
   - "Hiển thị thêm" shows all remaining readings at once (up to 97); the owner was offered steps of 10 and has not answered;
   - `PRODUCT.md` still says original images are never stored and does not mention the medicine schedule; it is in git, so it changes through a pull request;
   - findings of the medicine-schedule critique that were not acted on: no undo after deleting a medicine, no way to pause a medicine without deleting it, and the date field shows the browser's own date format.
11. **Run the design critique again** to get a new score for the Di truyền tab, the medicine schedule and the whole app.
12. **Giấy tờ, not yet verified:**
   - `gemini-3.6-flash` as the fallback for documents and its handling of the repaired parsing (every verified scan ran on `gemini-3.1-flash-lite`);
   - a Vietnamese prescription through the medicine review step, and the "Chưa bắt đầu" and "Đã hết đợt" tags on real data;
   - the sideways scroll on a real Pixel 9 or iPhone: it was reproduced and fixed only for a page whose width changes after the charts were drawn; a fresh phone-width load never overflowed in Edge. If the owner still sees it, ask which tab;
   - a phone photo of a real paper document (rotation, glare, handwriting);
   - "Lưu ảnh" on a real phone (verified in Edge on a PC only, where the file downloads and the app stays in place). On an iPhone, Safari puts downloads in the Files app, not in Photos; inside in-app browsers such as Zalo a download may not be offered. The owner has **no plan for an iPhone-specific way** (the share sheet was offered and declined on 2 October 2026), so leave it as a plain download;
   - the profile picture: a real finger drag in the crop dialog, a rotated camera photo, "Xóa ảnh" through the UI, and the header link while viewing a relative.
13. **Giấy tờ, possible next steps:** a glucose unit read from the document and converted in code instead of by the model; more data types than hereditary and cardiovascular; removing the reading when its document is deleted.

## 7. How the work is done here (follow this flow)

1. **Read first.** Read the task and the code it touches before proposing anything. For "does X work?" questions, reproduce with real numbers or in the browser and report findings before changing code.
2. **Plan and ask.** For anything beyond a small fix, lay out the plan and ask the owner the decisions that are theirs, with two to four concrete options and a recommendation. Record the answers in section 4.
3. **Branch per change** from an up-to-date `master` (`fix/…`, `feat/…`, `docs/…`). If a second change depends on an unmerged one, branch from it and say in the PR which one to merge first.
4. **Edit.** Small edits with the Edit tool. For many edits at once, a short Python script saved in the session scratchpad with the Write tool (not a Bash heredoc: quotes in Vietnamese text and backslashes get mangled there) that asserts each old string occurs exactly once and writes nothing until every assertion has passed. Read each file with `newline=""` and convert `\n` in the script's strings to the file's own line ending, so the script works whichever ending the file has. Do not use `sed -i` on source files. Set `PYTHONIOENCODING=utf-8` when a script prints Vietnamese. In a multi-line Bash command a failed line does not stop the lines after it; check `git status` and `git log` before pushing.
5. **Verify before reporting.**
   - `node --check` on changed JS, then `pytest`.
   - Restart the server after backend edits (see the reload note in section 3).
   - Check in Playwright (Edge) at about 1100px and at 375×812. Read-only checks can use the signed-in test accounts in section 3; anything that writes goes to a throwaway server (section 3). Fetch changed files with `cache: "reload"` and reload, or the old script is served. Read back DOM facts with `browser_evaluate`, then take one screenshot per width and look at it. Also narrow the window after load once: content sized in pixels at draw time (the charts) only shows its overflow that way.
   - Do not judge behaviour in the Claude browser pane while it is hidden: it does not fire a dialog's `close` event and does not open new tabs or downloads.
   - Say plainly what was not checked (printed PDF, real Bluetooth, Google sign-in, AI, the live site).
6. **Bump `CACHE`** in `frontend/sw.js` when frontend files changed.
7. **Commit, push, open the PR** with `gh` (path in section 3). PR body: what changed, why, testing, not tested, reviewer notes. The owner merges.
8. **After the merge:** switch to `master`, pull, check the live site over HTTP (cache name in `/sw.js`, the policy header, one marker of the change in the served files, the API route answering), update this file, and add an entry to the Notion page (see "Working style" for how it is written). `PRODUCT.md` is in git, so it changes through a PR.
9. **Design work** goes through the impeccable skill: `scripts/impeccable context` once, then the command's reference file. A critique runs as two sub-agents one after the other (they share one Playwright browser): a design review, then the detector and measurements. Save the report with `critique-storage write` and commit it.
