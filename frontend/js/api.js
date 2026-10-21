async function request(path, requestOptions = {}) {
  const { timeout = 35000, quiet = false, ...options } = requestOptions;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const isForm = options.body instanceof FormData;
    const response = await fetch(path, { ...options, signal: controller.signal, credentials: "same-origin", cache: "no-store",
      headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), "X-Requested-With": "HealthPredict", ...options.headers } });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof data.detail === "string" ? data.detail : data.detail?.[0]?.msg || "Chưa thể hoàn tất. Vui lòng thử lại.";
      const error = new Error(message);
      error.status = response.status;
      if (response.status === 401 && !quiet) window.dispatchEvent(new Event("session-expired"));
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Kết nối mất nhiều thời gian. Hãy thử lại sau ít phút.");
    if (error instanceof TypeError) throw new Error("Chưa kết nối được. Hãy kiểm tra mạng và thử lại.");
    throw error;
  } finally { clearTimeout(timer); }
}
export const api = {
  authConfig: () => request("/api/auth/config"),
  me: () => request("/api/auth/me", { quiet: true }),
  demo: () => request("/api/auth/demo", { method: "POST" }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  profile: () => request("/api/profile"),
  exportData: async () => {
    const response = await fetch("/api/privacy/export", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) window.dispatchEvent(new Event("session-expired"));
      throw new Error(typeof data.detail === "string" ? data.detail : "Chưa tải được bản sao dữ liệu. Vui lòng thử lại.");
    }
    return response.blob();
  },
  deleteAccount: () => request("/api/account", { method: "DELETE", body: JSON.stringify({ confirm_delete: true }) }),
  // The picture is bytes, not JSON. Resolves to null when the account has none (204).
  avatar: () => fetch("/api/avatar", { credentials: "same-origin", cache: "no-store" }).then(response => response.status === 200 ? response.blob() : null).catch(() => null),
  saveAvatar: blob => request("/api/avatar", { method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" } }),
  removeAvatar: () => request("/api/avatar", { method: "DELETE" }),
  risk: () => request("/api/risk"),
  saveProfile: body => request("/api/profile", { method: "PUT", body: JSON.stringify(body) }),
  assess: body => request("/api/assessments", { method: "POST", body: JSON.stringify(body) }),
  history: (limit = 100) => request(`/api/assessments?limit=${limit}`),
  weeklyBp: timezoneOffset => request(`/api/assessments/weekly-bp?timezone_offset=${timezoneOffset}`),
  assessment: id => request(`/api/assessments/${encodeURIComponent(id)}`),
  careLinks: () => request("/api/care/links"),
  careInvite: () => request("/api/care/invites", { method: "POST" }),
  careAccept: code => request("/api/care/links", { method: "POST", body: JSON.stringify({ code }) }),
  careRemove: id => request(`/api/care/links/${encodeURIComponent(id)}`, { method: "DELETE" }),
  careRisk: patientId => request(`/api/care/patients/${encodeURIComponent(patientId)}/risk`),
  careProfile: patientId => request(`/api/care/patients/${encodeURIComponent(patientId)}/profile`),
  careHistory: patientId => request(`/api/care/patients/${encodeURIComponent(patientId)}/assessments`),
  careAssessment: (patientId, id) => request(`/api/care/patients/${encodeURIComponent(patientId)}/assessments/${encodeURIComponent(id)}`),
  careWeeklyBp: (patientId, timezoneOffset) => request(`/api/care/patients/${encodeURIComponent(patientId)}/weekly-bp?timezone_offset=${timezoneOffset}`),
  careMedications: (patientId, scheduledOn) => request(`/api/care/patients/${encodeURIComponent(patientId)}/medications?scheduled_on=${encodeURIComponent(scheduledOn)}`),
  familyLinks: () => request("/api/care/family/links"),
  familyInvite: body => request("/api/care/family/invites", { method: "POST", body: JSON.stringify(body) }),
  familyInvitePreview: code => request("/api/care/family/invites/preview", { method: "POST", body: JSON.stringify({ code }) }),
  familyAccept: (code, confirmRelationship) => request("/api/care/family/links", { method: "POST", body: JSON.stringify({ code, confirm_relationship: confirmRelationship }) }),
  familySharing: (id, shareConditions) => request(`/api/care/family/links/${encodeURIComponent(id)}/sharing`, { method: "PUT", body: JSON.stringify({ share_conditions: shareConditions }) }),
  familyRemove: id => request(`/api/care/family/links/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteAssessment: id => request(`/api/assessments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  feedback: body => request("/api/feedback", { method: "POST", body: JSON.stringify(body) }),
  analyzeMedicalRecord: body => request("/api/medical-records/analyze", { method: "POST", body, timeout: 65000 }),
  saveMedicalRecord: body => request("/api/medical-records", { method: "POST", body: JSON.stringify(body) }),
  medicalRecords: (limit = 30) => request(`/api/medical-records?limit=${limit}`),
  reviewGeneticFinding: (recordId, index, source) => request(`/api/medical-records/${encodeURIComponent(recordId)}/genetic-findings/${index}/review`, {
    method: "PUT", body: JSON.stringify({ source })
  }),
  medications: () => request("/api/medications"),
  medicationIntakes: scheduledOn => request(`/api/medications/intakes?scheduled_on=${encodeURIComponent(scheduledOn)}`),
  setMedicationIntake: (id, slot, body) => request(`/api/medications/${encodeURIComponent(id)}/intakes/${encodeURIComponent(slot)}`, { method: "PUT", body: JSON.stringify(body) }),
  saveMedication: (body, id) => request("/api/medications" + (id ? "/" + encodeURIComponent(id) : ""), { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
  deleteMedication: id => request(`/api/medications/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteMedicalRecord: id => request(`/api/medical-records/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
