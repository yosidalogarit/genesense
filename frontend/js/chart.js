// Small SVG trend chart: one y-axis, a reference band, 2px lines, >=8px markers,
// a crosshair tooltip on hover/keyboard, and a direct label on the latest value.
const NS = "http://www.w3.org/2000/svg";
const HEIGHT = 200;
const PAD = { top: 14, right: 52, bottom: 30, left: 42 };
const valueFormat = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const pad = n => String(n).padStart(2, "0");
const dayLabel = d => pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
const timeLabel = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
const fullFormat = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
}

export class TrendChart {
  constructor(host) {
    this.host = host;
    this.config = null;
    this.active = -1;
    this.animationPlayed = matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window);
    if (!this.animationPlayed) this.revealObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || !this.svg) return;
      this.animationPlayed = true;
      const svg = this.svg;
      const finish = event => {
        if (event.type !== "animationcancel" && event.animationName !== "chart-point-in") return;
        svg.classList.remove("chart-animate");
        svg.removeEventListener("animationend", finish);
        svg.removeEventListener("animationcancel", finish);
      };
      svg.addEventListener("animationend", finish);
      svg.addEventListener("animationcancel", finish);
      svg.classList.add("chart-animate");
      this.revealObserver.disconnect();
    }, { threshold: 0.12, rootMargin: "0px 0px -80px 0px" });
    this.tip = document.createElement("div");
    this.tip.className = "chart-tip hidden";
    host.append(this.tip);
    new ResizeObserver(() => this.draw()).observe(host);
    host.addEventListener("pointermove", event => { if (event.pointerType !== "touch") this.pointer(event); });
    host.addEventListener("pointerup", event => { if (event.pointerType === "touch") this.pointer(event); });
    host.addEventListener("pointerleave", event => { if (event.pointerType !== "touch") this.show(-1); });
    host.addEventListener("blur", () => this.show(-1));
    host.addEventListener("focus", () => this.show(this.count() - 1));
    host.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const last = this.count() - 1;
      const next = { ArrowLeft: this.active - 1, ArrowRight: this.active + 1, Home: 0, End: last }[event.key];
      this.show(Math.max(0, Math.min(last, next)));
    });
  }

  // config: { unit, band: [lo, hi] | null, thresholds: [{ value, color, label }], min, max, times: [Date], series: [{ label, color, values: [number] }] }
  set(config) {
    this.config = config;
    this.active = -1;
    this.draw();
  }

  count() { return this.config?.times.length || 0; }

  draw() {
    this.svg?.remove();
    this.svg = null;
    this.geometry = null;
    this.cross = null;
    this.tip.classList.add("hidden");
    const width = this.host.clientWidth;
    const c = this.config;
    if (!width || !c || !c.times.length) return;
    const all = c.series.flatMap(s => s.values);
    // Round the axis to a readable step so ticks land on whole numbers (60, 100, 140...).
    const lo = Math.min(c.min, ...all), hi = Math.max(c.max, ...all);
    const step = [5, 10, 20, 25, 50, 100].find(size => (hi - lo) / size <= 4) || 100;
    const min = Math.floor(lo / step) * step;
    const max = Math.max(min + step, Math.ceil(hi / step) * step);
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const y = v => PAD.top + (max - v) / (max - min) * plotH;
    const n = c.times.length;
    const x = i => PAD.left + (n === 1 ? plotW / 2 : i / (n - 1) * plotW);
    this.geometry = { x, n, width };

    const svg = el("svg", { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, "aria-hidden": "true", class: "chart-svg" });
    if (c.band) svg.append(el("rect", { class: "chart-band", x: PAD.left, y: y(c.band[1]), width: plotW, height: y(c.band[0]) - y(c.band[1]) }));
    for (let value = min; value <= max; value += step) {
      svg.append(el("line", { class: "chart-grid", x1: PAD.left, x2: PAD.left + plotW, y1: y(value), y2: y(value) }));
      svg.append(el("text", { class: "chart-axis", x: PAD.left - 8, y: y(value), "text-anchor": "end", "dominant-baseline": "middle" }, Math.round(value)));
    }
    const ticks = n === 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];
    const sameDay = dayLabel(c.times[0]) === dayLabel(c.times[n - 1]);
    ticks.forEach((i, k) => {
      const anchor = n === 1 ? "middle" : k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle";
      svg.append(el("text", { class: "chart-axis", x: x(i), y: HEIGHT - 6, "text-anchor": anchor }, sameDay ? timeLabel(c.times[i]) : dayLabel(c.times[i])));
    });

    for (const t of c.thresholds || []) {
      svg.append(el("line", { class: "chart-threshold", x1: PAD.left, x2: PAD.left + plotW, y1: y(t.value), y2: y(t.value), stroke: t.color }));
    }
    this.cross = el("line", { class: "chart-cross hidden", y1: PAD.top, y2: PAD.top + plotH });
    svg.append(this.cross);
    const labels = [];
    for (const s of c.series) {
      const d = s.values.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
      if (n > 1) svg.append(el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", ...(s.dash ? { "stroke-dasharray": s.dash } : { class: "chart-series-line", pathLength: 1 }) }));
      s.values.forEach((v, i) => {
        const last = i === n - 1;
        svg.append(el("circle", { class: "chart-series-point", cx: x(i), cy: y(v), r: 4, fill: last ? s.color : "#fff", stroke: s.color, "stroke-width": 2 }));
      });
      labels.push({ y: y(s.values[n - 1]), text: valueFormat.format(s.values[n - 1]) });
    }
    // Direct label on the latest value, in text ink; nudge apart when two series sit close.
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 18) labels[i].y = labels[i - 1].y + 18;
    labels.forEach(label => svg.append(el("text", { class: "chart-value", x: x(n - 1) + 10, y: label.y, "dominant-baseline": "middle" }, label.text)));
    this.svg = svg;
    this.host.prepend(svg);
    if (!this.animationPlayed) this.revealObserver.observe(this.host);
    if (this.active >= 0) this.show(this.active);
  }

  pointer(event) {
    if (!this.geometry) return;
    const { x, n } = this.geometry;
    const left = event.clientX - this.host.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - left) < Math.abs(x(best) - left)) best = i;
    this.show(best);
  }

  show(index) {
    this.active = index;
    const c = this.config;
    if (index < 0 || !c || !this.geometry) { this.tip.classList.add("hidden"); this.cross?.classList.add("hidden"); return; }
    const px = this.geometry.x(index);
    this.cross.setAttribute("x1", px); this.cross.setAttribute("x2", px);
    this.cross.classList.remove("hidden");
    this.tip.replaceChildren();
    const when = document.createElement("div");
    when.className = "chart-tip-date";
    when.textContent = fullFormat.format(c.times[index]);
    this.tip.append(when);
    for (const s of c.series) {
      const row = document.createElement("div");
      row.className = "chart-tip-row";
      const key = document.createElement("span");
      key.className = "chart-tip-key";
      key.style.background = s.color;
      const value = document.createElement("strong");
      value.textContent = valueFormat.format(s.values[index]) + (c.unit === "%" ? "" : " ") + c.unit;
      const label = document.createElement("span");
      label.textContent = s.label;
      row.append(key, value, label);
      this.tip.append(row);
    }
    this.tip.classList.remove("hidden");
    const tipW = this.tip.offsetWidth;
    this.tip.style.left = Math.max(0, Math.min(this.geometry.width - tipW, px - tipW / 2)) + "px";
  }
}
