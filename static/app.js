const $ = (selector) => document.querySelector(selector);
let config;
let liveGpsWatch;
let adminSearchTimer;
let routePreviewToken = 0;
let pendingApiRequests = 0;
let lastUserRequestsSnapshot = null;
let adminLoadToken = 0;
let activeRequestLocation;

const confirmationDialog = $("#confirmationDialog");
if (confirmationDialog && !confirmationDialog.querySelector('form[method="dialog"]')) {
  const confirmationCancel = $("#confirmationCancel");
  const confirmationAccept = $("#confirmationAccept");
  if (confirmationCancel) confirmationCancel.addEventListener("click", () => confirmationDialog.close("cancel"));
  if (confirmationAccept) confirmationAccept.addEventListener("click", () => confirmationDialog.close("confirm"));
}

function updateLoadingBar() {
  const loadingBar = $("#loadingBar");
  const loadingBarBottom = $("#loadingBarBottom");
  const loadingGear = $("#loadingGear");
  const isLoading = pendingApiRequests > 0;
  loadingBar.hidden = !isLoading;
  loadingBarBottom.hidden = !isLoading;
  loadingBar.setAttribute("aria-busy", String(isLoading));
  loadingBar.setAttribute("aria-valuenow", isLoading ? "50" : "0");
  loadingBar.setAttribute("aria-valuetext", isLoading ? "Processing request" : "Idle");
  loadingGear.hidden = !isLoading;
}

function notify(message, type = "success") {
  const stack = $("#notificationStack");
  const notification = document.createElement("div");
  notification.className = `notification${type === "error" ? " notification-error" : ""}`;
  notification.setAttribute("role", type === "error" ? "alert" : "status");

  const text = document.createElement("span");
  text.className = "notification-message";
  text.textContent = message;

  const dismiss = document.createElement("button");
  dismiss.className = "notification-dismiss";
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Dismiss notification");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => notification.remove());

  notification.append(text, dismiss);
  stack.append(notification);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  window.setTimeout(() => notification.remove(), 10000);
}

async function withButtonLoading(button, loadingText, action) {
  if (!button) return action();

  const row = button.closest("tr");
  const buttons = row ? Array.from(row.querySelectorAll("button")) : [button];
  const originalText = button.textContent;
  buttons.forEach((item) => { item.disabled = true; });
  button.textContent = loadingText;
  try {
    return await action();
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
    button.textContent = originalText;
  }
}

function highlightRequestRow(id) {
  const row = Array.from(document.querySelectorAll("[data-request-id]"))
    .find((item) => item.dataset.requestId === String(id));
  if (row) row.classList.add("request-row-updated");
}

function confirmAction(title, message, { confirmLabel = "Confirm", danger = false } = {}) {
  const confirmButton = $("#confirmationAccept");
  $("#confirmationTitle").textContent = title;
  $("#confirmationMessage").textContent = message;
  confirmButton.textContent = confirmLabel;
  confirmButton.classList.toggle("confirm-danger", danger);
  confirmationDialog.returnValue = "";

  return new Promise((resolve) => {
    confirmationDialog.addEventListener("close", () => resolve(confirmationDialog.returnValue === "confirm"), { once: true });
    confirmationDialog.showModal();
  });
}

async function api(url, options = {}) {
  pendingApiRequests += 1;
  updateLoadingBar();
  try {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Something went wrong");
    return data;
  } finally {
    pendingApiRequests = Math.max(0, pendingApiRequests - 1);
    updateLoadingBar();
  }
}

function showApp(user, animate = true) {
  const authView = $("#authView");
  const app = user.role === "admin" ? $("#adminApp") : $("#userApp");
  app.style.display = "block";
  if (animate) {
    authView.classList.add("leaving");
    app.classList.add("entering");
    window.setTimeout(() => {
      authView.classList.add("hidden");
      authView.setAttribute("aria-hidden", "true");
      app.classList.remove("entering");
    }, 340);
  } else {
    authView.classList.add("hidden");
    authView.setAttribute("aria-hidden", "true");
  }
  $(user.role === "admin" ? "#adminName" : "#userName").textContent = user.name;
  if (user.role === "admin") {
    loadAdmin().catch((error) => notify(`Admin requests could not be loaded: ${error.message}`, "error"));
    EcoRouteMap.initAdminMap(config.hubs, setHubCoordinates);
    renderHubList();
    loadInventorySummary().catch((error) => notify(`Inventory could not be loaded: ${error.message}`, "error"));
    loadAuditHistory().catch((error) => notify(`Audit history could not be loaded: ${error.message}`, "error"));
  } else {
    EcoRouteMap.initUserMap(config.hubs, setUserCoordinates);
    loadUser().catch((error) => notify(`Requests could not be loaded: ${error.message}`, "error"));
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[char]));
}

function renderRisk() {
  $("#riskGuide").innerHTML = Object.entries(config.categories)
    .sort(([, first], [, second]) => second.hazard - first.hazard)
    .map(([name, data]) =>
    `<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:11px 0"><span>${name}</span><strong>Level ${data.hazard}</strong></div>`
  ).join("");
}

function renderItems() {
  const data = config.categories[$("#category").value];
  $("#item").innerHTML = data.items.map((item) => `<option>${item}</option>`).join("");
}

function routeSummary(route) {
  if (!route) return "";
  const label = route.type === "pickup" ? "Pickup point" : "Shortest drop-off route";
  return `<div class="hint"><strong>${label}:</strong> ${escapeHtml(route.destination)} · ${route.distance} km</div><div class="hint">${route.path.map(escapeHtml).join(" → ")}</div>`;
}

function approvalGuidance(item) {
  if (item.status === "Pending") return '<div class="hint">Awaiting admin approval. Do not drop off this item yet.</div>';
  if (item.status === "Rejected") return '<div class="hint">This request was not approved. Please submit a new request if needed.</div>';
  if (item.status === "Completed") return `<div class="hint"><strong>Completed:</strong> ${item.method === "dropoff" ? "Drop-off confirmed by admin." : "Pickup confirmed by admin."}</div>`;
  if (item.method === "dropoff") return '<div class="hint"><strong>Approved:</strong> You may now take this item to the listed drop-off point.</div>';
  return '<div class="hint"><strong>Approved:</strong> Keep the item ready for collection.</div>';
}

function completionSummary(item) {
  return item.completed_at ? `<div class="hint">Confirmed ${escapeHtml(item.completed_at.replace("T", " "))}</div>` : "";
}

function lifecycleSummary(item) {
  const events = [["Submitted", item.created_at], ["Approved", item.approved_at], ["Rejected", item.rejected_at], ["Completed", item.completed_at]];
  return `<ol class="request-timeline" aria-label="Request timeline">${events.filter(([, timestamp]) => timestamp).map(([label, timestamp]) => {
    const parsedDate = new Date(timestamp);
    const formattedDate = Number.isNaN(parsedDate.getTime())
      ? timestamp.replace("T", " ")
      : parsedDate.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const rejected = label === "Rejected";
    return `<li class="timeline-event${rejected ? " timeline-rejected" : ""}"><span>${label}</span><time datetime="${escapeHtml(timestamp)}">${escapeHtml(formattedDate)}</time></li>`;
  }).join("")}</ol>`;
}

function requestMapContent(item) {
  const latitude = Number(item.latitude);
  const longitude = Number(item.longitude);
  if (item.latitude == null || item.longitude == null
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return '<span class="hint" title="No map location was saved for this request">No pinned location</span>';
  }
  const label = `${item.item} · ${item.name}`;
  return `<button class="view-map-button" type="button" data-request-map data-request-id="${escapeHtml(item.id)}" data-latitude="${latitude}" data-longitude="${longitude}" data-location-label="${escapeHtml(label)}" aria-label="View map for request ${escapeHtml(item.id)}" title="View location on map"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 18.5 3.8 21V5.5L9 3l6 2.5L20.2 3v15.5L15 21l-6-2.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 3v15.5M15 5.5V21" stroke="currentColor" stroke-width="1.7"/><path d="M12 8.2a2.1 2.1 0 0 0-2.1 2.1c0 1.5 2.1 3.8 2.1 3.8s2.1-2.3 2.1-3.8A2.1 2.1 0 0 0 12 8.2Z" fill="var(--leaf)" stroke="var(--white)" stroke-width=".8"/></svg></button>`;
}

function requestMapAction(item) {
  return `<td class="view-map-cell" data-label="Location">${requestMapContent(item)}</td>`;
}

function residentCell(item, admin) {
  if (!admin) return `<td data-label="Resident">${escapeHtml(item.name)}</td>`;
  return `<td data-label="Resident"><button class="resident-contact-button" type="button" data-resident-contact data-resident-name="${escapeHtml(item.name)}" data-phone="${escapeHtml(item.phone || "")}" aria-label="View contact information for ${escapeHtml(item.name)}">${escapeHtml(item.name)}</button></td>`;
}

function requestReference(item) {
  return item.request_number || `ER-${String(item.id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase()}`;
}

function adminActionButtons(item) {
  let actions = "";
  if (item.status === "Pending") actions += `<button type="button" class="action approve" onclick="updateRequest('${item.id}','approve',this)">Approve</button><button type="button" class="action reject" onclick="updateRequest('${item.id}','reject',this)">Reject</button>`;
  if (item.status === "Approved") actions += `<button type="button" class="action approve" onclick="updateRequest('${item.id}','complete',this)">Confirm ${item.method === "dropoff" ? "drop-off" : "pickup"}</button>`;
  return `${actions ? `<div class="request-action-group">${actions}</div>` : ""}<div class="request-action-delete"><button type="button" class="action reject" onclick="deleteRequest('${item.id}',this)">Delete</button></div>`;
}

function adminActions(item, admin) {
  if (!admin) return "";
  return `<td class="request-actions" data-label="Action">${adminActionButtons(item)}</td>`;
}

function requestTable(items, admin = false, emptyMessage = "No requests yet.", history = false) {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
  const statusIcon = {
    Pending: "&#8987;",
    Approved: "&#10003;",
    Rejected: "&#10007;",
    Completed: "&#10003;",
  };
  return `<table class="request-table${history ? " admin-history-table" : ""}"><thead><tr><th>Request</th><th>Resident</th><th>Item</th><th>Method</th><th>Risk</th><th>Score</th><th>Status</th><th>Location</th>${admin ? "<th>Action</th>" : ""}</tr></thead><tbody>${items.map((item) => {
    const reference = requestReference(item);
    const mobileMethod = item.method === "dropoff" ? "drop-off" : "pickup";
    const statusDetails = `${approvalGuidance(item)}${lifecycleSummary(item)}${routeSummary(item.route)}${item.queue_number ? `<div class="hint">Pickup queue #${item.queue_number}</div>` : ""}`;
    return `<tr data-request-id="${escapeHtml(item.id)}"><td data-label="Request">${escapeHtml(reference)}</td>${residentCell(item, admin)}<td data-label="Item">${escapeHtml(item.item)}<span class="request-mobile-method"> · ${mobileMethod}</span></td><td data-label="Method">${escapeHtml(item.method)}</td><td data-label="Risk"><strong>${item.hazard}/5</strong></td><td data-label="Score">${item.priority_score}</td><td class="request-status-cell" data-label="Status"><span class="status ${escapeHtml(item.status)}"><span aria-hidden="true">${statusIcon[item.status] || ""}</span>${escapeHtml(item.status)}</span>${statusDetails}</td>${requestMapAction(item)}${adminActions(item, admin)}<td class="request-details-toggle"><button type="button" class="request-details-toggle-button" data-request-details aria-expanded="false" aria-controls="request-details-${escapeHtml(item.id)}">Details</button></td></tr><tr class="request-details-row" id="request-details-${escapeHtml(item.id)}" data-details-row><td colspan="${admin ? "10" : "9"}"><div class="request-detail-summary"><div class="request-details-metrics"><div class="request-detail-field"><span class="request-detail-label">Risk</span><strong>${item.hazard}/5</strong></div><div class="request-detail-field"><span class="request-detail-label">Score</span><span>${item.priority_score}</span></div><div class="request-detail-field request-detail-location"><span class="request-detail-label">Location</span>${requestMapContent(item)}</div></div><div class="request-detail-status">${statusDetails}</div></div>${admin ? `<div class="request-details-actions">${adminActionButtons(item)}</div>` : ""}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function updateOverview(prefix, requests) {
  const openCount = requests.filter((item) => !["Completed", "Rejected"].includes(item.status)).length;
  const pendingCount = requests.filter((item) => item.status === "Pending").length;
  const completedCount = requests.filter((item) => item.status === "Completed").length;
  $(`#${prefix}OpenCount`).textContent = openCount;
  $(`#${prefix}PendingCount`).textContent = pendingCount;
  $(`#${prefix}CompletedCount`).textContent = completedCount;
}

if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const sectionId = entry.target.id;
      const nav = entry.target.closest(".dashboard").querySelector(".dashboard-section-nav");
      nav.querySelectorAll(".section-link").forEach((link) => {
        if (link.dataset.sectionLink === sectionId) {
          link.setAttribute("aria-current", "location");
        } else {
          link.removeAttribute("aria-current");
        }
      });
    });
  }, { rootMargin: "-130px 0px -65% 0px" });

  document.querySelectorAll("[data-dashboard-section]").forEach((section) => sectionObserver.observe(section));
}

async function loadUser() {
  const requests = await api("/api/my-requests");
  const snapshot = JSON.stringify(requests);
  if (snapshot === lastUserRequestsSnapshot) return;
  lastUserRequestsSnapshot = snapshot;
  updateOverview("user", requests);
  $("#userRequests").innerHTML = requestTable(requests.filter((item) => !["Completed", "Rejected"].includes(item.status)), false, "No active requests yet. Submit a request to see it here.");
  $("#userHistory").innerHTML = requestTable(requests.filter((item) => ["Completed", "Rejected"].includes(item.status)), false, "Completed or rejected requests will appear here.");
}

async function loadAdmin() {
  const loadToken = ++adminLoadToken;
  const search = $("#adminSearch").value;
  const params = new URLSearchParams({
    search,
    sort: $("#adminSort").value,
    status: $("#adminStatusFilter").value,
    method: $("#adminMethodFilter").value,
    hazard: $("#adminHazardFilter").value,
    from_date: $("#adminFromDate").value,
    to_date: $("#adminToDate").value,
  });
  const requests = await api(`/api/admin/requests?${params}`);
  if (loadToken !== adminLoadToken) return;
  const hasFilters = search || $("#adminStatusFilter").value || $("#adminMethodFilter").value
    || $("#adminHazardFilter").value || $("#adminFromDate").value || $("#adminToDate").value;
  if (!hasFilters) updateOverview("admin", requests);
  $("#adminFilterSummary").textContent = hasFilters
    ? `${requests.length} matching request${requests.length === 1 ? "" : "s"}`
    : `Showing all ${requests.length} request${requests.length === 1 ? "" : "s"}`;
  $("#adminRequests").innerHTML = requestTable(requests.filter((item) => !["Completed", "Rejected"].includes(item.status)), true, "No active requests match these filters.");
  $("#adminHistory").innerHTML = requestTable(requests.filter((item) => ["Completed", "Rejected"].includes(item.status)), true, "No history requests match these filters.", true);
}

async function loadInventorySummary() {
  const summary = await api("/api/admin/inventory-summary");
  $("#inventorySummary").innerHTML = `<p class="hint">${summary.total_items} completed items · ${summary.total_weight} kg total</p>${summary.categories.length ? `<table><thead><tr><th>Category</th><th>Items</th><th>Total weight</th><th>Hazard total</th></tr></thead><tbody>${summary.categories.map((category) => `<tr><td data-label="Category">${escapeHtml(category.category)}</td><td data-label="Items">${category.item_count}</td><td data-label="Total weight">${category.total_weight} kg</td><td data-label="Hazard total">${category.hazard_total}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No completed inventory yet.</p>'}`;
}

async function loadAuditHistory() {
  const entries = await api("/api/admin/audit");
  $("#auditHistory").innerHTML = entries.length ? `<table><thead><tr><th>Request</th><th>Action</th><th>Admin</th><th>Timestamp</th></tr></thead><tbody>${entries.map((entry) => `<tr><td data-label="Request">#${entry.request_id}</td><td data-label="Action">${escapeHtml(entry.action)}</td><td data-label="Admin">${escapeHtml(entry.admin)}</td><td data-label="Timestamp">${escapeHtml(entry.timestamp.replace("T", " "))}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No admin actions yet.</p>';
}

setInterval(() => {
  if ($("#userApp").style.display === "block") loadUser();
}, 5000);

function setHubCoordinates(latitude, longitude) {
  const changed = $("#hubLatitude").value !== latitude.toFixed(6)
    || $("#hubLongitude").value !== longitude.toFixed(6);
  $("#hubLatitude").value = latitude.toFixed(6);
  $("#hubLongitude").value = longitude.toFixed(6);
  if (changed) notify("Hub coordinates pinned. Add the hub to save this location.");
}

function setUserCoordinates(latitude, longitude, announce = true) {
  const changed = $("#latitude").value !== latitude.toFixed(6)
    || $("#longitude").value !== longitude.toFixed(6);
  $("#latitude").value = latitude.toFixed(6);
  $("#longitude").value = longitude.toFixed(6);
  $("#locationStatus").textContent = `Pinned location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  if (announce && changed) {
    const status = $("#locationStatus");
    status.classList.remove("location-status-updated");
    void status.offsetWidth;
    status.classList.add("location-status-updated");
    notify(`Location pinned at ${latitude.toFixed(4)}, ${longitude.toFixed(4)}.`);
  }
  updateLocationPreview(latitude, longitude);
}

async function updateLocationPreview(latitude, longitude) {
  const token = ++routePreviewToken;
  $("#locationDetails").textContent = "Calculating nearest hub and road route...";
  try {
    const preview = await api(`/api/route-preview?latitude=${latitude}&longitude=${longitude}`);
    if (token !== routePreviewToken) return;
    const duration = preview.duration == null ? "duration unavailable" : `${preview.duration} min`;
    $("#locationDetails").textContent = `Nearest hub: ${preview.destination} · ${preview.distance} km · ${duration} · ${preview.source}`;
  } catch (error) {
    if (token === routePreviewToken) $("#locationDetails").textContent = error.message;
  }
}

function renderHubList() {
  $("#hubList").innerHTML = config.hubs.map((hub) => `<div class="hub-row"><span>${escapeHtml(hub.name)}<small>${hub.latitude.toFixed(5)}, ${hub.longitude.toFixed(5)}</small></span><button class="action reject" onclick="removeHub('${escapeHtml(hub.name)}',this)">Remove</button></div>`).join("");
  const options = config.hubs.map((hub) => `<option value="${escapeHtml(hub.name)}">${escapeHtml(hub.name)}</option>`).join("");
  const previousStart = $("#routeStart").value;
  const previousEnd = $("#routeEnd").value;
  $("#routeStart").innerHTML = options;
  $("#routeEnd").innerHTML = options;
  if (config.hubs.some((hub) => hub.name === previousStart)) $("#routeStart").value = previousStart;
  if (config.hubs.some((hub) => hub.name === previousEnd)) $("#routeEnd").value = previousEnd;
}

async function authenticate(url, payload) {
  const form = url.endsWith("/login") ? $("#loginForm") : $("#signupForm");
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = url.endsWith("/login") ? "Logging in..." : "Creating account...";
  }
  form.setAttribute("aria-busy", "true");
  try {
    const data = await api(url, { method: "POST", body: JSON.stringify(payload) });
    if (data.status === "confirmation_required") {
      $("#authError").textContent = data.message;
      return;
    }
    showApp({ name: data.name || payload.name, role: data.role || "user" });
  } catch (error) {
    $("#authError").textContent = error.message;
  } finally {
    form.setAttribute("aria-busy", "false");
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = url.endsWith("/login") ? "Log in" : "Create account";
    }
  }
}

function activateAuthTab(tab, focus = false) {
  document.querySelectorAll(".tab").forEach((item) => {
    const active = item === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  });
  $("#loginForm").classList.toggle("hidden", tab.dataset.mode !== "login");
  $("#signupForm").classList.toggle("hidden", tab.dataset.mode !== "signup");
  $("#authError").textContent = "";
  if (focus) tab.focus();
}

document.querySelectorAll(".tab").forEach((tab, index, tabs) => {
  tab.addEventListener("click", () => activateAuthTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabItems = Array.from(document.querySelectorAll(".tab"));
    let nextIndex = tabItems.indexOf(tab);
    if (event.key === "ArrowLeft") nextIndex = (nextIndex - 1 + tabItems.length) % tabItems.length;
    if (event.key === "ArrowRight") nextIndex = (nextIndex + 1) % tabItems.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabItems.length - 1;
    activateAuthTab(tabItems[nextIndex], true);
  });
});

document.querySelectorAll("[data-password-toggle]").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const input = document.getElementById(toggle.dataset.passwordToggle);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    toggle.querySelector(".eye-open")?.classList.toggle("hidden", showing);
    toggle.querySelector(".eye-closed")?.classList.toggle("hidden", !showing);
    toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    toggle.setAttribute("aria-pressed", String(!showing));
  });
});

$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("/api/login", { email: $("#loginEmail").value, password: $("#loginPassword").value });
});

$("#signupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("/api/signup", { name: $("#signupName").value, email: $("#signupEmail").value, password: $("#signupPassword").value });
});

document.querySelectorAll(".logout").forEach((button) => button.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    window.location.reload();
  } catch (error) {
    notify(`Could not log out: ${error.message}`, "error");
  }
}));

$("#category").addEventListener("change", renderItems);
let gpsPinNotified = false;
$("#locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    $("#locationStatus").textContent = "This browser does not support GPS.";
    notify("This browser does not support GPS.", "error");
    return;
  }
  if (liveGpsWatch) navigator.geolocation.clearWatch(liveGpsWatch);
  gpsPinNotified = false;
  $("#locationStatus").textContent = "Tracking your live location...";
  liveGpsWatch = navigator.geolocation.watchPosition((position) => {
    setUserCoordinates(position.coords.latitude, position.coords.longitude, false);
    $("#locationStatus").textContent = `Live location: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`;
    if (!gpsPinNotified) {
      notify(`GPS location pinned at ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}. Live tracking is on.`);
      gpsPinNotified = true;
    }
  }, () => {
    $("#locationStatus").textContent = "Location permission was not granted.";
    notify("Location permission was not granted.", "error");
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
});

$("#centerLocation").addEventListener("click", () => {
  if (EcoRouteMap.centerUserMap()) return;
  navigator.geolocation.getCurrentPosition((position) => {
    setUserCoordinates(position.coords.latitude, position.coords.longitude);
  }, () => {
    $("#locationStatus").textContent = "Location permission was not granted.";
    notify("Location permission was not granted.", "error");
  }, { enableHighAccuracy: true });
});

$("#requestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("#latitude").value || !$("#longitude").value) {
    $("#requestError").textContent = "Click the map or use GPS to pin your location before submitting.";
    notify("Pin a location before submitting your request.", "error");
    return;
  }
  if (!await confirmAction(
    "Submit collection request?",
    `Submit a collection request for "${$("#item").value}"?`,
    { confirmLabel: "Submit request" },
  )) return;
  const submitButton = $("#requestSubmit");
  submitButton.disabled = true;
  submitButton.textContent = "Saving request...";
  event.target.setAttribute("aria-busy", "true");
  $("#requestConfirmation").textContent = "";
  const phone = $("#contactPhone").value.trim();
  const savePhoneDefault = $("#savePhoneDefault").checked;
  try {
    await api("/api/e-waste", { method: "POST", body: JSON.stringify({ category: $("#category").value, item: $("#item").value, method: $("#method").value, phone, save_phone_default: savePhoneDefault, latitude: $("#latitude").value, longitude: $("#longitude").value }) });
    event.target.reset();
    $("#contactPhone").value = savePhoneDefault ? phone : "";
    $("#savePhoneDefault").checked = savePhoneDefault;
    $("#locationStatus").textContent = "Location is required before submitting.";
    $("#latitude").value = "";
    $("#longitude").value = "";
    $("#requestError").textContent = "";
    $("#requestConfirmation").textContent = "Request submitted. It is now waiting for admin approval.";
    EcoRouteMap.clearUserPin();
    notify("Collection request submitted. It is waiting for admin approval.");
    loadUser();
  } catch (error) {
    $("#requestError").textContent = error.message;
    notify(`Request could not be submitted: ${error.message}`, "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Submit request";
    event.target.setAttribute("aria-busy", "false");
  }
});

$("#refreshUser").addEventListener("click", (event) => {
  withButtonLoading(event.currentTarget, "Refreshing...", loadUser)
    .catch((error) => notify(`Requests could not be refreshed: ${error.message}`, "error"));
});

$("#closeRequestMap").addEventListener("click", () => $("#requestMapDialog").close());
$("#recenterRequestMap").addEventListener("click", () => {
  if (!activeRequestLocation) return;
  EcoRouteMap.showRequestLocation(
    activeRequestLocation.latitude,
    activeRequestLocation.longitude,
    activeRequestLocation.label,
    config.hubs,
  );
});
$("#closeRequestContact").addEventListener("click", () => $("#requestContactDialog").close());
["#userRequests", "#userHistory", "#adminRequests", "#adminHistory"].forEach((selector) => {
  $(selector).addEventListener("click", (event) => {
    const detailsButton = event.target.closest("[data-request-details]");
    if (detailsButton) {
      const row = detailsButton.closest("tr");
      const detailsRow = row.nextElementSibling?.matches("[data-details-row]")
        ? row.nextElementSibling
        : null;
      if (detailsRow) {
        const open = detailsRow.classList.toggle("is-open");
        row.classList.toggle("has-expanded-details", open);
        detailsButton.setAttribute("aria-expanded", String(open));
        detailsButton.textContent = open ? "Hide" : "Details";
      }
      return;
    }

    const mapButton = event.target.closest("[data-request-map]");
    if (mapButton) {
      const latitude = Number(mapButton.dataset.latitude);
      const longitude = Number(mapButton.dataset.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        notify("This request does not have a valid map location.", "error");
        return;
      }
      activeRequestLocation = {
        latitude,
        longitude,
        label: mapButton.dataset.locationLabel,
      };
      const requestRow = mapButton.closest("[data-request-id]");
      const visibleReference = requestRow?.querySelector('[data-label="Request"]')?.textContent.trim();
      $("#requestMapTitle").textContent = visibleReference ? `Request ${visibleReference}` : "Request location";
      $("#requestMapDescription").textContent = `${mapButton.dataset.locationLabel} · ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      $("#requestMapDialog").showModal();
      window.requestAnimationFrame(() => EcoRouteMap.showRequestLocation(latitude, longitude, activeRequestLocation.label, config.hubs));
      return;
    }

    const contactButton = event.target.closest("[data-resident-contact]");
    if (!contactButton) return;
    const phone = contactButton.dataset.phone;
    const phoneLink = $("#contactCallLink");
    $("#requestContactTitle").textContent = contactButton.dataset.residentName;
    $("#requestContactMessage").textContent = phone
      ? `Contact number: ${phone}`
      : "No contact number was provided for this request.";
    const dialableNumber = phone.replace(/[^0-9+]/g, "");
    const validPhone = /^\+?[0-9]{7,15}$/.test(dialableNumber);
    phoneLink.hidden = !validPhone;
    if (validPhone) {
      phoneLink.href = `tel:${dialableNumber}`;
      phoneLink.textContent = `Call ${contactButton.dataset.residentName}`;
    }
    $("#requestContactDialog").showModal();
  });
});

$("#refreshAdmin").addEventListener("click", (event) => {
  withButtonLoading(event.currentTarget, "Refreshing...", loadAdmin)
    .catch((error) => notify(`Queue could not be refreshed: ${error.message}`, "error"));
});
if ($("#refreshQueue")) {
  $("#refreshQueue").addEventListener("click", (event) => {
    withButtonLoading(event.currentTarget, "Refreshing...", loadAdmin)
      .catch((error) => notify(`Queue could not be refreshed: ${error.message}`, "error"));
  });
}
function refreshAdminResults() {
  loadAdmin().catch((error) => notify(`Requests could not be filtered: ${error.message}`, "error"));
}
$("#adminSearch").addEventListener("input", () => {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(refreshAdminResults, 250);
});
["#adminSort", "#adminStatusFilter", "#adminMethodFilter", "#adminHazardFilter", "#adminFromDate", "#adminToDate"].forEach((selector) => {
  $(selector).addEventListener("change", refreshAdminResults);
});
$("#clearAdminSearch").addEventListener("click", () => {
  $("#adminSearch").value = "";
  $("#adminSort").value = "risk";
  $("#adminStatusFilter").value = "";
  $("#adminMethodFilter").value = "";
  $("#adminHazardFilter").value = "";
  $("#adminFromDate").value = "";
  $("#adminToDate").value = "";
  refreshAdminResults();
});
$("#adminLocate").addEventListener("click", () => navigator.geolocation.getCurrentPosition((position) => {
  EcoRouteMap.setAdminPin(position.coords.latitude, position.coords.longitude, setHubCoordinates);
}, () => {
  $("#hubError").textContent = "Location permission was not granted.";
  notify("Location permission was not granted.", "error");
}, { enableHighAccuracy: true }));
$("#routePlanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = $("#routePlanResult");
  result.textContent = "Comparing routes...";
  await withButtonLoading($("#routePlanForm button[type=submit]"), "Comparing...", async () => {
    try {
      const params = new URLSearchParams({ start: $("#routeStart").value, end: $("#routeEnd").value });
      const comparison = await api(`/api/admin/hub-route?${params}`);
      const formatRoute = (label, route) => route.path.length
        ? `<div><strong>${label}:</strong> ${route.distance} km · ${route.path.map(escapeHtml).join(" → ")}</div>`
        : `<div><strong>${label}:</strong> No route found</div>`;
      result.innerHTML = `${formatRoute("Greedy (Dijkstra)", comparison.greedy)}${formatRoute("Exhaustive Search", comparison.exhaustive)}${formatRoute("Divide and Conquer", comparison.divide_and_conquer)}`;
    } catch (error) {
      result.textContent = error.message;
    }
  });
});
$("#hubForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const hubName = $("#hubName").value.trim();
  if (!await confirmAction(
    "Add drop-off location?",
    `Add "${hubName}" as a drop-off location?`,
    { confirmLabel: "Add location" },
  )) return;
  event.target.setAttribute("aria-busy", "true");
  await withButtonLoading($("#hubForm button[type=submit]"), "Adding location...", async () => {
    try {
      await api("/api/admin/hubs", { method: "POST", body: JSON.stringify({ name: $("#hubName").value, latitude: $("#hubLatitude").value, longitude: $("#hubLongitude").value }) });
      config = await api("/api/config");
      event.target.reset();
      $("#hubError").textContent = "";
      EcoRouteMap.initAdminMap(config.hubs, setHubCoordinates);
      renderHubList();
      notify(`Hub "${hubName}" added.`);
    } catch (error) {
      $("#hubError").textContent = error.message;
      notify(`Hub could not be added: ${error.message}`, "error");
    }
  });
  event.target.setAttribute("aria-busy", "false");
});

window.updateRequest = async (id, action, button) => {
  const confirmation = {
    approve: { title: "Approve request?", message: "This will approve the collection request.", confirmLabel: "Approve request" },
    reject: { title: "Reject request?", message: "This will reject the collection request.", confirmLabel: "Reject request", danger: true },
  }[action];
  if (confirmation && !await confirmAction(confirmation.title, confirmation.message, confirmation)) return;
  await withButtonLoading(button, "Saving...", async () => {
    try {
      await api(`/api/admin/requests/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      const messages = {
        approve: "Request approved.",
        reject: "Request rejected.",
        complete: "Request marked as completed.",
      };
      notify(messages[action] || "Request updated.");
      loadAdmin().then(() => highlightRequestRow(id))
        .catch((error) => notify(`Request updated, but the queue could not refresh: ${error.message}`, "error"));
      loadInventorySummary().catch((error) => notify(`Request updated, but inventory could not refresh: ${error.message}`, "error"));
      loadAuditHistory().catch((error) => notify(`Request updated, but audit history could not refresh: ${error.message}`, "error"));
    } catch (error) {
      notify(`Request could not be updated: ${error.message}`, "error");
    }
  });
};

window.deleteRequest = async (id, button) => {
  if (!await confirmAction(
    "Delete request?",
    "This permanently deletes the request from the system and history.",
    { confirmLabel: "Delete request", danger: true },
  )) return;
  await withButtonLoading(button, "Deleting...", async () => {
    try {
      await api(`/api/admin/requests/${id}`, { method: "DELETE" });
      notify("Request deleted.");
      loadAdmin().catch((error) => notify(`Request deleted, but the queue could not refresh: ${error.message}`, "error"));
      loadInventorySummary().catch((error) => notify(`Request deleted, but inventory could not refresh: ${error.message}`, "error"));
      loadAuditHistory().catch((error) => notify(`Request deleted, but audit history could not refresh: ${error.message}`, "error"));
    } catch (error) {
      notify(`Request could not be deleted: ${error.message}`, "error");
    }
  });
};

window.removeHub = async (name, button) => {
  if (!await confirmAction(
    "Remove drop-off location?",
    `Remove "${name}" from drop-off locations?`,
    { confirmLabel: "Remove location", danger: true },
  )) return;
  await withButtonLoading(button, "Removing...", async () => {
    try {
      await api(`/api/admin/hubs/${encodeURIComponent(name)}`, { method: "DELETE" });
      config = await api("/api/config");
      EcoRouteMap.initAdminMap(config.hubs, setHubCoordinates);
      renderHubList();
      notify(`Hub "${name}" removed.`);
    } catch (error) {
      $("#hubError").textContent = error.message;
      notify(`Hub could not be removed: ${error.message}`, "error");
    }
  });
};

(async () => {
  try {
    config = await api("/api/config");
    if (config.user && config.user.role === "user") {
      $("#contactPhone").value = config.user.phone || "";
    }
    if (config.user) showApp(config.user, false);
    else $("#authView").style.display = "grid";
    $("#category").innerHTML = Object.keys(config.categories).map((category) => `<option>${category}</option>`).join("");
    renderItems();
    renderRisk();
  } catch (error) {
    $("#authError").textContent = error.message;
  }
})();
