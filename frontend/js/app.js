import { api } from "./api.js";
import { HealthBleClient, VitalSimulator } from "./ble.js";
import { TrendChart } from "./chart.js";
import { hydrateIcons } from "./icons.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const CONDITIONS = [["hypertension", "Tăng huyết áp"], ["diabetes", "Đái tháo đường"], ["cardiovascular", "Bệnh tim mạch"], ["stroke", "Đột quỵ"], ["dyslipidemia", "Rối loạn mỡ máu"], ["breast_cancer", "Ung thư vú"], ["colorectal_cancer", "Ung thư đại trực tràng"]];
const MEMBERS = [
  { id: "father", label: "Bố", relation: "father", side: "immediate" },
  { id: "mother", label: "Mẹ", relation: "mother", side: "immediate" },
  { id: "sibling", label: "Anh chị em ruột", relation: "sibling", side: "immediate" },
  { id: "paternal-grandfather", label: "Ông nội", relation: "grandfather", side: "paternal" },
  { id: "paternal-grandmother", label: "Bà nội", relation: "grandmother", side: "paternal" },
  { id: "maternal-grandfather", label: "Ông ngoại", relation: "grandfather", side: "maternal" },
  { id: "maternal-grandmother", label: "Bà ngoại", relation: "grandmother", side: "maternal" },
];
const METRICS = [
  { key: "systolic", label: "Huyết áp", unit: "mmHg" },
  { key: "heart_rate", label: "Nhịp tim", unit: "lần/phút" },
  { key: "spo2", label: "Oxy trong máu (SpO₂)", unit: "%" },
  { key: "glucose", label: "Đường huyết", unit: "mg/dL" },
];
const KEYS = ["heart_rate", "systolic", "diastolic", "spo2", "glucose"];
const LEVELS = { safe: "An toàn", attention: "Cần chú ý", alert: "Nên đi khám sớm", emergency: "Nguy hiểm", watch: "Cần theo dõi" };
const SUMMARY_FALLBACK = { safe: "Các chỉ số vừa đo chưa chạm ngưỡng cảnh báo.", attention: "Có chỉ số cần theo dõi. Hãy đo lại.", alert: "Nguy cơ tổng hợp ở mức cao. Nên sắp xếp đi khám.", emergency: "Có chỉ số ở mức nguy hiểm." };
const SOURCE_NAMES = { manual: "Nhập tay", ble: "Máy đo Bluetooth", simulation: "Dữ liệu mẫu", document: "Từ giấy tờ" };
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
const isEmergency = result => Boolean(result?.alerts?.some(a => a.severity === "alert"));
const levelOf = result => isEmergency(result) ? "emergency" : result.risk_level;
const isReal = record => (record.vitals?.source || "manual") !== "simulation";
const DOCUMENT_TYPES = { lab_result: "Kết quả xét nghiệm", prescription: "Đơn thuốc", discharge_note: "Giấy ra viện", imaging_report: "Kết quả chẩn đoán hình ảnh", vaccination: "Tiêm chủng", other: "Tài liệu sức khỏe" };
const FLAG_NAMES = { normal: "Trong khoảng tham chiếu", high: "Cao", low: "Thấp", abnormal: "Cần xem lại", unknown: "Chưa rõ" };
const state = { viewing: null, own: null, care: { patients: [], caregivers: [] }, user: null, health: null, records: [], result: null, risk: null, step: 0, editing: false, rating: 0,
  medicalRecords: [], medications: [], recordsTab: null, editingMedicine: null, pendingMedical: null, documentAiEnabled: false, aiProvider: "AI", previewUrl: null,
  deviceSource: null, deviceValues: {}, deviceTimes: {}, samples: [], deviceEpoch: 0, authEpoch: 0, busy: false, view: "dashboard" };
let ble = null;
let simulator = null;
let freshnessTimer = null;
const accountChannel = "BroadcastChannel" in window ? new BroadcastChannel("genesense-account") : null;

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
// Plays the exit animation before the native close, so "close" listeners still fire once, at the end.
function closeDialog(dialog) {
  if (!dialog.open || dialog.classList.contains("closing")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { dialog.close(); return; }
  dialog.classList.add("closing");
  const done = () => { dialog.classList.remove("closing"); if (dialog.open) dialog.close(); };
  dialog.addEventListener("animationend", done, { once: true });
  setTimeout(done, 250);
}
function confirmAction(title, body = "Không thể khôi phục sau khi xóa.", okLabel = "Xóa") {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-ok").textContent = okLabel;
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true }));
}
function errorAt(id, text = "") {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("hidden", !text);
}
function screen(name) {
  ["loading", "login", "onboarding", "app", "report"].forEach(key => $("#" + key + "-screen").classList.toggle("hidden", key !== name));
  if (name !== "app") document.title = "GeneSense - Theo dõi sức khỏe";
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
function valueOf(key, values = {}) {
  if (values[key] == null) return "-";
  if (key === "systolic") return Math.round(values.systolic) + "/" + (values.diastolic == null ? "-" : Math.round(values.diastolic));
  return key === "spo2" ? num(values[key]) : Math.round(values[key]).toString();
}
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
  $("#avatar-dialog").showModal();
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
function navigate(view) {
  if (!state.user || !state.health) return;
  state.view = ["dashboard", "records", "history", "genetics", "profile"].includes(view) && !(state.viewing && view === "records") ? view : "dashboard";
  $$(".view").forEach(el => el.classList.toggle("hidden", el.id !== state.view + "-view"));
  $$("nav [data-nav]").forEach(button => {
    button.classList.toggle("active", button.dataset.nav === state.view);
    if (button.dataset.nav === state.view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.title = { dashboard: "Hôm nay", records: "Thuốc và giấy tờ", history: "Lịch sử đo", genetics: "Di truyền", profile: "Hồ sơ" }[state.view] + " - GeneSense";
  window.history.replaceState(null, "", "#" + state.view);
  if (state.view === "profile") renderProfile();
  if (state.view === "genetics") renderGenetics();
  if (state.view === "records") { renderMedicalRecords(); renderRecordsTab(); }
  if (state.view === "history") { renderHistory(); renderTips(); renderTrends(); }
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
      return '<div class="family-member" data-member="' + member.id + '"><div class="member-top"><strong>' + member.label + '</strong><label class="visually-hidden" for="knowledge-' + member.id + '">Tiền sử ' + member.label + '</label><select id="knowledge-' + member.id + '" data-knowledge><option value="unknown"' + (knowledge === "unknown" ? " selected" : "") + '>Chưa rõ</option><option value="none"' + (knowledge === "none" ? " selected" : "") + '>Không có bệnh đã biết</option><option value="known"' + (knowledge === "known" ? " selected" : "") + '>Có bệnh đã biết</option></select></div><div class="chips"' + (knowledge === "known" ? "" : " hidden") + '>' + conditionChips(member.id, saved?.conditions) + "</div>" + (member.id === "sibling" ? '<label class="member-count"' + (knowledge === "known" ? "" : " hidden") + '>Số anh chị em mắc bệnh<input type="number" inputmode="numeric" data-affected min="1" max="10" value="' + (saved?.affected_count || 1) + '"></label>' : "") + "</div>";
    }).join("");
  }
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
function showStep() {
  $$("[data-step]").forEach(el => el.hidden = Number(el.dataset.step) !== state.step);
  $$("[data-step-indicator]").forEach(el => { el.classList.toggle("active", Number(el.dataset.stepIndicator) === state.step); el.classList.toggle("done", Number(el.dataset.stepIndicator) < state.step); });
  $("#step-caption").textContent = "Bước " + (state.step + 1) + " trên 3";
  $("#onboarding-progress").value = state.step + 1;
  $("#step-back").hidden = state.step === 0;
  $("#step-next").textContent = state.step === 2 ? (state.editing ? "Lưu thay đổi" : "Hoàn tất") : "Tiếp tục";
  errorAt("#onboarding-error");
}
function validCurrentStep() {
  const active = $('[data-step="' + state.step + '"]');
  errorAt("#onboarding-error");
  const invalid = [...active.querySelectorAll("input, select, textarea")].find(el => !el.checkValidity());
  if (invalid) { invalid.reportValidity(); invalid.focus(); return false; }
  const missing = [...active.querySelectorAll("[data-member]")].find(el => el.querySelector("select").value === "known" && !el.querySelector("input:checked"));
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
      smoker: $("#smoker").checked, activity_minutes_week: Number($("#activity").value), known_conditions: $$('#personal-conditions input:checked').map(el => el.value) },
    family_history: MEMBERS.map(m => {
      const el = $('[data-member="' + m.id + '"]');
      const knowledge = el.querySelector("select").value;
      return { member_id: m.id, relation: m.relation, side: m.side, knowledge,
        affected_count: knowledge === "known" ? Math.min(10, Math.max(1, Math.round(Number(el.querySelector("[data-affected]")?.value) || 1))) : 1,
        conditions: knowledge === "known" ? [...el.querySelectorAll("input:checked")].map(box => box.value) : [] };
    }),
    personal_notes: $("#personal-notes").value.trim(), paternal_notes: $("#paternal-notes").value.trim(), maternal_notes: $("#maternal-notes").value.trim(),
    ai_consent: $("#ai-consent").checked, health_consent: $("#health-consent").checked,
  };
}
async function nextStep(event) {
  event.preventDefault();
  if (!validCurrentStep()) return;
  if (state.step < 2) {
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
    await Promise.all([refreshRecords(), refreshCare(), refreshRisk()]);
    navigate(wasEditing ? state.editReturn : "dashboard");
    toast(wasEditing ? "Đã lưu hồ sơ." : "Đã lưu hồ sơ. Bạn có thể ghi chỉ số đầu tiên.");
  } catch (error) { errorAt("#onboarding-error", error.message); }
  finally { button.disabled = false; button.innerHTML = original; }
}

function rangeBar(key, value) {
  const scale = ZONES[key];
  const pos = v => ((Math.min(scale.max, Math.max(scale.min, v)) - scale.min) / (scale.max - scale.min) * 100).toFixed(1);
  // Positions travel as data attributes and are applied by placeRanges(): the Content-Security-Policy blocks style attributes.
  return '<div class="range" aria-hidden="true">' + scale.zones.map(([from, to, level]) => '<span class="range-zone ' + level + '" data-left="' + pos(from) + '" data-width="' + (pos(to) - pos(from)).toFixed(1) + '"></span>').join("") + '<span class="range-mark" data-left="' + pos(value) + '"></span></div>';
}
function placeRanges(root) {
  root.querySelectorAll("[data-left]").forEach(el => {
    el.style.left = el.dataset.left + "%";
    if (el.dataset.width) el.style.width = el.dataset.width + "%";
  });
}
function renderMetrics() {
  const values = state.result?.measured_vitals || {};
  $("#metric-grid").innerHTML = METRICS.map(m => {
    const [level, status] = statusOf(m.key, values);
    const measured = values[m.key] != null;
    const flag = level === "attention" || level === "alert" ? '<span class="reading-flag flag-' + level + '">' + status + "</span>" : "";
    return '<div class="reading"><span class="reading-name">' + m.label + "</span>" + (measured ? '<span class="reading-value">' + valueOf(m.key, values) + "<small>" + m.unit + "</small></span>" + rangeBar(m.key, values[m.key]) : '<span class="reading-value empty">Chưa đo</span>') + flag + "</div>";
  }).join("");
  placeRanges($("#metric-grid"));
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
  $("#tip-list").innerHTML = cards.join("") + dailyCard;
  // Today shows only the top personal tip and the daily one; advice must not compete with the emergency panel.
  $("#today-tips").innerHTML = (cards[0] || "") + dailyCard;
  $("#today-advice").classList.toggle("hidden", isEmergency(state.result));
  // During the 24h watch window the stored "all fine" follow-up would contradict Today.
  const followUp = state.result && !isEmergency(state.result) && recentEmergency() ? "" : state.result?.insight.follow_up || "";
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
  const status = $("#risk-status");
  status.className = "status-word " + ({ emergency: "alert", watch: "attention" }[level] || level);
  status.textContent = r ? LEVELS[level] : "Chưa có dữ liệu";
  $("#risk-summary").textContent = !r ? "Nhập chỉ số từ máy đo để xem đánh giá đầu tiên." : level === "emergency" ? SUMMARY_FALLBACK.emergency : level === "watch" ? "24 giờ qua có lần đo ở mức nguy hiểm." : r.insight.summary || SUMMARY_FALLBACK[level];
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
  renderMedicineLink();
}
// Charts show what the readings table shows: whole numbers, except SpO₂ which keeps one decimal.
const chartValue = (key, value) => key === "spo2" ? value : Math.round(value);
function renderTrends() {
  const source = state.result?.measurement_source;
  // Every source shares one chart: typed-in, Bluetooth and sample readings.
  const rows = state.records.slice(0, 30).reverse();
  $("#chart-context").textContent = source ? "Tối đa 30 lần đo gần nhất" : "";
  for (const [id, spec] of Object.entries(TRENDS)) {
    const card = $('[data-trend="' + id + '"]');
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
      series: spec.series.map(([key, label, color]) => ({ label, color, values: points.map(row => chartValue(key, row.vitals[key])) })) });
  }
}
function pickCurrent(rows) {
  return rows.find(row => !fromDocument(row)) || null;
}
async function refreshRecords() {
  const epoch = state.authEpoch;
  try {
    const rows = await reader().history();
    if (epoch !== state.authEpoch) return;
    const current = pickCurrent(rows);
    const result = current ? await reader().assessment(current.id) : null;
    if (epoch !== state.authEpoch) return;
    state.records = rows; state.result = result;
    renderDashboard(); renderHistory();
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
function renderHistory() {
  const filter = $("#history-filter").value;
  const records = state.records.filter(row => filter === "all" || (filter === "simulation" ? !isReal(row) : isReal(row)));
  if (!records.length) {
    $("#history-list").innerHTML = '<div class="empty-state"><h3>' + (state.records.length ? "Không có lần đo phù hợp" : "Chưa có lần đo nào") + '</h3><p>Các lần đo sẽ hiện ở đây sau khi bạn ghi chỉ số.</p><button class="btn outline" id="history-add">Ghi chỉ số</button></div>';
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
      return '<li><span class="value-mark ' + mark + '" aria-hidden="true"></span><span>' + (m.key === "spo2" ? "SpO₂" : m.label) + '</span><strong>' + esc(withUnit(valueOf(m.key, record.vitals), m.unit)) + '</strong><span class="visually-hidden">, ' + esc(word.toLowerCase()) + "</span></li>";
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
    $("#result-dialog").showModal();
  } catch (error) { toast(error.message, "error"); }
}
function bmiLabel(bmi) {
  // Asian cut-offs (WHO Western Pacific), as used by Vietnamese health guidance.
  return bmi < 18.5 ? "Thiếu cân" : bmi < 23 ? "Bình thường" : bmi < 25 ? "Thừa cân" : "Béo phì";
}
function familyNode(h, member, extraClass = "") {
  const conditionName = key => CONDITIONS.find(([id]) => id === key)?.[1];
  const saved = h.family_history.find(row => row.member_id === member.id);
  const known = saved?.knowledge === "known" && saved.conditions?.length;
  const kind = known ? "known" : saved?.knowledge === "none" ? "none" : "unknown";
  const text = known ? (saved.affected_count > 1 ? saved.affected_count + " người: " : "") + saved.conditions.map(conditionName).join(", ") : kind === "none" ? "Không có bệnh đã biết" : "Chưa rõ";
  return '<div class="ft-node ' + kind + " " + extraClass + '"><span class="ft-rel">' + member.label + '</span><span class="ft-state">' + esc(text) + "</span></div>";
}
function familySummary(h) {
  const conditionName = key => CONDITIONS.find(([id]) => id === key)?.[1];
  const known = h.family_history.filter(row => row.knowledge === "known" && row.conditions?.length);
  const unknown = MEMBERS.length - h.family_history.filter(row => row.knowledge === "known" || row.knowledge === "none").length;
  const tally = {};
  known.forEach(row => row.conditions.forEach(key => { tally[key] = (tally[key] || 0) + (row.affected_count || 1); }));
  const parts = [];
  parts.push(known.length ? known.reduce((sum, row) => sum + (row.affected_count || 1), 0) + " người thân có bệnh đã biết: " + Object.entries(tally).map(([key, count]) => conditionName(key) + " (" + count + " người)").join(", ") + "." : "Chưa khai báo người thân nào có bệnh đã biết.");
  if (unknown) parts.push(unknown + " người chưa rõ tiền sử. Hỏi thêm gia đình để hồ sơ đầy đủ hơn.");
  return parts.map(text => "<p>" + esc(text) + "</p>").join("");
}
function renderProfile() {
  const h = state.health, p = h.profile;
  const conditionName = key => CONDITIONS.find(([id]) => id === key)?.[1];
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
      "<div><dt>BMI</dt><dd>" + num(bmi) + ' <span class="fact-note">' + bmiLabel(bmi) + "</span></dd></div><div><dt>Vận động</dt><dd>" + p.activity_minutes_week + " phút mỗi tuần</dd></div>" +
      "<div><dt>Bệnh đã chẩn đoán</dt><dd>" + esc(conditions.join(", ") || "Không khai báo") + "</dd></div><div><dt>Hút thuốc</dt><dd>" + (p.smoker ? "Có" : "Không") + "</dd></div>" +
      (state.viewing ? "" : "<div><dt>Dùng AI giải thích kết quả</dt><dd>" + (h.ai_consent ? "Đã cho phép" : "Chưa cho phép") + "</dd></div>") +
    "</dl>" + (h.personal_notes ? "<h3>Ghi chú</h3><p>" + esc(h.personal_notes) + "</p>" : "") + "</article>" +
    '<article class="panel"><h2>Tiền sử bệnh trong gia đình</h2><div class="ft-summary">' + familySummary(h) + '</div><button class="link-button" data-nav="genetics">Xem sơ đồ gia đình và nguy cơ theo từng bệnh</button></article>';
  if (!state.viewing) renderAvatar();
}

// Family-risk tab: a level per condition from who in the family has it, computed on the server from the current profile.
// tone = colour and shape, bars = filled steps of the 3-step meter. Family levels stop at amber:
// red is kept for dangerous readings, so "Rất cao" and "Cao" differ by word and meter, not by colour.
const RISK_LEVELS = {
  very_high: { tone: "attention", label: "Rất cao", bars: 3 }, high: { tone: "attention", label: "Cao", bars: 2 }, moderate: { tone: "moderate", label: "Trung bình", bars: 1 },
  diagnosed: { tone: "diagnosed", label: "Đã được chẩn đoán" }, unknown: { tone: "neutral", label: "Chưa đủ thông tin" }, none: { tone: "neutral", label: "Chưa ghi nhận" },
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
  $("#pgrs-score").textContent = state.risk && unknown === state.risk.relatives_total ? "Chưa rõ" : Math.round(s.pgrs);
  $("#brs-score").textContent = Math.round(s.brs);
  $("#vital-score").textContent = s.vitals == null ? "-" : Math.round(s.vitals);
  $("#score-family-note").textContent = unknown ? "Còn " + unknown + " người thân chưa rõ tiền sử, chưa được tính vào điểm tiền sử gia đình." : "";
  $("#score-family-note").classList.toggle("hidden", !unknown);
}
function renderGenetics() {
  const h = state.health, p = h.profile;
  const conditionName = key => CONDITIONS.find(([id]) => id === key)?.[1];
  const member = id => MEMBERS.find(m => m.id === id);
  const conditions = p.known_conditions.map(conditionName).filter(Boolean);
  const notes = [["Bên nội", h.paternal_notes], ["Bên ngoại", h.maternal_notes]].filter(([, text]) => text);
  const order = Object.keys(RISK_LEVELS);
  const rows = (state.risk?.conditions || []).slice().sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const of = (...levels) => rows.filter(row => levels.includes(row.level));
  const raised = of("very_high", "high", "moderate"), diagnosed = of("diagnosed"), rest = of("unknown", "none");
  const high = of("very_high", "high").length;
  const allUnknown = rows.length > 0 && rows.every(row => row.level === "unknown");
  const edit = primary => '<button class="btn ' + (primary ? "primary" : "outline") + ' own-only" data-edit-family>' + (primary ? "Cập nhật tiền sử gia đình" : "Sửa tiền sử gia đình") + "</button>";
  $("#genetics-lead").textContent = !state.risk ? (state.riskFailed ? "" : "Đang tải…") : allUnknown ? "Chưa đủ thông tin về tiền sử gia đình."
    : raised.length ? raised.length + " bệnh có người thân mắc" + (high ? ", trong đó " + high + " ở mức cao." : ".") : "Chưa ghi nhận bệnh nào có người thân mắc.";
  // The disease name comes first in the markup so heading navigation reads name then level; CSS shows the level strip on top.
  const card = row => { const level = RISK_LEVELS[row.level]; return '<article class="risk-card ' + level.tone + '"><div class="risk-card-body"><h3>' + conditionName(row.condition) + '<span class="visually-hidden">, ' + (level.bars ? "mức " : "") + level.label.toLowerCase() + "</span></h3>" +
    (row.level === "diagnosed" ? "<p>Bệnh này đã có trong hồ sơ cá nhân.</p>" : "") + riskWho(row) + (row.advice ? '<p class="risk-do"><strong>Nên làm:</strong> ' + esc(row.advice) + "</p>" : "") +
    '</div><div class="risk-card-top" aria-hidden="true">' + riskLevel(row.level) + (level.bars ? riskMeter(row.level) : "") + "</div></article>"; };
  const section = (id, title, body, action = "") => '<section class="section genetics-section" aria-labelledby="genetics-' + id + '"><div class="section-heading"><h2 id="genetics-' + id + '">' + title + "</h2>" + action + "</div>" + body + "</section>";
  const key = '<div class="panel risk-key"><h3>Cách đọc mức nguy cơ</h3><ul>' +
    "<li>" + riskLevel("very_high") + riskMeter("very_high") + "<span>Từ hai người trong số bố, mẹ, anh chị em mắc bệnh. Hoặc một người trong số đó và thêm ông hoặc bà.</span></li>" +
    "<li>" + riskLevel("high") + riskMeter("high") + "<span>Một người trong số bố, mẹ, anh chị em mắc bệnh. Hoặc hai ông bà cùng một bên.</span></li>" +
    "<li>" + riskLevel("moderate") + riskMeter("moderate") + "<span>Chỉ có ông hoặc bà mắc bệnh.</span></li></ul></div>";
  const restList = '<div class="panel risk-rest">' + rest.map(row => '<div class="risk-rest-row"><strong>' + conditionName(row.condition) + "</strong>" + riskLevel(row.level) + "</div>").join("") + "</div>";
  const unknownCount = state.risk?.relatives_unknown || 0;
  const risk = !state.risk
    ? (state.riskFailed ? '<article class="panel empty-state"><h2>Chưa tải được mức nguy cơ</h2><p>Hồ sơ của bạn vẫn được lưu. Hãy kiểm tra kết nối mạng rồi thử lại.</p><button class="btn outline" id="retry-risk">Thử lại</button></article>' : "")
    : allUnknown
      ? '<article class="panel"><h2>' + unknownCount + " người thân chưa rõ tiền sử</h2><p>Khi chưa biết người thân có bệnh gì, ứng dụng chưa thể xếp mức nguy cơ. Hãy hỏi bố mẹ, anh chị em rồi cập nhật.</p>" + edit(true) + "</article>" +
        section("rest", "Các bệnh được theo dõi", restList)
      : (raised.length || diagnosed.length ? '<p class="genetics-reassure">Tiền sử gia đình không quyết định tất cả. Lối sống và việc theo dõi đều đặn vẫn làm thay đổi nguy cơ.</p>' : "") +
        (raised.length ? section("raised", "Bệnh có người thân mắc", '<div class="risk-grid">' + raised.map(card).join("") + "</div>" + key) : "") +
        (diagnosed.length ? section("diagnosed", "Bệnh đã được chẩn đoán", '<div class="risk-grid">' + diagnosed.map(card).join("") + "</div>") : "") +
        (rest.length ? section("rest", "Các bệnh khác", restList) : "");
  $("#genetics-content").innerHTML = risk +
    section("tree", "Sơ đồ gia đình", '<article class="panel"><div class="ft-summary">' + familySummary(h) + "</div>" +
    '<div class="family-tree" role="group" aria-label="Sơ đồ gia đình ba thế hệ">' +
      '<span class="ft-side ft-side-p">Bên nội</span><span class="ft-side ft-side-m">Bên ngoại</span>' +
      familyNode(h, member("paternal-grandfather"), "ft-pgf") + familyNode(h, member("paternal-grandmother"), "ft-pgm") +
      familyNode(h, member("maternal-grandfather"), "ft-mgf") + familyNode(h, member("maternal-grandmother"), "ft-mgm") +
      '<span class="ft-join ft-join-p"></span><span class="ft-join ft-join-m"></span>' +
      familyNode(h, member("father"), "ft-father") + familyNode(h, member("mother"), "ft-mother") +
      '<span class="ft-join ft-join-c"></span>' +
      '<div class="ft-children"><div class="ft-node you ' + (conditions.length ? "known" : "none") + '"><span class="ft-rel">' + (state.viewing ? esc(h.display_name) : "Bạn") + '</span><span class="ft-state">' + esc(conditions.join(", ") || "Không khai báo bệnh") + "</span></div>" + familyNode(h, member("sibling")) + "</div>" +
    "</div>" +
    '<ul class="ft-legend"><li><span class="ft-key known"></span>Có bệnh đã biết</li><li><span class="ft-key none"></span>Không có bệnh đã biết</li><li><span class="ft-key unknown"></span>Chưa rõ</li></ul>' +
    notes.map(([title, text]) => "<h3>Ghi chú " + title.toLowerCase() + "</h3><p>" + esc(text) + "</p>").join("") + "</article>", allUnknown ? "" : edit(false)) +
    '<p class="note">Thông tin tham khảo để trao đổi với bác sĩ, không phải chẩn đoán hay kết quả xét nghiệm gen.</p>';
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
  const conditionName = key => CONDITIONS.find(([id]) => id === key)?.[1];
  const pad = n => String(n).padStart(2, "0");
  const code = "GS-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
  const bmi = p.weight_kg / (p.height_cm / 100) ** 2;
  const sex = { female: "Nữ", male: "Nam", other: "Không khai báo" }[p.sex] || "Không khai báo";
  const cell = (key, v) => v[key] == null ? "" : valueOf(key, v);
  const mark = v => { const levels = METRICS.map(m => statusOf(m.key, v)[0]); return levels.includes("alert") ? "Nguy hiểm" : levels.includes("attention") ? "Cần chú ý" : ""; };
  const family = MEMBERS.map(m => {
    const saved = h.family_history.find(row => row.member_id === m.id);
    const text = saved?.knowledge === "known" && saved.conditions?.length ? saved.conditions.map(conditionName).join(", ") : saved?.knowledge === "none" ? "Không có bệnh đã biết" : "Chưa rõ";
    return "<tr><td>" + m.label + "</td><td>" + esc(text) + "</td></tr>";
  }).join("");
  const notice = "Phiếu do người dùng tự ghi bằng ứng dụng GeneSense. Không phải kết quả khám bệnh, không có giá trị chẩn đoán.";
  $("#report-sheet").innerHTML =
    '<header class="report-head"><div><strong>GeneSense</strong><br>Ứng dụng theo dõi sức khỏe tại nhà</div><div class="report-meta">Mã phiếu: ' + code + "<br>Ngày lập: " + esc(date(now.toISOString(), false)) + "</div></header>" +
    '<h1 id="report-title">PHIẾU TỔNG HỢP CHỈ SỐ SỨC KHỎE TẠI NHÀ</h1><p class="report-period">Kỳ báo cáo: ' + days + " ngày, đến ngày " + esc(date(now.toISOString(), false)) + '</p><p class="report-notice">' + notice + "</p>" +
    (cut ? '<p class="report-notice">Phiếu chỉ gồm 100 lần đo gần nhất, từ ' + esc(date(oldest.toISOString())) + ". Các lần đo cũ hơn trong kỳ không có trong phiếu.</p>" : "") +
    "<h2>I. Thông tin người dùng</h2>" +
    '<table class="report-table report-info"><tbody><tr><th>Họ tên</th><td>' + esc(h.display_name) + "</td><th>Tuổi</th><td>" + p.age + "</td><th>Giới tính</th><td>" + sex + "</td></tr>" +
    "<tr><th>Chiều cao</th><td>" + num(p.height_cm) + " cm</td><th>Cân nặng</th><td>" + num(p.weight_kg) + " kg</td><th>BMI</th><td>" + num(bmi) + " (" + bmiLabel(bmi) + ")</td></tr>" +
    "<tr><th>Bệnh đã chẩn đoán</th><td colspan=\"5\">" + esc(p.known_conditions.map(conditionName).filter(Boolean).join(", ") || "Không khai báo") + "</td></tr>" +
    "<tr><th>Hút thuốc</th><td>" + (p.smoker ? "Có" : "Không") + "</td><th>Vận động</th><td colspan=\"3\">" + p.activity_minutes_week + " phút mỗi tuần</td></tr></tbody></table>" +
    "<h2>II. Tiền sử bệnh trong gia đình</h2>" +
    '<table class="report-table"><thead><tr><th>Người thân</th><th>Bệnh đã biết</th></tr></thead><tbody>' + family + "</tbody></table>" +
    "<h2>III. Tổng hợp trong kỳ</h2>" +
    (rows.length ? '<table class="report-table report-num"><thead><tr><th>Chỉ số</th><th>Đơn vị</th><th>Số lần đo</th><th>Trung bình</th><th>Thấp nhất</th><th>Cao nhất</th><th>Số lần ngoài ngưỡng</th></tr></thead><tbody>' + reportSummary(rows) + "</tbody></table>" : "<p>Không có số đo trong kỳ này.</p>") +
    (rows.length ? "<h2>IV. Biểu đồ diễn biến</h2><div class=\"report-charts\">" + Object.keys(TRENDS).map(id => '<figure data-report-chart="' + id + '"><figcaption></figcaption><div class="trend-chart"></div></figure>').join("") + '</div><p class="report-small">Đường liền: tâm thu hoặc chỉ số chính. Đường đứt: tâm trương. Nền xám hoặc đường chấm: ngưỡng tham khảo.</p>' +
      "<h2>V. Bảng số đo chi tiết</h2>" +
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
function openReport() { screen("report"); document.title = "Phiếu tổng hợp - GeneSense"; renderReport(); }

// Family sharing. While viewing a relative, the same screens render that person's data read-only:
// state is swapped, writes are hidden (.own-only) and guarded, and reads go through the care endpoints.
const reader = () => state.viewing
  ? { history: () => api.careHistory(state.viewing.id), assessment: id => api.careAssessment(state.viewing.id, id) }
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
    "<h2>Chia sẻ với người thân</h2>" +
    '<p class="note">Người thân có mã sẽ xem được tình trạng, số đo, biểu đồ, thông tin cá nhân và tiền sử gia đình của bạn. Họ không sửa được gì và không xem được giấy tờ. Bạn có thể thu hồi bất cứ lúc nào.</p>' +
    '<button class="btn outline" id="care-create">Tạo mã chia sẻ</button><div id="care-code-box"></div>' +
    "<h3>Người đang xem được hồ sơ của bạn</h3>" +
    (caregivers.length ? '<div class="care-rows">' + caregivers.map(c => '<div class="care-row"><div class="care-row-main"><strong>' + esc(c.display_name) + '</strong><span class="note">Từ ' + esc(date(c.created_at, false)) + '</span></div><button class="delete-record" data-remove-link="' + esc(c.link_id) + '" data-remove-kind="caregiver">Thu hồi</button></div>').join("") + "</div>" : '<p class="note">Chưa chia sẻ với ai.</p>') +
    "<h3>Theo dõi người thân</h3>" +
    '<form id="care-form" class="care-form"><label>Nhập mã người thân gửi cho bạn<input id="care-code-input" autocomplete="off" autocapitalize="characters" maxlength="16" required></label><button class="btn primary" type="submit">Liên kết</button></form><p id="care-error" class="inline-message error hidden" role="alert"></p>' +
    (patients.length ? '<div class="care-rows">' + patients.map(patientRow).join("") + "</div>" : "");
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
async function viewPatient(patientId) {
  const patient = state.care.patients.find(p => p.patient_id === patientId);
  if (!patient || state.viewing) return;
  try {
    const shared = await api.careProfile(patientId);
    state.own = { health: state.health, records: state.records, result: state.result, risk: state.risk };
    state.viewing = { id: patientId, name: shared.display_name };
    state.health = shared.health; state.records = []; state.result = null; state.risk = null;
    document.body.classList.add("viewing");
    $("#viewing-text").textContent = "Bạn đang xem hồ sơ của " + shared.display_name + ". Chỉ xem, không sửa được.";
    $("#viewing-banner").classList.remove("hidden");
    personalize();
    await Promise.all([refreshRecords(), refreshRisk()]);
    navigate("dashboard");
  } catch (error) { toast(error.message, "error"); }
}
async function exitViewing() {
  if (!state.viewing) return;
  Object.assign(state, state.own, { viewing: null, own: null });
  document.body.classList.remove("viewing");
  $("#viewing-banner").classList.add("hidden");
  personalize(); renderDashboard(); renderHistory();
  navigate("dashboard");
  refreshCare();
}

function analysisMarkup(analysis) {
  const metricRows = analysis.metrics?.length ? '<div class="extracted-metrics">' + analysis.metrics.map(metric => {
    const badge = metric.flag === "normal" ? "safe" : metric.flag === "unknown" ? "neutral" : "attention";
    return '<div><span><strong>' + esc(metric.name) + '</strong><small>' + esc(metric.reference_range ? "Tham chiếu: " + metric.reference_range : "Không có khoảng tham chiếu") + '</small></span><span class="metric-value">' + esc(metric.value) + " " + esc(metric.unit) + '</span><span class="tag ' + badge + '">' + esc(FLAG_NAMES[metric.flag] || "Chưa rõ") + "</span></div>";
  }).join("") + "</div>" : "";
  const list = (title, values, tone = "") => values?.length ? '<section class="extracted-list ' + tone + '"><strong>' + title + '</strong><ul>' + values.map(value => "<li>" + esc(value) + "</li>").join("") + "</ul></section>" : "";
  const medications = analysis.medications?.length ? '<section class="extracted-list"><strong>Thuốc được ghi trên tài liệu</strong><ul>' + analysis.medications.map(item => "<li>" + esc(item.name) + (item.dose ? ", " + esc(item.dose) : "") + (item.frequency ? ", " + esc(item.frequency) : "") + "</li>").join("") + "</ul></section>" : "";
  return '<div class="analysis-summary"><div class="record-meta"><span>' + esc(DOCUMENT_TYPES[analysis.document_type] || "Tài liệu sức khỏe") + '</span><span>' + esc(analysis.document_date ? date(analysis.document_date, false) : "Không rõ ngày") + '</span><span>' + esc(analysis.provider || "Không rõ cơ sở") + '</span></div><h3>' + esc(analysis.title) + '</h3><p>' + esc(analysis.summary) + "</p></div>" + metricRows + list("Thông tin bệnh được ghi", analysis.conditions) + medications + list("Đề xuất được ghi trên tài liệu", analysis.recommendations) + list("Điểm cần kiểm tra lại", analysis.warnings, "warning") + '<p class="analysis-disclaimer">' + esc(analysis.disclaimer) + "</p>";
}

function renderMedicalRecords() {
  if (!state.medicalRecords.length) {
    $("#medical-record-list").innerHTML = '<article class="panel empty-state"><h2>Chưa có giấy tờ nào</h2><p class="note">Giấy tờ đã lưu sẽ hiện ở đây.</p></article>';
    return;
  }
  $("#medical-record-list").innerHTML = state.medicalRecords.map(record => {
    const a = record.analysis;
    const notable = (a.metrics || []).filter(metric => !["normal", "unknown"].includes(metric.flag)).length;
    return '<article class="panel medical-record"><div class="record-meta"><span>' + esc(DOCUMENT_TYPES[a.document_type] || "Tài liệu sức khỏe") + "</span><span>" + esc(a.document_date ? date(a.document_date, false) : date(record.created_at, false)) + "</span>" + (notable ? '<span class="tag attention">' + notable + " mục cần xem lại</span>" : "") + "</div><h2>" + esc(a.title) + "</h2><p>" + esc(a.summary) + '</p><details class="record-details"><summary>Xem nội dung đã lưu</summary>' + analysisMarkup(a) + '</details><div class="record-actions"><button class="link-button hidden" data-view-scan="' + esc(record.id) + '">Xem ảnh gốc</button><button class="delete-record" data-delete-record="' + esc(record.id) + '">Xóa</button></div></article>';
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
  $("#scan-dialog").showModal();
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
  const vitals = analysis.vitals || {}, pressure = vitals.systolic != null || vitals.diastolic != null;
  const found = APPLY_VITALS.filter(([key]) => vitals[key] != null || (pressure && ["systolic", "diastolic"].includes(key)));
  const name = key => CONDITIONS.find(([id]) => id === key)?.[1];
  const own = (analysis.own_conditions || []).filter(key => !state.health.profile.known_conditions.includes(key));
  const family = (analysis.family_conditions || []).filter(item => !state.health.family_history.find(row => row.member_id === item.member)?.conditions.includes(item.condition));
  const medicines = analysis.medications || [];
  if (!found.length && !own.length && !family.length && !medicines.length) return '<p class="note">Không thấy chỉ số huyết áp, nhịp tim, đường huyết, thuốc, bệnh đã chẩn đoán hay tiền sử gia đình mới để đưa vào hồ sơ. Nội dung giấy tờ vẫn được lưu.</p>';
  const check = (attribute, label) => '<label class="check-label"><input type="checkbox" ' + attribute + ' checked><span>' + label + "</span></label>";
  return '<h3>Đưa vào hồ sơ</h3>' +
    (found.length ? '<fieldset class="apply-group"><legend>Chỉ số đo</legend>' + check('id="apply-vitals"', "Thêm vào Lịch sử đo với nguồn “Từ giấy tờ”<small>Số liệu cũ, không đổi tình trạng Hôm nay.</small>") +
      '<div class="field-grid">' + found.map(([key, label, min, max]) => "<label>" + label + '<input type="number" inputmode="decimal" step=".1" min="' + min + '" max="' + max + '" data-apply-vital="' + key + '" value="' + esc(vitals[key] == null ? "" : Math.round(vitals[key] * 10) / 10) + '"></label>').join("") +
      '<label>Ngày ghi trên giấy tờ<input type="date" id="apply-date" required min="1950-01-01" max="' + new Date().toLocaleDateString("sv") + '" value="' + esc(analysis.document_date || "") + '"></label></div></fieldset>' : "") +
    (own.length ? '<fieldset class="apply-group"><legend>Bệnh đã được chẩn đoán</legend>' + own.map(key => check('data-apply-own="' + esc(key) + '"', esc(name(key)))).join("") + "</fieldset>" : "") +
    (family.length ? '<fieldset class="apply-group"><legend>Tiền sử gia đình</legend>' + family.map(item => check('data-apply-family="' + esc(item.member + "|" + item.condition) + '"', esc(MEMBERS.find(m => m.id === item.member).label + ": " + name(item.condition)))).join("") + "</fieldset>" : "") +
    (medicines.length ? '<fieldset class="apply-group"><legend>Thuốc trong đơn</legend><p class="note">So từng thuốc với đơn giấy.</p>' + medicines.map(applyMedicineMarkup).join("") + "</fieldset>" : "");
}
// One card per medicine read from a prescription. A name the AI was not sure of starts unticked, so it cannot be saved unseen.
function applyMedicineMarkup(m) {
  const field = (label, key, value, extra = "") => "<label" + (key === "name" ? ' class="full"' : "") + ">" + label + '<input data-med="' + key + '" value="' + esc(value) + '" autocomplete="off" ' + extra + "></label>";
  return '<div class="apply-medicine" data-apply-medicine>' +
    '<label class="check-label"><input type="checkbox" data-med-on' + (m.unsure ? "" : " checked") + "><span>Thêm vào lịch uống thuốc</span></label>" +
    (m.unsure ? '<p class="inline-message warning">Chữ viết không rõ. Hãy so với đơn giấy, sửa cho đúng rồi mới chọn thêm.</p>' : "") +
    '<div class="field-grid">' + field("Tên thuốc", "name", m.name, 'required maxlength="160"') + field("Hàm lượng", "strength", m.strength, 'maxlength="60"') + field("Mỗi lần uống", "amount", m.dose, 'maxlength="60"') + "</div>" +
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
function renderMedicineLink() {
  const count = state.viewing ? 0 : state.medications.filter(m => medicineActive(m)).length;
  const link = $("#today-medicines");
  // The emergency panel stays the only call to action while it shows.
  link.classList.toggle("hidden", !count || (state.result && isEmergency(state.result)));
  link.textContent = "Hôm nay có " + count + " loại thuốc. Xem lịch uống thuốc";
}
function renderRecordsTab() {
  const tab = state.recordsTab || (state.medications.length ? "medicines" : "documents");
  $$("[data-records-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.recordsTab === tab);
    button.setAttribute("aria-pressed", String(button.dataset.recordsTab === tab));
  });
  $("#medicines-panel").classList.toggle("hidden", tab !== "medicines");
  $("#documents-panel").classList.toggle("hidden", tab !== "documents");
  renderMedicines();
}
function renderMedicines() {
  const active = state.medications.filter(m => medicineActive(m));
  const hour = new Date().getHours(), now = hour < 11 ? "morning" : hour < 14 ? "noon" : hour < 18 ? "afternoon" : "evening";
  const title = m => esc(m.name + (m.strength ? " " + m.strength : ""));
  const item = m => "<li><strong>" + title(m) + "</strong>" + (medicineHow(m) ? "<span>" + esc(medicineHow(m)) + "</span>" : "") + (m.note ? '<span class="note">' + esc(m.note) + "</span>" : "") + "</li>";
  const block = (label, rows, current) => rows.length ? '<article class="panel slot"><h3>' + label + (current ? ' <span class="tag">Bây giờ</span>' : "") + "</h3><ul>" + rows.map(item).join("") + "</ul></article>" : "";
  const blocks = SLOTS.map(([key, label]) => block(label, active.filter(m => m[key]), key === now)).join("") + block("Khi cần", active.filter(m => !SLOTS.some(([key]) => m[key])));
  $("#medicine-today").innerHTML = blocks ? '<div class="slot-grid">' + blocks + '</div><p class="note">Nếu khác đơn giấy, hãy làm theo đơn và lời bác sĩ.</p>'
    : '<article class="panel empty-state"><h3>Hôm nay không có thuốc trong lịch</h3><p class="note">Chụp đơn thuốc hoặc bấm Thêm thuốc.</p></article>';
  const day = localDay();
  const course = m => "Từ " + date(m.start_date + "T12:00:00", false) + (m.days ? ", " + m.days + " ngày" : ", uống lâu dài");
  const tag = m => m.start_date > day ? '<span class="tag">Chưa bắt đầu</span>' : medicineActive(m, day) ? "" : '<span class="tag">Đã hết đợt</span>';
  const when = m => SLOTS.filter(([key]) => m[key]).map(([, label]) => label).join(", ") || "Khi cần";
  $("#medicine-all").classList.toggle("hidden", !state.medications.length);
  $("#medicine-list-title").textContent = "Tất cả thuốc (" + state.medications.length + ")";
  $("#medicine-list").innerHTML = '<ul class="panel medicine-rows">' + state.medications.map(m =>
    "<li><div><strong>" + title(m) + "</strong><span>" + esc(when(m) + (medicineHow(m) ? ": " + medicineHow(m) : "")) + '</span><span class="note">' + esc(course(m)) + " " + tag(m) + "</span></div>" +
    '<button class="btn outline" data-edit-medicine="' + esc(m.id) + '">Sửa</button></li>').join("") + "</ul>";
  renderMedicineLink();
}
async function refreshMedications() {
  const epoch = state.authEpoch;
  try {
    const rows = await api.medications();
    if (epoch !== state.authEpoch) return;
    state.medications = rows;
  } catch (error) { if (epoch !== state.authEpoch) return; toast(error.message, "error"); }
  renderMedicines();
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
  $("#medicine-dialog").showModal();
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
  if (!form.checkValidity()) $("#medicine-more").open = true; // a field inside closed details cannot show its message
  if (!form.reportValidity()) return;
  const slots = Object.fromEntries(SLOTS.map(([key]) => [key, form.elements[key].checked]));
  if (!form.elements.as_needed.checked && !Object.values(slots).some(Boolean)) { errorAt("#medicine-error", "Hãy chọn buổi uống, hoặc chọn Khi cần."); return; }
  state.busy = true;
  const data = new FormData(form);
  const body = { name: data.get("name"), strength: data.get("strength").trim(), amount: data.get("amount").trim(), meal: data.get("meal"), start_date: data.get("start_date"),
    days: data.get("days") ? Number(data.get("days")) : null, note: data.get("note").trim(), ...slots };
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

async function refreshMedicalRecords() {
  const epoch = state.authEpoch;
  try {
    const records = await api.medicalRecords();
    if (epoch !== state.authEpoch) return;
    state.medicalRecords = records;
    renderMedicalRecords();
  } catch (error) {
    if (epoch !== state.authEpoch) return;
    $("#medical-record-list").innerHTML = '<article class="panel empty-state"><h2>Chưa tải được danh sách giấy tờ</h2><p>' + esc(error.message) + "</p></article>";
  }
}

function resetMedicalUpload() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  state.pendingMedical = null; state.pendingScan = null;
  $("#document-apply").innerHTML = "";
  $("#medical-document-file").value = "";
  $("#document-ai-consent").checked = false;
  $("#confirm-medical-record").checked = false;
  $("#document-preview").removeAttribute("src");
  $("#document-preview").classList.add("hidden");
  $(".document-drop").classList.remove("has-file");
  $("#upload-stage").classList.remove("hidden");
  $("#review-stage").classList.add("hidden");
  $("#analyze-document").disabled = true;
  $("#save-medical-record").disabled = true;
  errorAt("#document-error");
  errorAt("#record-save-error");
}

function updateDocumentButton() {
  const file = $("#medical-document-file").files[0];
  $("#analyze-document").disabled = !state.documentAiEnabled || !file || !$("#document-ai-consent").checked || state.busy;
}

function openMedicalUpload() {
  if (state.viewing) return;
  resetMedicalUpload();
  $("#medical-upload-dialog").showModal();
}

function selectMedicalImage() {
  const file = $("#medical-document-file").files[0];
  errorAt("#document-error");
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  $("#document-preview").classList.add("hidden");
  $(".document-drop").classList.remove("has-file");
  if (!file) { updateDocumentButton(); return; }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    errorAt("#document-error", "Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.");
    $("#medical-document-file").value = "";
  } else if (file.size > 8 * 1024 * 1024) {
    errorAt("#document-error", "Ảnh vượt quá giới hạn 8 MB.");
    $("#medical-document-file").value = "";
  } else {
    state.previewUrl = URL.createObjectURL(file);
    $("#document-preview").src = state.previewUrl;
    $("#document-preview").classList.remove("hidden");
    $(".document-drop").classList.add("has-file");
  }
  updateDocumentButton();
}

async function analyzeMedicalDocument() {
  const file = $("#medical-document-file").files[0];
  if (!file || !$("#document-ai-consent").checked || state.busy) return;
  state.busy = true;
  const button = $("#analyze-document");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "Đang đọc ảnh…";
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
  if (!$("#document-apply").reportValidity()) return;
  // Checked before anything is saved, so a reading the server would refuse cannot leave the document half applied.
  const vitals = applyVitals ? documentVitals() : null;
  const problem = vitals ? vitalsProblem(vitals, true) : "";
  // Every medicine going into the schedule needs a time of day or an explicit "Khi cần".
  const untimed = [...$$("[data-apply-medicine]")].some(card => card.querySelector("[data-med-on]").checked && !card.querySelector("[data-med-slot]:checked, [data-med-needed]:checked"));
  errorAt("#record-save-error", problem || (untimed ? "Hãy chọn buổi uống cho từng thuốc, hoặc chọn Khi cần." : ""));
  if (problem || untimed) return;
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
  $("#measurement-dialog").showModal();
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
async function saveMeasurement(values, source, samples = []) {
  if (state.busy) return;
  const problem = vitalsProblem(values);
  if (problem) { errorAt("#measurement-error", problem); return; }
  state.busy = true;
  const epoch = state.authEpoch;
  const button = source === "manual" ? $('#measurement-form button[type="submit"]') : $("#save-device");
  const original = button.innerHTML;
  button.disabled = true; button.textContent = "Đang lưu…";
  errorAt("#measurement-error");
  try {
    const r = await api.assess({ vitals: { ...values, timestamp: new Date().toISOString() }, source, samples });
    if (epoch !== state.authEpoch) return;
    const record = { id: r.id, created_at: r.created_at, risk_level: r.risk_level, overall_score: r.scores.overall, vitals: { ...values, source } };
    state.records = [record, ...state.records].slice(0, 100);
    state.result = r;
    closeDialog($("#measurement-dialog"));
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
  } catch (error) { errorAt("#measurement-error", error.message); }
  finally { state.busy = false; button.disabled = false; button.innerHTML = original; if (source !== "manual") renderDevice(); }
}
async function submitManual(event) {
  event.preventDefault();
  const form = $("#measurement-form");
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const values = Object.fromEntries(KEYS.map(key => [key, data.get(key)?.trim() ? Number(data.get(key)) : null]));
  await saveMeasurement(values, "manual");
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
  state.user = null; state.health = null; state.records = []; state.result = null; state.risk = null; state.riskFailed = false; state.medicalRecords = []; state.medications = []; state.recordsTab = null; state.editing = false; state.rating = 0;
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
    clearAccount(); screen("login");
    accountChannel?.postMessage("signed-out");
    window.history.replaceState(null, "", "/");
  } catch (error) { toast(error.message, "error"); }
}
// step 1 opens the wizard straight at the family pages; the user returns to the tab they came from.
function editProfile(step = 0) {
  if (state.viewing) return;
  state.editing = true; state.editReturn = state.view; fillWizard(state.health);
  state.step = step; showStep();
  screen("onboarding");
}
async function enterAccount(user) {
  state.user = user;
  const epoch = ++state.authEpoch;
  const data = await api.profile();
  if (epoch !== state.authEpoch) return;
  state.health = data.health; state.user = data.user;
  if (!user.onboarding_completed || !data.health) {
    state.editing = false; fillWizard(); screen("onboarding");
  } else {
    personalize(); screen("app");
    loadAvatar();
    await Promise.all([refreshRecords(), refreshMedicalRecords(), refreshMedications(), refreshCare(), refreshRisk()]);
    navigate(location.hash.slice(1) || "dashboard");
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
    $("#upload-record").disabled = !state.documentAiEnabled;
    $("#records-ai-off").classList.toggle("hidden", state.documentAiEnabled);
    $("#google-login").disabled = !config.google_enabled;
    $("#demo-entry").classList.toggle("hidden", !config.demo_enabled);
    const loginError = new URLSearchParams(location.search).get("auth_error");
    errorAt("#login-message", loginError ? "Chưa đăng nhập được với Google. Hãy thử lại hoặc chọn tài khoản khác." : !config.google_enabled ? "Đăng nhập bằng Google sẽ có trong bản chính thức." : "");
    if (loginError) window.history.replaceState(null, "", "/");
    let user;
    try { user = await api.me(); } catch (error) { if (error.status !== 401) throw error; }
    if (user) await enterAccount(user);
    else screen("login");
  } catch (error) {
    $("#loading-screen p").textContent = error.message;
    $("#retry-boot").classList.remove("hidden");
  }
}

function bindEvents() {
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
      const chips = event.target.closest("[data-member]").querySelector(".chips");
      chips.hidden = event.target.value !== "known";
      if (chips.hidden) chips.querySelectorAll("input").forEach(input => input.checked = false);
      const count = chips.parentElement.querySelector(".member-count");
      // Reset the hidden field: an out-of-range number left in it would block the step with no visible message.
      if (count) { count.hidden = chips.hidden; if (chips.hidden) count.querySelector("input").value = 1; }
    }
  });
  $("#step-back").addEventListener("click", () => { state.step = Math.max(0, state.step - 1); showStep(); });
  ["height", "weight"].forEach(id => $("#" + id).addEventListener("input", updateBmi));
  document.addEventListener("click", event => {
    const nav = event.target.closest("[data-nav]");
    if (nav) navigate(nav.dataset.nav);
    const close = event.target.closest("[data-close]");
    if (close) closeDialog($("#" + close.dataset.close));
    const record = event.target.closest("[data-record]");
    if (record) showResult(record.dataset.record);
    const deleteRecord = event.target.closest("[data-delete-record]");
    if (deleteRecord) deleteMedicalRecord(deleteRecord.dataset.deleteRecord);
    const scan = event.target.closest("[data-view-scan]");
    if (scan) viewScan(scan.dataset.viewScan);
    const tab = event.target.closest("[data-records-tab]");
    if (tab) { state.recordsTab = tab.dataset.recordsTab; renderRecordsTab(); }
    if (event.target.closest("[data-open-medicines]")) { state.recordsTab = "medicines"; navigate("records"); }
    const editMedicine = event.target.closest("[data-edit-medicine]");
    if (editMedicine) openMedicine(editMedicine.dataset.editMedicine);

    if (event.target.closest("[data-open-upload]")) openMedicalUpload();
    const viewTarget = event.target.closest("[data-view-patient]");
    if (viewTarget) viewPatient(viewTarget.dataset.viewPatient);
    const removeTarget = event.target.closest("[data-remove-link]");
    if (removeTarget) removeCareLink(removeTarget.dataset.removeLink, removeTarget.dataset.removeKind);
    if (event.target.closest("#care-create")) createCareCode();
    if (event.target.closest("#exit-viewing")) exitViewing();
    if (event.target.closest("[data-open-measurement]")) openMeasurement();
    if (event.target.closest("#history-add")) openMeasurement();
    if (event.target.closest("#retry-history")) refreshRecords();
    if (event.target.closest("#retry-risk")) refreshRisk();
    if (event.target.closest("[data-edit-family]")) editProfile(1);
  });
  $("#edit-profile").addEventListener("click", () => editProfile());
  document.addEventListener("submit", event => { if (event.target.id === "care-form") acceptCareCode(event); });
  $$("dialog").forEach(dialog => dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(dialog); }));
  $("#delete-assessment").addEventListener("click", event => deleteAssessment(event.currentTarget.dataset.id));
  $("#new-measurement").addEventListener("click", () => openMeasurement());
  $("#upload-record").addEventListener("click", openMedicalUpload);
  $("#add-medicine").addEventListener("click", () => openMedicine());
  $("#medicine-form").addEventListener("submit", saveMedicine);
  $("#medicine-form").addEventListener("change", event => {
    const form = event.currentTarget;
    if (event.target.type === "checkbox") keepSlotChoice(event.target, SLOTS.map(([key]) => form.elements[key]), form.elements.as_needed);
  });
  $("#medicine-delete").addEventListener("click", () => deleteMedicine(state.editingMedicine));
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
  $("#measurement-dialog").addEventListener("close", stopStreams);
  $("#measurement-form").addEventListener("submit", submitManual);
  $("#connect-ble").addEventListener("click", connectBle);
  $("#simulate-ble").addEventListener("click", startSimulation);
  $("#disconnect-device").addEventListener("click", stopStreams);
  $("#save-device").addEventListener("click", () => saveMeasurement(freshValues(), state.deviceSource || "ble", state.samples.slice()));
  $("#refresh-history").addEventListener("click", refreshRecords);
  $("#open-report").addEventListener("click", openReport);
  $("#report-days").addEventListener("change", renderReport);
  $("#report-print").addEventListener("click", () => window.print());
  $("#report-back").addEventListener("click", () => { screen("app"); navigate("history"); });
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
  accountChannel?.addEventListener("message", () => { clearAccount(); boot(); });
  // Links like the header logo only change the hash; route on every hash change (also back/forward).
  window.addEventListener("hashchange", () => { if (state.user && state.health) navigate(location.hash.slice(1) || "dashboard"); });
  window.addEventListener("pagehide", stopStreams);
  window.addEventListener("pageshow", event => { if (event.persisted) { clearAccount(); boot(); } });
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !state.user) return;
    try { const me = await api.me(); if (me.id !== state.user?.id) { clearAccount(); await boot(); } }
    catch (error) { if (error.status === 401) { clearAccount(); await boot(); } }
  });
}
hydrateIcons();
bindEvents();
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
