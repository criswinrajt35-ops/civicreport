const STORAGE_KEY = "civicresolve.reports.v1";
const CATEGORIES = ["Roads & sidewalks", "Waste management", "Street lighting", "Water & drainage", "Public spaces", "Other"];
const STATUS_OPTIONS = ["Reported", "AI Analysed", "Awaiting Admin Verification", "Assigned", "Accepted", "In Progress", "Awaiting Additional Information", "Resolved", "Rejected", "Reopened"];
const DEPARTMENTS = {
  "Roads & sidewalks": "Public Works",
  "Waste management": "Sanitation",
  "Street lighting": "Public Lighting",
  "Water & drainage": "Water & Sewer",
  "Public spaces": "Parks & Recreation",
  Other: "311 / General Services",
};
const CATEGORY_ICONS = {
  "Roads & sidewalks": '<path d="M8 3 5 21M16 3l3 18M12 4v3m0 4v3m0 4v3"/>',
  "Waste management": '<path d="M4.5 7h15M9 7V4h6v3m-8 0 1 13h8l1-13M10 10v6m4-6v6"/>',
  "Street lighting": '<path d="M9 17h6m-5 3h4m-5-6a6 6 0 1 1 6 0c-.8.6-1 1.4-1 3h-4c0-1.6-.2-2.4-1-3Z"/>',
  "Water & drainage": '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  "Public spaces": '<path d="M12 20v-8m0 2c-4 0-7-2.5-7-6 4 0 7 2 7 6Zm0-3c0-4 3-7 7-7 0 4-3 7-7 7Z"/>',
  Other: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5m0-8h.01"/>',
};
const $ = (selector) => document.querySelector(selector);
const modal = $("#report-modal");
const form = $("#report-form");
const submitButton = $("#submit-button");
const imageInput = $("#issue-image");
const toast = $("#toast");
let selectedImage = "";
let toastTimer;
let draftAnalysis = null;
let activeView = "overview";
let backendReports = [];
let authSession = null;
let selectedCoordinates = null;
let civicMap = null;
let civicMarkerLayer = null;
let problemMap = null;
let problemMarker = null;
let duplicateContinueConfirmed = false;
let voiceRecognition = null;
let voiceRecording = false;
let voicePaused = false;
let voiceFinalText = "";
let notificationEventSource = null;
let draftDatabase = null;
let activeDraftId = null;

try {
  authSession = JSON.parse(localStorage.getItem("civicresolve.session") || "null");
} catch {
  authSession = null;
}

function openDraftDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Offline drafts are not supported in this browser."));
      return;
    }
    if (draftDatabase) {
      resolve(draftDatabase);
      return;
    }
    const request = indexedDB.open("CivicResolveDrafts", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("drafts")) {
        database.createObjectStore("drafts", { keyPath: "draftId" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      draftDatabase = request.result;
      resolve(draftDatabase);
    };
  });
}

async function getDraftStore(mode = "readonly") {
  const database = await openDraftDatabase();
  const transaction = database.transaction("drafts", mode);
  return { transaction, store: transaction.objectStore("drafts") };
}

async function saveDraft(draft) {
  const { store, transaction } = await getDraftStore("readwrite");
  await new Promise((resolve, reject) => {
    const request = store.put(draft);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve) => { transaction.oncomplete = resolve; transaction.onerror = resolve; });
  await renderDraftList();
  return draft;
}

async function getAllDrafts() {
  const { store } = await getDraftStore("readonly");
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function deleteDraft(draftId) {
  const { store, transaction } = await getDraftStore("readwrite");
  await new Promise((resolve, reject) => {
    const request = store.delete(draftId);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve) => { transaction.oncomplete = resolve; transaction.onerror = resolve; });
  await renderDraftList();
}

function escapeDraftText(value) {
  return escapeHtml(value || "");
}

async function renderDraftList() {
  let drafts = [];
  try {
    drafts = await getAllDrafts();
  } catch (error) {
    $("#draft-list").innerHTML = `<div class="notification-empty">${escapeHtml(error.message)}</div>`;
    return;
  }
  drafts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  $("#draft-count").textContent = drafts.length;
  $("#draft-count").classList.toggle("hidden", drafts.length === 0);
  if (!drafts.length) {
    $("#draft-list").innerHTML = '<div class="notification-empty">No saved drafts. Start a report and choose “Save draft”.</div>';
    return;
  }
  $("#draft-list").innerHTML = drafts.map((draft) => `
    <article class="draft-card">
      <div class="draft-card-copy"><span class="draft-status ${draft.syncStatus === "SUBMITTED" ? "submitted" : ""}">${draft.syncStatus === "SUBMITTED" ? "Submitted" : navigator.onLine ? "Ready to submit" : "Saved offline"}</span><strong>${escapeDraftText(draft.title || "Untitled complaint")}</strong><span>${escapeDraftText(draft.location || "Location not set")}</span><small>Updated ${relativeDate(draft.updatedAt)}</small></div>
      <div class="draft-card-actions"><button type="button" class="text-button" data-edit-draft="${escapeHtml(draft.draftId)}">Edit</button><button type="button" class="text-button" data-submit-draft="${escapeHtml(draft.draftId)}" ${!navigator.onLine ? "disabled" : ""}>Submit</button><button type="button" class="text-button draft-delete" data-delete-draft="${escapeHtml(draft.draftId)}">Delete</button></div>
    </article>
  `).join("");
}

async function submitSavedDraft(draftId) {
  if (!authSession?.idToken) {
    showToast();
    return;
  }
  const drafts = await getAllDrafts();
  const draft = drafts.find((item) => item.draftId === draftId);
  if (!draft) return;
  if (!draft.title || !draft.description || !draft.location) {
    draft.syncStatus = "FAILED";
    draft.syncError = "Title, description and location are required.";
    await saveDraft(draft);
    return;
  }
  draft.syncStatus = "SYNCING";
  draft.updatedAt = new Date().toISOString();
  await saveDraft(draft);
  try {
    const response = await fetch("/api/complaints", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authSession.idToken}`,
        "X-Idempotency-Key": draft.draftId,
      },
      body: JSON.stringify({
        title: draft.title,
        description: draft.description,
        location: draft.location,
        coordinates: draft.coordinates || null,
        image: draft.image || "",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Draft submission failed.");
    await deleteDraft(draft.draftId);
    await loadBackendReports();
    showToast();
  } catch (error) {
    draft.syncStatus = "FAILED";
    draft.syncError = error.message;
    draft.updatedAt = new Date().toISOString();
    await saveDraft(draft);
  }
}

function updateConnectivityStatus() {
  const status = $("#connectivity-status");
  if (!status) return;
  const dot = status.querySelector("span");
  const label = status.querySelector("strong");
  status.dataset.connected = navigator.onLine ? "true" : "false";
  if (dot) dot.className = navigator.onLine ? "connected" : "offline";
  if (label) label.textContent = navigator.onLine ? "Online · ready to sync" : "Offline · drafts saved locally";
}

async function syncSavedDrafts() {
  if (!navigator.onLine || !authSession?.idToken) return;
  const drafts = await getAllDrafts();
  for (const draft of drafts) {
    if (draft.syncStatus !== "SUBMITTED") await submitSavedDraft(draft.draftId);
  }
}

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authSession?.idToken) headers.Authorization = `Bearer ${authSession.idToken}`;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "The CivicResolve service is unavailable.");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadBackendReports() {
  if (!authSession?.idToken) {
    backendReports = [];
    applyRoleUi();
    render();
    return;
  }
  try {
    const data = await apiRequest("/api/complaints");
    backendReports = data.complaints || [];
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem("civicresolve.session");
      authSession = null;
    }
    backendReports = [];
  }
  applyRoleUi();
  render();
}

async function loadDashboard() {
  if (!authSession?.idToken) return;
  try {
    const dashboard = await apiRequest("/api/dashboard");
    $("#kpi-national").textContent = dashboard.national;
    $("#kpi-state").textContent = dashboard.state;
    $("#kpi-local").textContent = dashboard.local;
    $("#kpi-verification").textContent = dashboard.awaitingVerification;
    $("#kpi-progress").textContent = dashboard.inProgress;
    $("#kpi-resolved").textContent = dashboard.resolved;
    $("#kpi-feedback-average").textContent = dashboard.feedback?.averageRating || 0;
    $("#kpi-feedback-unresolved").textContent = dashboard.feedback?.unresolved || 0;
    $("#kpi-reopening").textContent = dashboard.feedback?.reopeningRequests || 0;
  } catch (error) {
    $("#admin-error").textContent = error.message;
    $("#admin-error").classList.remove("hidden");
  }
}

async function loadCivicIntelligence() {
  if (!authSession?.idToken) return;
  $("#intel-ai-status").textContent = "LOADING";
  try {
    const range = $("#intelligence-range")?.value || "30";
    const governance = $("#intelligence-governance")?.value || "ALL";
    const department = $("#intelligence-department")?.value || "ALL";
    const data = await apiRequest(`/api/intelligence?range=${encodeURIComponent(range)}&governance=${encodeURIComponent(governance)}&department=${encodeURIComponent(department)}`);
    const summary = data.summary || {};
    $("#intel-total").textContent = summary.total || 0;
    $("#intel-unresolved").textContent = summary.unresolved || 0;
    $("#intel-resolved").textContent = summary.resolved || 0;
    $("#intel-overdue").textContent = summary.overdue || 0;
    $("#intel-reopened").textContent = summary.reopened || 0;
    $("#intel-average").textContent = `${summary.averageResolutionDays || 0}d`;

    const categories = data.categories || [];
    const categoryMax = Math.max(...categories.map((item) => item.count), 1);
    $("#intel-categories").innerHTML = categories.length ? categories.map((item) => `
      <div class="bar-row"><div><span>${escapeHtml(item.name)}</span><strong>${item.count}</strong></div><div class="bar-track"><i style="width:${Math.max(5, item.count / categoryMax * 100)}%"></i></div></div>
    `).join("") : '<div class="notification-empty">No category data in this period.</div>';

    const departments = data.departmentWorkload || [];
    $("#intel-departments").innerHTML = departments.length ? departments.map((item) => `
      <article class="intelligence-row"><div><strong>${escapeHtml(item.departmentName || item.departmentId)}</strong><span>${item.pending} pending · ${item.overdue} overdue</span></div><span class="intelligence-score">${item.assigned} assigned</span></article>
    `).join("") : '<div class="notification-empty">No department workload data in this period.</div>';

    const hotspots = data.hotspots || [];
    $("#intel-hotspots").innerHTML = hotspots.length ? hotspots.map((item) => `
      <article class="intelligence-row hotspot-row"><div><strong>${escapeHtml(item.location)}</strong><span>${item.unresolved} unresolved · ${item.reopened} reopened</span><small>${escapeHtml(item.mostCommonCategory)} · average age ${item.averageAgeDays}d</small></div><span class="intelligence-score">${item.score} attention</span></article>
    `).join("") : '<div class="notification-empty">No hotspot concentration found.</div>';

    const predictions = data.predictions || [];
    $("#intel-predictions").innerHTML = predictions.length ? predictions.map((item) => `
      <article class="intelligence-row prediction-row"><div><strong>${escapeHtml(item.category)}</strong><span>${escapeHtml(item.prediction)}</span><small>${escapeHtml(item.evidence)} · ${escapeHtml(item.confidence)} confidence</small></div><span class="intelligence-score">${item.changePercent > 0 ? "+" : ""}${item.changePercent}%</span></article>
    `).join("") : '<div class="notification-empty">Insufficient data for reliable prediction.</div>';

    const ai = data.aiInsights;
    if (!ai || ai.error) {
      $("#intel-ai-status").textContent = "VERIFIED DATA";
      $("#intel-ai-insights").innerHTML = '<div class="notification-empty">Gemini is unavailable or insufficient data was available. Verified statistics above remain available.</div>';
    } else {
      $("#intel-ai-status").textContent = "ADVISORY";
      const sections = [
        ["Key findings", ai.keyFindings],
        ["Hotspot observations", ai.hotspotObservations],
        ["Department observations", ai.departmentObservations],
        ["Recurring issues", ai.recurringIssues],
        ["Attention items", ai.attentionItems],
        ["Recommended actions", ai.recommendedActions],
        ["Data limitations", ai.dataLimitations],
      ];
      $("#intel-ai-insights").innerHTML = sections.map(([title, items]) =>
        `<div class="ai-insight-section"><strong>${escapeHtml(title)}</strong><ul>${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
      ).join("") + `<div class="ai-confidence">AI confidence: ${escapeHtml(ai.confidence || "Unspecified")}</div>`;
    }
  } catch (error) {
    $("#intel-ai-status").textContent = "UNAVAILABLE";
    $("#intel-ai-insights").innerHTML = `<div class="notification-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadNotifications() {
  if (!authSession?.idToken) {
    $("#notification-count").classList.add("hidden");
    $("#notification-nav-count").classList.add("hidden");
    $("#notification-list").innerHTML = '<div class="notification-empty">Sign in to view notifications.</div>';
    $("#notification-page-list").innerHTML = '<div class="notification-empty">Sign in to view notifications.</div>';
    return;
  }
  try {
    const filter = $("#notification-filter")?.value || "ALL";
    const governance = $("#notification-governance-filter")?.value || "ALL";
    const priority = $("#notification-priority-filter")?.value || "ALL";
    const data = await apiRequest(`/api/notifications?filter=${encodeURIComponent(filter)}&governance=${encodeURIComponent(governance)}&priority=${encodeURIComponent(priority)}&limit=100`);
    const count = data.unreadCount || 0;
    $("#notification-count").textContent = count > 99 ? "99+" : count;
    $("#notification-count").classList.toggle("hidden", count === 0);
    $("#notification-nav-count").textContent = count > 99 ? "99+" : count;
    $("#notification-nav-count").classList.toggle("hidden", count === 0);
    const renderItems = (fullPage = false) => data.notifications.length ? data.notifications.map((notification) => `
      <button type="button" class="notification-item ${notification.read ? "" : "unread"} ${notification.priority === "URGENT" ? "notification-urgent" : notification.priority === "IMPORTANT" ? "notification-important" : ""}" data-notification-id="${escapeHtml(notification.notificationId)}" data-notification-complaint="${escapeHtml(notification.complaintId || "")}">
        <span class="notification-dot"></span>
        <span class="notification-copy"><strong>${escapeHtml(notification.title)}</strong><span>${escapeHtml(notification.message)}</span><small>${escapeHtml(notification.priority || "NORMAL")} · ${relativeDate(notification.createdAt)}</small></span>
      </button>
    `).join("") : '<div class="notification-empty">No notifications match this view.</div>';
    $("#notification-list").innerHTML = renderItems(false);
    $("#notification-page-list").innerHTML = renderItems(true);
  } catch (error) {
    $("#notification-list").innerHTML = `<div class="notification-empty">${escapeHtml(error.message)}</div>`;
    $("#notification-page-list").innerHTML = `<div class="notification-empty">${escapeHtml(error.message)}</div>`;
  }
}

function applyNotificationStreamData(data) {
  const count = data.unreadCount || 0;
  $("#notification-count").textContent = count > 99 ? "99+" : count;
  $("#notification-count").classList.toggle("hidden", count === 0);
  $("#notification-nav-count").textContent = count > 99 ? "99+" : count;
  $("#notification-nav-count").classList.toggle("hidden", count === 0);
  const list = data.notifications || [];
  $("#notification-list").innerHTML = list.length ? list.slice(0, 20).map((notification) => `
    <button type="button" class="notification-item ${notification.read ? "" : "unread"} ${notification.priority === "URGENT" ? "notification-urgent" : notification.priority === "IMPORTANT" ? "notification-important" : ""}" data-notification-id="${escapeHtml(notification.notificationId)}" data-notification-complaint="${escapeHtml(notification.complaintId || "")}">
      <span class="notification-dot"></span>
      <span class="notification-copy"><strong>${escapeHtml(notification.title)}</strong><span>${escapeHtml(notification.message)}</span><small>${escapeHtml(notification.priority || "NORMAL")} · ${relativeDate(notification.createdAt)}</small></span>
    </button>
  `).join("") : '<div class="notification-empty">You are all caught up.</div>';
  if (activeView === "notifications") loadNotifications();
}

function startNotificationStream() {
  if (!authSession?.idToken) return;
  if (notificationEventSource) notificationEventSource.close();
  notificationEventSource = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(authSession.idToken)}`);
  notificationEventSource.addEventListener("notifications", (event) => {
    try { applyNotificationStreamData(JSON.parse(event.data)); } catch {}
  });
  notificationEventSource.addEventListener("error", () => {
    if (notificationEventSource) notificationEventSource.close();
    notificationEventSource = null;
  });
}

async function loadNotificationPreferences() {
  if (!authSession?.idToken) return;
  try {
    const data = await apiRequest("/api/notifications/preferences");
    const preferences = data.preferences || {};
    ["statusUpdates", "assignmentUpdates", "progressUpdates", "deadlineReminders", "escalationAlerts", "emailEnabled", "pushEnabled"].forEach((key) => {
      $(`#pref-${key}`).checked = preferences[key] !== false && (key === "emailEnabled" || key === "pushEnabled" ? Boolean(preferences[key]) : true);
    });
  } catch (error) {
    console.error(error.message);
  }
}

function applyRoleUi() {
  const role = authSession?.profile?.role;
  const adminLink = document.querySelector(".nav-link[data-view=\"admin\"]");
  if (adminLink) adminLink.classList.toggle("hidden", role === "CITIZEN");
  if (role === "DEPARTMENT_MEMBER" && authSession.profile?.authorityStatus !== "VERIFIED") {
    if (adminLink) adminLink.classList.add("hidden");
  }
  if (role) $("#top-avatar").textContent = (authSession.profile.displayName || authSession.profile.email || "CR").slice(0, 2).toUpperCase();
}

async function reverseGeocodeLocation(latitude, longitude) {
  $("#selected-address").textContent = "Detecting address...";
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=en&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`, {
      headers: { "Accept-Language": "en" },
    });
    if (!response.ok) throw new Error("Reverse geocoding failed");
    const result = await response.json();
    const address = result.address || {};
    const parts = [
      address.house_number,
      address.road,
      address.neighbourhood || address.suburb,
      address.city_district || address.county,
      address.state_district || address.state,
      address.postcode,
    ].filter(Boolean);
    const formattedAddress = parts.length ? parts.join(", ") : result.display_name;
    $("#selected-address").textContent = formattedAddress || "Address unavailable";
    if (!$("#issue-location").value.trim() || $("#issue-location").dataset.locationPicked === "true") {
      $("#issue-location").value = formattedAddress || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      $("#issue-location").dataset.locationPicked = "true";
    }
  } catch {
    $("#selected-address").textContent = "Address unavailable";
  }
}

async function setProblemLocation(latitude, longitude, accuracyMeters = null) {
  if (!problemMap) return;
  const latitudeNumber = Number(latitude);
  const longitudeNumber = Number(longitude);
  if (!Number.isFinite(latitudeNumber) || !Number.isFinite(longitudeNumber)) return;
  selectedCoordinates = {
    latitude: latitudeNumber,
    longitude: longitudeNumber,
    accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : null,
  };
  $("#selected-latitude").textContent = latitudeNumber.toFixed(6);
  $("#selected-longitude").textContent = longitudeNumber.toFixed(6);
  if (problemMarker) {
    problemMarker.setLatLng([latitudeNumber, longitudeNumber]);
  } else {
    problemMarker = window.L.marker([latitudeNumber, longitudeNumber], { draggable: true }).addTo(problemMap);
    problemMarker.on("dragend", (event) => {
      const position = event.target.getLatLng();
      setProblemLocation(position.lat, position.lng);
    });
  }
  problemMap.setView([latitudeNumber, longitudeNumber], Math.max(problemMap.getZoom(), 16));
  $("#location-status").textContent = "Problem location selected.";
  $("#location-status").classList.remove("hidden");
  await reverseGeocodeLocation(latitudeNumber, longitudeNumber);
}

function initProblemLocationPicker() {
  if (typeof window.L === "undefined") {
    $("#location-status").textContent = "Map unavailable. Search or enter the street and area manually.";
    $("#location-status").classList.remove("hidden");
    return;
  }
  if (!problemMap) {
    problemMap = window.L.map("problem-location-map").setView([11.1085, 77.3411], 13);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    }).addTo(problemMap);
    problemMap.on("click", (event) => setProblemLocation(event.latlng.lat, event.latlng.lng));
  }
  window.setTimeout(() => problemMap.invalidateSize(), 100);
  if (selectedCoordinates) {
    setProblemLocation(selectedCoordinates.latitude, selectedCoordinates.longitude, selectedCoordinates.accuracyMeters);
  }
}

function getReports() {
  if (authSession?.idToken) return backendReports;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    console.error("Could not read saved civic reports.", error);
    return [];
  }
}

function saveReports(reports) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
  } catch (error) {
    throw new Error("We couldn't save this report on your device. Try removing the photo or freeing up browser storage.");
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function relativeDate(value) {
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (!Number.isFinite(date.getTime()) || days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function issueIcon(category) {
  return `<span class="issue-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${CATEGORY_ICONS[category] || CATEGORY_ICONS.Other}</svg></span>`;
}

function statusClass(status) {
  return status === "Resolved" ? "status-resolved" : status === "In Progress" ? "status-progress" : "status-reported";
}

function priorityClass(priority) {
  return `priority-${String(priority || "Low").toLowerCase()}`;
}

function deadlineLabel(report) {
  if (!report.deadlineAt) return '<span class="deadline-label">Deadline pending</span>';
  const deadline = new Date(report.deadlineAt).getTime();
  if (!Number.isFinite(deadline)) return '<span class="deadline-label">Deadline pending</span>';
  const difference = deadline - Date.now();
  if (report.status === "Resolved") return '<span class="deadline-label deadline-resolved">Resolved on time</span>';
  if (difference < 0) return `<span class="deadline-label deadline-overdue">Overdue ${Math.ceil(Math.abs(difference) / 3600000)}h</span>`;
  if (difference <= 86400000) return `<span class="deadline-label deadline-soon">${Math.ceil(difference / 3600000)}h remaining</span>`;
  return `<span class="deadline-label">${Math.ceil(difference / 3600000)}h remaining</span>`;
}

function evidenceGallery(report) {
  const stages = [
    ["Before", report.evidence?.before?.[0]?.photo || report.image],
    ["During", report.evidence?.during?.[0]?.photo],
    ["After", report.evidence?.after?.[0]?.photo || report.resolution?.photo],
  ];
  const available = stages.filter(([, photo]) => photo);
  if (!available.length) return '<span class="evidence-empty">No photos yet</span>';
  return `<div class="evidence-gallery">${available.map(([stage, photo]) =>
    `<button class="evidence-thumb" type="button" data-evidence-photo="${escapeHtml(photo)}" title="${stage} evidence"><img src="${escapeHtml(photo)}" alt="${stage} evidence" /><span>${stage}</span></button>`
  ).join("")}</div>`;
}

function renderReportItem(report) {
  const evidenceCount = (report.evidence?.before?.length || (report.image ? 1 : 0)) + (report.evidence?.during?.length || 0) + (report.evidence?.after?.length || 0);
  const locationLabel = report.coordinates ? `<a class="location-link" href="https://www.google.com/maps?q=${encodeURIComponent(report.coordinates.latitude)},${encodeURIComponent(report.coordinates.longitude)}" target="_blank" rel="noopener noreferrer">${escapeHtml(report.location)} · map</a>` : escapeHtml(report.location);
  return `<article class="report-item">${issueIcon(report.category)}<div class="issue-copy"><div class="issue-title">${escapeHtml(report.title)}</div><div class="issue-meta"><span>${locationLabel}</span><span class="meta-separator">·</span><span>${escapeHtml(report.category)}</span><span class="meta-separator">·</span><span>${escapeHtml(report.governanceLevel || "LOCAL")}</span><span class="meta-separator">·</span><span>${evidenceCount} evidence photo${evidenceCount === 1 ? "" : "s"}</span></div></div><div class="report-item-right"><span class="status-badge ${statusClass(report.status)}">${escapeHtml(report.status)}</span><span class="priority-badge ${priorityClass(report.priority)}">${escapeHtml(report.priority)} priority</span>${deadlineLabel(report)}</div></article>`;
}

function renderTableRow(report, admin = false) {
  const evidenceCount = (report.evidence?.before?.length || (report.image ? 1 : 0)) + (report.evidence?.during?.length || 0) + (report.evidence?.after?.length || 0);
  const issue = `<div class="table-issue">${issueIcon(report.category)}<div><div class="table-title">${escapeHtml(report.title)}</div><div class="table-subtitle">${escapeHtml(report.category)} · ${evidenceCount} evidence photo${evidenceCount === 1 ? "" : "s"}</div></div></div>`;
  const locationLabel = report.coordinates ? `<a class="location-link" href="https://www.google.com/maps?q=${encodeURIComponent(report.coordinates.latitude)},${encodeURIComponent(report.coordinates.longitude)}" target="_blank" rel="noopener noreferrer">${escapeHtml(report.location)}</a>` : escapeHtml(report.location);
  const common = `<td>${issue}</td><td>${locationLabel}<div>${deadlineLabel(report)}</div></td>`;
  const priority = `<td><span class="priority-badge ${priorityClass(report.priority)}">${escapeHtml(report.priority)} priority</span></td>`;
  if (admin) {
    const verifyButton = report.aiAnalysis?.requiresManualReview ? `<button class="text-button verify-button" data-verify-id="${escapeHtml(report.complaintId || report.id)}">Verify routing</button>` : "";
    const mergeButton = authSession?.profile?.role === "SUPER_ADMIN" ? `<button type="button" class="text-button merge-button" data-merge-duplicate="${escapeHtml(report.complaintId || report.id)}">Merge duplicates</button>` : "";
    const beforeCount = report.evidence?.before?.length || (report.image ? 1 : 0);
    const deadlineButton = authSession?.profile?.role === "SUPER_ADMIN" ? `<button type="button" class="text-button deadline-button" data-deadline-id="${escapeHtml(report.complaintId || report.id)}">Extend deadline</button>` : "";
    const reopenReviewButton = authSession?.profile?.role === "SUPER_ADMIN" && report.reopenRequest?.status === "PENDING" ? `<button type="button" class="text-button reopen-review" data-reopen-review-id="${escapeHtml(report.complaintId || report.id)}">Review reopening</button>` : "";
    return `<tr>${common}<td>${escapeHtml((report.assignments || []).map((assignment) => assignment.departmentName).join(", ") || "Awaiting verified assignment")}${evidenceGallery(report)}</td>${priority}<td><span class="status-badge ${statusClass(report.status)}">${escapeHtml(report.status)}</span></td><td><select class="admin-status-select" data-status-id="${escapeHtml(report.complaintId || report.id)}" aria-label="Update status for ${escapeHtml(report.title)}">${STATUS_OPTIONS.map((status) => `<option${status === report.status ? " selected" : ""}>${status}</option>`).join("")}</select><div class="evidence-upload-row"><label>Before <span class="evidence-count">${beforeCount}</span></label><label>During <input class="during-evidence" type="file" accept="image/jpeg,image/png,image/webp" /></label><label>After <input class="after-evidence" type="file" accept="image/jpeg,image/png,image/webp" /></label></div>${verifyButton}${mergeButton}${deadlineButton}${reopenReviewButton}</td></tr>`;
  }
  let citizenActions = "";
  if (authSession?.profile?.role === "CITIZEN" && report.status === "Resolved") {
    if (report.feedback?.submittedAt) {
      citizenActions = `<span class="feedback-complete">Feedback: ${escapeHtml(report.feedback.rating)}/5</span>`;
    } else {
      citizenActions = `<button type="button" class="text-button feedback-open" data-feedback-id="${escapeHtml(report.complaintId || report.id)}">Give feedback</button>`;
    }
    if (report.reopenRequest?.status === "PENDING") {
      citizenActions += '<span class="reopen-pending">Reopening under review</span>';
    } else if (!report.reopenRequest || report.reopenRequest.status === "REJECTED") {
      citizenActions += `<button type="button" class="text-button reopen-open" data-reopen-id="${escapeHtml(report.complaintId || report.id)}">Request reopening</button>`;
    }
  }
  if (report.status === "Reopened") citizenActions += '<span class="reopen-approved">Complaint reopened</span>';
  return `<tr>${common}<td>${escapeHtml(report.category)}${evidenceGallery(report)}${citizenActions}</td>${priority}<td><span class="status-badge ${statusClass(report.status)}">${escapeHtml(report.status)}</span></td><td>${relativeDate(report.createdAt)}</td></tr>`;
}

function render() {
  const reports = getReports();
  const total = reports.length;
  const resolved = reports.filter((report) => report.status === "Resolved").length;
  const progress = reports.filter((report) => report.status === "In Progress").length;
  const reported = total - resolved - progress;
  $("#stat-total").textContent = total;
  $("#stat-progress").textContent = progress;
  $("#stat-resolved").textContent = resolved;
  $("#report-count").textContent = total;
  $("#legend-resolved").textContent = resolved;
  $("#legend-progress").textContent = progress;
  $("#legend-reported").textContent = reported;
  const percent = total ? Math.round((resolved / total) * 100) : 0;
  $("#resolved-percent").textContent = `${percent}%`;
  const resolvedAngle = total ? (resolved / total) * 100 : 0;
  const progressAngle = total ? ((resolved + progress) / total) * 100 : 0;
  $("#status-donut").style.background = `conic-gradient(#65966c 0% ${resolvedAngle}%, #dcae57 ${resolvedAngle}% ${progressAngle}%, #e9eee8 ${progressAngle}% 100%)`;
  $("#status-message").textContent = total === 0 ? "Every resolved issue makes a real difference." : resolved === total ? "Look at this neighbourhood getting things done!" : `${resolved} ${resolved === 1 ? "issue" : "issues"} resolved so far — thanks for speaking up.`;

  const recent = [...reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 4);
  $("#recent-reports").innerHTML = recent.map(renderReportItem).join("");
  $("#recent-empty").classList.toggle("hidden", recent.length > 0);
  $("#recent-reports").classList.toggle("hidden", recent.length === 0);

  const query = ($("#issue-search")?.value || "").trim().toLowerCase();
  const statusFilter = $("#status-filter")?.value || "all";
  const categoryFilter = $("#category-filter")?.value || "all";
  const filtered = [...reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).filter((report) => {
    const matchesText = !query || [report.title, report.description, report.location, report.category, report.complaintId, report.id].some((value) => String(value || "").toLowerCase().includes(query));
    return matchesText && (statusFilter === "all" || report.status === statusFilter) && (categoryFilter === "all" || report.category === categoryFilter);
  });
  $("#all-reports-body").innerHTML = filtered.map((report) => renderTableRow(report)).join("");
  $("#all-empty").classList.toggle("hidden", filtered.length > 0);
  $("#admin-reports-body").innerHTML = [...reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((report) => renderTableRow(report, true)).join("");
  $("#admin-empty").classList.toggle("hidden", total > 0);
}

async function geocodeReportLocation(report) {
  if (report.coordinates?.latitude && report.coordinates?.longitude) {
    return report.coordinates;
  }
  const cacheKey = `civicresolve.geocode.${encodeURIComponent(report.location || "")}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached?.latitude && cached?.longitude) return cached;
  } catch {}
  if (!navigator.onLine || !report.location) return null;
  try {
    const query = encodeURIComponent(`${report.location}, Tamil Nadu, India`);
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${query}`, {
      headers: { "Accept-Language": "en" },
    });
    if (!response.ok) return null;
    const results = await response.json();
    if (!results.length) return null;
    const coordinates = { latitude: Number(results[0].lat), longitude: Number(results[0].lon) };
    localStorage.setItem(cacheKey, JSON.stringify(coordinates));
    return coordinates;
  } catch {
    return null;
  }
}

function markerColor(report) {
  if (report.status === "Resolved") return "#65966c";
  if (report.priority === "CRITICAL") return "#c75d52";
  if (report.priority === "HIGH") return "#d49b4d";
  if (report.priority === "MEDIUM") return "#7896ad";
  return "#7e9e76";
}

async function renderIssueMap() {
  if (typeof window.L === "undefined") {
    $("#map-empty").innerHTML = "<strong>Map library unavailable.</strong><span>Check your internet connection and refresh this page.</span>";
    $("#map-empty").classList.remove("hidden");
    return;
  }
  if (!civicMap) {
    civicMap = window.L.map("civic-map").setView([11.1085, 77.3411], 12);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    }).addTo(civicMap);
  }
  if (civicMarkerLayer) civicMarkerLayer.clearLayers();
  civicMarkerLayer = window.L.layerGroup().addTo(civicMap);

  const level = $("#map-level-filter").value;
  const category = $("#map-category-filter").value;
  const status = $("#map-status-filter").value;
  const priority = $("#map-priority-filter").value;
  const reports = getReports().filter((report) =>
    (level === "all" || report.governanceLevel === level) &&
    (category === "all" || report.category === category) &&
    (status === "all" || report.status === status) &&
    (priority === "all" || String(report.priority || "").toUpperCase() === priority)
  );
  let markerCount = 0;
  const bounds = [];
  for (const report of reports) {
    const coordinates = await geocodeReportLocation(report);
    if (!coordinates) continue;
    const latitude = Number(coordinates.latitude);
    const longitude = Number(coordinates.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const icon = window.L.divIcon({
      className: "civic-marker-wrap",
      html: `<span class="civic-marker" style="background:${markerColor(report)}"></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -10],
    });
    const marker = window.L.marker([latitude, longitude], { icon }).addTo(civicMarkerLayer);
    marker.bindPopup(`
      <div class="map-popup">
        <strong>${escapeHtml(report.title)}</strong>
        <span>${escapeHtml(report.complaintId || report.id || "Complaint")}</span>
        <span>${escapeHtml(report.category || "Other")} · ${escapeHtml(report.priority || "LOW")} priority</span>
        <span>${escapeHtml(report.location || "Location unavailable")}</span>
        <span class="map-popup-status">${escapeHtml(report.status || "Reported")}</span>
        ${coordinates !== report.coordinates ? '<small>Approximate location</small>' : ""}
      </div>
    `);
    bounds.push([latitude, longitude]);
    markerCount++;
  }
  if (bounds.length) civicMap.fitBounds(bounds, { padding: [35, 35], maxZoom: 15 });
  $("#map-empty").classList.toggle("hidden", markerCount > 0);
}

function setView(view) {
  activeView = view;
  document.querySelectorAll(".page-content").forEach((section) => section.classList.add("hidden"));
  const targetView = $(`#${view}-view`);
  if (!targetView) return;
  targetView.classList.remove("hidden");
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === view));
  const titles = { overview: "Overview", issues: "All reports", map: "Issue map", notifications: "Notifications", admin: "Admin review" };
  $("#breadcrumb-current").textContent = titles[view];
  if (view === "issues" || view === "admin") render();
  if (view === "map") window.setTimeout(renderIssueMap, 50);
  if (view === "notifications") {
    loadNotifications();
    loadNotificationPreferences();
  }
  if (view === "admin") {
    loadDashboard();
    loadAuthorityApplications();
  }
}

function openModal() {
  if (!authSession?.idToken) {
    openAuthModal();
    return;
  }
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  window.setTimeout(() => {
    $("#issue-title").focus();
    initProblemLocationPicker();
  }, 50);
}

function openAuthModal(register = false) {
  $("#auth-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("#auth-name").classList.toggle("hidden", !register);
  $("#auth-name-label").classList.toggle("hidden", !register);
  $("#auth-title").textContent = register ? "Create a citizen account" : "Sign in to CivicResolve";
  $("#auth-submit").innerHTML = register ? "Create account <span>↗</span>" : "Sign in <span>↗</span>";
  $("#auth-switch").textContent = register ? "Already have an account? Sign in" : "New here? Create a citizen account";
  $("#auth-switch").dataset.mode = register ? "login" : "register";
  window.setTimeout(() => $(register ? "#auth-name" : "#auth-email").focus(), 50);
}

function closeAuthModal() {
  $("#auth-modal").classList.add("hidden");
  document.body.style.overflow = "";
}

async function openAuthorityApplicationModal() {
  $("#authority-application-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("#authority-application-error").classList.add("hidden");
  try {
    const data = await apiRequest("/api/departments");
    const select = $("#authority-department");
    select.innerHTML = '<option value="">Select department</option>' + data.departments.map((department) => `<option value="${escapeHtml(department.id)}">${escapeHtml(department.name)} — ${escapeHtml(department.governanceLevel)}</option>`).join("");
  } catch (error) {
    $("#authority-application-error").textContent = error.message;
    $("#authority-application-error").classList.remove("hidden");
  }
}

function closeModal() {
  if (voiceRecognition && voiceRecording) {
    voiceRecording = false;
    voicePaused = false;
    try { voiceRecognition.stop(); } catch {}
  }
  modal.classList.add("hidden");
  document.body.style.overflow = "";
}

function showToast() {
  toast.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 5000);
}

async function classifyIssue(title, description, location, image) {
  if (!authSession?.idToken) {
    const error = new Error("Sign in before submitting a complaint.");
    error.status = 401;
    throw error;
  }
  const response = await apiRequest("/api/analyze", {
    method: "POST",
    body: JSON.stringify({ title, description, location, coordinates: selectedCoordinates, image }),
  });
  return response;
}

async function showAnalysis(result) {
  const analysis = result.analysis;
  draftAnalysis = result;
  $("#analysis-category").textContent = analysis.category;
  $("#analysis-governance").textContent = analysis.governanceLevel;
  $("#analysis-priority").textContent = analysis.priority;
  $("#analysis-priority").className = priorityClass(analysis.priority);
  const departmentNames = result.assignments.map((assignment) => assignment.departmentName).join(", ");
  $("#analysis-department").textContent = departmentNames || "Awaiting Super Admin review";
  $("#analysis-jurisdiction").textContent = [analysis.localBody, analysis.district, analysis.state].filter(Boolean).join(", ") || "Pending verification";
  $("#analysis-impact").textContent = analysis.publicImpact;
  $("#analysis-reason").textContent = analysis.reason;
  $("#analysis-engine").textContent = `Analyzed with Google Gemini · ${Math.round(analysis.confidence * 100)}% confidence`;
  $("#analysis-card").classList.remove("hidden");
  try {
    const duplicateData = await apiRequest("/api/complaints/check-duplicates", {
      method: "POST",
      body: JSON.stringify({
        title: $("#issue-title").value.trim(),
        description: $("#issue-description").value.trim(),
        category: analysis.category,
        location: $("#issue-location").value.trim(),
        coordinates: selectedCoordinates,
      }),
    });
    renderDuplicateMatches(duplicateData.possibleDuplicates || []);
  } catch (error) {
    renderDuplicateMatches([]);
  }
}

function renderDuplicateMatches(matches) {
  const card = $("#duplicate-card");
  const list = $("#duplicate-list");
  duplicateContinueConfirmed = false;
  if (!matches.length) {
    card.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  $("#duplicate-count").textContent = `${matches.length} possible match${matches.length === 1 ? "" : "es"}`;
  list.innerHTML = matches.map((match) => `
    <div class="duplicate-match">
      <div><strong>${escapeHtml(match.title)}</strong><span>${escapeHtml(match.location)} · ${escapeHtml(match.status)} · ${Math.round(match.similarityScore * 100)}% confidence${match.distanceMeters !== null && match.distanceMeters !== undefined ? ` · ${match.distanceMeters < 1000 ? `${match.distanceMeters} m away` : `${(match.distanceMeters / 1000).toFixed(1)} km away`}` : ""}</span><small>${match.verificationMode === "GEMINI" ? "Gemini verified" : "Local similarity fallback"}</small></div>
      <div class="duplicate-actions"><button type="button" class="text-button" data-view-duplicate="${escapeHtml(match.complaintId)}">View status</button><button type="button" class="button button-light duplicate-support" data-support-duplicate="${escapeHtml(match.complaintId)}">Support</button></div>
    </div>
  `).join("");
  list.insertAdjacentHTML("beforeend", '<button type="button" class="text-button duplicate-continue" data-continue-duplicate>Submit as a separate complaint</button>');
  card.classList.remove("hidden");
}

function setBusy(busy, label) {
  submitButton.disabled = busy;
  submitButton.innerHTML = busy ? `<span class="button-spinner"></span>${label}` : draftAnalysis ? "Submit my report <span>↗</span>" : "Review my report <span>↗</span>";
}

function showError(message) {
  $("#form-error").textContent = message;
  $("#form-error").classList.remove("hidden");
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-navigate]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.navigate)));
document.querySelectorAll("[data-open-report]").forEach((button) => button.addEventListener("click", openModal));
$("#save-draft-button").addEventListener("click", async () => {
  const now = new Date().toISOString();
  activeDraftId = activeDraftId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const draft = {
    draftId: activeDraftId,
    title: $("#issue-title").value.trim(),
    description: $("#issue-description").value.trim(),
    location: $("#issue-location").value.trim(),
    coordinates: selectedCoordinates,
    image: selectedImage,
    syncStatus: "DRAFT",
    createdAt: activeDraftId ? now : now,
    updatedAt: now,
  };
  try {
    await saveDraft(draft);
    $("#form-error").textContent = "";
    $("#form-error").classList.add("hidden");
    showToast();
  } catch (error) {
    showError(error.message);
  }
});
$("#refresh-authority-applications").addEventListener("click", loadAuthorityApplications);
document.addEventListener("click", async (event) => {
  const reviewButton = event.target.closest("[data-authority-review]");
  if (!reviewButton) return;
  const remarks = window.prompt(`${reviewButton.dataset.authorityDecision === "APPROVE" ? "Approval" : "Rejection"} remarks (required):`);
  if (!remarks?.trim()) return;
  try {
    await apiRequest(`/api/authority/applications/${reviewButton.dataset.authorityReview}`, {
      method: "PATCH",
      body: JSON.stringify({ decision: reviewButton.dataset.authorityDecision, remarks: remarks.trim() }),
    });
    await loadAuthorityApplications();
  } catch (error) {
    $("#authority-applications-list").innerHTML = `<div class="notification-empty">${escapeHtml(error.message)}</div>`;
  }
});
document.getElementById("draft-list").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-draft]");
  const deleteButton = event.target.closest("[data-delete-draft]");
  const submitButton = event.target.closest("[data-submit-draft]");
  if (deleteButton) {
    await deleteDraft(deleteButton.dataset.deleteDraft);
    return;
  }
  if (editButton) {
    const drafts = await getAllDrafts();
    const draft = drafts.find((item) => item.draftId === editButton.dataset.editDraft);
    if (!draft) return;
    activeDraftId = draft.draftId;
    $("#issue-title").value = draft.title || "";
    $("#issue-description").value = draft.description || "";
    $("#issue-location").value = draft.location || "";
    selectedCoordinates = draft.coordinates || null;
    selectedImage = draft.image || "";
    if (selectedImage) {
      $("#upload-preview").src = selectedImage;
      $("#upload-preview").classList.remove("hidden");
      $("#upload-caption").textContent = "Saved draft photo";
    }
    openModal();
  }
  if (submitButton) {
    if (!navigator.onLine) {
      showToast();
      return;
    }
    await submitSavedDraft(submitButton.dataset.submitDraft);
  }
});

$("#report-open").addEventListener("click", openModal);
$("#modal-close").addEventListener("click", closeModal);
$("#toast-close").addEventListener("click", () => toast.classList.add("hidden"));
$("#top-avatar").addEventListener("click", () => {
  if (!authSession?.idToken) {
    openAuthModal(false);
    return;
  }
  if (authSession.profile?.role === "CITIZEN" && authSession.profile?.authorityStatus !== "PENDING" && authSession.profile?.authorityStatus !== "VERIFIED") {
    openAuthorityApplicationModal();
  }
});
$("#auth-close").addEventListener("click", closeAuthModal);
$("#auth-modal").addEventListener("click", (event) => { if (event.target === $("#auth-modal")) closeAuthModal(); });
$("#auth-switch").addEventListener("click", () => openAuthModal($("#auth-switch").dataset.mode === "register"));
$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const register = !$("#auth-name").classList.contains("hidden");
  $("#auth-error").classList.add("hidden");
  $("#auth-submit").disabled = true;
  try {
    const data = await apiRequest(register ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("#auth-email").value.trim(),
        password: $("#auth-password").value,
        displayName: $("#auth-name").value.trim(),
      }),
    });
    authSession = data;
    localStorage.setItem("civicresolve.session", JSON.stringify(data));
    closeAuthModal();
    $("#top-avatar").textContent = (data.profile?.displayName || data.profile?.email || "CR").slice(0, 2).toUpperCase();
    await loadBackendReports();
    await loadNotifications();
    startNotificationStream();
  } catch (error) {
    $("#auth-error").textContent = error.message;
    $("#auth-error").classList.remove("hidden");
  } finally {
    $("#auth-submit").disabled = false;
  }
});
$("#authority-application-close").addEventListener("click", () => {
  $("#authority-application-modal").classList.add("hidden");
  document.body.style.overflow = "";
});
$("#authority-application-modal").addEventListener("click", (event) => {
  if (event.target === $("#authority-application-modal")) {
    $("#authority-application-modal").classList.add("hidden");
    document.body.style.overflow = "";
  }
});
$("#authority-application-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#authority-application-error").classList.add("hidden");
  try {
    await apiRequest("/api/authority/apply", {
      method: "POST",
      body: JSON.stringify({
        requestedRole: $("#authority-requested-role").value,
        departmentId: $("#authority-department").value,
        employeeId: $("#authority-employee-id").value.trim(),
        designation: $("#authority-designation").value.trim(),
        verificationNote: $("#authority-verification-note").value.trim(),
      }),
    });
    authSession.profile.authorityStatus = "PENDING";
    localStorage.setItem("civicresolve.session", JSON.stringify(authSession));
    $("#authority-application-modal").classList.add("hidden");
    document.body.style.overflow = "";
    showToast();
  } catch (error) {
    $("#authority-application-error").textContent = error.message;
    $("#authority-application-error").classList.remove("hidden");
  }
});

async function loadAuthorityApplications() {
  if (!authSession?.profile || authSession.profile.role !== "SUPER_ADMIN" || authSession.profile.authorityStatus !== "VERIFIED") {
    $("#authority-verification-panel").classList.add("hidden");
    return;
  }
  $("#authority-verification-panel").classList.remove("hidden");
  try {
    const data = await apiRequest("/api/authority/applications");
    const applications = data.applications || [];
    $("#authority-applications-list").innerHTML = applications.length ? applications.map((application) => {
      const authority = application.authorityApplication || {};
      return `<article class="authority-application"><div><strong>${escapeHtml(application.displayName || application.email)}</strong><span>${escapeHtml(authority.requestedRole)} · ${escapeHtml(authority.departmentName)} · ${escapeHtml(authority.employeeId)}</span><small>${escapeHtml(authority.designation)} — ${escapeHtml(authority.verificationNote)}</small></div><div class="authority-actions"><button type="button" class="text-button authority-review" data-authority-review="${escapeHtml(application.uid)}" data-authority-decision="APPROVE">Approve</button><button type="button" class="text-button authority-reject" data-authority-review="${escapeHtml(application.uid)}" data-authority-decision="REJECT">Reject</button></div></article>`;
    }).join("") : '<div class="notification-empty">No pending authority applications.</div>';
  } catch (error) {
    $("#authority-applications-list").innerHTML = `<div class="notification-empty">${escapeHtml(error.message)}</div>`;
  }
}
modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !modal.classList.contains("hidden")) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#auth-modal").classList.contains("hidden")) closeAuthModal(); });
$("#issue-search").addEventListener("input", render);
$("#status-filter").addEventListener("change", render);
$("#category-filter").addEventListener("change", render);
["map-level-filter", "map-category-filter", "map-status-filter", "map-priority-filter"].forEach((id) => {
  $(`#${id}`).addEventListener("change", renderIssueMap);
});
$("#map-locate").addEventListener("click", () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((position) => {
    if (civicMap) civicMap.setView([position.coords.latitude, position.coords.longitude], 15);
  }, () => {
    $("#map-empty").innerHTML = "<strong>Location permission needed.</strong><span>Allow location access to centre the map near you.</span>";
    $("#map-empty").classList.remove("hidden");
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
});

async function searchProblemLocation() {
  const query = $("#location-search").value.trim();
  if (!query) {
    $("#location-status").textContent = "Enter a place, street, area or landmark.";
    $("#location-status").classList.remove("hidden");
    return;
  }
  $("#location-search-button").disabled = true;
  $("#location-status").textContent = "Searching...";
  $("#location-status").classList.remove("hidden");
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&countrycodes=in&accept-language=en&q=${encodeURIComponent(query)}`, {
      headers: { "Accept-Language": "en" },
    });
    if (!response.ok) throw new Error("Place search failed");
    const results = await response.json();
    if (!results.length) {
      $("#location-status").textContent = "No matching place found. Try a nearby landmark or street.";
      return;
    }
    const result = results[0];
    initProblemLocationPicker();
    await setProblemLocation(Number(result.lat), Number(result.lon));
    $("#location-status").textContent = `Found: ${result.display_name}`;
  } catch {
    $("#location-status").textContent = "Place search is unavailable. Click the map or use current location.";
  } finally {
    $("#location-search-button").disabled = false;
  }
}

$("#location-search-button").addEventListener("click", searchProblemLocation);
$("#location-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchProblemLocation();
  }
});
$("#clear-location").addEventListener("click", () => {
  selectedCoordinates = null;
  if (problemMarker && problemMap) {
    problemMap.removeLayer(problemMarker);
    problemMarker = null;
  }
  $("#selected-latitude").textContent = "Not selected";
  $("#selected-longitude").textContent = "Not selected";
  $("#selected-address").textContent = "Search or select a point on the map";
  $("#location-search").value = "";
  $("#issue-location").dataset.locationPicked = "false";
  $("#issue-location").dataset.locationPicked = "false";
  $("#selected-latitude").textContent = "Not selected";
  $("#selected-longitude").textContent = "Not selected";
  $("#selected-address").textContent = "Search or select a point on the map";
  $("#location-status").textContent = "Location cleared. Select a new point on the map.";
  $("#location-status").classList.remove("hidden");
  if (problemMarker) {
    problemMap.removeLayer(problemMarker);
    problemMarker = null;
  }
});

$("#location-capture").addEventListener("click", () => {
  if (!navigator.geolocation) {
    $("#location-status").textContent = "Location capture is not supported by this browser.";
    $("#location-status").classList.remove("hidden");
    return;
  }
  $("#location-capture").disabled = true;
  $("#location-capture-label").textContent = "Finding your location...";
  navigator.geolocation.getCurrentPosition((position) => {
    initProblemLocationPicker();
    setProblemLocation(position.coords.latitude, position.coords.longitude, position.coords.accuracy);
    $("#location-capture-label").textContent = "Use My Current Location";
    $("#location-capture").disabled = false;
  }, (error) => {
    const message = error.code === 1 ? "Location permission was denied." : error.code === 2 ? "Your location could not be determined." : "Location request timed out.";
    $("#location-status").textContent = message;
    $("#location-status").classList.remove("hidden");
    $("#location-capture-label").textContent = "Try current location again";
    $("#location-capture").disabled = false;
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
});

imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  $("#form-error").classList.add("hidden");
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    imageInput.value = "";
    showError("Please choose an image file.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    imageInput.value = "";
    showError("That photo is over 5 MB. Please choose a smaller image.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    selectedImage = String(reader.result);
    $("#upload-preview").src = selectedImage;
    $("#upload-preview").classList.remove("hidden");
    $("#upload-caption").textContent = file.name;
  };
  reader.onerror = () => showError("We couldn't read that photo. Please try another image.");
  reader.readAsDataURL(file);
});

$("#admin-reports-body").addEventListener("change", (event) => {
  const select = event.target.closest("[data-status-id]");
  if (!select) return;
  const readPhoto = (input) => new Promise((resolve, reject) => {
    const file = input?.files?.[0];
    if (!file) return resolve("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) return reject(new Error("Evidence photos must be JPG, PNG or WEBP and no larger than 5 MB."));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("We couldn't read an evidence photograph."));
    reader.readAsDataURL(file);
  });
  const updateStatus = async () => {
    const duringPhoto = await readPhoto(select.parentElement.querySelector(".during-evidence"));
    const afterPhoto = await readPhoto(select.parentElement.querySelector(".after-evidence"));
    try {
      await apiRequest(`/api/complaints/${select.dataset.statusId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: select.value, evidence: { during: duringPhoto, after: afterPhoto }, resolutionPhoto: afterPhoto }),
      });
      $("#admin-error").classList.add("hidden");
      await loadBackendReports();
    } catch (error) {
      $("#admin-error").textContent = error.message;
      $("#admin-error").classList.remove("hidden");
    }
  };
  if (select.value === "Resolved") {
    const photoInput = select.parentElement.querySelector(".after-evidence");
    if (!photoInput?.files?.[0]) {
      $("#admin-error").textContent = "Choose an after photograph before resolving this complaint.";
      $("#admin-error").classList.remove("hidden");
      select.value = select.closest("tr").dataset.previousStatus || "In Progress";
      return;
    }
  }
  updateStatus().catch((error) => {
    $("#admin-error").textContent = error.message;
    $("#admin-error").classList.remove("hidden");
  });
});

$("#admin-reports-body").addEventListener("click", async (event) => {
  const reopenReviewButton = event.target.closest("[data-reopen-review-id]");
  if (reopenReviewButton) {
    const decisionInput = window.prompt("Approve or reject reopening? Enter APPROVED or REJECTED:");
    if (!decisionInput) return;
    const decision = decisionInput.trim().toUpperCase();
    if (!["APPROVED", "REJECTED"].includes(decision)) {
      $("#admin-error").textContent = "Decision must be APPROVED or REJECTED.";
      $("#admin-error").classList.remove("hidden");
      return;
    }
    const remarks = window.prompt("Required review remarks:");
    if (!remarks?.trim()) {
      $("#admin-error").textContent = "Review remarks are required.";
      $("#admin-error").classList.remove("hidden");
      return;
    }
    try {
      await apiRequest(`/api/complaints/${reopenReviewButton.dataset.reopenReviewId}/reopen/review`, {
        method: "PATCH",
        body: JSON.stringify({ decision, remarks: remarks.trim() }),
      });
      await loadBackendReports();
    } catch (error) {
      $("#admin-error").textContent = error.message;
      $("#admin-error").classList.remove("hidden");
    }
    return;
  }
  const deadlineButton = event.target.closest("[data-deadline-id]");
  if (deadlineButton) {
    const hours = window.prompt("Extend deadline by how many hours?");
    const extendedHours = Number(hours);
    const reason = window.prompt("Reason for extending the deadline?");
    if (!extendedHours || !reason?.trim()) {
      $("#admin-error").textContent = "A valid extension period and reason are required.";
      $("#admin-error").classList.remove("hidden");
      return;
    }
    try {
      await apiRequest(`/api/complaints/${deadlineButton.dataset.deadlineId}/deadline`, {
        method: "PATCH",
        body: JSON.stringify({ extendedHours, reason: reason.trim() }),
      });
      await loadBackendReports();
    } catch (error) {
      $("#admin-error").textContent = error.message;
      $("#admin-error").classList.remove("hidden");
    }
    return;
  }
  const mergeButton = event.target.closest("[data-merge-duplicate]");
  if (mergeButton) {
    const ids = window.prompt("Enter source complaint IDs to merge, separated by commas:");
    if (!ids) return;
    const reason = window.prompt("Required reason for merging these complaints:");
    if (!reason?.trim()) {
      $("#admin-error").textContent = "A merge reason is required.";
      $("#admin-error").classList.remove("hidden");
      return;
    }
    try {
      await apiRequest(`/api/complaints/${mergeButton.dataset.mergeDuplicate}/merge`, {
        method: "PATCH",
        body: JSON.stringify({
          duplicateComplaintIds: ids.split(",").map((id) => id.trim()).filter(Boolean),
          reason: reason.trim(),
        }),
      });
      await loadBackendReports();
    } catch (error) {
      $("#admin-error").textContent = error.message;
      $("#admin-error").classList.remove("hidden");
    }
    return;
  }
  const button = event.target.closest("[data-verify-id]");
  if (!button) return;
  try {
    const data = await apiRequest("/api/departments");
    const choices = data.departments.map((department, index) => `${index + 1}. ${department.name} [${department.id}]`).join("\n");
    const selected = window.prompt(`Choose exact department IDs for this complaint.\nSeparate multiple IDs with commas.\n\n${choices}`);
    if (!selected) return;
    const departmentIds = selected.split(",").map((id) => id.trim()).filter(Boolean);
    await apiRequest(`/api/complaints/${button.dataset.verifyId}/verify`, {
      method: "PATCH",
      body: JSON.stringify({ departmentIds }),
    });
    await loadBackendReports();
  } catch (error) {
    $("#admin-error").textContent = error.message;
    $("#admin-error").classList.remove("hidden");
  }
});

document.addEventListener("click", (event) => {
  const thumb = event.target.closest("[data-evidence-photo]");
  if (thumb) {
    $("#evidence-modal-image").src = thumb.dataset.evidencePhoto;
    $("#evidence-modal").classList.remove("hidden");
  }
});
$("#evidence-close").addEventListener("click", () => $("#evidence-modal").classList.add("hidden"));
$("#evidence-modal").addEventListener("click", (event) => {
  if (event.target === $("#evidence-modal")) $("#evidence-modal").classList.add("hidden");
});

document.addEventListener("click", async (event) => {
  const feedbackButton = event.target.closest("[data-feedback-id]");
  if (feedbackButton) openFeedbackModal(feedbackButton.dataset.feedbackId);
  const reopenButton = event.target.closest("[data-reopen-id]");
  if (reopenButton) openReopenModal(reopenButton.dataset.reopenId);
  const continueButton = event.target.closest("[data-continue-duplicate]");
  if (continueButton) {
    duplicateContinueConfirmed = true;
    $("#duplicate-card").classList.add("hidden");
  }
  const supportButton = event.target.closest("[data-support-duplicate]");
  if (supportButton) {
    if (!authSession?.idToken) {
      openAuthModal(false);
      return;
    }
    try {
      const result = await apiRequest(`/api/complaints/${supportButton.dataset.supportDuplicate}/support`, { method: "POST", body: "{}" });
      supportButton.textContent = "Supported";
      supportButton.disabled = true;
      $("#toast").querySelector("strong").textContent = "Support recorded";
      $("#toast").querySelector("div span").textContent = `${result.supportCount} citizen${result.supportCount === 1 ? "" : "s"} now support this complaint.`;
      showToast();
    } catch (error) {
      $("#form-error").textContent = error.message;
      $("#form-error").classList.remove("hidden");
    }
  }
  const viewButton = event.target.closest("[data-view-duplicate]");
  if (viewButton) {
    try {
      const result = await fetch(`/api/public/complaints/${encodeURIComponent(viewButton.dataset.viewDuplicate)}`);
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || "Public complaint status is unavailable.");
      const complaint = data.complaint;
      $("#duplicate-detail-title").textContent = complaint.title;
      $("#duplicate-detail-content").innerHTML = `
        <dl class="duplicate-detail-list">
          <div><dt>Complaint ID</dt><dd>${escapeHtml(complaint.complaintId)}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(complaint.status)}</dd></div>
          <div><dt>Category</dt><dd>${escapeHtml(complaint.category)}</dd></div>
          <div><dt>Location</dt><dd>${escapeHtml(complaint.location || complaint.locationText)}</dd></div>
          <div><dt>Governance</dt><dd>${escapeHtml(complaint.governanceLevel)}</dd></div>
          <div><dt>Priority</dt><dd>${escapeHtml(complaint.priority)}</dd></div>
          <div><dt>Community support</dt><dd>${escapeHtml(complaint.supportCount)}</dd></div>
        </dl>`;
      $("#duplicate-detail-modal").classList.remove("hidden");
    } catch (error) {
      $("#form-error").textContent = error.message;
      $("#form-error").classList.remove("hidden");
    }
  }
});
$("#duplicate-detail-close").addEventListener("click", () => $("#duplicate-detail-modal").classList.add("hidden"));
$("#duplicate-detail-modal").addEventListener("click", (event) => {
  if (event.target === $("#duplicate-detail-modal")) $("#duplicate-detail-modal").classList.add("hidden");
});

document.querySelectorAll("#feedback-stars button").forEach((button) => {
  button.addEventListener("click", () => {
    const rating = Number(button.dataset.rating);
    $("#feedback-rating").value = String(rating);
    document.querySelectorAll("#feedback-stars button").forEach((star) => {
      star.classList.toggle("selected", Number(star.dataset.rating) <= rating);
    });
  });
});
$("#feedback-close").addEventListener("click", () => $("#feedback-modal").classList.add("hidden"));
$("#feedback-modal").addEventListener("click", (event) => {
  if (event.target === $("#feedback-modal")) $("#feedback-modal").classList.add("hidden");
});
$("#feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const rating = Number($("#feedback-rating").value);
  const resolvedRadio = document.querySelector('input[name="problem-resolved"]:checked');
  if (rating < 1 || rating > 5) {
    $("#feedback-error").textContent = "Please select a rating from 1 to 5.";
    $("#feedback-error").classList.remove("hidden");
    return;
  }
  if (!resolvedRadio) {
    $("#feedback-error").textContent = "Please confirm whether the problem was resolved.";
    $("#feedback-error").classList.remove("hidden");
    return;
  }
  $("#feedback-error").classList.add("hidden");
  try {
    await apiRequest(`/api/complaints/${$("#feedback-complaint-id").value}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        rating,
        problemResolved: resolvedRadio.value === "yes",
        comments: $("#feedback-comments").value.trim(),
      }),
    });
    $("#feedback-modal").classList.add("hidden");
    await loadBackendReports();
    showToast();
  } catch (error) {
    $("#feedback-error").textContent = error.message;
    $("#feedback-error").classList.remove("hidden");
  }
});

function openFeedbackModal(reportId) {
  const report = getReports().find((item) => (item.complaintId || item.id) === reportId);
  if (!report) return;
  $("#feedback-complaint-id").value = reportId;
  $("#feedback-complaint-title").textContent = report.title;
  $("#feedback-rating").value = "0";
  $("#feedback-comments").value = "";
  document.querySelectorAll("#feedback-stars button").forEach((button) => button.classList.remove("selected"));
  document.querySelectorAll('input[name="problem-resolved"]').forEach((radio) => { radio.checked = false; });
  $("#feedback-error").classList.add("hidden");
  $("#feedback-modal").classList.remove("hidden");
}

function openReopenModal(reportId) {
  const report = getReports().find((item) => (item.complaintId || item.id) === reportId);
  if (!report) return;
  $("#reopen-complaint-id").value = reportId;
  $("#reopen-complaint-title").textContent = report.title;
  $("#reopen-reason").value = "";
  $("#reopen-error").classList.add("hidden");
  $("#reopen-modal").classList.remove("hidden");
}

$("#reopen-close").addEventListener("click", () => $("#reopen-modal").classList.add("hidden"));
$("#reopen-modal").addEventListener("click", (event) => {
  if (event.target === $("#reopen-modal")) $("#reopen-modal").classList.add("hidden");
});
$("#reopen-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const reason = $("#reopen-reason").value.trim();
  if (!reason) {
    $("#reopen-error").textContent = "Please explain why this complaint should be reopened.";
    $("#reopen-error").classList.remove("hidden");
    return;
  }
  $("#reopen-error").classList.add("hidden");
  try {
    await apiRequest(`/api/complaints/${$("#reopen-complaint-id").value}/reopen`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    $("#reopen-modal").classList.add("hidden");
    await loadBackendReports();
    showToast();
  } catch (error) {
    $("#reopen-error").textContent = error.message;
    $("#reopen-error").classList.remove("hidden");
  }
});

$("#notification-button").addEventListener("click", async () => {
  const panel = $("#notification-panel");
  panel.classList.toggle("hidden");
  $("#notification-button").setAttribute("aria-expanded", String(!panel.classList.contains("hidden")));
  await loadNotifications();
});
$("#notification-close").addEventListener("click", () => {
  $("#notification-panel").classList.add("hidden");
  $("#notification-button").setAttribute("aria-expanded", "false");
});
["notification-filter", "notification-governance-filter", "notification-priority-filter"].forEach((id) => {
  $(`#${id}`).addEventListener("change", loadNotifications);
});
$("#mark-all-read").addEventListener("click", async () => {
  try {
    await apiRequest("/api/notifications/read-all", { method: "POST", body: "{}" });
    await loadNotifications();
  } catch (error) {
    $("#notification-page-list").innerHTML = `<div class="notification-empty">${escapeHtml(error.message)}</div>`;
  }
});
$("#save-notification-preferences").addEventListener("click", async () => {
  const preferences = {};
  ["statusUpdates", "assignmentUpdates", "progressUpdates", "deadlineReminders", "escalationAlerts", "emailEnabled", "pushEnabled"].forEach((key) => {
    preferences[key] = $(`#pref-${key}`).checked;
  });
  try {
    await apiRequest("/api/notifications/preferences", { method: "PATCH", body: JSON.stringify(preferences) });
    showToast();
  } catch (error) {
    $("#notification-page-list").insertAdjacentHTML("beforeend", `<div class="notification-empty">${escapeHtml(error.message)}</div>`);
  }
});
$("#notification-list").addEventListener("click", async (event) => {
  const item = event.target.closest("[data-notification-id]");
  if (!item) return;
  try {
    await apiRequest(`/api/notifications/${item.dataset.notificationId}/read`, { method: "PATCH", body: "{}" });
  } catch (error) {
    console.error(error.message);
  }
  item.classList.remove("unread");
  await loadNotifications();
  if (item.dataset.notificationComplaint) {
    $("#issue-search").value = item.dataset.notificationComplaint;
    setView("issues");
  }
});

function updateVoiceStatus(text, state) {
  $("#voice-status-text").textContent = text;
  $("#voice-recording-status").dataset.state = state || "idle";
}

function getVoiceRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  if (voiceRecognition) return voiceRecognition;
  voiceRecognition = new Recognition();
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = true;
  voiceRecognition.maxAlternatives = 1;

  voiceRecognition.onresult = (event) => {
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const phrase = event.results[index][0].transcript.trim();
      if (event.results[index].isFinal) {
        if (phrase) voiceFinalText = `${voiceFinalText} ${phrase}`.trim();
      } else {
        interimText += `${phrase} `;
      }
    }
    const liveText = `${voiceFinalText} ${interimText}`.trim();
    $("#voice-transcript-live").textContent = liveText || "Listening...";
    $("#voice-transcript").value = voiceFinalText + (interimText ? ` ${interimText}` : "");
    $("#voice-use-text").disabled = !liveText;
  };

  voiceRecognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Microphone permission was denied. Allow microphone access and try again.",
      "audio-capture": "No microphone was found or it could not be accessed.",
      "network": "Speech recognition could not reach its language service.",
      "no-speech": "No speech was detected. Please try again.",
      "language-not-supported": "The selected language is not supported in this browser.",
    };
    $("#voice-error").textContent = messages[event.error] || "Voice recognition stopped because of an unexpected error.";
    $("#voice-error").classList.remove("hidden");
    voiceRecording = false;
    voicePaused = false;
    $("#voice-start").disabled = false;
    $("#voice-stop").disabled = true;
    $("#voice-pause").disabled = true;
    $("#voice-resume").disabled = true;
    updateVoiceStatus("Ready to record", "idle");
  };

  voiceRecognition.onend = () => {
    if (voiceRecording && !voicePaused) {
      try { voiceRecognition.start(); } catch {}
    }
  };
  return voiceRecognition;
}

function setVoiceControls(recording, paused) {
  $("#voice-start").disabled = recording;
  $("#voice-stop").disabled = !recording;
  $("#voice-pause").disabled = !recording || paused;
  $("#voice-resume").disabled = !recording || !paused;
}

$("#voice-start").addEventListener("click", () => {
  $("#voice-error").classList.add("hidden");
  const recognition = getVoiceRecognition();
  if (!recognition) {
    $("#voice-error").textContent = "Live speech recognition is not supported in this browser. Use Chrome or Edge and enter the text manually.";
    $("#voice-error").classList.remove("hidden");
    updateVoiceStatus("Not supported", "error");
    return;
  }
  recognition.lang = $("#voice-language").value;
  voiceRecording = true;
  voicePaused = false;
  setVoiceControls(true, false);
  updateVoiceStatus("Recording in progress", "recording");
  try {
    recognition.start();
  } catch (error) {
    $("#voice-error").textContent = "Recording could not start. Check microphone permissions and try again.";
    $("#voice-error").classList.remove("hidden");
  }
});

$("#voice-stop").addEventListener("click", () => {
  if (!voiceRecognition) return;
  voiceRecording = false;
  voicePaused = false;
  voiceRecognition.stop();
  setVoiceControls(false, false);
  updateVoiceStatus("Recording stopped", "idle");
});

$("#voice-pause").addEventListener("click", () => {
  if (!voiceRecognition || !voiceRecording) return;
  voicePaused = true;
  voiceRecognition.stop();
  setVoiceControls(true, true);
  updateVoiceStatus("Recording paused", "paused");
});

$("#voice-resume").addEventListener("click", () => {
  if (!voiceRecognition || !voiceRecording) return;
  voicePaused = false;
  voiceRecognition.lang = $("#voice-language").value;
  setVoiceControls(true, false);
  updateVoiceStatus("Recording resumed", "recording");
  try { voiceRecognition.start(); } catch {}
});

$("#voice-language").addEventListener("change", () => {
  if (voiceRecording && voiceRecognition) {
    voiceRecognition.lang = $("#voice-language").value;
  }
});

$("#voice-clear").addEventListener("click", () => {
  if (voiceRecognition && voiceRecording) {
    voiceRecording = false;
    voicePaused = false;
    voiceRecognition.stop();
  }
  voiceFinalText = "";
  $("#voice-transcript-live").textContent = "Your spoken words will appear here.";
  $("#voice-transcript").value = "";
  $("#voice-use-text").disabled = true;
  $("#voice-error").classList.add("hidden");
  setVoiceControls(false, false);
  updateVoiceStatus("Recording cleared", "idle");
});

$("#voice-edit").addEventListener("click", () => {
  if ($("#voice-edit").dataset.editing === "true") {
    $("#voice-transcript-live").classList.toggle("hidden", false);
    $("#voice-transcript").classList.toggle("hidden", true);
    $("#voice-edit").textContent = "Edit Generated Text";
    $("#voice-edit").dataset.editing = "false";
    const editedText = $("#voice-transcript").value.trim();
    if (editedText) $("#voice-transcript-live").textContent = editedText;
    return;
  }
  const liveText = $("#voice-transcript").value.trim() || voiceFinalText.trim();
  $("#voice-transcript").value = liveText;
  $("#voice-transcript-live").classList.toggle("hidden", true);
  $("#voice-transcript").classList.toggle("hidden", false);
  $("#voice-edit").textContent = "Hide Text Editor";
  $("#voice-edit").dataset.editing = "true";
  $("#voice-transcript").focus();
});

$("#voice-transcript").addEventListener("input", () => {
  const text = $("#voice-transcript").value.trim();
  $("#voice-use-text").disabled = !text;
  voiceFinalText = text;
});

$("#voice-use-text").addEventListener("click", () => {
  const spokenText = $("#voice-transcript").value.trim();
  if (!spokenText) return;
  $("#issue-description").value = spokenText.slice(0, 1200);
  if (!$("#issue-title").value.trim()) {
    const words = spokenText.split(/\s+/).slice(0, 12).join(" ");
    $("#issue-title").value = words.slice(0, 90);
  }
  draftAnalysis = null;
  $("#analysis-card").classList.add("hidden");
  $("#form-error").classList.add("hidden");
  setBusy(false);
  $("#voice-status-text").textContent = "Text added to the complaint";
  $("#voice-recording-status").dataset.state = "complete";
});

form.addEventListener("input", () => {
  if (!draftAnalysis) return;
  draftAnalysis = null;
  duplicateContinueConfirmed = false;
  $("#analysis-card").classList.add("hidden");
  $("#form-error").classList.add("hidden");
  setBusy(false);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").classList.add("hidden");
  const title = $("#issue-title").value.trim();
  const description = $("#issue-description").value.trim();
  const location = $("#issue-location").value.trim();
  if (!title || !description || !location) {
    showError("Please fill in the title, description, and location.");
    return;
  }
  if (!draftAnalysis) {
    setBusy(true, "Looking into it...");
    try {
      const result = await classifyIssue(title, description, location, selectedImage);
      await showAnalysis(result);
      setBusy(false);
    } catch (error) {
      showError(error.message || "We couldn't analyze the report. Please try again.");
      setBusy(false);
    }
    return;
  }
  if (!$("#duplicate-card").classList.contains("hidden") && !duplicateContinueConfirmed) {
    showError("This may be an existing complaint. Support it or choose “Submit as a separate complaint” before continuing.");
    return;
  }
  try {
    await apiRequest("/api/complaints", {
      method: "POST",
      body: JSON.stringify({ title, description, location, coordinates: selectedCoordinates, image: selectedImage }),
    });
  } catch (error) {
    showError(error.message);
    setBusy(false);
    return;
  }
  closeModal();
  form.reset();
  selectedImage = "";
  draftAnalysis = null;
  selectedCoordinates = null;
  if (voiceRecognition && voiceRecording) {
    voiceRecording = false;
    voicePaused = false;
    try { voiceRecognition.stop(); } catch {}
  }
  voiceFinalText = "";
  $("#voice-transcript-live").textContent = "Your spoken words will appear here.";
  $("#voice-transcript-live").classList.remove("hidden");
  $("#voice-transcript").value = "";
  $("#voice-transcript").classList.add("hidden");
  $("#voice-use-text").disabled = true;
  setVoiceControls(false, false);
  if (problemMarker && problemMap) {
    problemMap.removeLayer(problemMarker);
    problemMarker = null;
  }
  $("#selected-latitude").textContent = "Not selected";
  $("#selected-longitude").textContent = "Not selected";
  $("#selected-address").textContent = "Search or select a point on the map";
  $("#location-search").value = "";
  $("#issue-location").dataset.locationPicked = "false";
  $("#location-status").classList.add("hidden");
  $("#location-capture-label").textContent = "Use my current location";
  $("#analysis-card").classList.add("hidden");
  $("#upload-preview").classList.add("hidden");
  $("#upload-caption").textContent = "or drag and drop here · JPG, PNG up to 5 MB";
  setBusy(false);
  await loadBackendReports();
  setView(activeView);
  showToast();
});

render();
loadBackendReports();
loadNotifications();
startNotificationStream();
window.setInterval(() => {
  if (!notificationEventSource) startNotificationStream();
  loadNotifications();
}, 30000);

renderDraftList();
updateConnectivityStatus();
syncSavedDrafts();
window.addEventListener("online", () => {
  updateConnectivityStatus();
  syncSavedDrafts();
  showToast();
});
window.addEventListener("offline", () => {
  updateConnectivityStatus();
  renderDraftList();
});
