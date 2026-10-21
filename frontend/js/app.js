import { api } from "./api.js";
import { HealthBleClient, VitalSimulator } from "./ble.js";
import { TrendChart } from "./chart.js";
import { hydrateIcons, icon } from "./icons.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const CONDITIONS = [["hypertension", "Tăng huyết áp"], ["diabetes", "Đái tháo đường"], ["cardiovascular", "Bệnh tim mạch"], ["stroke", "Đột quỵ"], ["dyslipidemia", "Rối loạn mỡ máu"], ["breast_cancer", "Ung thư vú"], ["colorectal_cancer", "Ung thư đại trực tràng"]];
// Single-gene hereditary conditions, asked on their own wizard page; the server screens them (services/hereditary.py).
const HEREDITARY = [["thalassemia", "Thalassemia (tan máu bẩm sinh)"], ["g6pd", "Thiếu men G6PD"], ["ovarian_cancer", "Ung thư buồng trứng"], ["familial_hypercholesterolemia", "Tăng cholesterol gia đình"]];
const HEREDITARY_WHO = [["self", "Bạn"], ["father", "Bố"], ["mother", "Mẹ"], ["sibling", "Anh chị em ruột"], ["paternal-grandfather", "Ông nội"], ["paternal-grandmother", "Bà nội"],
  ["maternal-grandfather", "Ông ngoại"], ["maternal-grandmother", "Bà ngoại"], ["maternal-uncle", "Cậu (anh, em trai của mẹ)"]];
const NOT_FOR_OVARIAN = new Set(["father", "paternal-grandfather", "maternal-grandfather", "maternal-uncle"]);   // not offered for ovarian cancer
const SCREENS = { thalassemia: "Thalassemia (tan máu bẩm sinh)", g6pd: "Thiếu men G6PD", brca: "Ung thư vú/buồng trứng liên quan BRCA1/2", familial_hypercholesterolemia: "Tăng cholesterol gia đình (FH)" };
const PATTERNS = {
  thalassemia: "Thalassemia có nhiều thể. Một số thể beta di truyền lặn; alpha thalassemia có các tổ hợp gen phức tạp hơn. Tiền sử gia đình không cho biết ai mang biến thể.",
  x_linked: "G6PD nằm trên nhiễm sắc thể X. Bố không truyền nhiễm sắc thể X cho con trai; biểu hiện ở nữ có thể khác nhau. Phả hệ không thay thế xét nghiệm men G6PD.",
  brca: "Một số biến thể BRCA có thể truyền từ bố hoặc mẹ và làm tăng nguy cơ ung thư; mang biến thể không đồng nghĩa chắc chắn mắc bệnh.",
  fh: "Phần lớn FH có kiểu di truyền trội, nhưng có thể có nguyên nhân và kiểu di truyền khác. Chỉ tiền sử cholesterol cao không xác định FH."
};
const conditionName = key => [...CONDITIONS, ...HEREDITARY].find(([id]) => id === key)?.[1];
const MEMBERS = [
  { id: "father", label: "Bố", relation: "father", side: "immediate" },
  { id: "mother", label: "Mẹ", relation: "mother", side: "immediate" },
  { id: "sibling", label: "Anh chị em ruột", relation: "sibling", side: "immediate" },
  { id: "paternal-grandfather", label: "Ông nội", relation: "grandfather", side: "paternal" },
  { id: "paternal-grandmother", label: "Bà nội", relation: "grandmother", side: "paternal" },
  { id: "maternal-grandfather", label: "Ông ngoại", relation: "grandfather", side: "maternal" },
  { id: "maternal-grandmother", label: "Bà ngoại", relation: "grandmother", side: "maternal" },
];
const FAMILY_HISTORY_SOURCES = [["self_reported", "Tôi tự khai"], ["relative_reported", "Người thân xác nhận"],
  ["document_checked", "Đã đối chiếu giấy tờ"], ["clinician_reviewed", "Nhân viên y tế xác nhận"], ["unknown", "Chưa rõ"]];
const FAMILY_HISTORY_SOURCE_LABEL = Object.fromEntries(FAMILY_HISTORY_SOURCES);
const GENETIC_GUIDES = [
  {
    title: "Thalassemia (tan máu bẩm sinh)", summary: "Bệnh máu có nhiều thể alpha và beta; người mang một số biến thể có thể ít hoặc không có triệu chứng.",
    inheritance: "Một số thể beta di truyền lặn; alpha thalassemia phụ thuộc số lượng và tổ hợp gen bị ảnh hưởng. Không thể xác định tình trạng mang gen chỉ từ phả hệ.",
    next: "Hỏi bác sĩ về xét nghiệm máu phù hợp hoặc tư vấn di truyền, nhất là khi gia đình có người bệnh hay bạn đang chuẩn bị có con.",
    links: [["Alpha thalassemia — MedlinePlus", "https://medlineplus.gov/genetics/condition/alpha-thalassemia/"], ["Beta thalassemia — MedlinePlus", "https://medlineplus.gov/genetics/condition/beta-thalassemia/"]]
  },
  {
    title: "Thiếu men G6PD", summary: "Thiếu một enzyme bảo vệ hồng cầu; một số thuốc, nhiễm trùng hoặc yếu tố khác có thể kích hoạt tan máu.",
    inheritance: "Gen G6PD nằm trên nhiễm sắc thể X. Bố không truyền X cho con trai; biểu hiện ở nữ có thể khác nhau.",
    next: "Nếu đã được chẩn đoán, hãy báo bác sĩ và dược sĩ trước khi dùng thuốc mới; không tự ý ngừng thuốc. Xét nghiệm máu giúp xác định men G6PD.",
    links: [["Thiếu men G6PD — MedlinePlus", "https://medlineplus.gov/genetics/condition/glucose-6-phosphate-dehydrogenase-deficiency/"]]
  },
  {
    title: "Ung thư liên quan BRCA1/2", summary: "Một số biến thể BRCA làm tăng nguy cơ một số ung thư; phần lớn ung thư vú không phải do biến thể di truyền.",
    inheritance: "Biến thể nguy cơ có thể truyền từ mẹ hoặc bố. Người mang biến thể không chắc chắn sẽ mắc ung thư.",
    next: "Nếu gia đình có nhiều trường hợp ung thư vú/buồng trứng hoặc ca bệnh đặc biệt, hãy hỏi bác sĩ về tư vấn di truyền và lựa chọn tầm soát.",
    links: [["Ung thư vú — MedlinePlus", "https://medlineplus.gov/genetics/condition/breast-cancer/"], ["Ung thư buồng trứng — MedlinePlus", "https://medlineplus.gov/genetics/condition/ovarian-cancer/"]]
  },
  {
    title: "Tăng cholesterol gia đình (FH)", summary: "Một số thể làm LDL-cholesterol rất cao và có thể gây bệnh tim sớm; cholesterol cao đơn thuần chưa đủ để kết luận FH.",
    inheritance: "Phần lớn FH do một số gen như LDLR, APOB hoặc PCSK9 di truyền trội; hiếm hơn, biến thể LDLRAP1 di truyền lặn.",
    next: "Khi người thân đã được chẩn đoán FH, hãy hỏi bác sĩ xem bạn và người thân có cần xét nghiệm mỡ máu hoặc đánh giá thêm không.",
    links: [["FH — MedlinePlus Genetics", "https://medlineplus.gov/genetics/condition/familial-hypercholesterolemia/"]]
  },
];
const METRICS = [
  { key: "systolic", label: "Huyết áp", unit: "mmHg", icon: "pressure" },
  { key: "heart_rate", label: "Nhịp tim", unit: "lần/phút", icon: "heart" },
  { key: "spo2", label: "Oxy trong máu (SpO₂)", unit: "%", icon: "lungs" },
  { key: "glucose", label: "Đường huyết", unit: "mg/dL", icon: "drop" },
];
const KEYS = ["heart_rate", "systolic", "diastolic", "spo2", "glucose"];
const LEVELS = { safe: "An toàn", attention: "Cần chú ý", alert: "Nên đi khám sớm", emergency: "Nguy hiểm", watch: "Cần theo dõi" };
const SUMMARY_FALLBACK = { safe: "Các chỉ số vừa đo chưa chạm ngưỡng cảnh báo.", attention: "Có chỉ số cần theo dõi. Hãy đo lại.", alert: "Nguy cơ tổng hợp ở mức cao. Nên sắp xếp đi khám.", emergency: "Có chỉ số ở mức nguy hiểm." };
const SOURCE_NAMES = { manual: "Nhập tay", ble: "Máy đo Bluetooth", simulation: "Dữ liệu mẫu", document: "Từ giấy tờ", device: "Máy đo GeneSense" };
// Readings copied from a scanned document are history: dated by the document and never the current state.
const fromDocument = record => (record.vitals?.source || record.measurement_source) === "document";
const when = record => date(record.created_at, !fromDocument(record));
const ZONES = {
  systolic: { min: 80, max: 200, zones: [[80, 140, "safe"], [140, 180, "attention"], [180, 200, "alert"]] },
  heart_rate: { min: 30, max: 170, zones: [[30, 40, "alert"], [40, 50, "attention"], [50, 110, "safe"], [110, 150, "attention"], [150, 170, "alert"]] },
  spo2: { min: 85, max: 100, zones: [[85, 90, "alert"], [90, 95, "attention"], [95, 100, "safe"]] },
  glucose: { min: 40, max: 320, zones: [[40, 54, "alert"], [54, 70, "attention"], [70, 180, "safe"], [180, 300, "attention"], [300, 320, "alert"]] },
};
const TRENDS = {
  bp: { unit: "mmHg", band: null, thresholds: [{ value: 140, color: "#0b57a4", label: "Ngưỡng cao tâm thu 140" }, { value: 90, color: "#3d8fd6", label: "Ngưỡng cao tâm trương 90" }], min: 60, max: 160, series: [["systolic", "Tâm thu", "#0b57a4"], ["diastolic", "Tâm trương", "#3d8fd6"]] },
  heart_rate: { unit: "lần/phút", band: [50, 110], min: 45, max: 120, series: [["heart_rate", "Nhịp tim", "#0b57a4"]] },
  spo2: { unit: "%", band: [95, 100], min: 88, max: 100, series: [["spo2", "SpO₂", "#0b57a4"]] },
  glucose: { unit: "mg/dL", band: [70, 180], min: 50, max: 220, series: [["glucose", "Đường huyết", "#0b57a4"]] },
};
const trendCharts = {};
const revealedPanels = new Set();
const panelRevealObserver = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    panelRevealObserver.unobserve(entry.target);
    const finish = event => {
      if (event.target !== entry.target || event.animationName !== "panel-reveal") return;
      entry.target.classList.remove("reveal-once");
      entry.target.removeEventListener("animationend", finish);
      entry.target.removeEventListener("animationcancel", finish);
    };
    entry.target.addEventListener("animationend", finish);
    entry.target.addEventListener("animationcancel", finish);
    entry.target.classList.remove("reveal-pending");
    entry.target.classList.add("reveal-once");
    revealedPanels.add(entry.target.dataset.revealKey);
  }
}, { threshold: 0.12, rootMargin: "0px 0px -80px 0px" }) : null;
function revealPanelOnce(element, key) {
  if (!panelRevealObserver || revealedPanels.has(key) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  element.dataset.revealKey = key;
  element.classList.add("reveal-pending");
  panelRevealObserver.observe(element);
}
const isEmergency = result => Boolean(result?.alerts?.some(a => a.severity === "alert"));
const levelOf = result => isEmergency(result) ? "emergency" : result.risk_level;
const isReal = record => (record.vitals?.source || "manual") !== "simulation";
const DOCUMENT_TYPES = { lab_result: "Kết quả xét nghiệm", genetic_test_report: "Kết quả xét nghiệm di truyền", prescription: "Đơn thuốc", discharge_note: "Giấy ra viện", imaging_report: "Kết quả chẩn đoán hình ảnh", vaccination: "Tiêm chủng", other: "Tài liệu sức khỏe" };
const FLAG_NAMES = { normal: "Trong khoảng tham chiếu", high: "Cao", low: "Thấp", abnormal: "Cần xem lại", unknown: "Chưa rõ" };
const state = { viewing: null, viewingMedications: null, own: null, care: { patients: [], caregivers: [] }, familyLinks: { relatives: [] }, familyInviteCode: null, familyInvitePreview: null, user: null, health: null, records: [], result: null, risk: null, weeklyBP: null, step: 0, editing: false, rating: 0,
  medicalRecords: [], medications: [], medicationIntakes: null, pendingAssessments: [], recordsTab: null, editingMedicine: null, pendingMedical: null, documentAiEnabled: false, aiProvider: "AI", previewUrl: null, uploadFile: null,
  deviceSource: null, deviceValues: {}, deviceTimes: {}, samples: [], deviceEpoch: 0, authEpoch: 0, busy: false, view: "dashboard" };
let ble = null;
let simulator = null;
let freshnessTimer = null;
let pendingSync = false;
let printingMedicine = false;
const accountChannel = "BroadcastChannel" in window ? new BroadcastChannel("genesense-account") : null;

function offlineRequest(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("genesense-offline", 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains("pending-assessments")) open.result.createObjectStore("pending-assessments", { keyPath: "client_id" });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const transaction = db.transaction("pending-assessments", mode);
        const request = run(transaction.objectStore("pending-assessments"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      } catch (error) { db.close(); reject(error); }
    };
  });
}
async function pendingForAccount(userId) {
  return (await offlineRequest("readonly", store => store.getAll())).filter(item => item.user_id === userId)
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}
async function deletePending(clientId) {
  await offlineRequest("readwrite", store => store.delete(clientId));
}
async function deletePendingForAccount(userId) {
  const items = await pendingForAccount(userId);
  await Promise.all(items.map(item => deletePending(item.client_id)));
}
function renderSyncStatus() {
  const status = $("#sync-status");
  if (!status) return;
  const count = state.pendingAssessments.length;
  const offline = !navigator.onLine;
  status.classList.toggle("hidden", !offline && !count);
  status.textContent = offline
    ? (count ? count + " chỉ số đã lưu trên thiết bị, chờ kết nối để đồng bộ." : "Đang mất kết nối. Bạn vẫn có thể nhập chỉ số thủ công.")
    : count ? count + " chỉ số đang chờ đồng bộ. Chưa có đánh giá nguy cơ cho các chỉ số này." : "";
}
async function queueManualReading(body) {
  const entry = { client_id: body.client_id, user_id: state.user.id, captured_at: body.vitals.timestamp, body };
  await offlineRequest("readwrite", store => store.put(entry));
  state.pendingAssessments = await pendingForAccount(state.user.id);
  renderSyncStatus(); renderHistory();
  closeDialog($("#measurement-dialog"));
  $("#measurement-form").reset();
  toast("Đã lưu trên thiết bị. Ứng dụng sẽ đồng bộ khi có mạng; hiện chưa tính nguy cơ.");
  // Offline the server cannot score the reading, but a dangerous value must still point to 115 at once.
  if (METRICS.some(m => statusOf(m.key, body.vitals)[0] === "alert")) {
    renderEmergency({ alerts: [{ severity: "alert" }], measured_vitals: body.vitals, created_at: body.vitals.timestamp || new Date().toISOString() });
    navigate("dashboard");
    const dialog = $("#measurement-dialog"), focusTitle = () => $("#emergency-title").focus();
    if (dialog.open) dialog.addEventListener("close", focusTitle, { once: true }); else focusTitle();
  }
}
async function syncPendingAssessments() {
  if (!state.user || state.viewing || !navigator.onLine || pendingSync) return;
  pendingSync = true;
  let synced = 0;
  try {
    const userId = state.user.id, epoch = state.authEpoch;
    const pending = await pendingForAccount(userId);
    state.pendingAssessments = pending;
    renderSyncStatus(); renderHistory();
    for (const item of pending) {
      if (state.authEpoch !== epoch || state.user?.id !== userId) return;
      try {
        await api.assess(item.body);
        await deletePending(item.client_id);
        synced++;
      } catch (error) {
        if (!error.status) return; // keep it for the next online event; the idempotency key makes retries safe
        if (error.status === 401) return;
        // A refused reading keeps its message for the user but must not hold back the readings after it.
        item.sync_error = error.message;
        await offlineRequest("readwrite", store => store.put(item));
      }
    }
    state.pendingAssessments = await pendingForAccount(userId);
    renderSyncStatus(); renderHistory();
    if (synced) {
      await refreshRecords();
      toast(synced === 1 ? "Đã đồng bộ 1 chỉ số." : "Đã đồng bộ " + synced + " chỉ số.");
    }
  } catch { /* IndexedDB can be unavailable in private browsing; the rest of the app remains usable. */ }
  finally { pendingSync = false; }
}

function toast(text, type = "") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = text;
  $("#toast-region").append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, 4500);
}
// Phone Back closes the dialog or report on top instead of leaving the page: each one opens a history entry,
// and closing it any other way takes that entry back off.
let layerCount = 0, layerPops = 0, reportLayer = false;
function openDialog(dialog) {
  dialog.showModal();
  dialog.dataset.layer = String(++layerCount);
  history.pushState({ layer: true }, "");
}
function dropLayer() { layerPops++; history.back(); }
// Plays the exit animation before the native close, so "close" listeners still fire once, at the end.
function closeDialog(dialog) {
  if (!dialog.open || dialog.classList.contains("closing")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { dialog.close(); return; }
  dialog.classList.add("closing");
  const done = () => { dialog.classList.remove("closing"); if (dialog.open) dialog.close(); };
  dialog.addEventListener("animationend", done, { once: true });
  setTimeout(done, 250);
}
function confirmAction(title, body = "Không thể khôi phục sau khi xóa.", okLabel = "Xóa", { cancel = "Hủy", danger = true } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-ok").textContent = okLabel;
  $("#confirm-ok").className = "btn " + (danger ? "danger" : "primary");
  $("#confirm-no").textContent = cancel;
  dialog.returnValue = ""; // Esc closes without a value, so an earlier "yes" must not count again
  openDialog(dialog);
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true }));
}
function errorAt(id, text = "") {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("hidden", !text);
}
function screen(name) {
  if (name !== "app") setNavDrawer(false, false);
  ["loading", "login", "onboarding", "app", "report"].forEach(key => $("#" + key + "-screen").classList.toggle("hidden", key !== name));
  if (name !== "app") document.title = "GeneSense - Sức khỏe gia đình và di truyền";
  window.scrollTo(0, 0);
}
const toDate = raw => { const value = String(raw ?? "").replace(/(\.\d{3})\d+/, "$1"); return new Date(value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value) ? value : value + "Z"); };
function date(value, time = true) {
  const parsed = toDate(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(parsed);
}
// Vietnamese number format: decimal comma, at most one decimal; "%" sits directly after the number.
const NUMBER_FORMAT = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const num = value => NUMBER_FORMAT.format(value);
const withUnit = (value, unit) => value + (unit === "%" ? "" : " ") + unit;
const GLUCOSE_WHEN = { fasting: "lúc đói", after_meal: "sau ăn" };
const glucoseWhen = (key, values = {}) => key === "glucose" && GLUCOSE_WHEN[values.glucose_context] || "";
function valueOf(key, values = {}) {
  if (values[key] == null) return "-";
  if (key === "systolic") return Math.round(values.systolic) + "/" + (values.diastolic == null ? "-" : Math.round(values.diastolic));
  return key === "spo2" ? num(values[key]) : Math.round(values[key]).toString();
}
// On the blood-pressure chart each line is judged by its own number, so a high diastolic marks the diastolic line.
const chartStatus = (key, v) => key === "systolic" ? statusOf("systolic", { systolic: v.systolic, diastolic: 0 })[0]
  : key === "diastolic" ? statusOf("systolic", { systolic: 0, diastolic: v.diastolic })[0] : statusOf(key, v)[0];
function statusOf(key, v) {
  if (v[key] == null) return ["neutral", "Chưa đo"];
  const n = v[key];
  if (key === "heart_rate") return n < 40 || n > 150 ? ["alert", "Nguy hiểm"] : n < 50 || n > 110 ? ["attention", "Cần chú ý"] : ["safe", "An toàn"];
  if (key === "spo2") return n < 90 ? ["alert", "Nguy hiểm"] : n < 95 ? ["attention", "Thấp, cần chú ý"] : ["safe", "An toàn"];
  if (key === "systolic") return n >= 180 || v.diastolic >= 120 ? ["alert", "Nguy hiểm"] : n >= 140 || v.diastolic >= 90 ? ["attention", "Cao, cần chú ý"] : ["safe", "An toàn"];
  if (key === "glucose") return n < 54 || n > 300 ? ["alert", "Nguy hiểm"] : n < 70 || n > 180 ? ["attention", "Cần chú ý"] : ["safe", "An toàn"];
  return ["safe", "An toàn"];
}
// Profile picture: the uploaded photo, or the first letter of the given name (the last word of a Vietnamese name).
const initialOf = name => (name.trim().split(/\s+/).pop() || "?").charAt(0).toUpperCase();
function renderAvatar() {
  $$("[data-avatar]").forEach(el => {
    if (!state.avatarUrl) { el.textContent = initialOf(state.user.display_name); return; }
    const img = new Image();
    img.alt = ""; img.src = state.avatarUrl;
    el.replaceChildren(img);
  });
  $("#avatar-remove")?.classList.toggle("hidden", !state.avatarUrl);
}
function setAvatar(blob) {
  if (state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
  state.avatarUrl = blob ? URL.createObjectURL(blob) : null;
  if (state.user) renderAvatar();
}
async function loadAvatar() {
  const epoch = state.authEpoch;
  const blob = await api.avatar();
  if (epoch === state.authEpoch) setAvatar(blob);
}
// Cropping: the chosen photo is drawn on a 280px square canvas; x, y and zoom say which part of it is kept.
const CROP = 280;
const crop = { image: null, zoom: 1, x: 0, y: 0 };
function drawCrop(canvas = $("#avatar-canvas")) {
  const { image } = crop, scale = CROP / Math.min(image.width, image.height) * crop.zoom, k = canvas.width / CROP;
  // The photo always covers the whole square, so no empty edge can be saved.
  crop.x = Math.min(0, Math.max(CROP - image.width * scale, crop.x));
  crop.y = Math.min(0, Math.max(CROP - image.height * scale, crop.y));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, crop.x * k, crop.y * k, image.width * scale * k, image.height * scale * k);
}
function moveCrop(dx, dy) { crop.x += dx; crop.y += dy; drawCrop(); }
function zoomCrop(zoom) {
  // Zoom around the centre of the square, not its corner.
  const ratio = zoom / crop.zoom;
  crop.x = CROP / 2 - (CROP / 2 - crop.x) * ratio; crop.y = CROP / 2 - (CROP / 2 - crop.y) * ratio; crop.zoom = zoom;
  drawCrop();
}
async function chooseAvatar(file) {
  if (!file || state.viewing) return;
  try { crop.image = await createImageBitmap(file); }
  catch { toast("Không đọc được ảnh này. Hãy chọn ảnh khác.", "error"); return; }
  const fit = CROP / Math.min(crop.image.width, crop.image.height);
  Object.assign(crop, { zoom: 1, x: (CROP - crop.image.width * fit) / 2, y: (CROP - crop.image.height * fit) / 2 });
  $("#avatar-zoom").value = 1;
  drawCrop();
  openDialog($("#avatar-dialog"));
}
// Only a 256px JPEG of the chosen area leaves the device.
async function saveAvatar() {
  const button = $("#avatar-save"); button.disabled = true;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    drawCrop(canvas);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    await api.saveAvatar(blob);
    setAvatar(blob);
    closeDialog($("#avatar-dialog"));
    toast("Đã đổi ảnh đại diện.");
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}
async function removeAvatar() {
  if (state.viewing || !await confirmAction("Xóa ảnh đại diện?", "Ảnh sẽ được thay bằng chữ cái đầu của tên bạn.", "Xóa ảnh")) return;
  try { await api.removeAvatar(); setAvatar(null); $("#avatar-change")?.focus(); toast("Đã xóa ảnh đại diện."); }
  catch (error) { toast(error.message, "error"); }
}
function personalize() {
  $$("[data-user-name]").forEach(el => el.textContent = state.user.display_name);
  renderAvatar();
  $("#greeting").textContent = state.viewing ? "Hồ sơ của " + state.viewing.name : "Xin chào, " + state.user.display_name;
  $("#demo-banner").classList.toggle("hidden", !state.user.is_demo);
  // Only trial accounts may create sample readings, so a real account's history never holds invented numbers.
  $("#simulate-ble").classList.toggle("hidden", !state.user.is_demo);
  const today = new Intl.DateTimeFormat("vi-VN", { weekday: "long", day: "numeric", month: "numeric", year: "numeric" }).format(new Date());
  $("#today-date").textContent = today.charAt(0).toUpperCase() + today.slice(1);
}
function setNavDrawer(open, restoreFocus = true) {
  const drawer = $("#app-nav-drawer"), scrim = $("#nav-scrim"), toggle = $("#sidebar-toggle");
  if (!drawer || !scrim || !toggle) return;
  document.body.classList.toggle("nav-open", open);
  [".app-site-header", "#demo-banner", "#viewing-banner", "#sync-status", "#main-content", ".mobile-nav"].forEach(selector => {
    const background = $(selector);
    if (background) background.toggleAttribute("inert", open);
  });
  drawer.classList.toggle("is-open", open);
  scrim.classList.toggle("is-open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  scrim.setAttribute("aria-hidden", String(!open));
  drawer.toggleAttribute("inert", !open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Đóng menu điều hướng" : "Mở menu điều hướng");
  if (open) ($("#nav-close") || drawer).focus({ preventScroll: true });
  else if (restoreFocus && !$("#app-screen").classList.contains("hidden")) toggle.focus({ preventScroll: true });
}

function navigate(view) {
  if (!state.user || !state.health) return;
  state.view = ["dashboard", "records", "history", "genetics", "profile"].includes(view) && !(state.viewing && view === "records") ? view : "dashboard";
  $$(".view").forEach(el => el.classList.toggle("hidden", el.id !== state.view + "-view"));
  const activeNav = state.view === "genetics" ? "profile" : state.view;
  $$("nav [data-nav]").forEach(button => {
    const active = button.dataset.nav === activeNav;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const pageName = { dashboard: "Hôm nay", records: "Thuốc và giấy tờ", history: "Lịch sử đo", genetics: "Gia đình và di truyền", profile: "Hồ sơ" }[state.view];
  document.title = pageName + " - GeneSense";
  window.history.replaceState(null, "", "#" + state.view);
  if (state.view === "profile") renderProfile();
  if (state.view === "genetics") { renderGenetics(); if (!state.viewing) void refreshFamilyLinks(); }
  if (state.view === "records") { renderMedicalRecords(); renderRecordsTab(); }
  if (state.view === "history") { renderHistory(); renderTips(); renderTrends(); if (!state.viewing) void refreshRecords(); }
  window.scrollTo(0, 0);
}

function conditionChips(name, selected = []) {
  return CONDITIONS.map(([value, label]) => '<label><input type="checkbox" name="' + name + '" value="' + value + '"' + (selected.includes(value) ? " checked" : "") + "><span>" + label + "</span></label>").join("");
}
function fillWizard(health = null) {
  $("#onboarding-form").reset();
  $("#display-name").value = health?.display_name || (state.user.is_demo ? "" : state.user.display_name);
  const p = health?.profile;
  ["age", "sex"].forEach(key => $("#" + key).value = p?.[key] ?? "");
  $("#height").value = p?.height_cm ?? "";
  $("#weight").value = p?.weight_kg ?? "";
  $("#activity").value = p?.activity_minutes_week ?? 0;
  $("#smoker").checked = p?.smoker ?? false;
  $("#personal-notes").value = health?.personal_notes || "";
  $("#paternal-notes").value = health?.paternal_notes || "";
  $("#maternal-notes").value = health?.maternal_notes || "";
  $("#health-consent").checked = health?.health_consent ?? false;
  $("#ai-consent").checked = health?.ai_consent ?? false;
  $("#personal-conditions").innerHTML = conditionChips("personal_conditions", p?.known_conditions);
  for (const side of ["immediate", "paternal", "maternal"]) {
    $("#family-" + side).innerHTML = MEMBERS.filter(m => m.side === side).map(member => {
      const saved = health?.family_history?.find(item => item.member_id === member.id);
      const knowledge = saved?.knowledge || "unknown";
      const source = saved?.source || (knowledge === "unknown" ? "unknown" : "self_reported");
      const sourceOptions = FAMILY_HISTORY_SOURCES.filter(([value]) => value !== "unknown").map(([value, label]) =>
        '<option value="' + value + '"' + (source === value ? " selected" : "") + ">" + label + "</option>").join("");
      const siblingFields = member.id === "sibling"
        ? '<label class="member-count"' + (knowledge === "known" ? "" : " hidden") + '>Số anh chị em mắc bệnh<input type="number" inputmode="numeric" data-affected min="1" max="10" value="' + (saved?.affected_count || 1) + '"></label>' +
          '<label class="member-count"' + (knowledge === "known" ? "" : " hidden") + '>Trong đó anh, em trai<input type="number" inputmode="numeric" data-brothers min="0" max="10" value="' + (saved?.affected_brothers || 0) + '"></label>'
        : "";
      const ageLabel = member.id === "sibling" ? "Tuổi chẩn đoán sớm nhất (nếu nhớ)" : "Tuổi khi được chẩn đoán (nếu nhớ)";
      return '<div class="family-member" data-member="' + member.id + '"><div class="member-top"><strong>' + member.label + '</strong><label class="visually-hidden" for="knowledge-' + member.id + '">Tiền sử ' + member.label + '</label><select id="knowledge-' + member.id + '" data-knowledge><option value="unknown"' + (knowledge === "unknown" ? " selected" : "") + '>Chưa rõ</option><option value="none"' + (knowledge === "none" ? " selected" : "") + '>Không có bệnh đã biết</option><option value="known"' + (knowledge === "known" ? " selected" : "") + '>Có bệnh đã biết</option></select></div><div class="chips"' + (knowledge === "known" ? "" : " hidden") + '>' + conditionChips(member.id, saved?.conditions) + "</div>" + siblingFields +
        '<label class="member-count"' + (knowledge === "known" ? "" : " hidden") + '>' + ageLabel + '<input type="number" inputmode="numeric" data-diagnosis-age min="1" max="120" value="' + (saved?.age_at_diagnosis || "") + '"></label>' +
        '<div class="family-provenance"' + (knowledge === "unknown" ? " hidden" : "") + '><label>Nguồn thông tin<select data-history-source>' + sourceOptions + '</select></label><label>Lần gần nhất hỏi hoặc đối chiếu (nếu nhớ)<input type="date" data-last-confirmed value="' + esc(saved?.last_confirmed_on || "") + '"></label><p class="note">Nguồn chỉ giúp biết thông tin đến từ đâu; không xác nhận nguyên nhân di truyền.</p></div></div>';
    }).join("");
  }
  const hasHereditary = (who, key) => who === "self" ? p?.known_conditions?.includes(key) : health?.family_history?.find(item => item.member_id === who)?.conditions?.includes(key);
  const uncle = health?.family_history?.find(item => item.member_id === "maternal-uncle");
  const uncleSource = uncle?.source || "self_reported";
  const uncleSourceOptions = FAMILY_HISTORY_SOURCES.filter(([value]) => value !== "unknown").map(([value, label]) =>
    '<option value="' + value + '"' + (uncleSource === value ? " selected" : "") + ">" + label + "</option>").join("");
  $("#hereditary-questions").innerHTML = HEREDITARY.map(([key, label]) => '<fieldset class="chip-field" data-hereditary="' + key + '"><legend>' + label + '</legend><div class="chips">' +
    HEREDITARY_WHO.filter(([who]) => key !== "ovarian_cancer" || !NOT_FOR_OVARIAN.has(who)).map(([who, name]) =>
      '<label><input type="checkbox" value="' + who + '"' + (hasHereditary(who, key) ? " checked" : "") + "><span>" + name + "</span></label>").join("") + "</div></fieldset>").join("") +
    '<div class="member-count" id="maternal-uncle-age-field"' + (uncle?.conditions?.length ? "" : " hidden") + '><label>Tuổi khi cậu được chẩn đoán (nếu nhớ)<input type="number" inputmode="numeric" data-maternal-uncle-age min="1" max="120" value="' + (uncle?.age_at_diagnosis || "") + '"></label><div class="family-provenance"><label>Nguồn thông tin<select data-maternal-uncle-source>' + uncleSourceOptions + '</select></label><label>Lần gần nhất hỏi hoặc đối chiếu (nếu nhớ)<input type="date" data-maternal-uncle-confirmed value="' + esc(uncle?.last_confirmed_on || "") + '"></label></div></div>';
  const related = health?.parents_related || "unknown";
  $("#parents-related").innerHTML = [["yes", "Có"], ["no", "Không"], ["unknown", "Không rõ"]].map(([value, label]) =>
    '<label><input type="radio" name="parents_related" value="' + value + '"' + (value === related ? " checked" : "") + "><span>" + label + "</span></label>").join("");
  $("#onboarding-exit").textContent = state.editing ? "Quay lại" : "Đăng xuất";
  $("#onboarding-title").textContent = !state.editing ? "Khai báo hồ sơ sức khỏe" : state.editReturn === "genetics" ? "Sửa tiền sử gia đình" : "Sửa hồ sơ sức khỏe";
  state.step = 0;
  showStep();
  updateBmi();
}
function updateBmi() {
  const h = Number($("#height").value) / 100, w = Number($("#weight").value);
  $("#bmi-output").textContent = h > 0 && w > 0 ? "Chỉ số BMI: " + num(w / h ** 2) : "";
}
const LAST_STEP = 3;
const hereditaryPicks = key => $$('[data-hereditary="' + key + '"] input:checked').map(el => el.value);
const hereditaryFor = who => HEREDITARY.map(([key]) => key).filter(key => hereditaryPicks(key).includes(who));
function showStep() {
  $$("[data-step]").forEach(el => el.hidden = Number(el.dataset.step) !== state.step);
  $$("[data-step-indicator]").forEach(el => { el.classList.toggle("active", Number(el.dataset.stepIndicator) === state.step); el.classList.toggle("done", Number(el.dataset.stepIndicator) < state.step); });
  $("#step-caption").textContent = "Bước " + (state.step + 1) + " trên " + (LAST_STEP + 1);
  $("#onboarding-progress").value = state.step + 1;
  $("#step-back").hidden = state.step === 0;
  $("#step-next").textContent = state.step === LAST_STEP ? (state.editing ? "Lưu thay đổi" : "Hoàn tất") : "Tiếp tục";
  errorAt("#onboarding-error");
}
function validCurrentStep() {
  const active = $('[data-step="' + state.step + '"]');
  errorAt("#onboarding-error");
  const invalid = [...active.querySelectorAll("input, select, textarea")].find(el => !el.checkValidity());
  if (invalid) { invalid.reportValidity(); invalid.focus(); return false; }
  const missing = [...active.querySelectorAll("[data-member]")].find(el => el.querySelector("select").value === "known" && !el.querySelector("input[type=checkbox]:checked") && !hereditaryFor(el.dataset.member).length);
  if (missing) {
    errorAt("#onboarding-error", "Hãy chọn bệnh đã biết cho " + MEMBERS.find(m => m.id === missing.dataset.member).label + ", hoặc chọn “Chưa rõ” và ghi chú thêm.");
    missing.querySelector("select").focus();
    return false;
  }
  return true;
}
function readWizard() {
  return {
    display_name: $("#display-name").value.trim(),
    profile: { age: Number($("#age").value), sex: $("#sex").value, height_cm: Number($("#height").value), weight_kg: Number($("#weight").value),
      smoker: $("#smoker").checked, activity_minutes_week: Number($("#activity").value),
      known_conditions: [...$$('#personal-conditions input:checked').map(el => el.value), ...hereditaryFor("self")] },
    family_history: [...MEMBERS.map(m => {
      const el = $('[data-member="' + m.id + '"]');
      const extra = hereditaryFor(m.id);
      // A hereditary condition picked on the last page makes the relative's history "known".
      const knowledge = extra.length ? "known" : el.querySelector("select").value;
      const cardKnown = el.querySelector("select").value === "known";
      const affected = knowledge === "known" ? Math.min(10, Math.max(1, Math.round(Number(el.querySelector("[data-affected]")?.value) || 1))) : 1;
      const diagnosisAge = el.querySelector("[data-diagnosis-age]")?.value;
      return { member_id: m.id, relation: m.relation, side: m.side, knowledge, affected_count: affected,
        source: knowledge === "unknown" ? "unknown" : (el.querySelector("[data-history-source]")?.value || "self_reported"),
        last_confirmed_on: knowledge === "unknown" ? null : (el.querySelector("[data-last-confirmed]")?.value || null),
        age_at_diagnosis: knowledge === "known" && diagnosisAge ? Number(diagnosisAge) : null,
        affected_brothers: m.id === "sibling" && knowledge === "known" ? Math.min(affected, Math.max(0, Math.round(Number(el.querySelector("[data-brothers]")?.value) || 0))) : 0,
        conditions: [...(cardKnown ? [...el.querySelectorAll("input[type=checkbox]:checked")].map(box => box.value) : []), ...extra] };
    }), ...(hereditaryFor("maternal-uncle").length ? [{ member_id: "maternal-uncle", relation: "uncle", side: "maternal", knowledge: "known", affected_count: 1,
      source: $("[data-maternal-uncle-source]")?.value || "self_reported", last_confirmed_on: $("[data-maternal-uncle-confirmed]")?.value || null,
      age_at_diagnosis: Number($("[data-maternal-uncle-age]").value) || null, conditions: hereditaryFor("maternal-uncle") }] : [])],
    parents_related: $('input[name="parents_related"]:checked')?.value || "unknown",
    personal_notes: $("#personal-notes").value.trim(), paternal_notes: $("#paternal-notes").value.trim(), maternal_notes: $("#maternal-notes").value.trim(),
    ai_consent: $("#ai-consent").checked, share_medications: Boolean(state.health?.share_medications), health_consent: $("#health-consent").checked,
  };
}
async function nextStep(event) {
  event.preventDefault();
  if (!validCurrentStep()) return;
  if (state.step < LAST_STEP) {
    state.step++;
    showStep();
    $("#onboarding-form").scrollIntoView({ block: "start" });
    return;
  }
  const button = $("#step-next");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "Đang lưu…";
  const epoch = state.authEpoch;
  try {
    const data = await api.saveProfile(readWizard());
    if (state.authEpoch !== epoch) return;
    state.user = data.user; state.health = data.health;
    const wasEditing = state.editing;
    state.editing = false;
    personalize();
    screen("app");
    await Promise.all([refreshRecords(), refreshCare(), refreshFamilyLinks(), refreshRisk()]);
    navigate(wasEditing ? state.editReturn : "dashboard");
    toast(wasEditing ? "Đã lưu hồ sơ." : "Đã lưu hồ sơ. Bạn có thể ghi chỉ số đầu tiên.");
    offerDeviceImport();
  } catch (error) { errorAt("#onboarding-error", error.message); }
  finally { button.disabled = false; button.innerHTML = original; }
}

function rangeBar(key, value) {
  const scale = ZONES[key];
  const pos = v => ((Math.min(scale.max, Math.max(scale.min, v)) - scale.min) / (scale.max - scale.min) * 100).toFixed(1);
  // Positions travel as data attributes and are applied by placeRanges(): the Content-Security-Policy blocks style attributes.
  return '<div class="range" aria-hidden="true">' + scale.zones.map(([from, to, level]) => '<span class="range-zone ' + level + '" data-left="' + pos(from) + '" data-width="' + (pos(to) - pos(from)).toFixed(1) + '"></span>').join("") + '<span class="range-mark" data-left="' + pos(value) + '"></span>' + rangeTicks(scale, pos) + "</div>";
}
function rangeTicks(scale, pos) {
  const edges = scale.zones.slice(1).map(([from], i) => ({ value: from, safe: scale.zones[i][2] === "safe" || scale.zones[i + 1][2] === "safe" }));
  const shown = [];
  [...edges.filter(e => e.safe), ...edges.filter(e => !e.safe)].forEach(e => { if (shown.every(s => Math.abs(pos(s) - pos(e.value)) >= 14)) shown.push(e.value); });
  return shown.map(v => '<span class="range-tick" data-left="' + pos(v) + '">' + num(v) + "</span>").join("");
}
function placeRanges(root) {
  root.querySelectorAll("[data-left]").forEach(el => {
    el.style.left = el.dataset.left + "%";
    if (el.dataset.width) el.style.width = el.dataset.width + "%";
  });
}
function renderMetrics() {
  const values = state.result?.measured_vitals || {};
  const grid = $("#metric-grid");
  $("#range-key").classList.toggle("hidden", !METRICS.some(m => values[m.key] != null));
  grid.querySelectorAll(".reveal-pending").forEach(card => panelRevealObserver?.unobserve(card));
  grid.innerHTML = METRICS.map(m => {
    const [level, status] = statusOf(m.key, values);
    const measured = values[m.key] != null;
    const flag = measured ? '<span class="reading-flag tag ' + level + '">' + status + '</span>' : "";
    return '<div class="reading"><span class="metric-icon">' + icon(m.icon) + '</span><span class="reading-name">' + m.label + (glucoseWhen(m.key, values) ? " <small>" + glucoseWhen(m.key, values) + "</small>" : "") + '</span>' + (measured ? '<span class="reading-value">' + valueOf(m.key, values) + '<small>' + m.unit + '</small></span>' + rangeBar(m.key, values[m.key]) + flag : '<span class="reading-value empty">Chưa có số đo</span>') + '</div>';
  }).join("");
  placeRanges(grid);
  // Keep emergency values immediately readable; other cards enter only on their first viewport visit.
  if (!isEmergency(state.result)) [...grid.children].forEach((card, index) => revealPanelOnce(card, "metric-" + METRICS[index].key));
}
// Stock photos (Pexels, self-hosted) chosen by the tip's topic; order matters ("thuốc lá" before generic words).
const TIP_IMAGES = [
  [/thuốc lá|hút thuốc|bỏ thuốc|cai thuốc/, "smoking"],
  [/spo₂|spo2|oxy/, "oximeter"],
  [/nhịp tim/, "pulse"],
  [/nhạt|muối|nước mắm/, "salt"],
  [/huyết áp/, "blood-pressure"],
  [/đường huyết|đường máu|tiểu đường|đái tháo đường|trước ăn|sau ăn/, "glucose"],
  [/uống đủ nước|cốc nước/, "water"],
  [/ngủ/, "sleep"],
  [/hít thở|thở chậm/, "breathing"],
  [/vận động|đi bộ|tập|chạy|thể dục/, "activity"],
  [/(?<!\p{L})ăn(?!\p{L})|rau|khẩu phần|cân nặng|đồ uống/u, "diet"],
  [/gia đình|bố mẹ|người thân/, "family"],
];
const tipImage = tip => {
  if (tip.image) return "/assets/tips/" + tip.image + ".jpg";
  const text = (tip.title + " " + tip.action).toLowerCase();
  return "/assets/tips/" + (TIP_IMAGES.find(([pattern]) => pattern.test(text))?.[1] || "logbook") + ".jpg";
};
// One general habit per calendar day, the same for the whole day and independent of readings.
const DAILY_TIPS = [
  { title: "Uống đủ nước", action: "Uống khoảng 6 đến 8 cốc nước trong ngày, chia đều từ sáng đến tối.", reason: "Nếu bác sĩ dặn hạn chế nước (bệnh tim, thận), hãy theo lời dặn đó.", image: "water" },
  { title: "Ngủ đủ giấc", action: "Đi ngủ trước 23 giờ và ngủ 7 đến 8 tiếng.", reason: "Thiếu ngủ làm huyết áp và đường huyết khó ổn định.", image: "sleep" },
  { title: "Thêm rau vào bữa ăn", action: "Ăn một bát rau xanh trong bữa trưa và bữa tối.", reason: "Rau giúp no lâu và giảm lượng muối, tinh bột trong bữa.", image: "diet" },
  { title: "Đi bộ sau bữa ăn", action: "Đi bộ nhẹ 10 phút sau bữa tối.", reason: "Vận động nhẹ sau ăn giúp đường huyết lên chậm hơn.", image: "routine" },
  { title: "Nêm nhạt hơn một chút", action: "Bớt nửa thìa nước mắm hoặc muối khi nấu hôm nay.", reason: "Ăn nhạt dần giúp kiểm soát huyết áp.", image: "salt" },
  { title: "Hít thở chậm", action: "Ngồi yên, hít vào 4 giây, thở ra 6 giây, trong 5 phút.", reason: "Thở chậm giúp cơ thể thư giãn trước khi đo chỉ số.", image: "breathing" },
  { title: "Hỏi thăm người thân", action: "Gọi cho bố mẹ hoặc anh chị em và hỏi thêm về sức khỏe trong gia đình.", reason: "Tiền sử gia đình càng rõ, đánh giá càng sát.", image: "family" },
];
const dailyTip = () => DAILY_TIPS[Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000) % DAILY_TIPS.length];
const tipCard = (tip, image, label = "") => '<article class="tip-card' + (label ? " daily" : "") + '"><img src="' + image + '" alt="" width="160" height="160" loading="lazy" decoding="async"><div>' + (label ? '<p class="tip-label">' + label + "</p>" : "") + "<h3>" + esc(tip.title) + "</h3><p>" + esc(tip.action) + "</p>" + (tip.reason ? '<p class="note">' + esc(tip.reason) + "</p>" : "") + "</div></article>";
function renderTips() {
  const tips = state.result?.insight.tips || [
    { title: "Bắt đầu với một chỉ số", action: "Chỉ cần nhập một chỉ số.", image: "blood-pressure" },
    { title: "Đo trong cùng điều kiện", action: "Ngồi nghỉ 5 phút trước khi đo và làm theo hướng dẫn của máy đo." },
    { title: "Hỏi thêm người thân", action: "Chưa rõ tiền sử? Hãy hỏi bố mẹ." },
  ];
  const daily = dailyTip();
  const cards = tips.slice(0, 4).map(tip => tipCard(tip, tipImage(tip)));
  const dailyCard = tipCard(daily, tipImage(daily), "Gợi ý hôm nay");
  // Lịch sử leaves out what Hôm nay shows, except in an emergency, when Hôm nay hides its tips.
  const emergency = isEmergency(state.result);
  $("#tip-list").innerHTML = emergency ? cards.join("") + dailyCard : cards.slice(1).join("");
  $("#tip-more").textContent = (cards[0] ? 2 : 1) + " lời khuyên khác ở trang Hôm nay.";
  $("#tip-more").classList.toggle("hidden", emergency);
  // Today shows only the top personal tip and the daily one; advice must not compete with the emergency panel.
  $("#today-tips").innerHTML = (cards[0] || "") + dailyCard;
  $("#today-advice").classList.toggle("hidden", isEmergency(state.result));
  // During the 24h watch window the stored "all fine" follow-up would contradict Today.
  const followUp = state.result && !isEmergency(state.result) && recentEmergency() || state.result?.risk_level === "safe" ? "" : state.result?.insight.follow_up || "";
  $("#follow-up").textContent = followUp;
  $("#follow-up").classList.toggle("hidden", !followUp);
}
function alertsMarkup(result) {
  return result.alerts.filter(a => a.severity !== "safe").map(a => '<div class="alert-item ' + a.severity + '"><strong>' + esc(a.metric) + ":</strong> " + esc(a.message) + "</div>").join("");
}
function renderEmergency(r) {
  const on = isEmergency(r);
  $("#emergency-panel").classList.toggle("hidden", !on);
  if (!on) return;
  const values = r.measured_vitals || {};
  const lines = METRICS.filter(m => statusOf(m.key, values)[0] === "alert").map(m => m.label + ": " + withUnit(valueOf(m.key, values), m.unit));
  $("#emergency-title").textContent = "Chỉ số ở mức nguy hiểm";
  $("#emergency-list").innerHTML = lines.map(line => "<li>" + esc(line) + "</li>").join("") + "<li>Đo lúc " + esc(date(r.created_at)) + "</li>";
}
function renderDashboard() {
  const r = state.result;
  // Hold an amber "watch" state for 24h after any dangerous real reading, even if a newer one is normal.
  const recent = r && !isEmergency(r) ? recentEmergency() : null;
  const level = r ? (recent ? "watch" : levelOf(r)) : "neutral";
  renderEmergency(r);
  $("#dashboard-shortcuts").classList.toggle("hidden", isEmergency(r));
  $("#status-panel").dataset.level = level;
  const status = $("#risk-status");
  status.className = "status-word " + ({ emergency: "alert", watch: "attention" }[level] || level);
  status.textContent = r ? LEVELS[level] : "Chưa có dữ liệu";
  $("#risk-summary").textContent = !r ? "Nhập số đo đầu tiên để bắt đầu theo dõi." : level === "emergency" ? SUMMARY_FALLBACK.emergency : level === "watch" ? "24 giờ qua có lần đo ở mức nguy hiểm." : r.insight.summary || SUMMARY_FALLBACK[level];
  $("#result-date").textContent = r ? "Đo lúc " + date(r.created_at) + ", " + SOURCE_NAMES[r.measurement_source].toLowerCase() : "";
  // While the emergency panel is up it is the only call to action; the score would read as reassurance.
  $("#score-details").classList.toggle("hidden", !r || level === "emergency");
  $("#new-measurement").classList.toggle("hidden", level === "emergency");
  $("#recent-emergency").classList.toggle("hidden", !recent);
  if (recent) $("#recent-emergency").textContent = "Lần đo lúc " + date(recent.created_at) + " ở mức nguy hiểm. Đo lại sau 1 giờ. Nếu lại ở mức nguy hiểm hoặc có triệu chứng, liên hệ bác sĩ ngay trong hôm nay.";
  $("#result-alerts").innerHTML = r && level !== "emergency" ? alertsMarkup(r) : "";
  renderScores();
  renderMetrics();
  renderTips();
  renderTodayMedicineSummary();
}
function showHistoryTab(tab) {
  const charts = tab === "charts";
  $("#history-charts-panel").classList.toggle("hidden", !charts);
  $("#history-readings-panel").classList.toggle("hidden", charts);
  $$("[data-history-tab]").forEach(button => {
    const active = button.dataset.historyTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (charts) renderTrends();
}
// Charts show what the readings table shows: whole numbers, except SpO₂ which keeps one decimal.
const chartValue = (key, value) => key === "spo2" ? value : Math.round(value);
function renderTrends() {
  const hasReadings = state.records.length > 0;
  $("#history-chart-empty").classList.toggle("hidden", hasReadings);
  $("#history-chart-content").classList.toggle("hidden", !hasReadings);
  if (!hasReadings) return;
  const source = state.result?.measurement_source;
  // Every source shares one chart: typed-in, Bluetooth and sample readings.
  const rows = state.records.slice(0, 30).reverse();
  $("#chart-context").textContent = source ? "Tối đa 30 lần đo gần nhất" : "";
  $("#chart-help").textContent = (matchMedia("(hover: hover) and (pointer: fine)").matches ? "Di chuột" : "Chạm") + " vào biểu đồ để xem từng lần đo.";
  $("#chart-help").classList.toggle("hidden", !rows.length);
  for (const [id, spec] of Object.entries(TRENDS)) {
    const card = $('[data-trend="' + id + '"]');
    revealPanelOnce(card, "trend-" + id);
    const points = rows.filter(row => spec.series.every(([key]) => row.vitals[key] != null));
    card.querySelector(".trend-empty").classList.toggle("hidden", points.length > 0);
    const host = card.querySelector(".trend-chart");
    host.classList.toggle("hidden", !points.length);
    card.querySelector(".trend-legend")?.classList.toggle("hidden", !points.length);
    const last = points.at(-1);
    const latest = last ? withUnit(valueOf(spec.series[0][0], last.vitals), spec.unit) : "";
    card.querySelector(".trend-latest").textContent = last ? "Gần nhất: " + latest : "";
    $("#trend-" + id + "-summary").textContent = last ? points.length + " lần đo. Gần nhất " + latest + " lúc " + date(last.created_at) + "." : "";
    if (!points.length) continue;
    trendCharts[id] ||= new TrendChart(host);
    trendCharts[id].set({ unit: spec.unit, band: spec.band, thresholds: spec.thresholds, min: spec.min, max: spec.max, times: points.map(row => toDate(row.created_at)),
      series: spec.series.map(([key, label, color]) => ({ label, color, dash: key === "diastolic" ? "10 6" : null, values: points.map(row => chartValue(key, row.vitals[key])),
        flags: points.map(row => ["attention", "alert"].includes(chartStatus(key, row.vitals))) })) });
  }
}
function pickCurrent(rows) {
  return rows.find(row => !fromDocument(row)) || null;
}
async function refreshRecords() {
  const epoch = state.authEpoch;
  try {
    const currentReader = reader();
    const [rows, weeklyBP] = await Promise.all([
      currentReader.history(),
      currentReader.weeklyBp(new Date().getTimezoneOffset()).catch(() => null),
    ]);
    if (epoch !== state.authEpoch) return;
    const current = pickCurrent(rows);
    const result = current ? await reader().assessment(current.id) : null;
    if (epoch !== state.authEpoch) return;
    state.records = rows; state.result = result; state.weeklyBP = weeklyBP;
    renderDashboard(); renderHistory();
    if (state.view === "history") renderTrends();
  } catch (error) {
    if (epoch !== state.authEpoch) return;
    toast(error.message, "error");
    renderDashboard();
    $("#history-list").innerHTML = '<div class="empty-state"><h3>Chưa tải được lịch sử</h3><p>' + esc(error.message) + '</p><button class="btn outline" id="retry-history">Thử lại</button></div>';
  }
}
function recentEmergency() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return state.records.find(row => !fromDocument(row) && recordLevel(row) === "emergency" && toDate(row.created_at).getTime() >= since) || null;
}
function recordLevel(record) {
  const v = record.vitals || {};
  return METRICS.some(m => statusOf(m.key, v)[0] === "alert") ? "emergency" : record.risk_level;
}
function renderPendingReadings() {
  const panel = $("#pending-readings"), pending = state.pendingAssessments;
  panel.classList.toggle("hidden", !pending.length);
  if (!pending.length) { panel.innerHTML = ""; return; }
  panel.innerHTML = '<h2 id="pending-readings-title">Chờ đồng bộ (' + pending.length + ")</h2><p class=\"note\">Các chỉ số này đang lưu trên thiết bị, chưa được máy chủ tính nguy cơ.</p><ul class=\"pending-reading-list\">" +
    pending.map(item => {
      const values = METRICS.filter(metric => item.body.vitals[metric.key] != null)
        .map(metric => esc(metric.label + " " + withUnit(valueOf(metric.key, item.body.vitals), metric.unit))).join(" · ");
      return '<li><strong>' + esc(date(item.captured_at)) + '</strong><span>' + values + '</span><span class="tag">Chưa đồng bộ</span>' +
        (item.sync_error ? '<span class="note">Chưa gửi được. Sẽ thử lại khi có mạng.</span>' : "") + "</li>";
    }).join("") + "</ul>";
}
function renderWeeklyBloodPressure() {
  const panel = $("#weekly-bp-summary"), summary = state.weeklyBP;
  panel.innerHTML = '<h3>Trung bình huyết áp 7 ngày</h3><p class="note">Phân nhóm theo giờ ghi nhận; chỉ để xem xu hướng.</p>' +
    '<div class="weekly-bp-grid">' + [["Sáng (5–12 giờ)", summary?.morning, "Chưa đo buổi sáng"], ["Tối (17–24 giờ)", summary?.evening, "Chưa đo buổi tối"]].map(([label, group, empty]) =>
      '<div class="weekly-bp-card"><strong>' + label + '</strong><b' + (group?.count ? "" : ' class="empty"') + '>' + (group?.count ? esc(num(group.systolic) + "/" + num(group.diastolic) + " mmHg") : empty) + '</b><span class="note">' + (group?.count ? group.count + " lần đo" : "Trong 7 ngày qua") + "</span></div>").join("") + "</div>";
}
function renderHistory() {
  renderPendingReadings();
  renderWeeklyBloodPressure();
  const filter = $("#history-filter").value;
  const records = state.records.filter(row => filter === "all" || (filter === "simulation" ? !isReal(row) : isReal(row)));
  if (!records.length) {
    $("#history-list").innerHTML = '<div class="empty-state history-list-empty"><span class="history-list-empty-icon" aria-hidden="true">' + icon("history") + '</span><h3>' + (state.records.length ? "Không có lần đo phù hợp" : "Chưa có lần đo nào") + '</h3><p>Các lần đo sẽ hiện ở đây sau khi bạn ghi chỉ số.</p><button class="btn primary" id="history-add"><span data-icon="plus"></span>Ghi số đo đầu tiên</button></div>';
    hydrateIcons($("#history-list"));
    return;
  }
  // One card per reading, one line per value. The mark beside a value says how that value stands (shape and colour,
  // with the word for screen readers); the tag says how the whole reading stands.
  // Only the newest readings show at first (2 on a phone, 3 on a wide screen); the rest wait behind one button.
  const first = matchMedia("(max-width: 760px)").matches ? 2 : 3, hidden = state.historyAll ? 0 : Math.max(0, records.length - first);
  $("#history-list").innerHTML = '<ul class="reading-cards">' + records.slice(0, records.length - hidden).map(record => {
    const level = recordLevel(record);
    const values = METRICS.filter(m => record.vitals[m.key] != null).map(m => {
      const [mark, word] = statusOf(m.key, record.vitals);
      return '<li><span class="value-mark ' + mark + '" aria-hidden="true"></span><span>' + (m.key === "spo2" ? "SpO₂" : m.label) + (glucoseWhen(m.key, record.vitals) ? " (" + glucoseWhen(m.key, record.vitals) + ")" : "") + '</span><strong>' + esc(withUnit(valueOf(m.key, record.vitals), m.unit)) + '</strong><span class="visually-hidden">, ' + esc(word.toLowerCase()) + "</span></li>";
    }).join("");
    return '<li class="reading-card"><div class="reading-card-head"><div><strong>' + esc(when(record)) + '</strong><span class="source">' + esc(SOURCE_NAMES[record.vitals.source || "manual"]) + '</span></div><span class="tag ' + (level === "emergency" ? "alert" : level) + '">' + LEVELS[level] + "</span></div><ul>" + values +
      '</ul><button class="link-button" data-record="' + esc(record.id) + '">Xem chi tiết</button></li>';
  }).join("") + "</ul>" + (hidden ? '<button class="btn outline history-more" id="history-more">Hiển thị thêm (' + hidden + ")</button>" : "");
}
async function deleteAssessment(id) {
  if (state.viewing) return;
  if (!id || !await confirmAction("Xóa lần đo này?")) return;
  try {
    await api.deleteAssessment(id);
    closeDialog($("#result-dialog"));
    await Promise.all([refreshRecords(), refreshRisk()]);
    if (state.view === "history") renderTrends();
    toast("Đã xóa lần đo.");
  } catch (error) { toast(error.message, "error"); }
}
async function showResult(id) {
  const epoch = state.authEpoch;
  try {
    const r = await reader().assessment(id);
    if (epoch !== state.authEpoch) return;
    const level = levelOf(r);
    $("#result-detail").innerHTML = '<p class="note">' + (fromDocument(r) ? "Ghi trên giấy tờ ngày " + when(r) : "Đo lúc " + when(r) + ", " + esc(SOURCE_NAMES[r.measurement_source].toLowerCase())) + '</p><span class="tag ' + (level === "emergency" ? "alert" : level) + '">' + LEVELS[level] + "</span>" + (level === "emergency" && !fromDocument(r) ? '<p class="detail-gap"><a class="btn danger" href="tel:115">Gọi cấp cứu 115</a></p>' : "") + '<p class="detail-gap">' + (fromDocument(r) ? "Số liệu cũ từ giấy tờ." : esc(r.insight.summary)) + '</p><div class="result-detail-vitals">' + METRICS.map(m => "<div><span>" + m.label + "</span><strong>" + (r.measured_vitals?.[m.key] == null ? "Chưa đo" : withUnit(valueOf(m.key, r.measured_vitals), m.unit)) + "</strong></div>").join("") + "</div>" + (fromDocument(r) ? "" : alertsMarkup(r) + (r.insight.follow_up ? '<p class="note">' + esc(r.insight.follow_up) + "</p>" : ""));
    $("#delete-assessment").dataset.id = r.id;
    openDialog($("#result-dialog"));
  } catch (error) { toast(error.message, "error"); }
}
function bmiLabel(bmi) {
  // Asian cut-offs (WHO Western Pacific), as used by Vietnamese health guidance.
  return bmi < 18.5 ? "Thiếu cân" : bmi < 23 ? "Bình thường" : bmi < 25 ? "Thừa cân" : "Béo phì";
}
function familyNode(h, member, extraClass = "") {
  const saved = h.family_history.find(row => row.member_id === member.id);
  const known = saved?.knowledge === "known" && saved.conditions?.length;
  const kind = known ? "known" : saved?.knowledge === "none" ? "none" : "unknown";
  const text = known ? (saved.affected_count > 1 ? saved.affected_count + " người: " : "") + saved.conditions.map(conditionName).join(", ") + (saved.age_at_diagnosis ? " · chẩn đoán từ " + saved.age_at_diagnosis + " tuổi" : "") : kind === "none" ? "Không có bệnh đã biết" : "Chưa rõ";
  const provenance = saved?.knowledge && saved.knowledge !== "unknown"
    ? '<span class="ft-provenance">' + esc(FAMILY_HISTORY_SOURCE_LABEL[saved.source] || "Tôi tự khai") + (saved.last_confirmed_on ? " · " + esc(date(saved.last_confirmed_on, false)) : "") + "</span>" : "";
  const content = '<span class="ft-rel">' + member.label + '</span><span class="ft-state">' + esc(text) + "</span>" + provenance;
  return state.viewing
    ? '<div class="ft-node ' + kind + " " + extraClass + '">' + content + "</div>"
    : '<button type="button" class="ft-node ft-edit-node own-only ' + kind + " " + extraClass + '" data-edit-member="' + member.id + '" aria-label="Sửa tiền sử của ' + esc(member.label) + '">' + content + "</button>";
}
function familySummary(h) {
  const known = h.family_history.filter(row => row.knowledge === "known" && row.conditions?.length);
  const unknown = MEMBERS.length - h.family_history.filter(row => MEMBERS.some(m => m.id === row.member_id) && (row.knowledge === "known" || row.knowledge === "none")).length;
  const tally = {};
  known.forEach(row => row.conditions.forEach(key => { tally[key] = (tally[key] || 0) + (row.affected_count || 1); }));
  const parts = [];
  parts.push(known.length ? known.reduce((sum, row) => sum + (row.affected_count || 1), 0) + " người thân có bệnh đã biết: " + Object.entries(tally).map(([key, count]) => conditionName(key) + " (" + count + " người)").join(", ") + "." : "Chưa khai báo người thân nào có bệnh đã biết.");
  if (unknown) parts.push(unknown + " người chưa rõ tiền sử. Hỏi thêm gia đình để hồ sơ đầy đủ hơn.");
  return parts.map(text => "<p>" + esc(text) + "</p>").join("");
}
function sharedMedicationPanel() {
  const data = state.viewingMedications;
  if (!data) return '<article class="panel"><h2>Thuốc hôm nay</h2><p class="note">Đang tải thông tin được chia sẻ…</p></article>';
  if (!data.shared) return '<article class="panel"><h2>Thuốc hôm nay</h2><p class="note">Lịch thuốc chưa được chia sẻ với người thân.</p></article>';
  const medications = data.medications || [];
  if (!medications.length) return '<article class="panel"><h2>Thuốc hôm nay</h2><p class="note">Chưa có thuốc trong lịch hôm nay.</p></article>';
  const taken = new Set((data.intakes || []).map(row => row.medication_id + ":" + row.slot));
  const blocks = SLOTS.map(([slot, label]) => {
    const rows = medications.filter(item => item[slot]);
    if (!rows.length) return "";
    return '<section class="shared-medicine-slot"><h3>' + label + "</h3><ul>" + rows.map(item =>
      '<li><strong>' + esc(item.name + (item.strength ? " " + item.strength : "")) + '</strong><span>' + esc([item.amount, item.meal === "before" ? "Trước ăn" : item.meal === "after" ? "Sau ăn" : ""].filter(Boolean).join(" · ") || "Theo đơn") + '</span><span class="tag">' +
      (taken.has(item.id + ":" + slot) ? "✓ Đã uống" : "Chưa uống") + "</span></li>").join("") + "</ul></section>";
  }).join("");
  const asNeeded = medications.filter(item => !SLOTS.some(([slot]) => item[slot]));
  const needed = asNeeded.length ? '<section class="shared-medicine-slot"><h3>Khi cần</h3><ul>' + asNeeded.map(item =>
    '<li><strong>' + esc(item.name + (item.strength ? " " + item.strength : "")) + '</strong><span>' + esc(item.amount || "Theo đơn") + "</span></li>").join("") + "</ul></section>" : "";
  return '<article class="panel shared-medicine-panel"><h2>Thuốc hôm nay</h2><p class="note">Chỉ xem. Trạng thái uống do chủ hồ sơ ghi nhận.</p>' + blocks + needed + "</article>";
}
function renderProfile() {
  const h = state.health, p = h.profile;
  const conditions = p.known_conditions.map(conditionName).filter(Boolean);
  const bmi = p.weight_kg / (p.height_cm / 100) ** 2;
  const sex = { female: "Nữ", male: "Nam", other: "Khác / không khai báo" }[p.sex] || "Không khai báo";
  $("#profile-content").innerHTML =
    '<article class="panel"><div class="profile-identity">' +
    (state.viewing ? '<span class="avatar large" aria-hidden="true">' + esc(initialOf(h.display_name)) + '</span>' : '<span class="avatar large" data-avatar aria-hidden="true"></span>') +
    '<div><h2>' + esc(h.display_name) + '</h2><p class="note">' + esc(state.viewing ? "Hồ sơ được chia sẻ, chỉ xem" : state.user.email || "Hồ sơ mẫu") + '</p>' +
    (state.viewing ? "" : '<div class="avatar-actions"><button type="button" id="avatar-change" class="link-button">Đổi ảnh đại diện</button><button type="button" id="avatar-remove" class="link-button hidden">Xóa ảnh</button></div>') + '</div></div>' +
    '<dl class="facts facts-2col">' +
      "<div><dt>Tuổi</dt><dd>" + p.age + "</dd></div><div><dt>Giới tính</dt><dd>" + sex + "</dd></div>" +
      "<div><dt>Chiều cao</dt><dd>" + num(p.height_cm) + " cm</dd></div><div><dt>Cân nặng</dt><dd>" + num(p.weight_kg) + " kg</dd></div>" +
      "<div><dt>BMI</dt><dd>" + num(bmi) + ' <span class="fact-note">' + bmiLabel(bmi) + " (theo chuẩn châu Á)</span></dd></div><div><dt>Vận động</dt><dd>" + p.activity_minutes_week + " phút mỗi tuần</dd></div>" +
      "<div><dt>Bệnh đã chẩn đoán</dt><dd>" + esc(conditions.join(", ") || "Không khai báo") + "</dd></div><div><dt>Hút thuốc</dt><dd>" + (p.smoker ? "Có" : "Không") + "</dd></div>" +
      (state.viewing ? "" : "<div><dt>Dùng AI giải thích kết quả</dt><dd>" + (h.ai_consent ? "Đã cho phép" : "Chưa cho phép") + "</dd></div>") +
    "</dl>" + (h.personal_notes ? "<h3>Ghi chú</h3><p>" + esc(h.personal_notes) + "</p>" : "") + "</article>" +
    '<section class="section profile-family-section" aria-labelledby="profile-family-title"><div class="section-heading"><h2 id="profile-family-title">Gia đình & di truyền</h2></div>' +
    '<article class="panel profile-family-card"><div class="ft-summary">' + familySummary(h) + '</div>' +
    '<button class="profile-genetics-link" data-nav="genetics"><span class="profile-genetics-icon" data-icon="family"></span><span class="profile-genetics-copy"><strong>Hồ sơ di truyền gia đình</strong><small>Phả hệ · bệnh trong gia đình · kết quả xét nghiệm</small></span><span class="profile-genetics-arrow" data-icon="chevron"></span></button></article></section>' +
    (state.viewing ? sharedMedicationPanel() : "");
  hydrateIcons($("#profile-content"));
  if (!state.viewing) renderAvatar();
}

// Family-history grouping, not an individual disease probability. The meter summarizes only how many/which relatives were reported.
const RISK_LEVELS = {
  very_high: { tone: "attention", label: "Nhiều người thân", bars: 3 }, high: { tone: "attention", label: "Có người thân gần", bars: 2 }, moderate: { tone: "moderate", label: "Có ông/bà", bars: 1 },
  diagnosed: { tone: "diagnosed", label: "Đã khai báo chẩn đoán" }, unknown: { tone: "neutral", label: "Chưa rõ tiền sử" }, none: { tone: "neutral", label: "Chưa ghi nhận" },
};
const riskLevel = level => '<span class="status-word risk-level ' + RISK_LEVELS[level].tone + '">' + RISK_LEVELS[level].label + "</span>";
const riskMeter = level => '<span class="risk-meter ' + RISK_LEVELS[level].tone + '" aria-hidden="true">' + [1, 2, 3].map(n => "<i" + (n <= RISK_LEVELS[level].bars ? ' class="on"' : "") + "></i>").join("") + "</span>";
function riskWho(row) {
  const names = row.relatives.map(id => id === "sibling" && row.sibling_count > 1 ? row.sibling_count + " anh chị em ruột" : MEMBERS.find(m => m.id === id)?.label).filter(Boolean);
  const label = state.viewing ? "Người thân của " + state.viewing.name + " mắc bệnh" : "Người thân mắc bệnh";
  return names.length ? '<p class="risk-who"><span class="risk-who-label">' + esc(label) + "</span>" + names.map(name => "<span>" + esc(name) + "</span>").join("") + "</p>" : "";
}
async function refreshRisk() {
  const epoch = state.authEpoch;
  try {
    const risk = await (state.viewing ? api.careRisk(state.viewing.id) : api.risk());
    if (epoch !== state.authEpoch) return;
    state.risk = risk; state.riskFailed = false;
  } catch { if (epoch !== state.authEpoch) return; state.risk = null; state.riskFailed = true; }
  renderScores();
  if (state.view !== "genetics") return;
  renderGenetics();
  // New content that appears in place gets the same small rise as a tab view.
  const content = $("#genetics-content");
  content.classList.remove("refreshed"); void content.offsetWidth; content.classList.add("refreshed");
}
// The family and body scores come live from the profile, so they follow profile edits without a new reading.
function renderScores() {
  const s = state.risk?.scores || state.result?.scores;
  if (!s) return;
  const unknown = state.risk?.relatives_unknown || 0;
  $("#risk-score").textContent = s.overall == null ? "-" : Math.round(s.overall);
  const of100 = v => Math.round(v) + "/100";
  $("#pgrs-score").textContent = state.risk && unknown === state.risk.relatives_total ? "Chưa rõ" : of100(s.pgrs);
  $("#brs-score").textContent = of100(s.brs);
  $("#vital-score").textContent = s.vitals == null ? "-" : of100(s.vitals);
  $("#score-family-note").textContent = unknown ? "Còn " + unknown + " người thân chưa rõ tiền sử, chưa được tính vào điểm tiền sử gia đình." : "";
  $("#score-family-note").classList.toggle("hidden", !unknown);
}
const FAMILY_RELATIONS = [["parent", "Cha/mẹ"], ["child", "Con"], ["sibling", "Anh/chị/em ruột"], ["grandparent", "Ông/bà"], ["grandchild", "Cháu"], ["other", "Người thân khác"]];
function renderFamilyLinks() {
  const host = $("#family-links-content");
  if (!host) return;
  const relationOptions = FAMILY_RELATIONS.map(([id, label]) => '<option value="' + id + '">' + label + "</option>").join("");
  const invite = state.familyInviteCode
    ? '<div class="family-invite-code"><strong>' + esc(state.familyInviteCode.code.slice(0, 4) + " " + state.familyInviteCode.code.slice(4)) +
      '</strong><span>Mã dùng một lần · hết hạn ' + esc(date(state.familyInviteCode.expires_at)) + '</span><small>Người bạn mời: ' + esc(state.familyInviteCode.relative_relation_label) + '</small></div>'
    : "";
  const preview = state.familyInvitePreview
    ? '<div class="family-invite-preview"><p><strong>' + esc(state.familyInvitePreview.display_name) + '</strong> xác nhận họ là <strong>' + esc(state.familyInvitePreview.inviter_relation_label) + '</strong> của bạn.</p>' +
      '<label class="check-label"><input id="family-confirm-relationship" type="checkbox"><span>Tôi xác nhận đây là quan hệ gia đình của mình.</span></label>' +
      '<button type="button" class="btn primary" id="family-invite-accept" disabled>Đồng ý liên kết</button></div>'
    : "";
  const relatives = state.familyLinks.relatives.length
    ? '<div class="family-link-list">' + state.familyLinks.relatives.map(relative => {
      const conditions = (relative.conditions || []).map(conditionName).filter(Boolean);
      const shared = relative.their_share
        ? '<p class="family-shared-conditions"><strong>Bệnh đã tự khai báo:</strong> ' + esc(conditions.join(", ") || "Chưa khai báo bệnh trong nhóm này") + '</p>'
        : '<p class="note">Người thân chưa bật chia sẻ bệnh di truyền.</p>';
      return '<article class="family-link-card"><div class="family-link-head"><div><h3>' + esc(relative.display_name) + '</h3><p class="note">' + esc(relative.relation_label) + ' · Đã xác nhận quan hệ</p></div>' +
        '<button type="button" class="delete-record" data-family-remove="' + esc(relative.link_id) + '">Ngắt liên kết</button></div>' + shared +
        '<label class="check-label family-sharing-toggle"><input type="checkbox" data-family-share="' + esc(relative.link_id) + '"' + (relative.my_share ? " checked" : "") + '><span>Cho phép người thân xem bệnh di truyền tôi đã tự khai báo</span></label>' +
        '<p class="note family-share-note">Chỉ chia sẻ tên bệnh đã khai báo trong nhóm di truyền; không chia sẻ xét nghiệm, thuốc hay hồ sơ khác. Đây không phải xác nhận gen hoặc chẩn đoán.</p></article>';
    }).join("") + "</div>"
    : '<p class="note">Chưa có tài khoản người thân nào được liên kết.</p>';
  host.innerHTML = '<section class="section genetics-section family-connections-section" aria-labelledby="family-connections-title">' +
    '<div class="section-heading"><h2 id="family-connections-title">Liên kết người thân</h2></div>' +
    '<p class="note">Hai bên xác nhận quan hệ. Mỗi tài khoản tự chọn có chia sẻ bệnh di truyền đã khai báo hay không.</p>' +
    '<div class="panel family-invite-panel"><h3>Mời người thân</h3><label for="family-relation-select">Người bạn mời là gì của bạn?</label><div class="family-invite-controls"><select id="family-relation-select">' + relationOptions + '</select><button type="button" class="btn outline" id="family-create-invite">Tạo mã mời</button></div>' + invite + '</div>' +
    '<details id="family-join-panel" class="panel family-join-panel"><summary>Nhập mã người thân gửi cho bạn</summary><form id="family-invite-preview-form" class="care-form"><label>Mã mời<input id="family-invite-code" value="' + esc(state.familyInvitePreview?.code || "") + '" autocomplete="off" autocapitalize="characters" maxlength="16" required></label><button class="btn primary" type="submit">Xem lời mời</button></form>' +
    '<p id="family-invite-error" class="inline-message error hidden" role="alert"></p>' + preview + '</details>' +
    '<div class="family-links-heading"><h3>Người thân đã liên kết</h3></div>' + relatives +
    '<p class="note family-privacy-note">Chỉ liên kết trực tiếp giữa hai tài khoản. Bệnh lấy từ hồ sơ hiện tại và cập nhật khi bạn mở lại mục này; không tự động sửa hồ sơ gia đình hay suy đoán bệnh của người khác.</p></section>';
}
async function refreshFamilyLinks() {
  const epoch = state.authEpoch;
  try {
    const links = await api.familyLinks();
    if (epoch !== state.authEpoch) return;
    state.familyLinks = links;
  } catch {
    if (epoch !== state.authEpoch) return;
    state.familyLinks = { relatives: [] };
  }
  renderFamilyLinks();
}
function renderGenetics() {
  renderFamilyLinks();
  const h = state.health, p = h.profile;
  const member = id => MEMBERS.find(m => m.id === id);
  const conditions = p.known_conditions.map(conditionName).filter(Boolean);
  const notes = [["Bên nội", h.paternal_notes], ["Bên ngoại", h.maternal_notes]].filter(([, text]) => text);
  const order = Object.keys(RISK_LEVELS);
  const rows = (state.risk?.conditions || []).slice().sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const of = (...levels) => rows.filter(row => levels.includes(row.level));
  const raised = of("very_high", "high", "moderate"), diagnosed = of("diagnosed"), rest = of("unknown", "none");
  const allUnknown = rows.length > 0 && rows.every(row => row.level === "unknown");
  const edit = primary => '<button class="btn ' + (primary ? "primary" : "outline") + ' own-only" data-edit-family>' + (primary ? "Cập nhật tiền sử gia đình" : "Sửa tiền sử gia đình") + "</button>";
  $("#genetics-lead").textContent = "Tiền sử gia đình, xét nghiệm và việc cần trao đổi với bác sĩ — trong một nơi.";
  // The disease name comes first in the markup so heading navigation reads name then level; CSS shows the level strip on top.
  const card = row => { const level = RISK_LEVELS[row.level]; return '<article class="risk-card ' + level.tone + '"><div class="risk-card-body"><h3>' + conditionName(row.condition) + '<span class="visually-hidden">, tiền sử: ' + level.label.toLowerCase() + "</span></h3>" +
    (row.level === "diagnosed" ? "<p>Bạn đã khai báo bệnh này trong hồ sơ.</p>" : "") + riskWho(row) + (row.advice ? (matchMedia("(max-width: 760px)").matches ? '<details class="record-details risk-do-fold"><summary>Nên làm</summary><p class="risk-do">' + esc(row.advice) + "</p></details>" : '<p class="risk-do"><strong>Nên làm:</strong> ' + esc(row.advice) + "</p>") : "") +
    '</div><div class="risk-card-top" aria-hidden="true">' + riskLevel(row.level) + (level.bars ? riskMeter(row.level) : "") + "</div></article>"; };
  const section = (id, title, body, action = "") => '<section class="section genetics-section" aria-labelledby="genetics-' + id + '"><div class="section-heading"><h2 id="genetics-' + id + '">' + title + "</h2>" + action + "</div>" + body + "</section>";
  const key = '<details class="panel risk-key genetics-fold"><summary>Cách xếp nhóm tiền sử</summary><p class="note">Đây là phân nhóm minh họa theo số lượng và quan hệ người thân được khai báo — không phải xác suất mắc bệnh hay kết luận di truyền.</p><ul>' +
    "<li>" + riskLevel("very_high") + riskMeter("very_high") + "<span>Từ hai người trong số bố, mẹ, anh chị em mắc bệnh. Hoặc một người trong số đó và thêm ông hoặc bà.</span></li>" +
    "<li>" + riskLevel("high") + riskMeter("high") + "<span>Một người trong số bố, mẹ, anh chị em mắc bệnh. Hoặc hai ông bà cùng một bên.</span></li>" +
    "<li>" + riskLevel("moderate") + riskMeter("moderate") + "<span>Chỉ có ông hoặc bà mắc bệnh.</span></li></ul></details>";
  const restList = '<div class="panel risk-rest">' + rest.map(row => '<div class="risk-rest-row"><strong>' + conditionName(row.condition) + "</strong>" + riskLevel(row.level) + "</div>").join("") + "</div>";
  const familyNote = '<p class="note genetics-method-note">Phần này tổng hợp bệnh mạn tính thường gặp theo người thân đã khai báo. Mức chỉ dựa trên số lượng và quan hệ trong gia đình; ứng dụng chưa xét tuổi khởi phát, hồ sơ xét nghiệm hay nguyên nhân gen.</p>';
  const risk = !state.risk
    ? (state.riskFailed ? '<article class="panel empty-state"><h2>Chưa tải được mức nguy cơ</h2><p>Hồ sơ của bạn vẫn được lưu. Hãy kiểm tra kết nối mạng rồi thử lại.</p><button class="btn outline" id="retry-risk">Thử lại</button></article>' : "")
    : allUnknown
      ? section("rest", "Tiền sử các bệnh thường gặp", '<details class="panel genetics-fold"><summary>Xem các bệnh chưa rõ tiền sử</summary><p class="note">Nếu chưa biết, giữ “Chưa rõ”; không nên đoán.</p>' + restList + '</details>')
      : (raised.length || diagnosed.length ? '<p class="genetics-reassure">Tiền sử gia đình là một phần thông tin sức khỏe — không cho biết chắc chắn ai sẽ mắc bệnh.</p>' : "") +
        (raised.length ? section("raised", "Bệnh có tiền sử trong gia đình", familyNote + '<div class="risk-grid">' + raised.map(card).join("") + "</div>" + key) : "") +
        (diagnosed.length ? section("diagnosed", "Bệnh bạn đã khai báo được chẩn đoán", '<div class="risk-grid">' + diagnosed.map(card).join("") + "</div>") : "") +
        (rest.length ? section("rest", "Các bệnh chưa ghi nhận hoặc chưa rõ", restList) : "");
  const introduction = '<section class="section genetics-section genetics-intro-section" aria-labelledby="genetics-intro-title"><article class="panel genetics-intro"><span class="genetics-eyebrow">HỒ SƠ DI TRUYỀN</span><h2 id="genetics-intro-title">Hiểu sức khỏe qua các thế hệ</h2><p>Ghi lại bệnh trong gia đình, lưu phiếu xét nghiệm và chuẩn bị câu hỏi cho buổi tư vấn. <strong>Tiền sử gia đình không phải kết quả xét nghiệm gen.</strong></p><div class="genetics-distinction"><span><strong>Tiền sử gia đình</strong><small>Thông tin người thân khai báo</small></span><span aria-hidden="true">≠</span><span><strong>Kết quả xét nghiệm</strong><small>Nội dung trên phiếu đã lưu</small></span></div>' + edit(true) + '</article></section>';
  $("#genetics-content").innerHTML = introduction + geneticsOverview(h) + geneticsDocuments(section) + geneticsQuestions(section) + (state.risk ? hereditarySection(section) : "") + risk +
    section("tree", "Sơ đồ gia đình", '<p class="note genetics-tree-note">Sơ đồ minh họa bạn, bố mẹ, anh chị em và ông bà theo dữ liệu đã khai báo. Thông tin chưa rõ không được xem là không có bệnh.</p><details class="panel genetics-fold genetics-family-fold"><summary>Xem sơ đồ 3 thế hệ</summary><div class="genetics-family-content"><div class="ft-summary">' + geneticsFamilySummary(h) + "</div>" +
    '<div class="family-tree" role="group" aria-label="Sơ đồ gia đình ba thế hệ">' +
      '<span class="ft-side ft-side-p">Bên nội</span><span class="ft-side ft-side-m">Bên ngoại</span>' +
      familyNode(h, member("paternal-grandfather"), "ft-pgf") + familyNode(h, member("paternal-grandmother"), "ft-pgm") +
      familyNode(h, member("maternal-grandfather"), "ft-mgf") + familyNode(h, member("maternal-grandmother"), "ft-mgm") +
      '<span class="ft-join ft-join-p"></span><span class="ft-join ft-join-m"></span>' +
      familyNode(h, member("father"), "ft-father") + familyNode(h, member("mother"), "ft-mother") +
      '<span class="ft-join ft-join-c"></span><span class="ft-side ft-side-c">' + (state.viewing ? esc(h.display_name) : "Bạn") + " và anh chị em</span>" +
      '<div class="ft-children"><div class="ft-node you ' + (conditions.length ? "known" : "none") + '"><span class="ft-rel">' + (state.viewing ? esc(h.display_name) : "Bạn") + '</span><span class="ft-state">' + esc(conditions.join(", ") || "Không khai báo bệnh") + "</span></div>" + familyNode(h, member("sibling")) + "</div>" +
    "</div>" +
    '<ul class="ft-legend"><li><span class="ft-key known"></span>Có bệnh</li><li><span class="ft-key none"></span>Chưa ghi nhận</li><li><span class="ft-key unknown"></span>Chưa rõ</li></ul>' +
    (notes.length ? '<details class="record-details genetics-fold genetics-notes"><summary>Ghi chú gia đình</summary><ul>' + notes.map(([title, text]) => "<li><strong>" + esc(title) + ":</strong> " + esc(text) + "</li>").join("") + "</ul></details>" : "") + "</div></details>", allUnknown ? "" : edit(false)) +
    geneticGuideMarkup() + '<p class="note genetics-disclaimer">Đây là bản tổng hợp thông tin tự khai và giấy tờ đã lưu, không phải chẩn đoán hay kết quả đọc ADN. Hãy trao đổi với bác sĩ hoặc chuyên gia di truyền trước khi quyết định xét nghiệm hay điều trị.</p>';
}

function geneticsOverview(h) {
  const known = h.family_history.filter(row => row.knowledge === "known" && row.conditions?.length);
  const unknown = MEMBERS.filter(member => !h.family_history.some(row => row.member_id === member.id && row.knowledge !== "unknown")).length;
  const hereditary = (state.risk?.hereditary || []).filter(row => row.status === "ask_doctor").length;
  const reports = state.viewing ? [] : state.medicalRecords.filter(record => record.analysis.document_type === "genetic_test_report");
  const findings = reports.reduce((count, record) => count + (record.analysis.genetic_findings || []).length, 0);
  const pendingReview = reports.reduce((count, record) => count + (record.analysis.genetic_findings || []).filter(finding => !finding.evidence_review_on).length, 0);
  const steps = [
    unknown && !state.viewing ? '<button type="button" class="genetics-next-step" data-edit-family><strong>Hỏi thêm ' + unknown + ' người thân chưa rõ</strong><span>Ghi bệnh và tuổi được chẩn đoán nếu gia đình biết.</span></button>' :
    unknown ? '<div class="genetics-next-step"><strong>Còn ' + unknown + ' người thân chưa rõ</strong><span>Chủ hồ sơ có thể bổ sung khi biết thêm.</span></div>' :
      '<div class="genetics-next-step"><strong>Tiền sử đã được khai báo</strong><span>Cập nhật khi gia đình có thông tin mới.</span></div>',
    state.viewing ? '' : reports.length ? '<button type="button" class="genetics-next-step" data-open-genetic-record="' + esc(reports[0].id) + '"><strong>' + (pendingReview ? 'Còn ' + pendingReview + ' mục chưa ghi nhận đối chiếu' : 'Xem phiếu di truyền gần nhất') + '</strong><span>So với bản gốc và hỏi chuyên gia khi chưa rõ.</span></button>' :
      '<button type="button" class="genetics-next-step" data-open-manual-genetics><strong>Nhập kết quả từ phiếu di truyền</strong><span>Chép gen, biến thể và kết luận từ phiếu gốc; không cần AI.</span></button>',
    '<button type="button" class="genetics-next-step" data-open-genetics-summary><strong>' + (hereditary ? 'Chuẩn bị trao đổi về ' + hereditary + ' chủ đề' : 'Tạo phiếu mang đến bác sĩ') + '</strong><span>Tổng hợp tiền sử và kết quả đã lưu để cùng xem.</span></button>',
  ].filter(Boolean).join('');
  return '<section class="section genetics-section genetics-overview" aria-labelledby="genetics-overview-title"><div class="section-heading"><h2 id="genetics-overview-title">' + (state.viewing ? 'Hồ sơ di truyền của ' + esc(h.display_name) : 'Hồ sơ di truyền của bạn') + '</h2></div>' +
    '<div class="genetics-overview-grid' + (state.viewing ? ' compact' : '') + '"><article class="panel genetics-overview-stat"><strong>' + known.length + '</strong><span>nhóm người thân có bệnh đã khai</span></article>' +
    (state.viewing ? '<article class="panel genetics-overview-stat"><strong>' + hereditary + '</strong><span>chủ đề nên trao đổi với bác sĩ</span></article>' :
      '<article class="panel genetics-overview-stat"><strong>' + reports.length + '</strong><span>phiếu xét nghiệm di truyền đã lưu</span></article>' +
      '<article class="panel genetics-overview-stat"><strong>' + findings + '</strong><span>mục gen/biến thể chép từ phiếu</span></article>') + '</div>' +
    '<div class="genetics-next-panel"><h3>Việc tiếp theo</h3><div class="genetics-next-list">' + steps + '</div></div>' +
    '<p class="note genetics-overview-note">Các con số là dữ liệu đã khai hoặc đã lưu, không phải điểm nguy cơ hay chẩn đoán.</p></section>';
}

function geneticsDocuments(section) {
  if (state.viewing) return '';
  const reports = state.medicalRecords.filter(record => record.analysis.document_type === "genetic_test_report");
  const content = reports.length ? '<div class="genetics-document-list">' + reports.map(record => {
    const findings = record.analysis.genetic_findings || [];
    const genes = [...new Set(findings.map(finding => finding.gene).filter(Boolean))];
    const reviewed = findings.filter(finding => finding.evidence_review_on).length;
    return '<article class="panel genetics-document"><div><span class="genetics-document-date">' + esc(record.analysis.document_date ? date(record.analysis.document_date, false) : date(record.created_at, false)) + '</span><h3>' + esc(record.analysis.title || 'Phiếu xét nghiệm di truyền') + '</h3><p>' + esc(genes.length ? 'Gen ghi trên phiếu: ' + genes.join(', ') : 'Chưa trích được tên gen từ phiếu') + '</p><small>' + (findings.length ? reviewed + '/' + findings.length + ' mục đã ghi nhận tự đối chiếu' : 'Chưa trích được mục biến thể có cấu trúc') + '</small></div><button type="button" class="btn outline" data-open-genetic-record="' + esc(record.id) + '">Xem phiếu</button></article>';
  }).join('') + '</div>' : '<article class="panel genetics-document-empty"><p>Chưa có phiếu xét nghiệm di truyền đã lưu. Bạn có thể chép thông tin từ phiếu gốc' + (state.documentAiEnabled ? ' hoặc dùng AI đọc ảnh rồi tự kiểm tra' : '') + '.</p><div class="genetics-document-actions"><button type="button" class="btn primary" data-open-manual-genetics>Nhập từ phiếu</button>' + (state.documentAiEnabled ? '<button type="button" class="btn outline" data-open-upload>Chụp phiếu</button>' : '') + '</div></article>';
  return section('documents', 'Kết quả xét nghiệm di truyền', content + '<p class="note">Kết quả nhập tay hoặc AI hỗ trợ đều cần đối chiếu với phiếu gốc. GeneSense không tự kết luận biến thể gây bệnh.</p>');
}

function geneticConsultationQuestions() {
  const history = state.health.family_history || [];
  const unknown = MEMBERS.filter(member => !history.some(row => row.member_id === member.id && row.knowledge !== "unknown")).length;
  const flagged = (state.risk?.hereditary || []).filter(row => row.status === "ask_doctor");
  const reports = state.viewing ? [] : state.medicalRecords.filter(record => record.analysis.document_type === "genetic_test_report");
  const findings = reports.flatMap(record => record.analysis.genetic_findings || []);
  const questions = [];
  if (reports.length) questions.push("Kết luận trên phiếu xét nghiệm có ý nghĩa gì khi xét cùng triệu chứng và tiền sử gia đình?");
  else if (!state.viewing) questions.push("Với tiền sử hiện tại, có cần xét nghiệm di truyền không? Nếu có, nên hỏi về loại xét nghiệm nào?");
  if (findings.some(finding => /\bVUS\b|uncertain|chưa rõ|không rõ/i.test(finding.classification || "")))
    questions.push("Phiếu có biến thể chưa rõ ý nghĩa: hiện nên hiểu và theo dõi lại kết luận này như thế nào?");
  if (flagged.length) {
    const topics = flagged.slice(0, 2).map(row => SCREENS[row.condition] || row.condition).join(" và ");
    questions.push("Tiền sử liên quan " + topics + (flagged.length > 2 ? " và các mục khác" : "") + " có cần đánh giá chuyên khoa hoặc tư vấn di truyền không?");
  }
  if (unknown) questions.push("Nên hỏi thêm bệnh nào và tuổi chẩn đoán của " + unknown + " người thân chưa rõ tiền sử?");
  questions.push("Thông tin nào nên chia sẻ với người thân, và cần bảo vệ quyền riêng tư ra sao?");
  return questions;
}

function geneticsQuestions(section) {
  return section("questions", "Câu hỏi cho buổi tư vấn di truyền", '<div class="panel genetics-questions"><p>Chọn câu phù hợp để trao đổi với bác sĩ hoặc chuyên gia di truyền. Đây là gợi ý chuẩn bị, không phải chỉ định xét nghiệm.</p><ol>' +
    geneticConsultationQuestions().map(question => '<li>' + esc(question) + '</li>').join('') +
    '</ol><div class="genetics-question-actions"><button type="button" class="btn outline" data-open-genetics-summary>Tạo phiếu tổng hợp</button><a href="https://medlineplus.gov/genetics/understanding/consult/expectations/" target="_blank" rel="noopener noreferrer">Tìm hiểu về tư vấn di truyền</a></div></div>');
}

function geneticsFamilySummary(h) {
  const known = h.family_history.filter(row => row.knowledge === "known" && row.conditions?.length);
  const people = known.reduce((sum, row) => sum + (row.affected_count || 1), 0);
  const unknown = MEMBERS.length - h.family_history.filter(row => MEMBERS.some(member => member.id === row.member_id) && (row.knowledge === "known" || row.knowledge === "none")).length;
  const recorded = people ? people + " người thân có bệnh được ghi nhận" : "Chưa ghi nhận bệnh trong gia đình";
  return "<p><strong>" + esc(recorded) + "</strong>" + (unknown ? " · " + unknown + " người chưa rõ" : " · Đã khai báo đủ") + "</p>";
}

function geneticGuideMarkup() {
  const cards = GENETIC_GUIDES.map(guide => '<details class="panel genetics-guide genetics-fold"><summary><span class="genetics-guide-heading"><strong>' + esc(guide.title) + '</strong><small>' + esc(guide.summary) +
    '</small></span></summary><div class="genetics-guide-details"><p><strong>Di truyền:</strong> ' + esc(guide.inheritance) + '</p><p><strong>Bước tiếp theo:</strong> ' + esc(guide.next) + '</p></div><p class="genetics-source-label">Nguồn đọc thêm · MedlinePlus, Thư viện Y khoa Quốc gia Hoa Kỳ</p><div class="genetics-sources">' + guide.links.map(([label, url]) =>
      '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>').join("") +
    '</div></details>').join("");
  const terms = [["Gen", "Một đoạn ADN chứa thông tin để cơ thể tạo ra sản phẩm hoặc thực hiện chức năng."], ["Biến thể", "Một khác biệt trong ADN. Có biến thể lành tính, chưa rõ ý nghĩa hoặc liên quan bệnh; không phải biến thể nào cũng gây bệnh."], ["Người mang gen", "Người có một biến thể liên quan bệnh nhưng có thể không có triệu chứng. Ý nghĩa phụ thuộc gen và kiểu di truyền."], ["Phả hệ", "Sơ đồ quan hệ và tiền sử bệnh đã biết trong gia đình; không xác nhận nguyên nhân do gen hay tình trạng mang gen."]];
  const glossary = '<details class="panel genetics-glossary genetics-fold"><summary>Giải nghĩa nhanh 4 thuật ngữ</summary><dl>' + terms.map(([term, meaning]) => '<div><dt>' + esc(term) + '</dt><dd>' + esc(meaning) + '</dd></div>').join("") + '</dl></details>';
  return '<section class="section genetics-section" aria-labelledby="genetics-guides"><div class="section-heading"><h2 id="genetics-guides">Tìm hiểu bốn nhóm bệnh</h2></div><p class="note genetics-learning-note">Chạm vào từng mục để xem bệnh là gì, kiểu di truyền có thể gặp và câu hỏi nên mang tới buổi khám.</p><div class="genetics-guide-list">' + cards + '</div>' + glossary + '</section>';
}

// Single-gene hereditary conditions: flagged ones as cards, the others one line per status. Advice only, never a diagnosis.
function hereditarySection(section) {
  const compact = matchMedia("(max-width: 760px)").matches;
  const screens = state.risk?.hereditary || [];
  if (!screens.length) return "";
  const label = id => id === "sibling" ? "Anh chị em ruột" : HEREDITARY_WHO.find(([who]) => who === id)?.[1];
  const names = rows => rows.map(row => SCREENS[row.condition]).join(", ");
  const flagged = screens.filter(row => row.status === "ask_doctor");
  const advice = row => compact
    ? '<details class="record-details risk-do-fold"><summary>Nên làm</summary><p class="risk-do">' + esc(row.advice) + "</p></details>"
    : '<p class="risk-do"><strong>Nên làm:</strong> ' + esc(row.advice) + "</p>";
  const card = row => '<article class="panel hereditary-card"><span class="tag info">' + icon("info") + "Nên hỏi bác sĩ</span><h3>" + SCREENS[row.condition] + "</h3>" +
    '<details class="record-details genetics-fold genetics-why"><summary>Vì sao cần lưu ý?</summary><p class="note">' + esc(PATTERNS[row.pattern]) + "</p>" + row.reasons.map(text => "<p>" + esc(text) + "</p>").join("") + "</details>" +
    (row.relatives.length ? '<p class="risk-who"><span class="risk-who-label">Người thân liên quan</span>' + row.relatives.map(id => "<span>" + esc(label(id) || id) + "</span>").join("") + "</p>" : "") +
    advice(row) + "</article>";
  const line = (status, text, action = "") => { const rows = screens.filter(row => row.status === status); return rows.length ? "<p><strong>" + text + ":</strong> " + names(rows) + action + "</p>" : ""; };
  const rest = line("diagnosed", "Bạn khai báo đã được chẩn đoán") + line("not_seen", "Chưa ghi nhận trong tiền sử đã khai báo") +
    line("not_enough_info", "Chưa rõ tiền sử gia đình", ' <button type="button" class="link-button own-only" data-edit-hereditary>Cập nhật thông tin</button>');
  const note = '<p class="note genetics-method-note">Bốn mục dưới đây chỉ rà soát tiền sử gia đình để gợi ý trao đổi với bác sĩ. “Chưa ghi nhận” không loại trừ người mang gen hoặc bệnh; ứng dụng không đọc ADN.</p>';
  return section("hereditary", "Bệnh di truyền được rà soát", note +
    (flagged.length ? '<div class="risk-grid">' + flagged.map(card).join("") + "</div>" : "") + '<div class="panel hereditary-rest">' + rest + "</div>");
}

// Doctor's report: an A4 page built from the user's readings, saved as PDF through the print dialog.
// ponytail: uses the readings already loaded (latest 100); add a date-range API if longer histories matter.
const reportCharts = {};
function reportRows(days) {
  const since = Date.now() - days * 86400000;
  return state.records.filter(row => toDate(row.created_at).getTime() >= since).reverse();
}
function reportSummary(rows) {
  // Same rounding as the readings table below, so the lowest and highest values can be found in it.
  const fix = (value, digits) => num(Number(value.toFixed(digits)));
  const stat = (values, digits = 0) => values.length ? { n: values.length, avg: fix(values.reduce((a, b) => a + b, 0) / values.length, digits), min: fix(Math.min(...values), digits), max: fix(Math.max(...values), digits) } : null;
  const flagged = key => rows.filter(row => ["attention", "alert"].includes(statusOf(key, row.vitals)[0])).length;
  const bp = rows.filter(row => row.vitals.systolic != null && row.vitals.diastolic != null);
  const sys = stat(bp.map(row => row.vitals.systolic)), dia = stat(bp.map(row => row.vitals.diastolic));
  // Lowest and highest are whole readings (picked by systolic), so the pair shown was really measured together.
  const pair = row => Math.round(row.vitals.systolic) + "/" + Math.round(row.vitals.diastolic);
  const bySys = bp.slice().sort((x, y) => x.vitals.systolic - y.vitals.systolic);
  const line = (label, unit, s, over) => "<tr><td>" + label + "</td><td>" + unit + "</td>" + (s ? "<td>" + s.n + "</td><td>" + s.avg + "</td><td>" + s.min + "</td><td>" + s.max + "</td><td>" + over + "</td>" : '<td colspan="5">Không có số đo trong kỳ</td>') + "</tr>";
  const single = (key, label, unit, digits) => line(label, unit, stat(rows.filter(row => row.vitals[key] != null).map(row => row.vitals[key]), digits), flagged(key));
  return line("Huyết áp", "mmHg", sys && { n: sys.n, avg: sys.avg + "/" + dia.avg, min: pair(bySys[0]), max: pair(bySys.at(-1)) }, flagged("systolic")) +
    single("heart_rate", "Nhịp tim", "lần/phút", 0) + single("spo2", "Oxy trong máu (SpO₂)", "%", 1) + single("glucose", "Đường huyết", "mg/dL", 0);
}
function renderReport() {
  const days = Number($("#report-days").value);
  const rows = reportRows(days);
  // Only the latest 100 readings are loaded; say so when the period reaches further back than they do.
  const oldest = state.records.length >= 100 ? toDate(state.records.at(-1).created_at) : null;
  const cut = oldest && oldest.getTime() > Date.now() - days * 86400000;
  const h = state.health, p = h.profile, now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const code = "GS-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
  const bmi = p.weight_kg / (p.height_cm / 100) ** 2;
  const sex = { female: "Nữ", male: "Nam", other: "Không khai báo" }[p.sex] || "Không khai báo";
  const cell = (key, v) => v[key] == null ? "" : valueOf(key, v) + (glucoseWhen(key, v) ? " (" + glucoseWhen(key, v) + ")" : "");
  const mark = v => { const levels = METRICS.map(m => statusOf(m.key, v)[0]); return levels.includes("alert") ? "Nguy hiểm" : levels.includes("attention") ? "Cần chú ý" : ""; };
  const extendedMembers = [...MEMBERS, ...(h.family_history.some(row => row.member_id === "maternal-uncle")
    ? [{ id: "maternal-uncle", label: "Cậu (anh/em trai của mẹ)" }] : [])];
  const family = extendedMembers.map(m => {
    const saved = h.family_history.find(row => row.member_id === m.id);
    const text = saved?.knowledge === "known" && saved.conditions?.length ? (saved.affected_count > 1 ? saved.affected_count + " người: " : "") + saved.conditions.map(conditionName).join(", ") : saved?.knowledge === "none" ? "Không có bệnh đã biết" : "Chưa rõ";
    const source = saved?.knowledge === "unknown" || !saved ? "Chưa rõ nguồn" : (FAMILY_HISTORY_SOURCE_LABEL[saved.source] || "Tôi tự khai");
    return "<tr><td>" + m.label + "</td><td>" + esc(text) + "</td><td>" + (saved?.age_at_diagnosis ? esc(saved.age_at_diagnosis + " tuổi") : "") + "</td><td>" + esc(source) + "</td><td>" + esc(saved?.last_confirmed_on ? date(saved.last_confirmed_on, false) : "") + "</td></tr>";
  }).join("");
  const hereditaryConcerns = (state.risk?.hereditary || []).filter(item => item.status === "ask_doctor");
  const hereditaryTable = hereditaryConcerns.length ? '<table class="report-table"><thead><tr><th>Chủ đề</th><th>Lý do từ tiền sử đã khai</th><th>Gợi ý trao đổi</th></tr></thead><tbody>' + hereditaryConcerns.map(item =>
    "<tr><td>" + esc(SCREENS[item.condition] || item.condition) + "</td><td>" + esc((item.reasons || []).join(" ")) + "</td><td>" + esc(item.advice || "Trao đổi với bác sĩ.") + "</td></tr>").join("") + "</tbody></table>" : "<p>Chưa có gợi ý trao đổi nào được ghi nhận từ thông tin hiện tại.</p>";
  const geneticDocuments = state.viewing ? [] : state.medicalRecords.filter(record => record.analysis.document_type === "genetic_test_report");
  const geneticResultRows = geneticDocuments.flatMap(record => (record.analysis.genetic_findings || []).map(finding =>
    "<tr><td>" + esc(record.analysis.document_date ? date(record.analysis.document_date, false) : date(record.created_at, false)) + "</td><td>" + esc(finding.gene || "") + "</td><td>" + esc(finding.variant || "") + "</td><td>" + esc(finding.classification || "") + "</td></tr>"));
  const geneticDocumentTable = geneticDocuments.length ? '<p>Kết quả dưới đây được chép từ giấy tờ người dùng đã xác nhận; GeneSense không diễn giải lại.</p>' +
    (geneticResultRows.length ? '<table class="report-table"><thead><tr><th>Ngày</th><th>Gen</th><th>Biến thể ghi trên phiếu</th><th>Kết luận phòng xét nghiệm</th></tr></thead><tbody>' + geneticResultRows.join("") + "</tbody></table>" : "<p>Đã lưu giấy tờ di truyền nhưng chưa trích được mục biến thể có cấu trúc.</p>") : state.viewing ? "<p>Giấy tờ di truyền không được chia sẻ trong chế độ xem người thân.</p>" : "<p>Chưa lưu kết quả xét nghiệm di truyền.</p>";
  const notice = "Phiếu do người dùng tự ghi bằng ứng dụng GeneSense. Không phải kết quả khám bệnh, không có giá trị chẩn đoán.";
  // Medicines being taken now. Not shown while viewing a relative: their medicines are not shared yet, and state.medications holds the viewer's own.
  const medicines = state.medications.filter(m => medicineActive(m));
  const medicineRows = medicines.map(m => "<tr><td>" + esc(m.name + (m.strength ? " " + m.strength : "")) + "</td><td>" + esc(medicineWhen(m) + (medicineHow(m) ? ": " + medicineHow(m) : "")) + "</td><td>" + esc(medicineCourse(m)) + "</td></tr>").join("");
  const numerals = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
  let part = 0;
  const heading = text => "<h2>" + numerals[part++] + ". " + text + "</h2>";
  $("#report-sheet").innerHTML =
    '<header class="report-head"><div><strong>GeneSense</strong><br>Ứng dụng theo dõi sức khỏe tại nhà</div><div class="report-meta">Mã phiếu: ' + code + "<br>Ngày lập: " + esc(date(now.toISOString(), false)) + "</div></header>" +
    '<h1 id="report-title">' + (state.reportReturnView === 'genetics' ? 'PHIẾU TỔNG HỢP SỨC KHỎE VÀ DI TRUYỀN' : 'PHIẾU TỔNG HỢP CHỈ SỐ SỨC KHỎE TẠI NHÀ') + '</h1><p class="report-period">Số đo trong ' + days + ' ngày; tiền sử và giấy tờ đã lưu đến ' + esc(date(now.toISOString(), false)) + '</p><p class="report-notice">' + notice + "</p>" +
    (cut ? '<p class="report-notice">Phiếu chỉ gồm 100 lần đo gần nhất, từ ' + esc(date(oldest.toISOString())) + ". Các lần đo cũ hơn trong kỳ không có trong phiếu.</p>" : "") +
    heading("Thông tin người dùng") +
    '<table class="report-table report-info"><tbody><tr><th>Họ tên</th><td>' + esc(h.display_name) + "</td><th>Tuổi</th><td>" + p.age + "</td><th>Giới tính</th><td>" + sex + "</td></tr>" +
    "<tr><th>Chiều cao</th><td>" + num(p.height_cm) + " cm</td><th>Cân nặng</th><td>" + num(p.weight_kg) + " kg</td><th>BMI</th><td>" + num(bmi) + " (" + bmiLabel(bmi) + ")</td></tr>" +
    "<tr><th>Bệnh đã chẩn đoán</th><td colspan=\"5\">" + esc(p.known_conditions.map(conditionName).filter(Boolean).join(", ") || "Không khai báo") + "</td></tr>" +
    "<tr><th>Hút thuốc</th><td>" + (p.smoker ? "Có" : "Không") + "</td><th>Vận động</th><td colspan=\"3\">" + p.activity_minutes_week + " phút mỗi tuần</td></tr></tbody></table>" +
    heading("Tiền sử bệnh trong gia đình") +
    '<table class="report-table"><thead><tr><th>Người thân</th><th>Bệnh đã biết</th><th>Tuổi chẩn đoán (nếu nhớ)</th><th>Nguồn thông tin</th><th>Ngày hỏi/đối chiếu</th></tr></thead><tbody>' + family + "</tbody></table>" +
    heading("Thông tin di truyền để trao đổi") + '<p class="report-notice">Các gợi ý này chỉ dựa trên tiền sử gia đình đã khai, không phải chẩn đoán.</p>' + hereditaryTable + "<h3>Kết quả xét nghiệm di truyền đã lưu</h3>" + geneticDocumentTable +
    '<h3>Câu hỏi chuẩn bị cho buổi tư vấn</h3><ol class="report-questions">' + geneticConsultationQuestions().map(question => '<li>' + esc(question) + '</li>').join('') + '</ol>' +
    (state.viewing ? "" : heading("Thuốc đang dùng") + (medicines.length ? '<table class="report-table"><thead><tr><th>Tên thuốc</th><th>Cách dùng</th><th>Thời gian</th></tr></thead><tbody>' + medicineRows + "</tbody></table>" : "<p>Không ghi thuốc đang dùng.</p>")) +
    heading("Tổng hợp trong kỳ") +
    (rows.length ? '<table class="report-table report-num"><thead><tr><th>Chỉ số</th><th>Đơn vị</th><th>Số lần đo</th><th>Trung bình</th><th>Thấp nhất</th><th>Cao nhất</th><th>Số lần ngoài ngưỡng</th></tr></thead><tbody>' + reportSummary(rows) + "</tbody></table>" : "<p>Không có số đo trong kỳ này.</p>") +
    (rows.length ? heading("Biểu đồ diễn biến") + "<div class=\"report-charts\">" + Object.keys(TRENDS).map(id => '<figure data-report-chart="' + id + '"><figcaption></figcaption><div class="trend-chart"></div></figure>').join("") + '</div><p class="report-small">Đường liền: tâm thu hoặc chỉ số chính. Đường đứt: tâm trương. Nền xám hoặc đường chấm: ngưỡng tham khảo.</p>' +
      heading("Bảng số đo chi tiết") +
      '<table class="report-table report-num"><thead><tr><th>Thời gian</th><th>Huyết áp (mmHg)</th><th>Nhịp tim (lần/phút)</th><th>SpO₂ (%)</th><th>Đường huyết (mg/dL)</th><th>Nguồn</th><th>Ghi chú</th></tr></thead><tbody>' +
      rows.slice().reverse().map(row => "<tr><td>" + esc(when(row)) + "</td><td>" + cell("systolic", row.vitals) + "</td><td>" + cell("heart_rate", row.vitals) + "</td><td>" + cell("spo2", row.vitals) + "</td><td>" + cell("glucose", row.vitals) + "</td><td>" + esc(SOURCE_NAMES[row.vitals.source || "manual"]) + "</td><td>" + mark(row.vitals) + "</td></tr>").join("") + "</tbody></table>" : "") +
    '<p class="report-notice report-end">' + notice + " Ngưỡng tham khảo dùng trong phiếu là ngưỡng minh họa của ứng dụng. Hãy mang phiếu này đến bác sĩ để được tư vấn.</p>";
  for (const [id, spec] of Object.entries(TRENDS)) {
    const figure = $('[data-report-chart="' + id + '"]');
    if (!figure) continue;
    const points = rows.filter(row => spec.series.every(([key]) => row.vitals[key] != null));
    figure.classList.toggle("hidden", !points.length);
    if (!points.length) continue;
    figure.querySelector("figcaption").textContent = { bp: "Huyết áp (mmHg)", heart_rate: "Nhịp tim (lần/phút)", spo2: "SpO₂ (%)", glucose: "Đường huyết (mg/dL)" }[id];
    reportCharts[id] = new TrendChart(figure.querySelector(".trend-chart"));
    reportCharts[id].set({ unit: spec.unit, band: spec.band, thresholds: spec.thresholds?.map(t => ({ ...t, color: "#555" })), min: spec.min, max: spec.max, times: points.map(row => toDate(row.created_at)),
      series: spec.series.map(([key, label], index) => ({ label, color: "#000", dash: index ? "6 4" : "", values: points.map(row => chartValue(key, row.vitals[key])) })) });
  }
}
function openReport() {
  state.reportReturnView = ["history", "genetics"].includes(state.view) ? state.view : "history";
  screen("report"); document.title = "Phiếu tổng hợp - GeneSense"; renderReport(); history.pushState({ layer: true }, ""); reportLayer = true;
}

// Family sharing. While viewing a relative, the same screens render that person's data read-only:
// state is swapped, writes are hidden (.own-only) and guarded, and reads go through the care endpoints.
const reader = () => state.viewing
  ? { history: () => api.careHistory(state.viewing.id), assessment: id => api.careAssessment(state.viewing.id, id),
      weeklyBp: timezoneOffset => api.careWeeklyBp(state.viewing.id, timezoneOffset) }
  : api;
async function refreshCare() {
  const epoch = state.authEpoch;
  try {
    const care = await api.careLinks();
    if (epoch !== state.authEpoch) return;
    state.care = care;
  } catch { /* sharing is optional; the rest of the app still works */ }
  renderCare();
}
function patientLevel(patient) {
  if (!patient.latest) return null;
  const level = recordLevel({ vitals: patient.latest.vitals, risk_level: patient.latest.risk_level });
  return level === "emergency" ? "emergency" : patient.recent_emergency_at ? "watch" : level;
}
function patientRow(patient) {
  const level = patientLevel(patient);
  const tag = level ? '<span class="tag ' + ({ emergency: "alert", watch: "attention" }[level] || level) + '">' + LEVELS[level] + "</span>" : '<span class="tag">Chưa có số đo</span>';
  return '<div class="care-row"><div class="care-row-main"><strong>' + esc(patient.display_name) + "</strong><span>" + tag + (patient.latest ? ' <span class="note">Đo lúc ' + esc(date(patient.latest.created_at)) + "</span>" : "") + '</span></div><div class="care-row-actions"><button class="btn outline" data-view-patient="' + esc(patient.patient_id) + '">Xem hồ sơ</button><button class="delete-record" data-remove-link="' + esc(patient.link_id) + '" data-remove-kind="patient">Ngừng theo dõi</button></div></div>';
}
function renderCare() {
  const { patients, caregivers } = state.care;
  $("#care-alerts").innerHTML = patients.map(patient => {
    const level = patientLevel(patient);
    if (level !== "emergency" && level !== "watch") return "";
    const when = date(level === "emergency" ? patient.latest.created_at : patient.recent_emergency_at);
    return '<div class="care-alert ' + (level === "watch" ? "watch" : "") + '" role="alert"><span>' + esc(patient.display_name) + (level === "emergency" ? " có chỉ số ở mức nguy hiểm, đo lúc " : " đã có lần đo ở mức nguy hiểm lúc ") + esc(when) + '.</span><span class="care-alert-actions"><button class="btn" data-view-patient="' + esc(patient.patient_id) + '">Xem hồ sơ</button>' + (level === "emergency" ? '<a class="btn" href="tel:115">Gọi cấp cứu 115</a>' : "") + "</span></div>";
  }).join("");
  $("#care-patients-section").classList.toggle("hidden", !patients.length);
  $("#care-patients").innerHTML = patients.map(patientRow).join("");
  $("#care-panel").innerHTML =
    "<h2>Cho người thân xem hồ sơ của bạn</h2>" +
    '<p class="note">Tạo mã rồi gửi cho con cháu. Họ chỉ xem, không sửa được.</p>' +
    '<label class="check-label care-medication-sharing"><input id="care-share-medications" type="checkbox"' + (state.health?.share_medications ? " checked" : "") + '><span>Cho xem cả lịch uống thuốc<small>Không gồm giấy tờ và ảnh đơn thuốc.</small></span></label>' +
    '<button class="btn outline" id="care-create">Tạo mã chia sẻ</button><div id="care-code-box"></div>' +
    "<h3>Người đang xem hồ sơ của bạn</h3>" +
    (caregivers.length ? '<div class="care-rows">' + caregivers.map(c => '<div class="care-row"><div class="care-row-main"><strong>' + esc(c.display_name) + '</strong><span class="note">Từ ' + esc(date(c.created_at, false)) + '</span></div><button class="delete-record" data-remove-link="' + esc(c.link_id) + '" data-remove-kind="caregiver">Thu hồi</button></div>').join("") + "</div>" : '<p class="note">Chưa chia sẻ với ai.</p>') +
    '<div class="care-divider"></div><details class="record-details care-follow"' + (patients.length ? " open" : "") + "><summary>Xem hồ sơ của người thân</summary>" +
    '<form id="care-form" class="care-form"><label>Mã người thân gửi cho bạn<input id="care-code-input" autocomplete="off" autocapitalize="characters" maxlength="16" required></label><button class="btn primary" type="submit">Liên kết</button></form><p id="care-error" class="inline-message error hidden" role="alert"></p>' +
    (patients.length ? '<div class="care-rows">' + patients.map(patientRow).join("") + "</div>" : "") + "</details>";
}
async function setMedicationSharing(toggle) {
  const previous = Boolean(state.health?.share_medications), requested = toggle.checked;
  toggle.disabled = true;
  try {
    const data = await api.saveProfile({ ...structuredClone(state.health), share_medications: requested });
    state.user = data.user; state.health = data.health;
    await refreshCare();
    toast(requested ? "Đã cho phép chia sẻ lịch thuốc với người thân đã liên kết." : "Đã tắt chia sẻ lịch thuốc.");
  } catch (error) {
    toggle.checked = previous;
    toast(error.message, "error");
  } finally { toggle.disabled = false; }
}
async function createCareCode() {
  try {
    const invite = await api.careInvite();
    $("#care-code-box").innerHTML = '<p class="care-code">' + esc(invite.code.slice(0, 4) + " " + invite.code.slice(4)) + '</p><p class="note">Gửi mã này cho người thân. Mã dùng được một lần và hết hạn lúc ' + esc(date(invite.expires_at)) + ". Tạo mã mới sẽ hủy mã cũ.</p>";
  } catch (error) { toast(error.message, "error"); }
}
async function acceptCareCode(event) {
  event.preventDefault();
  errorAt("#care-error");
  try {
    const linked = await api.careAccept($("#care-code-input").value.trim());
    await refreshCare();
    toast("Đã liên kết với " + linked.display_name + ".");
  } catch (error) { errorAt("#care-error", error.message); }
}
async function removeCareLink(id, kind) {
  const ok = kind === "caregiver"
    ? await confirmAction("Thu hồi quyền xem?", "Người này sẽ không xem được hồ sơ của bạn nữa.", "Thu hồi")
    : await confirmAction("Ngừng theo dõi?", "Bạn sẽ không xem được hồ sơ của người này nữa.", "Ngừng theo dõi");
  if (!ok) return;
  try { await api.careRemove(id); await refreshCare(); toast(kind === "caregiver" ? "Đã thu hồi quyền xem." : "Đã ngừng theo dõi."); }
  catch (error) { toast(error.message, "error"); }
}
async function createFamilyInvite() {
  const relation = $("#family-relation-select").value;
  try {
    state.familyInviteCode = await api.familyInvite({ relative_relation: relation });
    renderFamilyLinks();
    toast("Đã tạo mã mời dùng một lần.");
  } catch (error) { toast(error.message, "error"); }
}
async function previewFamilyInvite(event) {
  event.preventDefault();
  errorAt("#family-invite-error");
  const code = $("#family-invite-code").value.trim();
  try {
    state.familyInvitePreview = { ...(await api.familyInvitePreview(code)), code };
    renderFamilyLinks();
    $("#family-join-panel")?.setAttribute("open", "");
    $("#family-confirm-relationship")?.focus();
  } catch (error) { errorAt("#family-invite-error", error.message); }
}
async function acceptFamilyInvite() {
  if (!state.familyInvitePreview || !$("#family-confirm-relationship").checked) return;
  const invite = state.familyInvitePreview;
  const button = $("#family-invite-accept");
  button.disabled = true;
  try {
    const linked = await api.familyAccept(invite.code, true);
    state.familyInvitePreview = null;
    await refreshFamilyLinks();
    toast("Đã xác nhận liên kết với " + linked.display_name + ".");
  } catch (error) {
    button.disabled = false;
    errorAt("#family-invite-error", error.message);
  }
}
async function setFamilySharing(toggle) {
  const id = toggle.dataset.familyShare, previous = !toggle.checked;
  toggle.disabled = true;
  try {
    await api.familySharing(id, toggle.checked);
    await refreshFamilyLinks();
    toast(toggle.checked ? "Đã bật chia sẻ bệnh đã khai báo với người thân này." : "Đã tắt chia sẻ.");
  } catch (error) {
    toggle.checked = previous;
    toast(error.message, "error");
  } finally { toggle.disabled = false; }
}
async function removeFamilyLink(id) {
  if (!await confirmAction("Ngắt liên kết gia đình?", "Cả hai tài khoản sẽ không còn xem được thông tin đang chia sẻ với nhau.", "Ngắt liên kết")) return;
  try {
    await api.familyRemove(id);
    await refreshFamilyLinks();
    toast("Đã ngắt liên kết gia đình.");
  } catch (error) { toast(error.message, "error"); }
}
async function viewPatient(patientId) {
  const patient = state.care.patients.find(p => p.patient_id === patientId);
  if (!patient || state.viewing) return;
  try {
    const shared = await api.careProfile(patientId);
    state.own = { health: state.health, records: state.records, result: state.result, risk: state.risk, weeklyBP: state.weeklyBP,
      viewingMedications: state.viewingMedications };
    state.viewing = { id: patientId, name: shared.display_name };
    state.health = shared.health; state.records = []; state.result = null; state.risk = null; state.weeklyBP = null; state.viewingMedications = null;
    document.body.classList.add("viewing");
    $("#viewing-text").textContent = "Bạn đang xem hồ sơ của " + shared.display_name + ". Chỉ xem, không sửa được.";
    $("#viewing-banner").classList.remove("hidden");
    personalize();
    const medicationPromise = api.careMedications(patientId, localDay()).catch(() => ({ shared: false, medications: [], intakes: [] }));
    await Promise.all([refreshRecords(), refreshRisk(), medicationPromise.then(value => { if (state.viewing?.id === patientId) state.viewingMedications = value; })]);
    if (state.viewing?.id !== patientId) return; // left, or moved to another relative, while loading
    renderProfile();
    navigate("dashboard");
  } catch (error) { toast(error.message, "error"); }
}
async function exitViewing() {
  if (!state.viewing) return;
  state.authEpoch++; // answers still on their way for the relative must not land in the user's own data
  Object.assign(state, state.own, { viewing: null, viewingMedications: null, own: null });
  document.body.classList.remove("viewing");
  $("#viewing-banner").classList.add("hidden");
  personalize(); renderDashboard(); renderHistory();
  navigate("dashboard");
  refreshCare();
  offerDeviceImport();
}

function analysisMarkup(analysis, recordId = "") {
  const metricRows = analysis.metrics?.length ? '<div class="extracted-metrics">' + analysis.metrics.map(metric => {
    const badge = metric.flag === "normal" ? "safe" : metric.flag === "unknown" ? "neutral" : "attention";
    return '<div><span><strong>' + esc(metric.name) + '</strong><small>' + esc(metric.reference_range ? "Tham chiếu: " + metric.reference_range : "Không có khoảng tham chiếu") + '</small></span><span class="metric-value">' + esc(metric.value) + " " + esc(metric.unit) + '</span><span class="tag ' + badge + '">' + esc(FLAG_NAMES[metric.flag] || "Chưa rõ") + "</span></div>";
  }).join("") + "</div>" : "";
  const list = (title, values, tone = "") => values?.length ? '<section class="extracted-list ' + tone + '"><strong>' + title + '</strong><ul>' + values.map(value => "<li>" + esc(value) + "</li>").join("") + "</ul></section>" : "";
  const medications = analysis.medications?.length ? '<section class="extracted-list"><strong>Thuốc được ghi trên tài liệu</strong><ul>' + analysis.medications.map(item => "<li>" + esc(item.name) + (item.dose ? ", " + esc(item.dose) : "") + (item.frequency ? ", " + esc(item.frequency) : "") + "</li>").join("") + "</ul></section>" : "";
  const findings = (analysis.genetic_findings || []).map((finding, index) => {
    const values = [["Gen", finding.gene], ["Biến thể ghi trên phiếu", finding.variant], ["Transcript", finding.transcript],
      ["Hệ gen tham chiếu", finding.genome_build], ["HGVS hệ gen (g.)", finding.hgvs_genomic],
      ["HGVS mã hóa (c.)", finding.hgvs_coding], ["HGVS protein (p.)", finding.hgvs_protein], ["dbSNP (rsID)", finding.rsid],
      ["Kết luận của phòng xét nghiệm", finding.classification],
      ["Kiểu gen ghi trên phiếu", finding.zygosity], ["Bệnh liên quan (nếu có)", finding.condition]]
      .filter(([, value]) => value).map(([label, value]) => "<div><dt>" + label + "</dt><dd>" + esc(value) + "</dd></div>").join("");
    const preferredVariant = finding.rsid || finding.hgvs_coding || finding.hgvs_genomic || finding.variant || finding.hgvs_protein;
    const query = [finding.gene, finding.hgvs_coding && !finding.rsid ? finding.transcript : "", preferredVariant].filter(Boolean).join(" ");
    const sources = query ? '<div class="genetics-sources"><button type="button" class="link-button" data-genetics-search="' + esc(query) + '">Tìm trong ClinVar</button>' +
      '<a href="https://dataexchange.clinicalgenome.org/clinvar-gkm/profiles/review-status/" target="_blank" rel="noopener noreferrer">Cách đọc mức rà soát ClinVar</a>' +
      (finding.gene ? '<a href="https://search.clinicalgenome.org/kb/gene-validity" target="_blank" rel="noopener noreferrer">Tra cứu đánh giá gen–bệnh tại ClinGen</a>' : "") + "</div>" : "";
    const reviewSource = { clinvar: "ClinVar", clingen: "ClinGen", care_team: "Bác sĩ/nhóm chăm sóc" }[finding.evidence_review_source];
    const review = recordId && query ? '<div class="evidence-review"><p class="note">' + (finding.evidence_review_on
      ? "Bạn đã ghi nhận tự đối chiếu với " + esc(reviewSource || "nguồn tham khảo") + " ngày " + esc(date(finding.evidence_review_on, false)) + ". Đây không phải xác nhận của GeneSense."
      : "Chưa ghi nhận lần tự đối chiếu nào. GeneSense không tự đồng bộ dữ liệu phân loại.") + '</p><label>Nguồn đã xem<select data-evidence-source="' + esc(recordId) + ':' + index + '"><option value="clinvar"' + (finding.evidence_review_source === "clinvar" ? " selected" : "") + '>ClinVar</option><option value="clingen"' + (finding.evidence_review_source === "clingen" ? " selected" : "") + '>ClinGen</option><option value="care_team"' + (finding.evidence_review_source === "care_team" ? " selected" : "") + '>Bác sĩ/nhóm chăm sóc</option></select></label><button type="button" class="btn outline" data-mark-evidence="' + esc(recordId) + ':' + index + '">' + (finding.evidence_review_on ? "Cập nhật lần đối chiếu" : "Ghi nhận đã đối chiếu") + '</button></div>' : '';
    return '<article class="genetic-finding"><dl>' + values + "</dl>" + (finding.source_excerpt ? '<blockquote><strong>Trích trên phiếu:</strong> ' + esc(finding.source_excerpt) + "</blockquote>" : "") + sources + (query ? '<p class="note external-genetics-note">Mở ClinVar sẽ gửi tên gen và một mã biến thể được chọn đến NCBI. Chỉ mở nếu bạn đồng ý.</p>' : "") + review + "</article>";
  }).join("");
  const geneticBlock = findings ? '<section class="extracted-list genetic-result-list"><strong>Kết quả di truyền được ghi trên phiếu</strong><p class="note">' + (analysis.source === 'manual' ? 'Nội dung bạn nhập tay từ phiếu gốc.' : 'Nội dung AI đã trích và bạn xác nhận.') + ' GeneSense chưa đối chiếu hay diễn giải; hãy so từng mục với bản gốc.</p>' + findings + '<p class="note">GeneSense chưa tự đồng bộ phân loại, số sao rà soát, ngày cập nhật hay xung đột từ ClinVar/ClinGen. Khi tra cứu, hãy kiểm tra các chi tiết đó và hỏi chuyên gia; đường dẫn không thay thế tư vấn chuyên môn.</p></section>' : "";
  return '<div class="analysis-summary"><div class="record-meta"><span>' + esc(DOCUMENT_TYPES[analysis.document_type] || "Tài liệu sức khỏe") + '</span><span>' + esc(analysis.document_date ? date(analysis.document_date, false) : "Không rõ ngày") + '</span><span>' + esc(analysis.provider || "Không rõ cơ sở") + '</span></div><h3>' + esc(analysis.title) + '</h3><p>' + esc(analysis.summary) + "</p></div>" + geneticBlock + metricRows + list("Thông tin bệnh được ghi", analysis.conditions) + medications + list("Đề xuất được ghi trên tài liệu", analysis.recommendations) + list("Điểm cần kiểm tra lại", analysis.warnings, "warning") + '<p class="analysis-disclaimer">' + esc(analysis.disclaimer) + "</p>";
}

function renderMedicalRecords() {
  if (!state.medicalRecords.length) {
    $("#medical-record-list").innerHTML = '<article class="panel empty-state record-empty-state"><span class="record-empty-icon" aria-hidden="true">' + icon("document") + '</span><div><h2>Chưa lưu giấy tờ nào</h2><p class="note">Đơn thuốc, giấy khám và kết quả đã lưu sẽ hiện ở đây.</p></div></article>';
    return;
  }
  $("#medical-record-list").innerHTML = state.medicalRecords.map(record => {
    const a = record.analysis;
    const notable = (a.metrics || []).filter(metric => !["normal", "unknown"].includes(metric.flag)).length;
    return '<article class="panel medical-record" data-medical-record-id="' + esc(record.id) + '" tabindex="-1"><div class="record-meta"><span>' + esc(DOCUMENT_TYPES[a.document_type] || "Tài liệu sức khỏe") + "</span><span>" + esc(a.document_date ? date(a.document_date, false) : date(record.created_at, false)) + "</span>" + (a.source === "manual" ? '<span class="tag info">Nhập tay</span>' : "") + (notable ? '<span class="tag attention">' + notable + " mục cần xem lại</span>" : "") + "</div><h2>" + esc(a.title) + "</h2><p>" + esc(a.summary) + '</p><details class="record-details"><summary>Xem nội dung đã lưu</summary>' + analysisMarkup(a, record.id) + '</details><div class="record-actions"><button class="link-button hidden" data-view-scan="' + esc(record.id) + '">Xem ảnh gốc</button><button class="delete-record" data-delete-record="' + esc(record.id) + '">Xóa</button></div></article>';
  }).join("");
  // The button appears only where this device still holds the scan.
  $$("[data-view-scan]").forEach(async button => { if (await scanRequest("readonly", store => store.getKey(button.dataset.viewScan))) button.classList.remove("hidden"); });
}

// Scans stay on this device: IndexedDB, keyed by the saved record's id. They are never sent back to the server.
// ponytail: an account that can sign in again keeps its scans after sign-out, so the next user of a shared browser
// could reach them with developer tools; clear the store at every sign-out if shared devices become a real use.
function scanRequest(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("genesense-scans", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("scans");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      try {
        const request = run(open.result.transaction("scans", mode).objectStore("scans"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (error) { reject(error); } // thrown inside this handler it would never reach the promise, and the caller would wait forever
    };
  }).catch(() => null); // private windows and blocked storage: the app works, only without the kept scan
}
async function viewScan(id) {
  const blob = await scanRequest("readonly", store => store.get(id));
  if (!blob) { toast("Ảnh gốc không còn trên thiết bị này.", "error"); return; }
  if (state.scanUrl) URL.revokeObjectURL(state.scanUrl);
  state.scanUrl = URL.createObjectURL(blob);
  $("#scan-image").src = state.scanUrl;
  // "Lưu ảnh" hands the browser a file named after the document's date, so it can be found again outside the app.
  const record = state.medicalRecords.find(item => item.id === id), save = $("#scan-save");
  const day = record?.analysis.document_date || (record && toDate(record.created_at).toLocaleDateString("sv"));
  save.href = state.scanUrl;
  save.download = "giay-to" + (day ? "-" + day : "") + "." + ({ "image/png": "png", "image/webp": "webp" }[blob.type] || "jpg");
  openDialog($("#scan-dialog"));
}
// Phone photos are far larger than reading needs; 2000px keeps small print legible and fits the hosting upload limit.
async function shrinkImage(file, max = 2000) {
  try {
    const image = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(image.width, image.height)), canvas = document.createElement("canvas");
    // A small PNG (a screenshot or an exported page) goes as it is: JPEG would only smear its text.
    // Camera photos are always re-encoded, which also drops the location data stored in them.
    if (k === 1 && file.type === "image/png" && file.size <= 3 * 1024 * 1024) return file;
    canvas.width = Math.round(image.width * k); canvas.height = Math.round(image.height * k);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85)) || file;
  } catch { return file; }
}

const APPLY_VITALS = [["systolic", "Huyết áp tâm thu (mmHg)", 50, 260], ["diastolic", "Huyết áp tâm trương (mmHg)", 30, 180], ["heart_rate", "Nhịp tim (lần/phút)", 20, 260], ["spo2", "Oxy trong máu SpO₂ (%)", 50, 100], ["glucose", "Đường huyết (mg/dL)", 20, 600]];
// The part of a scanned document that can go into the profile. Only what is new is offered.
function applyMarkup(analysis) {
  // Blood pressure is saved as a pair, so both fields show even when the AI read only one of the two numbers.
  const geneticReport = analysis.document_type === "genetic_test_report";
  const vitals = geneticReport ? {} : analysis.vitals || {}, pressure = vitals.systolic != null || vitals.diastolic != null;
  const found = APPLY_VITALS.filter(([key]) => vitals[key] != null || (pressure && ["systolic", "diastolic"].includes(key)));
  const name = key => CONDITIONS.find(([id]) => id === key)?.[1];
  const own = geneticReport ? [] : (analysis.own_conditions || []).filter(key => !state.health.profile.known_conditions.includes(key));
  const family = geneticReport ? [] : (analysis.family_conditions || []).filter(item => !state.health.family_history.find(row => row.member_id === item.member)?.conditions.includes(item.condition));
  const medicines = geneticReport ? [] : analysis.medications || [];
  const geneticFindings = analysis.genetic_findings || [];
  if (!found.length && !own.length && !family.length && !medicines.length && !geneticFindings.length) return '<p class="note">Không thấy chỉ số, thuốc, bệnh mới hay kết quả di truyền rõ ràng để đưa vào hồ sơ. Nội dung giấy tờ vẫn được lưu.</p>';
  const check = (attribute, label) => '<label class="check-label"><input type="checkbox" ' + attribute + ' checked><span>' + label + "</span></label>";
  const geneticField = (index, finding, key, label, multiline = false) => '<label>' + label + (multiline
    ? '<textarea rows="2" maxlength="300" data-genetic-index="' + index + '" data-genetic-field="' + key + '">' + esc(finding[key]) + "</textarea>"
    : '<input maxlength="' + ({ gene: 60, variant: 240, transcript: 100, genome_build: 40, hgvs_genomic: 180, hgvs_coding: 180,
      hgvs_protein: 180, rsid: 40, zygosity: 100, classification: 120, condition: 200 }[key]) + '" data-genetic-index="' + index + '" data-genetic-field="' + key + '" value="' + esc(finding[key]) + '">') + "</label>";
  return '<h3>Đưa vào hồ sơ</h3>' +
    (found.length ? '<fieldset class="apply-group"><legend>Chỉ số đo</legend>' + check('id="apply-vitals"', "Thêm vào Lịch sử đo với nguồn “Từ giấy tờ”<small>Số liệu cũ, không đổi tình trạng Hôm nay.</small>") +
      '<div class="field-grid">' + found.map(([key, label, min, max]) => "<label>" + label + '<input type="number" inputmode="decimal" step=".1" min="' + min + '" max="' + max + '" data-apply-vital="' + key + '" value="' + esc(vitals[key] == null ? "" : Math.round(vitals[key] * 10) / 10) + '"></label>').join("") +
      '<label>Ngày ghi trên giấy tờ<input type="date" id="apply-date" required min="1950-01-01" max="' + new Date().toLocaleDateString("sv") + '" value="' + esc(analysis.document_date || "") + '"></label></div></fieldset>' : "") +
    (own.length ? '<fieldset class="apply-group"><legend>Bệnh đã được chẩn đoán</legend>' + own.map(key => check('data-apply-own="' + esc(key) + '"', esc(name(key)))).join("") + "</fieldset>" : "") +
    (family.length ? '<fieldset class="apply-group"><legend>Tiền sử gia đình</legend>' + family.map(item => check('data-apply-family="' + esc(item.member + "|" + item.condition) + '"', esc(MEMBERS.find(m => m.id === item.member).label + ": " + name(item.condition)))).join("") + "</fieldset>" : "") +
    (medicines.length ? '<fieldset class="apply-group"><legend>Thuốc trong đơn</legend><p class="note">So từng thuốc với đơn giấy.</p>' + medicines.map(applyMedicineMarkup).join("") + "</fieldset>" : "") +
    (geneticFindings.length ? '<fieldset class="apply-group genetic-review"><legend>Đối chiếu kết quả di truyền</legend><p class="note">Các trường này được chép từ phiếu. Bạn có thể sửa theo bản gốc; GeneSense không phân loại biến thể.</p>' + geneticFindings.map((finding, index) =>
      '<div class="genetic-review-card"><h4>Kết quả ' + (index + 1) + '</h4><div class="field-grid">' +
      geneticField(index, finding, "gene", "Gen") + geneticField(index, finding, "variant", "Biến thể ghi trên phiếu") +
      geneticField(index, finding, "classification", "Kết luận của phòng xét nghiệm") + geneticField(index, finding, "zygosity", "Kiểu gen ghi trên phiếu") +
      geneticField(index, finding, "condition", "Bệnh liên quan (nếu có)") + geneticField(index, finding, "source_excerpt", "Trích đoạn để đối chiếu", true) +
      '</div><details class="genetic-notation-details"><summary>Mã định danh trên phiếu (nếu có)</summary><div class="field-grid">' +
      geneticField(index, finding, "transcript", "Transcript / mã phiên bản") + geneticField(index, finding, "genome_build", "Hệ gen tham chiếu") +
      geneticField(index, finding, "hgvs_genomic", "HGVS hệ gen (g.)") + geneticField(index, finding, "hgvs_coding", "HGVS mã hóa (c.)") +
      geneticField(index, finding, "hgvs_protein", "HGVS protein (p.)") + geneticField(index, finding, "rsid", "dbSNP (rsID)") +
      "</div></details></div>").join("") + "</fieldset>" : "");
}
// One card per medicine read from a prescription. A name the AI was not sure of starts unticked, so it cannot be saved unseen.
function applyMedicineMarkup(m) {
  const field = (label, key, value, extra = "") => "<label" + (key === "name" ? ' class="full"' : "") + ">" + label + '<input data-med="' + key + '" value="' + esc(value) + '" autocomplete="off" ' + extra + "></label>";
  return '<div class="apply-medicine" data-apply-medicine>' +
    '<label class="check-label"><input type="checkbox" data-med-on' + (m.unsure ? "" : " checked") + "><span>Thêm vào lịch uống thuốc</span></label>" +
    (m.unsure ? '<p class="inline-message warning">Chữ viết không rõ. Hãy so với đơn giấy, sửa cho đúng rồi mới chọn thêm.</p>' : "") +
    '<div class="field-grid">' + field("Tên thuốc", "name", m.name, 'required maxlength="160"') + field("Hàm lượng", "strength", m.strength, 'maxlength="60"') + field("Mỗi lần uống", "amount", (m.dose || "").slice(0, 60), 'maxlength="60"') + "</div>" +
    (m.frequency ? '<p class="note">Trên đơn ghi: ' + esc(m.frequency) + "</p>" : "") +
    '<div class="chips" role="group" aria-label="Buổi uống">' + SLOTS.map(([key, label]) => '<label><input type="checkbox" data-med-slot="' + key + '"' + (m[key] ? " checked" : "") + ">" + label + "</label>").join("") + '<label><input type="checkbox" data-med-needed>Khi cần</label></div>' +
    '<div class="field-grid"><label>Uống trước hay sau ăn<select data-med="meal">' + [["any", "Không ghi trên đơn"], ["before", "Trước ăn"], ["after", "Sau ăn"]].map(([value, label]) => '<option value="' + value + '"' + (m.meal === value ? " selected" : "") + ">" + label + "</option>").join("") + "</select></label>" +
    field("Số ngày uống", "days", m.days || "", 'type="number" inputmode="numeric" min="1" max="365" step="1"') + "</div></div>";
}
// Unticked medicines are not saved, so their fields must not block the form.
function syncApplyMedicines() {
  $$("[data-apply-medicine]").forEach(card => {
    const on = card.querySelector("[data-med-on]").checked;
    card.querySelectorAll("[data-med], [data-med-slot], [data-med-needed]").forEach(el => { el.disabled = !on; });
  });
}

const SLOTS = [["morning", "Sáng"], ["noon", "Trưa"], ["afternoon", "Chiều"], ["evening", "Tối"]];
const currentSlot = () => { const hour = new Date().getHours(); return hour < 11 ? "morning" : hour < 14 ? "noon" : hour < 18 ? "afternoon" : "evening"; };
const MEALS = { before: "trước ăn", after: "sau ăn" };
const localDay = (value = new Date()) => value.toLocaleDateString("sv");
function medicineEnd(m) {
  if (!m.days) return null;
  const end = new Date(m.start_date + "T00:00:00");
  end.setDate(end.getDate() + m.days - 1);
  return localDay(end);
}
const medicineActive = (m, day = localDay()) => m.start_date <= day && (!m.days || medicineEnd(m) >= day);
const medicineHow = m => [m.amount, MEALS[m.meal]].filter(Boolean).join(", ");
const medicineWhen = m => SLOTS.filter(([key]) => m[key]).map(([, label]) => label).join(", ") || "Khi cần";
const medicineCourse = m => "Từ " + date(m.start_date + "T12:00:00", false) + (m.days ? ", " + m.days + " ngày" : ", uống lâu dài");
function renderTodayMedicineSummary() {
  const section = $("#today-medicine-section"), summary = $("#today-medicine-summary");
  const show = Boolean(state.user && !state.viewing && !(state.result && isEmergency(state.result)));
  section.classList.toggle("hidden", !show);
  if (!show) { summary.innerHTML = ""; return; }

  const active = state.medications.filter(m => medicineActive(m));
  if (!active.length) {
    summary.innerHTML = '<div class="today-medicine-empty"><span class="today-medicine-empty-icon" aria-hidden="true">' + icon("pill") + '</span><div><strong>Chưa có thuốc đang dùng hôm nay</strong><p>Thêm thuốc theo đơn bác sĩ để xem nhắc nhở ngay tại đây.</p></div><button class="btn primary" data-add-medicine><span data-icon="plus"></span>Thêm thuốc</button></div>';
    hydrateIcons(summary);
    return;
  }

  const taken = new Set((state.medicationIntakes || []).map(row => row.medication_id + ":" + row.slot));
  const groups = SLOTS.map(([slot, label]) => {
    const medicines = active.filter(m => m[slot]);
    const done = medicines.filter(m => taken.has(m.id + ":" + slot)).length;
    return { slot, label, medicines, done };
  }).filter(group => group.medicines.length);
  const doseCount = groups.reduce((sum, group) => sum + group.medicines.length, 0);
  const doneCount = groups.reduce((sum, group) => sum + group.done, 0);
  const current = currentSlot();
  const openGroup = groups.find(group => group.slot === current && group.done < group.medicines.length)
    || groups.find(group => group.done < group.medicines.length)
    || groups.find(group => group.slot === current)
    || groups[0];
  const progressMarkup = !doseCount ? "" : state.medicationIntakes === null
    ? '<p class="today-med-loading" role="status">Đang tải trạng thái các liều…</p>'
    : '<div class="today-medicine-progress-row"><span>' + doneCount + '/' + doseCount + ' liều đã ghi nhận</span><progress class="today-medicine-progress" aria-label="Tiến độ ghi nhận thuốc hôm nay" max="' + doseCount + '" value="' + doneCount + '"></progress></div>';
  const groupMarkup = groups.map(group => {
    const completed = group.done === group.medicines.length;
    const status = state.medicationIntakes === null ? "Đang tải trạng thái" : completed ? "Đã ghi nhận đủ" : group.done + "/" + group.medicines.length + " đã uống";
    const rows = group.medicines.map(m => {
      const checked = taken.has(m.id + ":" + group.slot);
      const label = "Đã uống " + m.name + " buổi " + group.label.toLowerCase();
      return '<li class="today-med-row"><div><strong>' + esc(m.name + (m.strength ? " " + m.strength : "")) + '</strong>' + (medicineHow(m) ? '<span>' + esc(medicineHow(m)) + '</span>' : "") + '</div><label class="today-med-check"><input type="checkbox" data-medication-intake="' + esc(m.id) + '" data-intake-slot="' + group.slot + '" aria-label="' + esc(label) + '"' + (checked ? " checked" : "") + (state.medicationIntakes === null ? " disabled" : "") + '><span>' + (checked ? "Đã uống" : "Đánh dấu đã uống") + '</span></label></li>';
    }).join("");
    return '<details class="today-med-group"' + (group === openGroup ? " open" : "") + '><summary><span class="today-med-period-name">' + esc(group.label) + (group.slot === current ? ' <span class="today-med-now">Buổi hiện tại</span>' : "") + '</span><span class="today-med-period-status">' + status + '</span><span class="today-med-chevron" data-icon="chevron" aria-hidden="true"></span></summary><ul>' + rows + '</ul></details>';
  }).join("");
  const asNeededCount = active.filter(m => !SLOTS.some(([slot]) => m[slot])).length;
  const asNeeded = asNeededCount ? '<p class="today-med-prn"><span data-icon="info" aria-hidden="true"></span><span><strong>' + asNeededCount + ' thuốc dùng khi cần.</strong> Làm theo hướng dẫn trong đơn.</span></p>' : "";
  summary.innerHTML = progressMarkup + (groupMarkup ? '<div class="today-med-groups">' + groupMarkup + '</div>' : '<p class="today-med-prn">Hôm nay chưa có liều theo buổi.</p>') + asNeeded + '<p class="today-med-note">Đánh dấu sau khi uống. Lịch hiển thị trong ứng dụng; chưa gửi thông báo ngoài ứng dụng.</p>';
  hydrateIcons(summary);
}
// The "Đã uống" ticks belong to one calendar day; after midnight they must be fetched again.
const refreshIfNewDay = () => { if (state.intakesDay && state.intakesDay !== localDay()) { state.medicationIntakes = null; state.intakesDay = null; void refreshMedications(); } };
function renderRecordsTab() {
  refreshIfNewDay();
  const tab = state.recordsTab || (state.medications.length ? "medicines" : "documents");
  $$("[data-records-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.recordsTab === tab);
    button.setAttribute("aria-pressed", String(button.dataset.recordsTab === tab));
  });
  $("#medicines-panel").classList.toggle("hidden", tab !== "medicines");
  $("#documents-panel").classList.toggle("hidden", tab !== "documents");
  renderMedicines();
}
function openGeneticRecord(id) {
  if (state.viewing) return;
  state.recordsTab = "documents";
  navigate("records");
  const article = [...$$('[data-medical-record-id]')].find(item => item.dataset.medicalRecordId === id);
  if (!article) { toast("Không tìm thấy phiếu di truyền đã lưu.", "error"); return; }
  article.querySelector("details")?.setAttribute("open", "");
  article.classList.add("genetics-record-focus");
  article.focus({ preventScroll: true });
  article.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}
function renderMedicines() {
  const active = state.medications.filter(m => medicineActive(m));
  const now = currentSlot();
  const title = m => esc(m.name + (m.strength ? " " + m.strength : ""));
  const taken = new Set((state.medicationIntakes || []).map(row => row.medication_id + ":" + row.slot));
  const item = (m, slot = null) => {
    const checked = slot && taken.has(m.id + ":" + slot);
    const intake = slot ? '<label class="medicine-intake"><input type="checkbox" data-medication-intake="' + esc(m.id) + '" data-intake-slot="' + slot + '" aria-label="' + esc("Đã uống " + m.name + " buổi " + SLOTS.find(([key]) => key === slot)[1].toLowerCase()) + '"' + (checked ? " checked" : "") + (state.medicationIntakes === null ? " disabled" : "") + '><span>' + (checked ? "✓ Đã uống" : "Đánh dấu đã uống") + "</span></label>" : "";
    return '<li class="medicine-schedule-row"><div><strong>' + title(m) + "</strong>" + (medicineHow(m) ? "<span>" + esc(medicineHow(m)) + "</span>" : "") + (m.note ? '<span class="note">' + esc(m.note) + "</span>" : "") + "</div>" + intake + "</li>";
  };
  const block = (label, rows, current, slot = null) => rows.length ? '<article class="panel slot"><h3>' + label + (current ? ' <span class="tag">Bây giờ</span>' : "") + "</h3><ul>" + rows.map(m => item(m, slot)).join("") + "</ul></article>" : "";
  const blocks = SLOTS.map(([key, label]) => block(label, active.filter(m => m[key]), key === now, key)).join("") + block("Uống khi cần", active.filter(m => !SLOTS.some(([key]) => m[key])));
  $("#medicine-today").innerHTML = blocks ? '<div class="slot-grid">' + blocks + '</div><p class="note">Chỉ đánh dấu sau khi đã uống thuốc. Nếu có điều gì khác với đơn, hãy làm theo đơn và hướng dẫn của bác sĩ. Ứng dụng không nhắc giờ uống.</p>'
    : '<article class="panel empty-state medicine-empty-state"><span class="record-empty-icon" aria-hidden="true">' + icon("pill") + '</span><div><h3>Chưa có thuốc trong lịch hôm nay</h3><p class="note">Thêm thuốc theo đơn bác sĩ để xem lịch uống tại đây.</p></div></article>';
  if (active.some(m => SLOTS.some(([key]) => m[key])) && state.medicationIntakes === null) {
    $("#medicine-today").insertAdjacentHTML("beforeend", '<p class="note" role="status">Chưa tải được trạng thái uống thuốc. Kiểm tra kết nối mạng rồi thử lại.</p>');
  } else if (blocks) {
    $("#medicine-today").insertAdjacentHTML("beforeend", '<p class="note">Chỉ đánh dấu sau khi đã uống. Lịch hiển thị trong ứng dụng; chưa gửi thông báo ngoài ứng dụng. Hãy làm theo đơn và hướng dẫn của bác sĩ.</p>');
  }
  const day = localDay();
  const tag = m => m.start_date > day ? '<span class="tag">Chưa bắt đầu</span>' : medicineActive(m, day) ? "" : '<span class="tag">Đã hết đợt</span>';
  $("#medicine-all-row").classList.toggle("hidden", !state.medications.length);
  $("#medicine-list-title").textContent = "Tất cả thuốc (" + state.medications.length + ")";
  $("#medicine-list").innerHTML = '<ul class="panel medicine-rows">' + state.medications.map(m =>
    "<li><div><strong>" + title(m) + "</strong><span>" + esc(medicineWhen(m) + (medicineHow(m) ? ": " + medicineHow(m) : "")) + '</span><span class="note">' + esc(medicineCourse(m)) + " " + tag(m) + "</span></div>" +
    '<button class="btn outline" data-edit-medicine="' + esc(m.id) + '">Sửa</button></li>').join("") + "</ul>";
  renderTodayMedicineSummary();
}
async function refreshMedications() {
  const epoch = state.authEpoch;
  const day = localDay();
  try {
    const [rows, intakes] = await Promise.all([api.medications(), api.medicationIntakes(day)]);
    if (epoch !== state.authEpoch) return;
    state.medications = rows; state.medicationIntakes = intakes; state.intakesDay = day;
  } catch (error) { if (epoch !== state.authEpoch) return; toast(error.message, "error"); }
  renderMedicines();
}
async function setMedicationIntake(input) {
  const medicationId = input.dataset.medicationIntake, slot = input.dataset.intakeSlot, taken = input.checked;
  const order = SLOTS.map(([key]) => key), now = currentSlot();
  if (taken && order.indexOf(slot) > order.indexOf(now)) {
    const label = SLOTS.find(([key]) => key === slot)[1];
    input.checked = false;
    if (!await confirmAction("Đánh dấu liều " + label + " đã uống?", "Bây giờ mới buổi " + SLOTS.find(([key]) => key === now)[1].toLowerCase() + ".", "Đã uống rồi", { cancel: "Không", danger: false })) return;
    input.checked = true;
  }
  input.disabled = true;
  try {
    const result = await api.setMedicationIntake(medicationId, slot, { scheduled_on: localDay(), taken });
    state.medicationIntakes = (state.medicationIntakes || []).filter(row => row.medication_id !== medicationId || row.slot !== slot);
    if (result.taken) state.medicationIntakes.push(result);
    renderMedicines();
    toast(taken ? "Đã ghi nhận bạn đã uống thuốc." : "Đã bỏ ghi nhận.");
  } catch (error) {
    input.checked = !taken;
    input.disabled = false;
    toast(error.message, "error");
  }
}
function printMedicineSchedule() {
  if (state.viewing) return;
  const day = localDay(), active = state.medications.filter(m => medicineActive(m, day));
  const taken = new Set((state.medicationIntakes || []).map(row => row.medication_id + ":" + row.slot));
  const groups = SLOTS.map(([slot, label]) => {
    const rows = active.filter(m => m[slot]);
    return rows.length ? '<section class="medicine-print-group"><h2>' + label + '</h2><ul>' + rows.map(m =>
      '<li><span><strong>' + esc(m.name + (m.strength ? " " + m.strength : "")) + '</strong><small>' + esc([m.amount, MEALS[m.meal], m.note].filter(Boolean).join(" · ") || "Theo đơn") + '</small></span><span class="medicine-print-status">' + (taken.has(m.id + ":" + slot) ? "✓ Đã uống" : "□ Chưa uống") + "</span></li>").join("") + "</ul></section>" : "";
  }).join("");
  const asNeeded = active.filter(m => !SLOTS.some(([slot]) => m[slot]));
  const needed = asNeeded.length ? '<section class="medicine-print-group"><h2>Khi cần</h2><ul>' + asNeeded.map(m =>
    '<li><span><strong>' + esc(m.name + (m.strength ? " " + m.strength : "")) + '</strong><small>' + esc([m.amount, m.note].filter(Boolean).join(" · ") || "Theo đơn") + "</small></span></li>").join("") + "</ul></section>" : "";
  const name = state.health?.display_name || state.user?.display_name || "";
  $("#medicine-print-sheet").innerHTML = '<header class="medicine-print-head"><h1>Lịch dùng thuốc</h1><p><strong>Hồ sơ:</strong> ' + esc(name) + ' <span>·</span> <strong>Ngày:</strong> ' + esc(date(day + "T12:00:00", false)) + '</p><p>Đối chiếu với đơn gốc và hướng dẫn của bác sĩ. Bản in này không thay thế đơn thuốc.</p></header>' +
    (groups || needed ? '<div class="medicine-print-grid">' + groups + needed + '</div>' : '<p>Hôm nay không có thuốc trong lịch.</p>');
  printingMedicine = true;
  document.body.classList.add("print-medicine");
  const finish = () => { printingMedicine = false; document.body.classList.remove("print-medicine"); };
  window.addEventListener("afterprint", finish, { once: true });
  window.print();
  setTimeout(() => { if (printingMedicine) finish(); }, 30000);
}
function openMedicine(id) {
  if (state.viewing) return;
  const m = state.medications.find(item => item.id === id), form = $("#medicine-form");
  state.editingMedicine = m ? m.id : null;
  form.reset();
  errorAt("#medicine-error");
  $("#medicine-title").textContent = m ? "Sửa thuốc" : "Thêm thuốc";
  $("#medicine-delete").classList.toggle("hidden", !m);
  $("#medicine-more").open = Boolean(m && (m.days || m.note));
  form.elements.start_date.value = m ? m.start_date : localDay();
  if (m) {
    ["name", "strength", "amount", "meal", "note"].forEach(key => { form.elements[key].value = m[key]; });
    form.elements.days.value = m.days || "";
    SLOTS.forEach(([key]) => { form.elements[key].checked = m[key]; });
    form.elements.as_needed.checked = !SLOTS.some(([key]) => m[key]);
  }
  openDialog($("#medicine-dialog"));
}
// "Khi cần" and the four times of day exclude each other, so "no fixed time" is always a choice the user made.
function keepSlotChoice(target, slots, needed) {
  if (target === needed && needed.checked) slots.forEach(box => { box.checked = false; });
  else if (target.checked) needed.checked = false;
}
async function saveMedicine(event) {
  event.preventDefault();
  const form = $("#medicine-form");
  if (state.busy) return;
  errorAt("#medicine-error");
  if (!form.checkValidity()) $("#medicine-more").open = true; // a field inside closed details cannot show its message
  if (!form.reportValidity()) return;
  const slots = Object.fromEntries(SLOTS.map(([key]) => [key, form.elements[key].checked]));
  if (!form.elements.as_needed.checked && !Object.values(slots).some(Boolean)) { errorAt("#medicine-error", "Hãy chọn buổi uống, hoặc chọn Khi cần."); return; }
  state.busy = true;
  const data = new FormData(form);
  const body = { name: data.get("name"), strength: data.get("strength").trim(), amount: data.get("amount").trim(), meal: data.get("meal"), start_date: data.get("start_date"),
    days: data.get("days") ? Number(data.get("days")) : null, note: data.get("note").trim(), as_needed: form.elements.as_needed.checked, ...slots };
  try {
    await api.saveMedication(body, state.editingMedicine);
    await refreshMedications();
    closeDialog($("#medicine-dialog"));
    toast("Đã lưu thuốc.");
  } catch (error) { errorAt("#medicine-error", error.message); }
  finally { state.busy = false; }
}
async function deleteMedicine(id) {
  if (!await confirmAction("Xóa thuốc này khỏi lịch?", "Thuốc sẽ không còn hiện trong lịch uống thuốc.")) return;
  try { await api.deleteMedication(id); await refreshMedications(); closeDialog($("#medicine-dialog")); toast("Đã xóa thuốc."); }
  catch (error) { toast(error.message, "error"); }
}
const documentVitals = () => Object.fromEntries([...$("#document-apply").querySelectorAll("[data-apply-vital]")].filter(el => el.value.trim()).map(el => [el.dataset.applyVital, Number(el.value)]));
const medicineKey = name => name.trim().toLocaleLowerCase("vi");
// Ticked medicines from the scan whose name is already in the schedule and not finished, e.g. the same prescription scanned twice.
function duplicateMedicines() {
  const day = localDay();
  const current = new Set(state.medications.filter(m => !m.days || medicineEnd(m) >= day).map(m => medicineKey(m.name)));
  return [...$$("[data-apply-medicine]:not([data-saved])")].filter(card => card.querySelector("[data-med-on]").checked && current.has(medicineKey(card.querySelector('[data-med="name"]').value)));
}
// Runs after the document itself is saved. Profile changes repeat safely; the reading is last, so a retry cannot add it twice.
async function applyDocument(vitals) {
  const form = $("#document-apply");
  const own = [...form.querySelectorAll("[data-apply-own]:checked")].map(el => el.dataset.applyOwn);
  const family = [...form.querySelectorAll("[data-apply-family]:checked")].map(el => el.dataset.applyFamily.split("|"));
  if (own.length || family.length) {
    const health = structuredClone(state.health);
    health.profile.known_conditions = [...new Set([...health.profile.known_conditions, ...own])];
    for (const [id, condition] of family) {
      const member = MEMBERS.find(m => m.id === id);
      let row = health.family_history.find(item => item.member_id === id);
      if (!row) health.family_history.push(row = { member_id: id, relation: member.relation, side: member.side, conditions: [] });
      row.knowledge = "known"; row.conditions = [...new Set([...row.conditions, condition])];
      row.source = "document_checked"; row.last_confirmed_on = localDay();
    }
    const data = await api.saveProfile(health);
    state.health = data.health; state.user = data.user;
    await refreshRisk();
  }
  // Each saved medicine is marked, so pressing save again after a failure does not add it twice.
  const day = localDay(), printed = state.pendingMedical.analysis.document_date;
  for (const card of form.querySelectorAll("[data-apply-medicine]:not([data-saved])")) {
    if (!card.querySelector("[data-med-on]").checked) continue;
    const value = key => card.querySelector('[data-med="' + key + '"]').value.trim();
    await api.saveMedication({ name: value("name"), strength: value("strength"), amount: value("amount"), meal: value("meal"), days: value("days") ? Number(value("days")) : null,
      start_date: printed && printed <= day ? printed : day, as_needed: card.querySelector("[data-med-needed]").checked,
      ...Object.fromEntries(SLOTS.map(([key]) => [key, card.querySelector('[data-med-slot="' + key + '"]').checked])) });
    card.dataset.saved = "true";
    state.recordsTab = "medicines";
  }
  if (form.querySelector("[data-saved]")) await refreshMedications();
  if (vitals) {
    await api.assess({ vitals, source: "document", measured_on: $("#apply-date").value });
    await refreshRecords();
  }
}

async function refreshMedicalRecords() {
  const epoch = state.authEpoch;
  try {
    const records = await api.medicalRecords();
    if (epoch !== state.authEpoch) return;
    state.medicalRecords = records;
    renderMedicalRecords();
  } catch (error) {
    if (epoch !== state.authEpoch) return;
    $("#medical-record-list").innerHTML = '<article class="panel empty-state"><h2>Chưa tải được giấy tờ</h2><p class="note">Kiểm tra kết nối mạng rồi thử lại.</p></article>';
  }
}

function resetMedicalUpload() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  state.pendingMedical = null; state.pendingScan = null;
  state.uploadFile = null;
  $("#document-apply").innerHTML = "";
  $("#medical-camera-file").value = "";
  $("#medical-document-file").value = "";
  $("#document-ai-consent").checked = false;
  $("#confirm-medical-record").checked = false;
  $("#document-preview").removeAttribute("src");
  $("#document-preview").classList.add("hidden");
  $("#document-drop").classList.remove("has-file");
  $("#document-photo-status").textContent = "Chưa chọn ảnh";
  $("#upload-stage").classList.remove("hidden");
  $("#review-stage").classList.add("hidden");
  $("#analyze-document").disabled = true;
  $("#save-medical-record").disabled = true;
  errorAt("#document-error");
  errorAt("#record-save-error");
}

function updateDocumentButton() {
  $("#analyze-document").disabled = !state.documentAiEnabled || !state.uploadFile || !$("#document-ai-consent").checked || state.busy;
}

function openMedicalUpload() {
  if (state.viewing) return;
  resetMedicalUpload();
  openDialog($("#medical-upload-dialog"));
}

const MANUAL_GENETIC_KEYS = ["gene", "variant", "classification", "condition", "transcript", "genome_build", "hgvs_genomic", "hgvs_coding", "hgvs_protein", "rsid", "zygosity", "source_excerpt"];
function manualFindingMarkup(number) {
  return '<fieldset class="manual-genetic-finding" data-manual-finding><legend>Gen/biến thể ' + number + '</legend>' +
    '<div class="field-grid"><label>Tên gen ghi trên phiếu<input name="gene" maxlength="60" autocomplete="off" placeholder="Ví dụ: BRCA1"></label><label>Biến thể ghi trên phiếu<input name="variant" maxlength="240" autocomplete="off" placeholder="Chép nguyên văn nếu có"></label></div>' +
    '<div class="field-grid"><label>Kết luận phòng xét nghiệm<input name="classification" maxlength="120" autocomplete="off" placeholder="Không tự phân loại"></label><label>Bệnh liên quan ghi trên phiếu<input name="condition" maxlength="200" autocomplete="off"></label></div>' +
    '<details class="record-details manual-genetic-more"><summary>Mã định danh và thông tin khác (nếu có)</summary><div class="field-grid">' +
      '<label>Transcript<input name="transcript" maxlength="100" autocomplete="off"></label><label>Hệ gen tham chiếu<input name="genome_build" maxlength="40" autocomplete="off"></label>' +
      '<label>HGVS hệ gen (g.)<input name="hgvs_genomic" maxlength="180" autocomplete="off"></label><label>HGVS mã hóa (c.)<input name="hgvs_coding" maxlength="180" autocomplete="off"></label>' +
      '<label>HGVS protein (p.)<input name="hgvs_protein" maxlength="180" autocomplete="off"></label><label>dbSNP (rsID)<input name="rsid" maxlength="40" autocomplete="off"></label>' +
      '<label>Kiểu gen ghi trên phiếu<input name="zygosity" maxlength="100" autocomplete="off"></label><label>Trích đoạn trên phiếu<input name="source_excerpt" maxlength="300" autocomplete="off"></label>' +
    '</div></details><button type="button" class="link-button manual-genetic-remove" data-remove-manual-finding>Xóa mục này</button></fieldset>';
}
function updateManualFindingControls() {
  const rows = $$("[data-manual-finding]");
  rows.forEach((row, index) => { row.querySelector("legend").textContent = "Gen/biến thể " + (index + 1); row.querySelector("[data-remove-manual-finding]").classList.toggle("hidden", rows.length === 1); });
  $("#manual-genetics-add").disabled = rows.length >= 5;
}
function openManualGenetics() {
  if (state.viewing) return;
  $("#manual-genetics-form").reset();
  $("#manual-genetic-findings").innerHTML = manualFindingMarkup(1);
  updateManualFindingControls();
  errorAt("#manual-genetics-error");
  openDialog($("#manual-genetics-dialog"));
}
function addManualFinding() {
  const count = $$("[data-manual-finding]").length;
  if (count >= 5) return;
  $("#manual-genetic-findings").insertAdjacentHTML("beforeend", manualFindingMarkup(count + 1));
  updateManualFindingControls();
  $$("[data-manual-finding]").at(-1).querySelector("[name=gene]").focus();
}
async function saveManualGenetics(event) {
  event.preventDefault();
  if (state.viewing || state.busy) return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const findings = $$("[data-manual-finding]").map(row => Object.fromEntries(MANUAL_GENETIC_KEYS.map(key => [key, row.querySelector('[name="' + key + '"]').value.trim()])));
  const missing = findings.findIndex(finding => !finding.gene && !finding.variant);
  if (missing !== -1) {
    errorAt("#manual-genetics-error", "Mỗi mục cần có tên gen hoặc biến thể đúng như trên phiếu.");
    $$("[data-manual-finding]")[missing].querySelector("[name=gene]").focus();
    return;
  }
  errorAt("#manual-genetics-error");
  const button = $("#manual-genetics-save"), original = button.textContent;
  state.busy = true; button.disabled = true; button.textContent = "Đang lưu…";
  const epoch = state.authEpoch;
  try {
    const values = form.elements;
    const analysis = { document_type: "genetic_test_report", document_date: values.document_date.value || null,
      provider: values.provider.value.trim(), title: values.title.value.trim(),
      summary: values.summary.value.trim() || "Thông tin di truyền được người dùng chép tay từ phiếu xét nghiệm.",
      genetic_findings: findings, confidence: "low", review_required: true, source: "manual",
      disclaimer: "Nội dung nhập tay từ phiếu gốc, chưa được GeneSense xác minh hoặc diễn giải; không phải chẩn đoán." };
    const document_hash = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    const saved = await api.saveMedicalRecord({ analysis, document_hash, health_consent: true });
    if (epoch !== state.authEpoch) return;
    state.medicalRecords = [saved, ...state.medicalRecords.filter(record => record.id !== saved.id)];
    renderMedicalRecords();
    closeDialog($("#manual-genetics-dialog"));
    navigate("genetics");
    $("#genetics-documents")?.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Đã lưu kết quả nhập tay. Hãy giữ phiếu gốc để đối chiếu với bác sĩ.");
  } catch (error) { errorAt("#manual-genetics-error", error.message); }
  finally { state.busy = false; button.disabled = false; button.textContent = original; }
}

function selectMedicalImage(event) {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) { updateDocumentButton(); return; }
  state.uploadFile = file;
  for (const selector of ["#medical-camera-file", "#medical-document-file"]) if (selector !== "#" + input.id) $(selector).value = "";
  errorAt("#document-error");
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  $("#document-preview").classList.add("hidden");
  $("#document-drop").classList.remove("has-file");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    errorAt("#document-error", "Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.");
    input.value = ""; state.uploadFile = null;
  } else if (file.size > 8 * 1024 * 1024) {
    errorAt("#document-error", "Ảnh vượt quá giới hạn 8 MB.");
    input.value = ""; state.uploadFile = null;
  } else {
    state.previewUrl = URL.createObjectURL(file);
    $("#document-preview").src = state.previewUrl;
    $("#document-preview").classList.remove("hidden");
    $("#document-drop").classList.add("has-file");
    $("#document-photo-status").textContent = "Ảnh đã sẵn sàng để kiểm tra";
  }
  updateDocumentButton();
}

async function analyzeMedicalDocument() {
  const file = state.uploadFile;
  if (!file || !$("#document-ai-consent").checked || state.busy) return;
  state.busy = true;
  const button = $("#analyze-document");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "AI đang đọc và tổng hợp…";
  errorAt("#document-error");
  const epoch = state.authEpoch;
  try {
    const scan = await shrinkImage(file);
    const body = new FormData();
    body.append("file", scan, scan.name || "scan.jpg");
    body.append("consent", "true");
    const result = await api.analyzeMedicalRecord(body);
    if (epoch !== state.authEpoch) return;
    state.pendingMedical = result; state.pendingScan = scan;
    $("#document-analysis-preview").innerHTML = analysisMarkup(result.analysis) + '<p class="privacy-result">' + esc(result.privacy_note) + "</p>";
    $("#document-apply").innerHTML = applyMarkup(result.analysis);
    syncApplyMedicines();
    $("#upload-stage").classList.add("hidden");
    $("#review-stage").classList.remove("hidden");
  } catch (error) { errorAt("#document-error", error.message); }
  finally { state.busy = false; button.innerHTML = original; updateDocumentButton(); }
}

async function saveMedicalRecord() {
  if (!state.pendingMedical || !$("#confirm-medical-record").checked || state.busy) return;
  // Unticked readings are not sent, so their fields must not block saving.
  const applyVitals = $("#apply-vitals")?.checked;
  $("#document-apply").querySelectorAll("[data-apply-vital], #apply-date").forEach(el => { el.disabled = !applyVitals; });
  syncApplyMedicines();
  $$("[data-genetic-field]").forEach(field => {
    const finding = state.pendingMedical.analysis.genetic_findings?.[Number(field.dataset.geneticIndex)];
    if (finding) finding[field.dataset.geneticField] = field.value.trim();
  });
  if (state.pendingMedical.analysis.document_type === "genetic_test_report") state.pendingMedical.analysis.review_required = true;
  if (!$("#document-apply").reportValidity()) return;
  // Checked before anything is saved, so a reading the server would refuse cannot leave the document half applied.
  const vitals = applyVitals ? documentVitals() : null;
  const problem = vitals ? vitalsProblem(vitals, true) : "";
  // Every medicine going into the schedule needs a time of day or an explicit "Khi cần".
  const untimed = [...$$("[data-apply-medicine]")].some(card => card.querySelector("[data-med-on]").checked && !card.querySelector("[data-med-slot]:checked, [data-med-needed]:checked"));
  errorAt("#record-save-error", problem || (untimed ? "Hãy chọn buổi uống cho từng thuốc, hoặc chọn Khi cần." : ""));
  if (problem || untimed) return;
  const twice = duplicateMedicines();
  if (twice.length) {
    const names = twice.map(card => card.querySelector('[data-med="name"]').value.trim()).join(", ");
    // Closing the question with Esc also keeps the schedule free of copies.
    if (!await confirmAction("Thuốc đã có trong lịch", names + " đã có trong lịch uống thuốc. Thêm lần nữa?", "Vẫn thêm", { cancel: "Không thêm", danger: false })) {
      twice.forEach(card => { card.querySelector("[data-med-on]").checked = false; });
      syncApplyMedicines();
    }
  }
  state.busy = true;
  const button = $("#save-medical-record");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "Đang lưu…";
  const epoch = state.authEpoch;
  try {
    const saved = await api.saveMedicalRecord({ analysis: state.pendingMedical.analysis, document_hash: state.pendingMedical.document_hash, health_consent: true });
    if (epoch !== state.authEpoch) return;
    state.medicalRecords = [saved, ...state.medicalRecords.filter(record => record.id !== saved.id)];
    if (state.pendingScan) await scanRequest("readwrite", store => store.put(state.pendingScan, saved.id));
    renderMedicalRecords(); // the document is saved from here on, even if a later step fails
    await applyDocument(vitals);
    closeDialog($("#medical-upload-dialog"));
    navigate("records");
    toast("Đã lưu giấy tờ.");
  } catch (error) { errorAt("#record-save-error", error.message); }
  finally { state.busy = false; button.innerHTML = original; button.disabled = !$("#confirm-medical-record").checked; }
}

async function deleteMedicalRecord(id) {
  if (!await confirmAction("Xóa giấy tờ này?")) return;
  try {
    await api.deleteMedicalRecord(id);
    await scanRequest("readwrite", store => store.delete(id));
    state.medicalRecords = state.medicalRecords.filter(record => record.id !== id);
    renderMedicalRecords();
    toast("Đã xóa giấy tờ.");
  } catch (error) { toast(error.message, "error"); }
}

function openMeasurement(mode = "manual") {
  if (state.viewing) return;
  errorAt("#measurement-error");
  $$("#measurement-form input[type=number]").forEach(input => fieldHint(input));
  openDialog($("#measurement-dialog"));
  setMeasureMode(mode);
}
function setMeasureMode(mode) {
  $("#manual-panel").hidden = mode !== "manual";
  $("#device-panel").hidden = mode !== "device";
  $$("[data-measure-mode]").forEach(button => button.classList.toggle("active", button.dataset.measureMode === mode));
  if (mode === "manual") stopStreams();
  errorAt("#measurement-error");
}
function freshValues() {
  const now = Date.now();
  const values = Object.fromEntries(KEYS.map(key => [key, now - (state.deviceTimes[key] || 0) <= 30000 ? state.deviceValues[key] ?? null : null]));
  if ((values.systolic == null) !== (values.diastolic == null)) { values.systolic = null; values.diastolic = null; }
  return values;
}
function stopStreams() {
  state.deviceEpoch++;
  simulator?.stop(); ble?.disconnect();
  simulator = null; ble = null;
  if (freshnessTimer) clearInterval(freshnessTimer);
  freshnessTimer = null;
  state.deviceSource = null; state.deviceValues = {}; state.deviceTimes = {}; state.samples = [];
  $("#device-values").classList.add("hidden"); $("#device-values").innerHTML = "";
  $("#save-device").disabled = true;
  $("#disconnect-device").classList.add("hidden");
  $("#device-name").textContent = "Kết nối máy đo qua Bluetooth";
  $("#device-message").textContent = "Bật Bluetooth trên máy đo, đặt gần điện thoại rồi bấm Kết nối.";
}
function renderDevice() {
  const v = freshValues();
  const hasData = KEYS.some(key => v[key] != null);
  $("#save-device").disabled = !hasData || state.busy;
  $("#device-values").classList.toggle("hidden", !hasData);
  $("#device-values").innerHTML = METRICS.map(m => {
    const [severity, text] = statusOf(m.key, v);
    return "<div><span>" + m.label + "</span><strong>" + withUnit(valueOf(m.key, v), m.unit) + '</strong> <span class="tag ' + severity + '">' + text + "</span></div>";
  }).join("");
  if (!hasData && state.deviceSource) $("#device-message").textContent = "Đang chờ chỉ số từ máy đo.";
}
function ingest(detail, epoch) {
  if (epoch !== state.deviceEpoch || !state.user) return;
  for (const [key, value] of Object.entries(detail.values)) {
    if (!KEYS.includes(key) || !Number.isFinite(value)) continue;
    state.deviceValues[key] = value; state.deviceTimes[key] = Date.now();
  }
  state.samples.push({ ...freshValues(), timestamp: new Date().toISOString() });
  if (state.samples.length > 60) state.samples.shift();
  renderDevice();
}
async function connectBle() {
  stopStreams();
  const epoch = state.deviceEpoch;
  ble = new HealthBleClient(5);
  state.deviceSource = "ble";
  ble.addEventListener("data", event => ingest(event.detail, epoch));
  ble.addEventListener("connected", event => {
    if (epoch !== state.deviceEpoch) return;
    $("#device-name").textContent = event.detail.name;
    $("#device-message").textContent = "Đã kết nối. Hãy bắt đầu đo trên máy.";
    $("#disconnect-device").classList.remove("hidden");
  });
  ble.addEventListener("disconnected", () => {
    if (epoch !== state.deviceEpoch) return;
    stopStreams();
    $("#device-message").textContent = "Máy đo đã ngắt kết nối. Bấm Kết nối để thử lại.";
  });
  ble.addEventListener("error", () => { if (epoch === state.deviceEpoch) errorAt("#measurement-error", "Chưa đọc được chỉ số. Hãy thử đo lại."); });
  $("#connect-ble").disabled = true;
  errorAt("#measurement-error");
  try {
    await ble.connect();
    if (epoch === state.deviceEpoch) freshnessTimer = setInterval(renderDevice, 3000);
  } catch (error) {
    if (epoch !== state.deviceEpoch) return;
    stopStreams();
    errorAt("#measurement-error", error.name === "NotFoundError" ? "Chưa chọn máy đo. Hãy thử lại hoặc dùng Nhập tay." : error.message);
  } finally { $("#connect-ble").disabled = false; }
}
function startSimulation() {
  stopStreams();
  state.deviceSource = "simulation";
  const epoch = state.deviceEpoch;
  simulator = new VitalSimulator(5);
  simulator.addEventListener("data", event => ingest(event.detail, epoch));
  simulator.start();
  $("#device-name").textContent = "Dữ liệu mẫu";
  $("#device-message").textContent = "Số liệu mẫu, không phải số đo thật.";
  $("#disconnect-device").classList.remove("hidden");
  freshnessTimer = setInterval(renderDevice, 3000);
}
// The rules the server applies to any reading, checked here first. The wording follows where the numbers came from.
function vitalsProblem(values, fromPaper = false) {
  if (!KEYS.some(key => values[key] != null)) return fromPaper ? "Hãy nhập ít nhất một chỉ số, hoặc bỏ chọn mục thêm vào Lịch sử đo." : "Hãy nhập ít nhất một chỉ số vừa đo.";
  if ((values.systolic == null) !== (values.diastolic == null)) return "Huyết áp cần cả số trên (tâm thu) và số dưới (tâm trương).";
  if (values.systolic != null && values.systolic <= values.diastolic) return "Số tâm thu cần lớn hơn số tâm trương. Hãy kiểm tra lại " + (fromPaper ? "giấy tờ." : "máy đo.");
  return "";
}
// A GeneSense measuring device (the UNIHIKER K10 sketch) links here as
// "#nhap-may-do?hr=78&spo2=97&t=1760600000" (t = Unix seconds, left out when the device has no clock).
// The numbers ride after "#", which browsers never send to a server. Nothing is saved until the person taps "Lưu chỉ số".
const DEVICE_IMPORT_ROUTE = "nhap-may-do";
const DEVICE_IMPORT_KEY = "genesense-device-import";
function parseDeviceImport(params) {
  const num = key => { const v = params.get(key); return v !== null && /^\d{1,3}(\.\d)?$/.test(v) ? Number(v) : null; };
  const heartRate = num("hr"), spo2 = num("spo2");
  if (heartRate === null && spo2 === null) return null;
  if ((heartRate !== null && (heartRate < 20 || heartRate > 260)) || (spo2 !== null && (spo2 < 50 || spo2 > 100))) return null;
  let takenAt = null;
  const t = params.get("t");
  if (t !== null) {
    if (!/^\d{9,11}$/.test(t)) return null;
    takenAt = Number(t) * 1000;
    // The same window the server accepts: not in the future, not older than 90 days.
    if (takenAt > Date.now() + 5 * 60 * 1000 || takenAt < Date.now() - 90 * 24 * 60 * 60 * 1000) return null;
  }
  return { heart_rate: heartRate, spo2, takenAt };
}
function takeDeviceImportFromLink() {
  const hash = location.hash;
  if (hash.startsWith("#" + DEVICE_IMPORT_ROUTE)) {
    // Take the numbers out of the address bar and the back history straight away.
    window.history.replaceState(null, "", location.pathname + location.search);
    const query = hash.indexOf("?");
    const reading = query < 0 ? null : parseDeviceImport(new URLSearchParams(hash.slice(query + 1)));
    state.deviceImport = reading;
    state.deviceImportBad = !reading;
    try { if (reading) sessionStorage.setItem(DEVICE_IMPORT_KEY, JSON.stringify(reading)); else sessionStorage.removeItem(DEVICE_IMPORT_KEY); } catch {}
    return;
  }
  // Coming back from Google sign-in: the reading waited in this tab's session storage.
  if (!state.deviceImport) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(DEVICE_IMPORT_KEY) || "null");
      if (saved) state.deviceImport = parseDeviceImport(new URLSearchParams({ ...(saved.heart_rate != null && { hr: String(saved.heart_rate) }),
        ...(saved.spo2 != null && { spo2: String(saved.spo2) }), ...(saved.takenAt != null && { t: String(Math.round(saved.takenAt / 1000)) }) }));
    } catch {}
  }
}
function clearDeviceImport() {
  state.deviceImport = null;
  try { sessionStorage.removeItem(DEVICE_IMPORT_KEY); } catch {}
}
function offerDeviceImport() {
  if (!state.user) { if (state.deviceImport) errorAt("#login-message", "Đăng nhập để lưu chỉ số từ máy đo."); return; }
  if (state.viewing && state.deviceImport) { toast("Quay về hồ sơ của bạn để lưu chỉ số từ máy đo."); return; }
  if (!state.health || state.viewing || $("#app-screen").classList.contains("hidden")) return;
  if (state.deviceImportBad) { state.deviceImportBad = false; toast("Đường link từ máy đo không hợp lệ. Chưa lưu gì.", "error"); }
  const reading = state.deviceImport;
  const dialog = $("#device-import-dialog");
  if (!reading || dialog.open) return;
  $("#device-import-when").textContent = reading.takenAt ? "Đo lúc " + date(new Date(reading.takenAt).toISOString())
    : "Máy đo chưa có giờ, nên lần đo sẽ được ghi là vừa xong.";
  const takenAt = new Date(reading.takenAt || Date.now());
  const values = { heart_rate: reading.heart_rate, spo2: reading.spo2 };
  const shown = METRICS.filter(m => values[m.key] != null);
  const host = $("#device-import-values");
  host.innerHTML = shown.map(m => importCard(m, values, takenAt)).join("");
  placeRanges(host);
  // Each chart: up to 6 earlier readings of that value, then this one (the filled point on the right).
  host.querySelectorAll(".import-trend").forEach(chartHost => {
    const key = chartHost.dataset.key, spec = TRENDS[key], before = importHistory(key, takenAt);
    const rows = [...before.map(row => ({ time: toDate(row.created_at), value: chartValue(key, row.vitals[key]) })), { time: takenAt, value: chartValue(key, values[key]) }];
    new TrendChart(chartHost).set({ height: 150, unit: spec.unit, band: spec.band, thresholds: [], min: spec.min, max: spec.max, times: rows.map(r => r.time),
      series: [{ label: spec.series[0][1], color: spec.series[0][2], values: rows.map(r => r.value), flags: rows.map(r => statusOf(key, { [key]: r.value })[0] !== "safe") }] });
  });
  $("#device-import-danger").classList.toggle("hidden", !shown.some(m => statusOf(m.key, values)[0] === "alert"));
  errorAt("#device-import-error");
  openDialog(dialog);
}
// The readings of one value saved before this one, oldest first (at most 6, as many as fit a small chart).
function importHistory(key, takenAt) {
  return state.records.filter(row => row.vitals?.[key] != null && toDate(row.created_at) < takenAt).slice(0, 6).reverse();
}
function importCard(m, values, takenAt) {
  const [level, word] = statusOf(m.key, values);
  const before = importHistory(m.key, takenAt);
  const last = before.at(-1);
  const compare = last ? "Lần trước: " + withUnit(valueOf(m.key, last.vitals), m.unit) + ", lúc " + date(last.created_at) + "." : "";
  return '<section class="import-metric"><div class="import-metric-head"><span class="metric-icon">' + icon(m.icon) + "</span><h3>" + m.label + "</h3></div>" +
    '<div class="import-value-row"><p class="import-value">' + valueOf(m.key, values) + "<small>" + m.unit + "</small></p>" +
    '<span class="tag ' + level + ' import-status"><span class="value-mark ' + level + '" aria-hidden="true"></span>' + word + "</span></div>" +
    rangeBar(m.key, values[m.key]) +
    (before.length
      ? '<p class="import-trend-label">Lần này so với ' + before.length + " lần đo trước</p>" +
        '<div class="trend-chart import-trend" data-key="' + m.key + '"></div><p class="visually-hidden">' + esc(compare) + "</p>"
      : '<p class="import-first">Chưa có lần đo nào trước đây để so sánh.</p>') +
    "</section>";
}
// The same link always gives the same id, so tapping it twice saves the reading once (the server keeps the first).
async function deviceClientId(reading) {
  if (!reading.takenAt || !crypto.subtle) return null;
  const text = ["genesense-device", reading.takenAt, reading.heart_rate, reading.spo2].join("|");
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}
async function saveDeviceImport() {
  const reading = state.deviceImport;
  if (!reading || state.busy) return;
  const values = {};
  if (reading.heart_rate != null) values.heart_rate = reading.heart_rate;
  if (reading.spo2 != null) values.spo2 = reading.spo2;
  const problem = vitalsProblem(values);
  if (problem) { errorAt("#device-import-error", problem); return; }
  const body = { vitals: { ...values, timestamp: new Date(reading.takenAt || Date.now()).toISOString() }, source: "device" };
  const button = $("#device-import-save");
  const epoch = state.authEpoch;
  state.busy = true;
  button.disabled = true; button.textContent = "Đang lưu…";
  errorAt("#device-import-error");
  try {
    const clientId = await deviceClientId(reading);
    if (clientId) body.client_id = clientId;
    const r = await api.assess(body);
    if (epoch !== state.authEpoch) return;
    const dialog = $("#device-import-dialog");
    clearDeviceImport();
    closeDialog(dialog);
    await Promise.all([refreshRecords(), refreshRisk()]);
    if (epoch !== state.authEpoch) return;
    navigate("dashboard");
    if (!isEmergency(r)) { toast("Đã lưu chỉ số từ máy đo."); return; }
    // As after any reading: focus moves once the dialog has really closed (the page behind it is inert until then).
    const showDanger = () => { if (state.result?.id === r.id) $("#emergency-title").focus(); else void showResult(r.id); };
    if (dialog.open) dialog.addEventListener("close", showDanger, { once: true }); else showDanger();
  } catch (error) {
    // The reading stays in the dialog so the person can try again.
    errorAt("#device-import-error", error.message);
  } finally {
    state.busy = false; button.disabled = false; button.textContent = "Lưu chỉ số";
  }
}

async function saveMeasurement(values, source, samples = [], takenAt = null) {
  if (state.busy) return;
  const problem = vitalsProblem(values);
  if (problem) { errorAt("#measurement-error", problem); return; }
  const userId = state.user.id;
  const body = { vitals: { ...values, timestamp: (takenAt || new Date()).toISOString() }, source, samples };
  if (source === "manual") body.client_id = crypto.randomUUID();
  state.busy = true;
  const epoch = state.authEpoch;
  const button = source === "manual" ? $('#measurement-form button[type="submit"]') : $("#save-device");
  const original = button.innerHTML;
  button.disabled = true; button.textContent = "Đang lưu…";
  errorAt("#measurement-error");
  try {
    const r = await api.assess(body);
    if (epoch !== state.authEpoch) return;
    const record = { id: r.id, created_at: r.created_at, risk_level: r.risk_level, overall_score: r.scores.overall, vitals: { ...values, source } };
    closeDialog($("#measurement-dialog"));
    if (takenAt) { $("#measurement-form").reset(); toast("Đã lưu chỉ số lúc " + date(body.vitals.timestamp) + "."); await refreshRecords(); return; }
    state.records = [record, ...state.records].slice(0, 100);
    state.result = r;
    $("#measurement-form").reset();
    stopStreams();
    // The new reading was scored against the current profile, so its scores are the live ones.
    if (state.risk) state.risk.scores = r.scores;
    renderDashboard(); renderHistory(); navigate("dashboard");
    if (isEmergency(r)) {
      // Focus can move only after the dialog has really closed: while it is open the page behind it is inert,
      // and on closing the browser hands focus back to the button that opened it, which is now hidden.
      const dialog = $("#measurement-dialog");
      const focusTitle = () => $("#emergency-title").focus();
      if (dialog.open) dialog.addEventListener("close", focusTitle, { once: true }); else focusTitle();
    } else toast("Đã lưu chỉ số.");
  } catch (error) {
    if (source === "manual" && epoch === state.authEpoch && state.user?.id === userId && (!navigator.onLine || !error.status)) {
      try { await queueManualReading(body); }
      catch { errorAt("#measurement-error", "Không lưu được trên thiết bị này. Hãy giữ lại số đo rồi thử lại."); }
    } else errorAt("#measurement-error", error.message);
  }
  finally { state.busy = false; button.disabled = false; button.innerHTML = original; if (source !== "manual") renderDevice(); }
}
// The browser's own range bubbles are English and vanish; each field gets a Vietnamese hint under it instead.
const FIELD_NAMES = { systolic: "Số trên", diastolic: "Số dưới", heart_rate: "Nhịp tim", spo2: "SpO₂", glucose: "Đường huyết" };
function fieldHint(input, text = "") {
  let hint = document.getElementById("hint-" + input.name);
  if (!hint && text) {
    hint = document.createElement("span");
    hint.id = "hint-" + input.name; hint.className = "field-hint";
    input.insertAdjacentElement("afterend", hint);
    input.setAttribute("aria-describedby", hint.id);
  }
  if (hint) { hint.textContent = text; hint.classList.toggle("hidden", !text); }
  if (text) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}
function checkFields(form) {
  let ok = true;
  form.querySelectorAll("input[type=number]").forEach(input => {
    const v = input.validity;
    const text = v.valid ? "" : v.rangeUnderflow || v.rangeOverflow
      ? FIELD_NAMES[input.name] + " thường từ " + num(Number(input.min)) + " đến " + num(Number(input.max)) + ". Hãy kiểm tra lại."
      : "Hãy nhập một số, ví dụ 120 hoặc 120,5.";
    fieldHint(input, text);
    if (text && ok) { ok = false; input.focus(); }
  });
  return ok;
}
async function submitManual(event) {
  event.preventDefault();
  const form = $("#measurement-form");
  if (!checkFields(form)) return;
  const data = new FormData(form);
  const values = Object.fromEntries(KEYS.map(key => [key, data.get(key)?.trim() ? Number(data.get(key)) : null]));
  if (values.glucose != null && data.get("glucose_context")) values.glucose_context = data.get("glucose_context");
  let takenAt = null;
  if (data.get("when") === "earlier") {
    const input = form.elements.measured_at;
    takenAt = input.value ? new Date(input.value) : null;
    const text = !takenAt ? "Hãy chọn ngày giờ đo." : takenAt > new Date() ? "Giờ đo không thể sau bây giờ." : Date.now() - takenAt > 7 * 864e5 ? "Chỉ ghi được lần đo trong 7 ngày qua." : "";
    fieldHint(input, text);
    if (text) { input.focus(); return; }
  }
  await saveMeasurement(values, "manual", [], takenAt);
}
function clearAccount() {
  state.authEpoch++;
  stopStreams();
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  state.viewing = null; state.own = null; state.care = { patients: [], caregivers: [] }; document.body.classList.remove("viewing");
  $("#viewing-banner").classList.add("hidden"); $("#viewing-text").textContent = "";
  setAvatar(null);
  if (state.scanUrl) URL.revokeObjectURL(state.scanUrl);
  state.scanUrl = null; $("#scan-image").removeAttribute("src"); $("#scan-save").removeAttribute("href");
  reportLayer = false;
  state.user = null; state.health = null; state.records = []; state.result = null; state.risk = null; state.weeklyBP = null; state.riskFailed = false; state.medicalRecords = []; state.medications = []; state.medicationIntakes = null; state.pendingAssessments = []; state.viewingMedications = null; state.recordsTab = null; state.historyAll = false; state.editing = false; state.rating = 0;
  renderSyncStatus();
  resetMedicalUpload();
  $("#profile-content").innerHTML = ""; $("#genetics-content").innerHTML = ""; $("#history-list").innerHTML = ""; $("#medical-record-list").innerHTML = ""; $("#result-detail").innerHTML = "";
  $("#onboarding-form").reset(); $("#measurement-form").reset(); $("#feedback-form").reset();
  $("#toast-region").innerHTML = "";
}
async function confirmSignOut() {
  const body = state.user.is_demo ? "Tài khoản dùng thử sẽ mất sau khi đăng xuất."
    : "Bạn cần đăng nhập lại để xem hồ sơ và ghi chỉ số.";
  if (await confirmAction("Đăng xuất?", body, "Đăng xuất")) signOut();
}
async function signOut() {
  try {
    // A trial account cannot be opened again, so its scans would stay on this device with no way to reach them.
    const orphans = state.user?.is_demo ? state.medicalRecords.map(record => record.id) : [];
    await api.logout();
    for (const id of orphans) await scanRequest("readwrite", store => store.delete(id));
    if (state.user?.is_demo) await deletePendingForAccount(state.user.id);
    clearAccount(); screen("login");
    accountChannel?.postMessage("signed-out");
    window.history.replaceState(null, "", "/");
  } catch (error) { toast(error.message, "error"); }
}
async function downloadAccountExport(button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const blob = await api.exportData();
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url;
    link.download = "genesense-du-lieu-ca-nhan.json";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Đã tạo bản sao dữ liệu. Ảnh giấy tờ trên thiết bị không nằm trong tệp này.");
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}
async function deleteAccountPermanently(button) {
  if (button.disabled || !state.user) return;
  const approved = await confirmAction("Xóa tài khoản và dữ liệu?",
    "Thao tác này xóa hồ sơ, lần đo, giấy tờ, thuốc và liên kết người thân trên máy chủ; không thể hoàn tác. Ảnh giấy tờ trên thiết bị cũng sẽ bị xóa.",
    "Xóa vĩnh viễn");
  if (!approved) return;
  button.disabled = true;
  try {
    const userId = state.user.id;
    const result = await api.deleteAccount();
    try {
      await deletePendingForAccount(userId);
      await Promise.all((result.deleted_medical_record_ids || []).map(id => scanRequest("readwrite", store => store.delete(id))));
    } catch { /* The server account is already deleted; private-mode storage may be unavailable. */ }
    clearAccount(); screen("login");
    accountChannel?.postMessage("signed-out");
    window.history.replaceState(null, "", "/");
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
}
async function markGeneticEvidenceReviewed(button) {
  if (button.disabled) return;
  const [recordId, indexText] = button.dataset.markEvidence.split(":"), index = Number(indexText);
  const source = button.closest(".evidence-review")?.querySelector(`[data-evidence-source="${CSS.escape(button.dataset.markEvidence)}"]`)?.value;
  if (!recordId || !Number.isInteger(index) || !source) return;
  button.disabled = true;
  try {
    const updated = await api.reviewGeneticFinding(recordId, index, source);
    state.medicalRecords = state.medicalRecords.map(record => record.id === updated.id ? updated : record);
    const saved = updated.analysis.genetic_findings[index], labels = { clinvar: "ClinVar", clingen: "ClinGen", care_team: "Bác sĩ/nhóm chăm sóc" };
    const note = button.closest(".evidence-review")?.querySelector(".note");
    if (note) note.textContent = "Bạn đã ghi nhận tự đối chiếu với " + labels[saved.evidence_review_source] + " ngày " + date(saved.evidence_review_on, false) + ". Đây không phải xác nhận của GeneSense.";
    button.textContent = "Cập nhật lần đối chiếu";
    toast("Đã ghi nhận lần đối chiếu do bạn thực hiện. GeneSense chưa xác minh kết quả.");
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
}
function searchGeneticEvidence(button) {
  const query = button.dataset.geneticsSearch;
  if (!query || !window.confirm("Mở ClinVar sẽ gửi truy vấn “" + query + "” đến NCBI. Không gửi tên hay thông tin tài khoản. Bạn có muốn tiếp tục không?")) return;
  window.open("https://www.ncbi.nlm.nih.gov/clinvar/?term=" + encodeURIComponent(query), "_blank", "noopener,noreferrer");
}
// step 1 opens the wizard straight at the family pages; the user returns to the tab they came from.
function editProfile(step = 0, memberId = null) {
  if (state.viewing) return;
  state.editing = true; state.editReturn = state.view; fillWizard(state.health);
  state.step = step; showStep();
  screen("onboarding");
  if (memberId) requestAnimationFrame(() => {
    const input = document.getElementById("knowledge-" + memberId);
    input?.scrollIntoView({ block: "center" }); input?.focus({ preventScroll: true });
  });
}
async function enterAccount(user) {
  state.familyLinks = { relatives: [] };
  state.familyInviteCode = null;
  state.familyInvitePreview = null;
  state.user = user;
  const epoch = ++state.authEpoch;
  const data = await api.profile();
  if (epoch !== state.authEpoch) return;
  state.health = data.health; state.user = data.user;
  state.pendingAssessments = await pendingForAccount(user.id).catch(() => []);
  renderSyncStatus();
  if (!user.onboarding_completed || !data.health) {
    state.editing = false; fillWizard(); screen("onboarding");
  } else {
    personalize(); screen("app");
    loadAvatar();
    await Promise.all([refreshRecords(), refreshMedicalRecords(), refreshMedications(), refreshCare(), refreshFamilyLinks(), refreshRisk()]);
    navigate(location.hash.slice(1) || "dashboard");
    void syncPendingAssessments();
    offerDeviceImport();
  }
}
async function boot() {
  screen("loading");
  $("#retry-boot").classList.add("hidden");
  try {
    const config = await api.authConfig();
    state.documentAiEnabled = Boolean(config.document_ai_enabled);
    state.aiProvider = config.ai_provider || "AI";
    $("#document-ai-provider").textContent = state.aiProvider;
    $("#upload-record").disabled = false;
    $("#records-ai-off").classList.toggle("hidden", state.documentAiEnabled);
    $("#document-ai-unavailable").classList.toggle("hidden", state.documentAiEnabled);
    $(".upload-consent").classList.toggle("hidden", !state.documentAiEnabled);
    $("#google-login").disabled = !config.google_enabled;
    $("#demo-entry").classList.toggle("hidden", !config.demo_enabled);
    const loginError = new URLSearchParams(location.search).get("auth_error");
    errorAt("#login-message", loginError ? "Chưa đăng nhập được với Google. Hãy thử lại hoặc chọn tài khoản khác." : !config.google_enabled ? "Đăng nhập bằng Google sẽ có trong bản chính thức." : "");
    if (loginError) window.history.replaceState(null, "", "/");
    let user;
    try { user = await api.me(); } catch (error) { if (error.status !== 401) throw error; }
    if (user) await enterAccount(user);
    else {
      screen("login");
      if (!loginError) offerDeviceImport();
    }
  } catch (error) {
    $("#loading-screen p").textContent = error.message;
    $("#retry-boot").classList.remove("hidden");
  }
}

// "Hiệu ứng kính mờ" is a choice for this device, so it is kept in this browser only. On by default.
function applyGlass(on) {
  document.body.classList.toggle("no-glass", !on);
  $("#glass-setting").checked = on;
}
function applyLargeText(on) {
  document.documentElement.classList.toggle("large-text", on);
  $("#large-text-setting").checked = on;
}
function bindEvents() {
  $("#large-text-setting").addEventListener("change", event => {
    applyLargeText(event.target.checked);
    try { localStorage.setItem("genesense-large-text", event.target.checked ? "on" : "off"); } catch {}
  });
  $("#glass-setting").addEventListener("change", event => {
    applyGlass(event.target.checked);
    try { localStorage.setItem("genesense-glass", event.target.checked ? "on" : "off"); } catch {}
  });
  $("#sidebar-toggle").addEventListener("click", () => setNavDrawer($("#sidebar-toggle").getAttribute("aria-expanded") !== "true"));
  $("#nav-close").addEventListener("click", () => setNavDrawer(false));
  $("#nav-scrim").addEventListener("click", () => setNavDrawer(false));
  document.addEventListener("keydown", event => {
    const drawer = $("#app-nav-drawer");
    if (!drawer.classList.contains("is-open")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setNavDrawer(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...drawer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0);
    const first = focusable[0], last = focusable.at(-1), active = document.activeElement;
    if (!first || !last) {
      event.preventDefault();
      drawer.focus({ preventScroll: true });
    } else if (event.shiftKey && (!drawer.contains(active) || active === first)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (!drawer.contains(active) || active === last)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });
  $("#google-login").addEventListener("click", () => { location.assign("/api/auth/google"); });
  $("#demo-login").addEventListener("click", async () => {
    const button = $("#demo-login"); button.disabled = true;
    try { await enterAccount(await api.demo()); accountChannel?.postMessage("account-changed"); }
    catch (error) { errorAt("#login-message", error.message); }
    finally { button.disabled = false; }
  });
  $("#retry-boot").addEventListener("click", boot);
  $("#logout").addEventListener("click", confirmSignOut);
  // The header shows the signed-in person, so it always leads to their own profile, also while viewing a relative.
  $("#account-link").addEventListener("click", async event => { if (state.viewing) { event.preventDefault(); await exitViewing(); navigate("profile"); } });
  $("#profile-content").addEventListener("click", event => {
    if (event.target.closest("#avatar-change")) $("#avatar-file").click();
    if (event.target.closest("#avatar-remove")) removeAvatar();
  });
  $("#avatar-file").addEventListener("change", event => { chooseAvatar(event.target.files[0]); event.target.value = ""; });
  $("#avatar-zoom").addEventListener("input", event => zoomCrop(Number(event.target.value)));
  $("#avatar-save").addEventListener("click", saveAvatar);
  const cropCanvas = $("#avatar-canvas");
  // Positions are compared by hand: movementX is unreliable for touch in some browsers.
  let dragFrom = null;
  cropCanvas.addEventListener("pointerdown", event => { dragFrom = [event.clientX, event.clientY]; try { cropCanvas.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ } });
  cropCanvas.addEventListener("pointermove", event => {
    if (!dragFrom) return;
    const k = CROP / cropCanvas.clientWidth;
    moveCrop((event.clientX - dragFrom[0]) * k, (event.clientY - dragFrom[1]) * k);
    dragFrom = [event.clientX, event.clientY];
  });
  ["pointerup", "pointercancel"].forEach(type => cropCanvas.addEventListener(type, () => { dragFrom = null; }));
  cropCanvas.addEventListener("keydown", event => {
    const step = { ArrowLeft: [16, 0], ArrowRight: [-16, 0], ArrowUp: [0, 16], ArrowDown: [0, -16] }[event.key];
    if (step) { event.preventDefault(); moveCrop(...step); }
  });
  $("#onboarding-exit").addEventListener("click", () => { if (state.editing) { state.editing = false; screen("app"); navigate(state.editReturn); } else signOut(); });
  $("#onboarding-form").addEventListener("submit", nextStep);
  $("#onboarding-form").addEventListener("change", event => {
    if (event.target.matches("[data-knowledge]")) {
      const memberCard = event.target.closest("[data-member]");
      const chips = memberCard.querySelector(".chips");
      chips.hidden = event.target.value !== "known";
      if (chips.hidden) chips.querySelectorAll("input").forEach(input => input.checked = false);
      const provenance = memberCard.querySelector(".family-provenance");
      provenance.hidden = event.target.value === "unknown";
      const memberId = memberCard.dataset.member;
      const hereditaryKnown = $$('[data-hereditary] input:checked').some(input => input.value === memberId);
      memberCard.querySelectorAll(".member-count").forEach(label => {
        const input = label.querySelector("input");
        const ageField = input.hasAttribute("data-diagnosis-age");
        const hidden = ageField ? (chips.hidden && !hereditaryKnown) : chips.hidden;
        label.hidden = hidden;
        input.disabled = hidden;
        // Clear optional details if the history is changed to unknown/none.
        if (hidden && ageField) input.value = "";
        else if (chips.hidden && input.hasAttribute("data-affected")) input.value = "1";
        else if (chips.hidden && input.hasAttribute("data-brothers")) input.value = "0";
      });
    }
    if (event.target.matches("[data-hereditary] input")) {
      const who = event.target.value;
      const memberCard = $('[data-member="' + who + '"]');
      if (who === "maternal-uncle") {
        const hereditaryKnown = $$('[data-hereditary] input:checked').some(input => input.value === who);
        const age = $("[data-maternal-uncle-age]");
        const uncleFields = $("#maternal-uncle-age-field");
        uncleFields.hidden = !hereditaryKnown;
        uncleFields.querySelectorAll("input, select").forEach(input => { input.disabled = !hereditaryKnown; });
        age.disabled = !hereditaryKnown;
        if (!hereditaryKnown) age.value = "";
      }
      if (who !== "self" && memberCard) {
        const hereditaryKnown = $$('[data-hereditary] input:checked').some(input => input.value === who);
        const generalKnown = memberCard.querySelector("[data-knowledge]").value === "known";
        const age = memberCard.querySelector("[data-diagnosis-age]");
        age.closest("label").hidden = !(generalKnown || hereditaryKnown);
        age.disabled = !(generalKnown || hereditaryKnown);
        if (!generalKnown && !hereditaryKnown) age.value = "";
      }
    }
  });
  $("#step-back").addEventListener("click", () => { state.step = Math.max(0, state.step - 1); showStep(); });
  ["height", "weight"].forEach(id => $("#" + id).addEventListener("input", updateBmi));
  document.addEventListener("click", event => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      if (nav.dataset.nav === "records") state.recordsTab = null;
      navigate(nav.dataset.nav);
      if (nav.closest("#app-nav-drawer")) {
        setNavDrawer(false, false);
        $("#main-content").focus({ preventScroll: true });
      }
    }
    const close = event.target.closest("[data-close]");
    if (close) closeDialog($("#" + close.dataset.close));
    const record = event.target.closest("[data-record]");
    if (record) showResult(record.dataset.record);
    const deleteRecord = event.target.closest("[data-delete-record]");
    if (deleteRecord) deleteMedicalRecord(deleteRecord.dataset.deleteRecord);
    const exportButton = event.target.closest("#privacy-export");
    if (exportButton) downloadAccountExport(exportButton);
    const deleteAccountButton = event.target.closest("#account-delete");
    if (deleteAccountButton) deleteAccountPermanently(deleteAccountButton);
    const geneticsSearch = event.target.closest("[data-genetics-search]");
    if (geneticsSearch) searchGeneticEvidence(geneticsSearch);
    const markEvidence = event.target.closest("[data-mark-evidence]");
    if (markEvidence) markGeneticEvidenceReviewed(markEvidence);
    const scan = event.target.closest("[data-view-scan]");
    if (scan) viewScan(scan.dataset.viewScan);
    const tab = event.target.closest("[data-records-tab]");
    if (tab) { state.recordsTab = tab.dataset.recordsTab; renderRecordsTab(); }
    if (event.target.closest("[data-open-medicines]")) { state.recordsTab = "medicines"; navigate("records"); }
    if (event.target.closest("[data-add-medicine]")) { state.recordsTab = "medicines"; navigate("records"); openMedicine(); }
    if (event.target.closest("#medicine-print")) printMedicineSchedule();
    const historyTab = event.target.closest("[data-history-tab]");
    if (historyTab) showHistoryTab(historyTab.dataset.historyTab);
    const historyView = event.target.closest("[data-history-view]");
    if (historyView) { navigate("history"); showHistoryTab(historyView.dataset.historyView); }
    const editMedicine = event.target.closest("[data-edit-medicine]");
    if (editMedicine) openMedicine(editMedicine.dataset.editMedicine);

    if (event.target.closest("[data-open-upload]")) openMedicalUpload();
    if (event.target.closest("[data-open-manual-genetics]")) openManualGenetics();
    const removeManualFinding = event.target.closest("[data-remove-manual-finding]");
    if (removeManualFinding && $$("[data-manual-finding]").length > 1) { removeManualFinding.closest("[data-manual-finding]").remove(); updateManualFindingControls(); }
    const geneticRecord = event.target.closest("[data-open-genetic-record]");
    if (geneticRecord) openGeneticRecord(geneticRecord.dataset.openGeneticRecord);
    if (event.target.closest("[data-open-genetics-summary]")) openReport();
    const viewTarget = event.target.closest("[data-view-patient]");
    if (viewTarget) viewPatient(viewTarget.dataset.viewPatient);
    const removeTarget = event.target.closest("[data-remove-link]");
    if (removeTarget) removeCareLink(removeTarget.dataset.removeLink, removeTarget.dataset.removeKind);
    if (event.target.closest("#care-create")) createCareCode();
    if (event.target.closest("#family-create-invite")) createFamilyInvite();
    if (event.target.closest("#family-invite-accept")) acceptFamilyInvite();
    const removeFamily = event.target.closest("[data-family-remove]");
    if (removeFamily) removeFamilyLink(removeFamily.dataset.familyRemove);
    if (event.target.closest("#exit-viewing")) exitViewing();
    if (event.target.closest("[data-open-measurement]")) openMeasurement();
    if (event.target.closest("#history-add")) openMeasurement();
    if (event.target.closest("#retry-history")) refreshRecords();
    if (event.target.closest("#retry-risk")) refreshRisk();
    const editMember = event.target.closest("[data-edit-member]");
    if (editMember) editProfile(1, editMember.dataset.editMember);
    else if (event.target.closest("[data-edit-family]")) editProfile(1);
    else if (event.target.closest("[data-edit-hereditary]")) editProfile(LAST_STEP);
  });
  $("#edit-profile").addEventListener("click", () => editProfile());
  document.addEventListener("submit", event => {
    if (event.target.id === "care-form") acceptCareCode(event);
    if (event.target.id === "family-invite-preview-form") previewFamilyInvite(event);
  });
  $$("dialog").forEach(dialog => dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(dialog); }));
  $("#delete-assessment").addEventListener("click", event => deleteAssessment(event.currentTarget.dataset.id));
  $("#new-measurement").addEventListener("click", () => openMeasurement());
  $("#upload-record").addEventListener("click", openMedicalUpload);
  $("#manual-genetics-add").addEventListener("click", addManualFinding);
  $("#manual-genetics-form").addEventListener("submit", saveManualGenetics);
  $("#add-medicine").addEventListener("click", () => openMedicine());
  $("#medicine-form").addEventListener("submit", saveMedicine);
  $("#care-panel").addEventListener("change", event => {
    if (event.target.matches("#care-share-medications")) setMedicationSharing(event.target);
  });
  document.addEventListener("change", event => {
    if (event.target.matches("[data-medication-intake]")) setMedicationIntake(event.target);
    if (event.target.matches("#family-confirm-relationship")) $("#family-invite-accept").disabled = !event.target.checked;
    if (event.target.matches("[data-family-share]")) setFamilySharing(event.target);
  });
  document.addEventListener("input", event => {
    if (event.target.matches("#family-invite-code") && state.familyInvitePreview?.code !== event.target.value.trim()) {
      state.familyInvitePreview = null;
      $(".family-invite-preview")?.remove();
    }
  });
  $("#medicine-form").addEventListener("change", event => {
    const form = event.currentTarget;
    if (event.target.type === "checkbox") keepSlotChoice(event.target, SLOTS.map(([key]) => form.elements[key]), form.elements.as_needed);
  });
  $("#medicine-delete").addEventListener("click", () => deleteMedicine(state.editingMedicine));
  $("#medical-camera-file").addEventListener("change", selectMedicalImage);
  $("#medical-document-file").addEventListener("change", selectMedicalImage);
  $("#document-ai-consent").addEventListener("change", updateDocumentButton);
  $("#analyze-document").addEventListener("click", analyzeMedicalDocument);
  $("#analyze-another").addEventListener("click", resetMedicalUpload);
  $("#confirm-medical-record").addEventListener("change", event => { $("#save-medical-record").disabled = !event.target.checked || state.busy; });
  $("#save-medical-record").addEventListener("click", saveMedicalRecord);
  $("#document-apply").addEventListener("submit", event => event.preventDefault());
  $("#document-apply").addEventListener("change", event => {
    if (event.target.id === "apply-vitals") $("#document-apply").querySelectorAll("[data-apply-vital], #apply-date").forEach(el => { el.disabled = !event.target.checked; });
    if (event.target.matches("[data-med-on]")) syncApplyMedicines();
    const card = event.target.closest("[data-apply-medicine]");
    if (card && event.target.matches("[data-med-slot], [data-med-needed]")) keepSlotChoice(event.target, [...card.querySelectorAll("[data-med-slot]")], card.querySelector("[data-med-needed]"));
  });
  $("#medical-upload-dialog").addEventListener("close", resetMedicalUpload);
  $$("[data-measure-mode]").forEach(button => button.addEventListener("click", () => setMeasureMode(button.dataset.measureMode)));
  $("#measurement-dialog").addEventListener("close", () => { stopStreams(); $("#measurement-form").reset(); });
  $("#measurement-form").addEventListener("submit", submitManual);
  $("#measurement-form").addEventListener("change", event => {
    if (event.target.name !== "when") return;
    const earlier = event.target.value === "earlier", input = $("#measurement-form").elements.measured_at;
    $("#measured-at-time").classList.toggle("hidden", !earlier);
    if (earlier) {
      const local = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
      input.max = local(new Date()); input.min = local(new Date(Date.now() - 7 * 864e5));
      if (!input.value) input.value = input.max;
      // Centred, so the sticky save bar never covers the field that just appeared.
      input.focus({ preventScroll: true });
      $("#measured-at-time").scrollIntoView({ block: "center" });
    } else fieldHint(input, "");
  });
  $("#measurement-form").addEventListener("reset", () => { $("#measured-at-time").classList.add("hidden"); fieldHint($("#measurement-form").elements.measured_at, ""); });
  // A message about the old input must not stay once the user changes it.
  $("#measurement-form").addEventListener("input", event => { errorAt("#measurement-error"); if (event.target.name in FIELD_NAMES) fieldHint(event.target); });
  $("#connect-ble").addEventListener("click", connectBle);
  $("#simulate-ble").addEventListener("click", startSimulation);
  $("#disconnect-device").addEventListener("click", stopStreams);
  $("#save-device").addEventListener("click", () => saveMeasurement(freshValues(), state.deviceSource || "ble", state.samples.slice()));
  $("#open-report").addEventListener("click", openReport);
  $("#report-days").addEventListener("change", renderReport);
  $("#report-print").addEventListener("click", () => window.print());
  $("#report-back").addEventListener("click", () => { if (reportLayer) { reportLayer = false; dropLayer(); } screen("app"); navigate(state.reportReturnView || "history"); });
  $("#history-filter").addEventListener("change", () => { state.historyAll = false; renderHistory(); });
  $("#history-list").addEventListener("click", event => { if (event.target.closest("#history-more")) { state.historyAll = true; renderHistory(); } });
  // Charts are drawn at the width they have at that moment, so they are drawn again when the window changes size.
  window.addEventListener("resize", () => { if (state.user && state.view === "history") renderTrends(); });
  $("#rating-buttons").innerHTML = [1, 2, 3, 4, 5].map(n => '<button type="button" data-rating="' + n + '" aria-pressed="false">' + n + "</button>").join("");
  $("#rating-buttons").addEventListener("click", event => {
    const button = event.target.closest("[data-rating]");
    if (!button) return;
    state.rating = Number(button.dataset.rating);
    $$("[data-rating]").forEach(el => { el.classList.toggle("active", Number(el.dataset.rating) <= state.rating); el.setAttribute("aria-pressed", String(Number(el.dataset.rating) === state.rating)); });
  });
  $("#feedback-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!state.rating) { toast("Hãy chọn mức độ hài lòng từ 1 đến 5.", "error"); return; }
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    const epoch = state.authEpoch;
    try {
      await api.feedback({ rating: state.rating, message: $("#feedback-message").value.trim(), assessment_id: null });
      if (epoch !== state.authEpoch) return;
      $("#feedback-form").reset(); state.rating = 0;
      $$("[data-rating]").forEach(el => { el.classList.remove("active"); el.setAttribute("aria-pressed", "false"); });
      toast("Đã gửi góp ý. Xin cảm ơn.");
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  });
  window.addEventListener("session-expired", () => { clearAccount(); screen("login"); errorAt("#login-message", "Phiên đã hết hạn. Hãy đăng nhập lại để tiếp tục."); });
  window.addEventListener("online", () => { renderSyncStatus(); void syncPendingAssessments(); });
  window.addEventListener("offline", renderSyncStatus);
  accountChannel?.addEventListener("message", () => { clearAccount(); boot(); });
  // Links like the header logo only change the hash; route on every hash change (also back/forward).
  window.addEventListener("hashchange", () => {
    if (location.hash.startsWith("#" + DEVICE_IMPORT_ROUTE)) { takeDeviceImportFromLink(); offerDeviceImport(); return; }
    if (state.user && state.health) navigate(location.hash.slice(1) || "dashboard");
  });
  $("#device-import-save").addEventListener("click", saveDeviceImport);
  $("#device-import-skip").addEventListener("click", () => closeDialog($("#device-import-dialog")));
  // However the dialog closes without saving (Bỏ qua, X, Esc, back), the reading is dropped so it does not ask again.
  $("#device-import-dialog").addEventListener("close", clearDeviceImport);
  window.addEventListener("popstate", () => {
    // Our own step back after a layer closed by its button: only keep the address on the page shown.
    if (layerPops) { layerPops--; if (state.user && state.health) history.replaceState(null, "", "#" + state.view); return; }
    const dialog = $$("dialog[open][data-layer]").sort((a, b) => b.dataset.layer - a.dataset.layer)[0];
    if (dialog) { delete dialog.dataset.layer; closeDialog(dialog); }
    else if (reportLayer) { reportLayer = false; screen("app"); navigate("history"); }
  });
  document.addEventListener("close", event => {
    if (!event.target.dataset?.layer) return;
    delete event.target.dataset.layer;
    dropLayer();
  }, true);
  window.addEventListener("pagehide", stopStreams);
  window.addEventListener("pageshow", event => { if (event.persisted) { clearAccount(); boot(); } });
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !state.user) return;
    try { const me = await api.me(); if (me.id !== state.user?.id) { clearAccount(); await boot(); } else { void syncPendingAssessments(); refreshIfNewDay(); } }
    catch (error) { if (error.status === 401) { clearAccount(); await boot(); } }
  });
}
hydrateIcons();
takeDeviceImportFromLink();
bindEvents();
try { applyGlass(localStorage.getItem("genesense-glass") !== "off"); } catch { applyGlass(true); }
try { applyLargeText(localStorage.getItem("genesense-large-text") === "on"); } catch { applyLargeText(false); }
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
