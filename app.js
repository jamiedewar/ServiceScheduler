const STORAGE_KEY = "legend-service-scheduler-v1";
const AUTH_STORAGE_KEY = "legend-service-scheduler-session";
const MS_DAY = 86400000;
let session = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");

function apiHeaders({ json = true } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
  } else {
    headers["X-User"] = "dispatcher";
    headers["X-Role"] = "dispatcher";
  }
  return headers;
}

const skills = [
  "Mechanical", "Rigging", "Electronics", "PDI", "Fiberglass", "Upholstery",
  "Detailing", "Trailer", "Warranty", "Diagnostics", "Canvas", "Quality"
];
let lastSnapshot = null;
let redoSnapshot = null;
let backendOnline = false;
let isHydrating = false;
let saveTimer = null;
let syncTimer = null;
let eventSource = null;
let remoteVersion = null;
let operationalReadiness = null;
let durableAuditEvents = null;

const demoUsers = {
  dispatcher: { id: "dispatcher", name: "Demo Dispatcher", role: "dispatcher" },
  manager: { id: "manager", name: "Demo Manager", role: "manager" },
  technician: { id: "technician", name: "Demo Technician", role: "technician" },
  admin: { id: "admin", name: "Demo Admin", role: "admin" }
};

function defaultSavedViews() {
  const base = { team: "", skill: "", status: "", parts: "", due: "", text: "" };
  return [
    { name: "Service", filters: { ...base, team: "Service" }, boardMode: "day" },
    { name: "Production", filters: { ...base }, boardMode: "week" },
    { name: "Rigging", filters: { ...base, team: "Rigging" }, boardMode: "week" },
    { name: "PDI", filters: { ...base, skill: "PDI" }, boardMode: "day" },
    { name: "Warranty", filters: { ...base, skill: "Warranty" }, boardMode: "day" },
    { name: "Detail", filters: { ...base, team: "Detail" }, boardMode: "day" },
    { name: "Yard", filters: { ...base, team: "Yard" }, boardMode: "week" }
  ];
}

function mergeDefaultSavedViews(savedViews = []) {
  const existing = new Set(savedViews.map(view => String(view.name || "").toLowerCase()));
  return [
    ...savedViews,
    ...defaultSavedViews().filter(view => !existing.has(view.name.toLowerCase()))
  ];
}

const seed = () => {
  const today = startOfDay(new Date());
  const date = (offset) => fmtDate(new Date(today.getTime() + offset * MS_DAY));
  return {
    selectedOrderId: null,
    activeOrderId: null,
    schedulerMode: "balanced",
    filters: { team: "", skill: "", status: "", parts: "", due: "", text: "" },
    savedViews: defaultSavedViews(),
    auditLog: [],
    errorLog: [],
    aiPlan: null,
    scenarioDiff: null,
    boardMode: "day",
    boardDate: date(0),
    recommendations: [],
    bays: ["Service Bay 1", "Service Bay 2", "Rigging Bay", "Electronics Bench", "PDI Lane", "Fiberglass Booth", "Detail Bay", "Yard / Trailer"],
    bayAvailability: {},
    workTypes: [
      type("Rigging Install", 4, ["Rigging", "Mechanical"], "Install/verify engine rigging, controls, and battery connections."),
      type("Mechanical Inspection", 2.5, ["Mechanical", "Diagnostics"], "Inspect propulsion, steering, fuel, and cooling systems."),
      type("Warranty Repair", 3, ["Warranty", "Diagnostics"], "Confirm complaint, document cause, complete repair notes."),
      type("Electronics Install", 3.5, ["Electronics", "Rigging"], "Install electronics, verify network/power, update labels."),
      type("Wash & Detail", 2, ["Detailing"], "Final wash, interior wipe-down, glass, vinyl, and delivery presentation."),
      type("Trailer Prep", 2, ["Trailer", "Quality"], "Inspect bunks, lights, tires, winch, brakes, and torque."),
      type("PDI", 3, ["PDI", "Quality"], "Delivery checklist, water test prep, documentation, and signoff."),
      type("Fiberglass Touch-Up", 4, ["Fiberglass"], "Gelcoat repair, sand, polish, and QA inspection."),
      type("Upholstery Repair", 2.5, ["Upholstery"], "Seat/vinyl repair, fasteners, trim, and fit check.")
    ],
    technicians: [
      tech("Marc L.", "Lead Mechanic", ["Mechanical", "Diagnostics", "Warranty", "Quality"], "08:00", "16:30", 100, "Service", ["Master Tech", "Warranty Authorization"]),
      tech("Alex R.", "Rigging Technician", ["Rigging", "Mechanical", "Trailer"], "07:30", "16:00", 100, "Rigging", ["Engine Rigging"]),
      tech("Sophie M.", "Electronics Specialist", ["Electronics", "Rigging", "Diagnostics"], "08:00", "16:30", 90, "Electronics", ["Marine Electronics", "NMEA"]),
      tech("Ben C.", "PDI Technician", ["PDI", "Quality", "Detailing"], "08:00", "16:30", 100, "Delivery", ["PDI Signoff"]),
      tech("Nate P.", "Fiberglass Technician", ["Fiberglass", "Quality"], "07:00", "15:30", 85, "Fiberglass", ["Gelcoat Repair"]),
      tech("Sam D.", "Detail Lead", ["Detailing", "Canvas", "Upholstery"], "08:30", "17:00", 100, "Detail", ["Canvas Fit"]),
      tech("Chris B.", "Trailer Technician", ["Trailer", "Mechanical", "Quality"], "08:00", "16:30", 100, "Yard", ["Trailer Brake"]),
      tech("Julie T.", "Service Generalist", ["Warranty", "PDI", "Mechanical", "Detailing"], "09:00", "17:30", 95, "Service", ["Warranty Intake", "PDI Signoff"])
    ],
    absences: [{ techId: "", date: date(1), reason: "Training placeholder" }],
    orders: [
      order("WO-1001", "Prepare 2026 20 XTR for Friday delivery", "Sarah Whitfield / 20 XTR", "PDI", "Critical", date(1), "Customer delivery is Friday afternoon.", "Need clean delivery handoff."),
      order("WO-1002", "Install Garmin package", "North Bay Marine / 18 ProSport", "Electronics Install", "High", date(2), "Install display, transducer, and NMEA backbone.", ""),
      order("WO-1003", "Outboard rigging correction", "Stock Unit LB-4471", "Rigging Install", "High", date(1), "Throttle cable binding at full trim.", ""),
      order("WO-1004", "Warranty bilge pump diagnosis", "Vetta customer / 23 Q-Series", "Warranty Repair", "Critical", date(0), "Customer reports intermittent pump operation.", "Flag customer experience risk."),
      order("WO-1005", "Trailer brake inspection", "Dealer transfer / Trailer T-882", "Trailer Prep", "Medium", date(3), "Inspect surge brakes and replace actuator if needed.", ""),
      order("WO-1006", "Final wash for showroom unit", "Showroom / 16 Widebody", "Wash & Detail", "Low", date(4), "Photo-ready cleanup.", ""),
      order("WO-1007", "Gelcoat chip repair", "Customer Smith / 19 Xcalibur", "Fiberglass Touch-Up", "Medium", date(5), "Bow rub rail area chip.", "Cure time may push polish to next day."),
      order("WO-1008", "Seat base vinyl repair", "Customer Lee / 21 Splash", "Upholstery Repair", "Medium", date(5), "Small tear near rear bench seam.", ""),
      order("WO-1009", "Water test prep and inspection", "Dealer demo / 20 XTR", "Mechanical Inspection", "High", date(2), "Engine hours low; verify cooling and charging.", ""),
      order("WO-1010", "Install trolling motor harness", "Customer Elliot / 18 Angler", "Electronics Install", "High", date(2), "Add 36V harness and breaker.", "Parts staged in bay 3."),
      order("WO-1011", "PDI and paperwork check", "Stock Unit LB-4490", "PDI", "Medium", date(3), "Delivery checklist before dealer pickup.", ""),
      order("WO-1012", "Replace trailer lights", "Customer Patel / Trailer T-901", "Trailer Prep", "Medium", date(1), "Left rear light intermittent.", ""),
      order("WO-1013", "Canvas snap adjustment", "Customer Nguyen / 22 Lounge", "Upholstery Repair", "Low", date(6), "Canvas tight near port bow.", ""),
      order("WO-1014", "Prop vibration diagnosis", "Customer O'Brien / 20 XTR", "Mechanical Inspection", "Critical", date(0), "Vibration over 3800 RPM.", "May need water test slot."),
      order("WO-1015", "Dealer warranty photos and repair", "Dealer Sudbury / 17 Flex", "Warranty Repair", "High", date(3), "Document rub rail separation and repair.", ""),
      order("WO-1016", "Rig kicker bracket", "Customer Tremblay / 18 ProSport", "Rigging Install", "Medium", date(4), "Install kicker bracket and fuel line.", ""),
      order("WO-1017", "Full detail after service", "Customer Mason / 21 Splash", "Wash & Detail", "Medium", date(2), "Clean after warranty service.", ""),
      order("WO-1018", "Quality hold investigation", "Stock Unit LB-4502", "PDI", "High", date(1), "QA flagged steering alignment.", ""),
      order("WO-1019", "Fiberglass polish follow-up", "Customer Roy / 19 Xcalibur", "Fiberglass Touch-Up", "Low", date(7), "Final polish after repair cure.", ""),
      order("WO-1020", "Battery drain diagnostics", "Customer Greene / 22 Q-Series", "Warranty Repair", "Critical", date(1), "Battery dead after 48 hours.", "Electrical diagnostic likely.")
    ]
  };
};

let state = load();

function type(name, duration, reqSkills, notes) {
  return { id: uid("type"), name, duration, skills: reqSkills, notes, actualSamples: [], learnedDuration: duration };
}
function tech(name, role, techSkills, start, end, capacity, area, certifications = []) {
  return { id: uid("tech"), name, role, skills: techSkills, certifications, start, end, capacity, area, active: true };
}
function order(id, title, boat, workType, priority, due, description, notes) {
  const wt = seedWorkTypeByName(workType);
  const customerUrgency = notes?.toLowerCase().includes("vetta") || description?.toLowerCase().includes("delivery") ? "Escalated" : "Normal";
  const party = inferCustomerDealer(boat);
  return {
    id, title, customer: party.customer, dealer: party.dealer, boat, description, workType, priority, customerUrgency, dueDate: due, earliestStartDate: "",
    duration: wt?.duration || 2, skills: wt?.skills || [], status: "Unscheduled",
    techId: "", scheduledDate: "", start: "", notes,
    parts: partsForWorkType(workType, id),
    bay: bayForWorkType(workType),
    operations: operationsForWorkType(workType),
    checklist: checklistForWorkType(workType),
    dependencies: dependencyHint(workType),
    actualHours: 0,
    timeEntries: [],
    rework: false,
    qualityHold: false,
    continuityTechId: "",
    unitHistory: [`${id} created for ${boat}`],
    attachments: []
  };
}
function seedWorkTypeByName(name) {
  const types = [
    ["Rigging Install", 4, ["Rigging", "Mechanical"]], ["Mechanical Inspection", 2.5, ["Mechanical", "Diagnostics"]],
    ["Warranty Repair", 3, ["Warranty", "Diagnostics"]], ["Electronics Install", 3.5, ["Electronics", "Rigging"]],
    ["Wash & Detail", 2, ["Detailing"]], ["Trailer Prep", 2, ["Trailer", "Quality"]],
    ["PDI", 3, ["PDI", "Quality"]], ["Fiberglass Touch-Up", 4, ["Fiberglass"]], ["Upholstery Repair", 2.5, ["Upholstery"]]
  ];
  const row = types.find(t => t[0] === name);
  return row ? { duration: row[1], skills: row[2] } : null;
}
function bayForWorkType(name) {
  return {
    "Rigging Install": "Rigging Bay",
    "Mechanical Inspection": "Service Bay 1",
    "Warranty Repair": "Service Bay 2",
    "Electronics Install": "Electronics Bench",
    "Wash & Detail": "Detail Bay",
    "Trailer Prep": "Yard / Trailer",
    "PDI": "PDI Lane",
    "Fiberglass Touch-Up": "Fiberglass Booth",
    "Upholstery Repair": "Detail Bay"
  }[name] || "Service Bay 1";
}
function partsForWorkType(workType, id) {
  if (["WO-1010", "WO-1016"].includes(id)) return "Staged";
  if (["WO-1005", "WO-1015"].includes(id)) return "Waiting on Parts";
  if (workType === "Wash & Detail" || workType === "PDI") return "Ready";
  return "Ready";
}
function operationsForWorkType(workType) {
  const map = {
    "Rigging Install": ["Stage hardware", "Install rigging", "Control/cable check", "QA signoff"],
    "Mechanical Inspection": ["Visual inspection", "Diagnostics", "Mechanical correction", "Test run"],
    "Warranty Repair": ["Confirm complaint", "Document cause", "Complete repair", "Warranty notes"],
    "Electronics Install": ["Mount hardware", "Wire power/network", "Configure device", "Function test"],
    "Wash & Detail": ["Exterior wash", "Interior detail", "Vinyl/glass", "Final presentation"],
    "Trailer Prep": ["Lights", "Brakes/tires", "Bunks/winch", "Torque/signoff"],
    "PDI": ["Checklist", "Systems test", "Documentation", "Delivery signoff"],
    "Fiberglass Touch-Up": ["Prep", "Repair", "Cure", "Sand/polish"],
    "Upholstery Repair": ["Remove/inspect", "Repair", "Reinstall", "Fit check"]
  };
  return (map[workType] || ["Inspect", "Perform work", "Quality check"]).map((name, index) => ({ id: uid("op"), name, done: false, sequence: index + 1 }));
}
function checklistForWorkType(workType) {
  return operationsForWorkType(workType).map(op => ({ id: uid("check"), text: op.name, done: false }));
}
function dependencyHint(workType) {
  if (workType === "PDI") return "Rigging and major repairs complete";
  if (workType === "Wash & Detail") return "All service work complete";
  if (workType === "Fiberglass Touch-Up") return "Repair cure time before polish";
  return "";
}

function inferCustomerDealer(reference = "") {
  const value = String(reference || "");
  const [prefix] = value.split("/");
  const owner = (prefix || "").trim();
  if (/^dealer\b/i.test(owner)) return { customer: "", dealer: owner.replace(/^dealer\s*/i, "").trim() || owner };
  if (/^customer\b/i.test(owner)) return { customer: owner.replace(/^customer\s*/i, "").trim() || owner, dealer: "" };
  if (/^vetta customer\b/i.test(owner)) return { customer: owner, dealer: "" };
  if (/^stock\b/i.test(owner)) return { customer: owner, dealer: "" };
  return { customer: owner, dealer: "" };
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return normalizeState(seed());
  try { return normalizeState(JSON.parse(raw)); } catch { return normalizeState(seed()); }
}
function normalizeState(data) {
  data.bays ||= ["Service Bay 1", "Service Bay 2", "Rigging Bay", "Electronics Bench", "PDI Lane", "Fiberglass Booth", "Detail Bay", "Yard / Trailer"];
  data.bayAvailability ||= {};
  data.bays.forEach(bay => { data.bayAvailability[bay] = normalizeBayAvailability(data.bayAvailability[bay]); });
  Object.keys(data.bayAvailability).forEach(bay => { if (!data.bays.includes(bay)) delete data.bayAvailability[bay]; });
  data.filters = { team: "", skill: "", status: "", parts: "", due: "", text: "", ...(data.filters || {}) };
  data.savedViews = mergeDefaultSavedViews(data.savedViews || []);
  data.auditLog ||= [];
  data.errorLog ||= [];
  data.aiPlan ||= null;
  data.scenarioDiff ||= null;
  data.schedulerMode ||= "balanced";
  data.absences ||= [];
  data.technicians = (data.technicians || []).map(t => ({ certifications: [], active: true, ...t }));
  data.userTechnicianLinks ||= {};
  if (!data.userTechnicianLinks.technician && data.technicians.find(t => t.active)) {
    data.userTechnicianLinks.technician = data.technicians.find(t => t.active).id;
  }
  data.workTypes = (data.workTypes || []).map(t => ({ actualSamples: [], learnedDuration: t.duration, ...t }));
  data.orders = (data.orders || []).map(o => ({
    id: uid("wo"),
    title: "Untitled work order",
    customer: inferCustomerDealer(o.boat).customer,
    dealer: inferCustomerDealer(o.boat).dealer,
    boat: "",
    description: "",
    workType: "Warranty Repair",
    priority: "Medium",
    customerUrgency: "Normal",
    dueDate: data.boardDate || fmtDate(new Date()),
    earliestStartDate: "",
    duration: 2,
    durationLocked: false,
    skills: [],
    status: "Unscheduled",
    techId: "",
    scheduledDate: "",
    start: "",
    segments: [],
    notes: "",
    parts: "Ready",
    bay: bayForWorkType(o.workType),
    operations: operationsForWorkType(o.workType),
    checklist: checklistForWorkType(o.workType),
    dependencies: dependencyHint(o.workType),
    actualHours: 0,
    timeEntries: [],
    rework: false,
    qualityHold: false,
    preferredTechId: "",
    continuityTechId: "",
    requiredCertifications: [],
    unitHistory: [],
    attachments: [],
    ...o
  }));
  return data;
}

function normalizeBayAvailability(value = {}) {
  const outages = Array.isArray(value.outages)
    ? value.outages.map(item => typeof item === "string" ? { date: item, reason: "" } : item).filter(item => item?.date)
    : [];
  return {
    start: value.start || "08:00",
    end: value.end || "17:00",
    outages
  };
}

function bayAvailabilityFor(bay) {
  state.bayAvailability ||= {};
  state.bayAvailability[bay] = normalizeBayAvailability(state.bayAvailability[bay]);
  return state.bayAvailability[bay];
}
function canUseBackend() {
  return typeof fetch === "function" && typeof location !== "undefined" && location.protocol !== "file:";
}

async function loadRemoteState() {
  if (!canUseBackend()) return;
  isHydrating = true;
  try {
    const response = await fetch("/api/state", { headers: apiHeaders() });
    if (!response.ok) throw new Error(`API state load failed: ${response.status}`);
    const remote = normalizeState(await response.json());
    backendOnline = true;
    if (remote.orders.length || remote.workTypes.length || remote.technicians.length) {
      state = remote;
      remoteVersion = remote._meta?.version || remoteVersion;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      await saveRemoteState("state.seed_from_browser");
    }
  } catch (error) {
    backendOnline = false;
    console.warn("Backend unavailable; using localStorage state.", error);
  } finally {
    isHydrating = false;
  }
}

async function refreshOperationalReadiness() {
  if (!canUseBackend()) {
    operationalReadiness = {
      ok: false,
      service: "legend-service-scheduler",
      environment: "browser-only",
      checks: [{
        name: "backend",
        ok: false,
        detail: "Opened in file mode or without backend API; using local browser storage."
      }],
      recentErrors: [],
      findings: []
    };
    renderDashboard();
    return operationalReadiness;
  }
  try {
    const response = await fetch("/api/readiness", { headers: apiHeaders() });
    const body = await response.json();
    operationalReadiness = {
      ...body,
      ok: response.ok && body.ok !== false,
      httpStatus: response.status
    };
    backendOnline = response.ok;
  } catch (error) {
    backendOnline = false;
    operationalReadiness = {
      ok: false,
      service: "legend-service-scheduler",
      environment: "offline",
      checks: [{
        name: "backend",
        ok: false,
        detail: error.message || "Backend readiness check failed."
      }],
      recentErrors: [],
      findings: []
    };
  }
  renderDashboard();
  return operationalReadiness;
}

async function refreshDurableAudit() {
  if (!backendOnline || !canUseBackend() || !["admin", "manager"].includes(currentRole())) {
    durableAuditEvents = null;
    renderDashboard();
    return [];
  }
  try {
    const response = await fetch("/api/audit", { headers: apiHeaders() });
    if (!response.ok) throw new Error(`Audit load failed: ${response.status}`);
    const body = await response.json();
    durableAuditEvents = body.events || [];
  } catch (error) {
    durableAuditEvents = null;
    logError(error.message || "Audit load failed");
  }
  renderDashboard();
  return durableAuditEvents || [];
}

async function pollRemoteState() {
  if (!backendOnline || !canUseBackend()) return;
  try {
    const response = await fetch("/api/state", { headers: apiHeaders() });
    if (!response.ok) throw new Error(`API state poll failed: ${response.status}`);
    const remote = normalizeState(await response.json());
    const version = remote._meta?.version;
    if (version && version !== remoteVersion) {
      isHydrating = true;
      state = remote;
      remoteVersion = version;
      audit(`Synced remote schedule version ${version}`);
      render();
      isHydrating = false;
    }
    backendOnline = true;
  } catch (error) {
    backendOnline = false;
    console.warn("Backend sync poll failed.", error);
  }
}

function startBackendPolling() {
  if (!backendOnline || !canUseBackend() || typeof setInterval !== "function" || syncTimer) return;
  syncTimer = setInterval(pollRemoteState, 15000);
}

function startRealtimeSync() {
  if (!backendOnline || !canUseBackend() || typeof EventSource !== "function" || eventSource) {
    startBackendPolling();
    return;
  }
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("state", async event => {
    const data = JSON.parse(event.data || "{}");
    if (data.version && data.version !== remoteVersion) await pollRemoteState();
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    startBackendPolling();
  };
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!isHydrating) scheduleRemoteSave();
}

function scheduleRemoteSave() {
  if (!backendOnline || !canUseBackend()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveRemoteState("state.autosave"), 300);
}

async function saveRemoteState(action = "state.save") {
  if (!canUseBackend()) return;
  const payload = { ...state };
  delete payload._meta;
  try {
    const response = await fetch(`/api/state?action=${encodeURIComponent(action)}`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`API state save failed: ${response.status}`);
    const body = await response.json().catch(() => ({}));
    if (body.version) remoteVersion = body.version;
    backendOnline = true;
  } catch (error) {
    backendOnline = false;
    console.warn("Backend save failed; localStorage copy preserved.", error);
  }
}

async function loginAsSelectedUser() {
  const userId = document.getElementById("loginUser").value;
  const pin = document.getElementById("loginPin").value;
  if (!canUseBackend()) {
    switchDemoRole(userId);
    return;
  }
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, pin })
    });
    if ([404, 405, 501].includes(response.status)) {
      switchDemoRole(userId);
      return;
    }
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
    const body = await response.json();
    session = { token: body.token, user: body.user, expiresAt: body.expiresAt };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    document.getElementById("loginPin").value = "";
    backendOnline = true;
    audit(`Logged in as ${body.user.name} (${body.user.role})`);
    renderAuth();
    await loadRemoteState();
    startRealtimeSync();
    render();
  } catch (error) {
    console.warn("Login failed.", error);
    alert("Login failed. Check that the backend server is running.");
  }
}

function switchDemoRole(userId) {
  session = { token: "", user: demoUsers[userId] || demoUsers.dispatcher, expiresAt: "" };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  document.getElementById("loginPin").value = "";
  audit(`Switched demo role to ${session.user.name} (${session.user.role})`);
  renderAuth();
  render();
}

async function logoutSession() {
  const token = session?.token;
  session = null;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  const pinInput = document.getElementById("loginPin");
  if (pinInput) pinInput.value = "";
  if (token && canUseBackend()) {
    await fetch("/api/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    }).catch(() => {});
  }
  audit("Logged out to demo dispatcher mode");
  renderAuth();
  save();
  render();
}

function renderAuth() {
  const status = document.getElementById("sessionStatus");
  if (!status) return;
  if (session?.user) {
    status.textContent = `${session.user.name} (${session.user.role})`;
    document.getElementById("loginUser").value = session.user.id;
  } else {
    status.textContent = "Demo dispatcher";
  }
  updateRoleHint();
}

function updateRoleHint() {
  const hint = document.getElementById("roleHint");
  if (!hint) return;
  const role = currentRole();
  const copy = {
    technician: "Technician view for today's assigned jobs, progress, checklists, and notes.",
    dispatcher: "Dispatch board for assigning work, balancing the day, and handling exceptions.",
    manager: "Manager view with schedule health, dispatch controls, and master-data oversight.",
    admin: "Admin view with full dispatch, configuration, import, export, and readiness tools."
  };
  hint.textContent = copy[role] || copy.dispatcher;
}

function uid(prefix) { return `${prefix}-${Math.random().toString(36).slice(2, 9)}`; }
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function fmtDate(date) { return date.toISOString().slice(0, 10); }
function parseList(value) { return value.split(",").map(s => s.trim()).filter(Boolean); }
function minutes(time) { const [h, m] = time.split(":").map(Number); return h * 60 + m; }
function timeFromMinutes(total) { return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function addDays(dateStr, n) { const d = new Date(`${dateStr}T00:00:00`); d.setDate(d.getDate() + n); return fmtDate(d); }
function priorityWeight(p) { return { Critical: 4, High: 3, Medium: 2, Low: 1 }[p] || 1; }
function urgencyWeight(value) { return { Escalated: 4, "Delivery Promise": 3, Normal: 2, Flexible: 1 }[value] || 2; }
function byDuePriority(a, b) {
  return priorityWeight(b.priority) - priorityWeight(a.priority) || urgencyWeight(b.customerUrgency) - urgencyWeight(a.customerUrgency) || new Date(a.dueDate) - new Date(b.dueDate);
}

function canStartOnDate(order, day) {
  return !order.earliestStartDate || day >= order.earliestStartDate;
}

function earliestStartText(order) {
  return order.earliestStartDate ? `Earliest ${order.earliestStartDate}` : "";
}

async function init() {
  if (typeof window !== "undefined") {
    window.addEventListener?.("error", event => logError(event.message || "Unhandled browser error"));
    window.addEventListener?.("unhandledrejection", event => logError(event.reason?.message || "Unhandled promise rejection"));
  }
  await loadRemoteState();
  await refreshOperationalReadiness();
  await refreshDurableAudit();
  startRealtimeSync();
  renderAuth();
  document.getElementById("boardDate").value = state.boardDate || fmtDate(new Date());
  document.getElementById("mobileDate").value = state.boardDate || fmtDate(new Date());
  document.getElementById("absenceDate").value = state.boardDate || fmtDate(new Date());
  bindEvents();
  render();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.view)));
  document.getElementById("loginBtn").addEventListener("click", loginAsSelectedUser);
  document.getElementById("logoutBtn").addEventListener("click", logoutSession);
  document.querySelectorAll("[data-board]").forEach(btn => btn.addEventListener("click", () => {
    state.boardMode = btn.dataset.board;
    save(); render();
  }));
  document.getElementById("boardDate").addEventListener("change", e => { state.boardDate = e.target.value; save(); render(); });
  document.getElementById("schedulerMode").addEventListener("change", e => { state.schedulerMode = e.target.value; save(); render(); });
  document.getElementById("mobileDate").addEventListener("change", e => renderMobile());
  document.getElementById("optimizeBtn").addEventListener("click", optimizeSchedule);
  document.getElementById("rescheduleBtn").addEventListener("click", () => generateWhatChangedPlan());
  document.getElementById("salesforceImportBtn").addEventListener("click", () => document.getElementById("salesforceImportFile").click());
  document.getElementById("salesforceImportFile").addEventListener("change", importSalesforceFile);
  document.getElementById("salesforceExportBtn").addEventListener("click", exportSalesforce);
  document.getElementById("readinessRefreshBtn").addEventListener("click", refreshOperationalReadiness);
  document.getElementById("auditRefreshBtn").addEventListener("click", refreshDurableAudit);
  document.getElementById("seedBtn").addEventListener("click", resetSeedData);
  document.getElementById("manualAssignBtn").addEventListener("click", manualAssign);
  ["manualTech", "manualStart"].forEach(id => document.getElementById(id).addEventListener("change", renderConflictBanner));
  document.getElementById("markAbsentBtn").addEventListener("click", markAbsentAndReplan);
  document.getElementById("markOverrunBtn").addEventListener("click", markJobOverrunAndReplan);
  document.getElementById("undoBtn").addEventListener("click", undoLastAction);
  document.getElementById("redoBtn").addEventListener("click", redoLastAction);
  document.getElementById("generatePlanBtn").addEventListener("click", generateMorningPlan);
  document.getElementById("approvePlanBtn").addEventListener("click", approveMorningPlan);
  document.getElementById("exportBtn").addEventListener("click", exportState);
  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", importState);
  ["filterTeam", "filterSkill", "filterStatus", "filterParts", "filterDue", "filterText"].forEach(id => {
    document.getElementById(id).addEventListener("change", e => {
      const key = id.replace("filter", "").toLowerCase();
      state.filters[key === "team" ? "team" : key] = e.target.value;
      render();
    });
  });
  document.getElementById("filterText").addEventListener("input", e => {
    state.filters.text = e.target.value;
    render();
  });
  document.addEventListener("keydown", handleShortcut);
  document.getElementById("saveViewBtn").addEventListener("click", saveCurrentView);
  document.getElementById("applySavedViewBtn").addEventListener("click", applySavedView);
  document.getElementById("closeDrawerBtn").addEventListener("click", closeDrawer);
  document.getElementById("orderType").addEventListener("change", applyTypeDefaults);
  document.getElementById("orderForm").addEventListener("submit", saveOrder);
  document.getElementById("batchForm").addEventListener("submit", saveBatchOrders);
  document.getElementById("techForm").addEventListener("submit", saveTech);
  document.getElementById("bayForm").addEventListener("submit", saveBay);
  document.getElementById("typeForm").addEventListener("submit", saveType);
  document.getElementById("clearOrderBtn").addEventListener("click", clearOrderForm);
  document.getElementById("sampleBatchBtn").addEventListener("click", fillSampleBatch);
  document.getElementById("clearTechBtn").addEventListener("click", clearTechForm);
  document.getElementById("clearBayBtn").addEventListener("click", clearBayForm);
  document.getElementById("clearTypeBtn").addEventListener("click", clearTypeForm);
  document.getElementById("mobileTech").addEventListener("change", renderMobile);
}

function showView(view) {
  if (document.querySelector(`.tab[data-view="${view}"]`)?.hidden) {
    view = firstVisibleView();
  }
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === view));
}

function firstVisibleView() {
  return [...document.querySelectorAll(".tab")].find(tab => !tab.hidden)?.dataset.view || "dispatch";
}

function render() {
  document.querySelectorAll("[data-board]").forEach(btn => btn.classList.toggle("active", btn.dataset.board === state.boardMode));
  renderMetrics();
  renderSelectors();
  renderQueue();
  renderBoard();
  renderRecommendations();
  renderAiPlan();
  renderScenarioDiff();
  renderOrders();
  renderTechs();
  renderBays();
  renderTypes();
  renderMobile();
  renderDashboard();
  renderConflictBanner();
  renderDrawer();
  applyRolePermissions();
  document.getElementById("schedulerMode").value = state.schedulerMode || "balanced";
  save();
}

function renderMetrics() {
  const unscheduled = state.orders.filter(o => o.status === "Unscheduled").length;
  const scheduled = state.orders.filter(o => o.status !== "Unscheduled").length;
  const today = fmtDate(new Date());
  const overdue = state.orders.filter(o => o.status !== "Complete" && o.dueDate < today).length;
  const blocked = state.orders.filter(o => o.status === "Blocked").length;
  const activeTechs = state.technicians.filter(t => t.active).length;
  const gaps = skillGaps().length;
  const waitingParts = state.orders.filter(o => ["Waiting on Parts", "Backordered"].includes(o.parts) && o.status !== "Complete").length;
  document.getElementById("metrics").innerHTML = [
    ["Unscheduled", unscheduled], ["Scheduled", scheduled], ["Overdue", overdue],
    ["Waiting Parts", waitingParts], ["Active Techs", activeTechs], ["Skill Gaps", gaps]
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
}

function renderSelectors() {
  const manualTech = document.getElementById("manualTech").value;
  const mobileTech = document.getElementById("mobileTech").value;
  const absenceTech = document.getElementById("absenceTech").value;
  const overrunOrder = document.getElementById("overrunOrder").value;
  const preferredTech = document.getElementById("orderPreferredTech").value;
  const continuityTech = document.getElementById("orderContinuityTech").value;
  const orderType = document.getElementById("orderType").value;
  const areas = [...new Set(state.technicians.map(t => t.area))].sort();
  const techOptions = state.technicians.filter(t => t.active).map(t => `<option value="${t.id}">${t.name} - ${t.area}</option>`).join("");
  document.getElementById("manualTech").innerHTML = techOptions;
  document.getElementById("mobileTech").innerHTML = techOptions;
  document.getElementById("absenceTech").innerHTML = `<option value="">None</option>${techOptions}`;
  document.getElementById("overrunOrder").innerHTML = `<option value="">Choose scheduled job</option>${state.orders.filter(o => scheduleSegments(o).length && o.status !== "Complete").map(o => `<option value="${o.id}">${o.id} - ${o.title}</option>`).join("")}`;
  document.getElementById("orderPreferredTech").innerHTML = `<option value="">No preference</option>${techOptions}`;
  document.getElementById("orderContinuityTech").innerHTML = `<option value="">Auto from unit history</option>${techOptions}`;
  document.getElementById("orderType").innerHTML = state.workTypes.map(t => `<option value="${t.name}">${t.name}</option>`).join("");
  document.getElementById("orderBay").innerHTML = state.bays.map(b => `<option value="${b}">${b}</option>`).join("");
  document.getElementById("filterTeam").innerHTML = `<option value="">All teams</option>${areas.map(a => `<option value="${a}">${a}</option>`).join("")}`;
  document.getElementById("filterSkill").innerHTML = `<option value="">All skills</option>${skills.map(s => `<option value="${s}">${s}</option>`).join("")}`;
  document.getElementById("filterStatus").innerHTML = `<option value="">All status</option>${["Unscheduled", "Scheduled", "In Progress", "Blocked", "Complete"].map(s => `<option value="${s}">${s}</option>`).join("")}`;
  document.getElementById("filterParts").innerHTML = `<option value="">All parts</option>${["Ready", "Staged", "Waiting on Parts", "Backordered"].map(s => `<option value="${s}">${s}</option>`).join("")}`;
  document.getElementById("savedViewSelect").innerHTML = `<option value="">Choose view</option>${state.savedViews.map(v => `<option value="${v.name}">${v.name}</option>`).join("")}`;
  if (manualTech) document.getElementById("manualTech").value = manualTech;
  if (mobileTech) document.getElementById("mobileTech").value = mobileTech;
  if (absenceTech) document.getElementById("absenceTech").value = absenceTech;
  if (overrunOrder) document.getElementById("overrunOrder").value = overrunOrder;
  if (preferredTech) document.getElementById("orderPreferredTech").value = preferredTech;
  if (continuityTech) document.getElementById("orderContinuityTech").value = continuityTech;
  if (orderType) document.getElementById("orderType").value = orderType;
  document.getElementById("filterTeam").value = state.filters.team || "";
  document.getElementById("filterSkill").value = state.filters.skill || "";
  document.getElementById("filterStatus").value = state.filters.status || "";
  document.getElementById("filterParts").value = state.filters.parts || "";
  document.getElementById("filterDue").value = state.filters.due || "";
  document.getElementById("filterText").value = state.filters.text || "";
}

function renderQueue() {
  const orders = filteredOrders(state.orders.filter(o => o.status === "Unscheduled")).sort(byDuePriority);
  document.getElementById("unscheduledCount").textContent = `${orders.length} jobs`;
  document.getElementById("unscheduledQueue").innerHTML = orders.map(jobCard).join("") || `<p>No unscheduled work.</p>`;
  document.querySelectorAll("[data-select-order]").forEach(btn => btn.addEventListener("click", () => {
    state.selectedOrderId = btn.dataset.selectOrder;
    renderQueue();
    renderConflictBanner();
  }));
  document.querySelectorAll("[data-detail-order]").forEach(btn => btn.addEventListener("click", () => openDrawer(btn.dataset.detailOrder)));
}

function jobCard(o) {
  const party = [o.customer, o.dealer].filter(Boolean).join(" / ");
  return `<article class="job-card priority-${o.priority} ${state.selectedOrderId === o.id ? "selected" : ""}" draggable="true" data-drag-order="${o.id}">
    <div class="job-title">${o.title}</div>
    <div class="job-meta"><span>${o.id}</span><span>${party || o.boat}</span><span>${o.duration}h</span><span>Due ${o.dueDate}</span>${o.earliestStartDate ? `<span>${earliestStartText(o)}</span>` : ""}</div>
    <div class="job-meta"><span>${o.boat}</span></div>
    <div class="job-meta"><span>${o.parts}</span><span>${o.bay}</span></div>
    <div class="chips">${o.skills.map(s => `<span class="chip">${s}</span>`).join("")}</div>
    <button data-select-order="${o.id}">${state.selectedOrderId === o.id ? "Selected" : "Select"}</button>
    <button data-detail-order="${o.id}">Details</button>
  </article>`;
}

function renderBoard() {
  const mode = state.boardMode || "day";
  if (mode === "day") {
    renderDayTimeSlotBoard();
    return;
  }
  const days = mode === "day" ? [state.boardDate] : [0,1,2,3,4].map(i => addDays(state.boardDate, i));
  let html = `<div class="board-grid ${mode}"><div class="board-head">Technician</div>${days.map(d => `<div class="board-head">${d}</div>`).join("")}`;
  state.technicians.filter(t => t.active).forEach(t => {
    if (state.filters.team && t.area !== state.filters.team) return;
    const utilization = utilizationFor(t.id, days);
    html += `<div class="tech-head">${t.name}<small>${t.area} | ${t.skills.join(", ")} | ${Math.round(utilization)}% used</small></div>`;
    days.forEach(day => {
      const jobs = scheduledInstancesFor(t.id, day).filter(({ order }) => filteredOrders([order]).length).sort((a,b) => a.segment.start - b.segment.start);
      html += `<div class="board-cell" data-drop-tech="${t.id}" data-drop-day="${day}">${jobs.map(scheduledCard).join("") || (isTechAbsent(t.id, day) ? `<span class="muted">Absent</span>` : "")}</div>`;
    });
  });
  html += `</div>`;
  document.getElementById("dispatchBoard").innerHTML = html;
  bindDragAndDrop();
  document.querySelectorAll("[data-unschedule]").forEach(btn => btn.addEventListener("click", () => unschedule(btn.dataset.unschedule)));
  document.querySelectorAll("[data-status]").forEach(sel => sel.addEventListener("change", () => updateStatus(sel.dataset.status, sel.value)));
  document.querySelectorAll("[data-detail-order]").forEach(btn => btn.addEventListener("click", () => openDrawer(btn.dataset.detailOrder)));
}

function renderDayTimeSlotBoard() {
  const day = state.boardDate;
  const techs = state.technicians.filter(t => t.active).filter(t => !state.filters.team || t.area === state.filters.team);
  const slots = boardTimeSlots(techs);
  let html = `<div class="board-grid time-slots" style="--tech-count:${Math.max(techs.length, 1)}"><div class="board-head time-head">Time</div>`;
  techs.forEach(t => {
    const utilization = utilizationFor(t.id, [day]);
    html += `<div class="board-head tech-head">${t.name}<small>${t.area} | ${t.skills.join(", ")} | ${Math.round(utilization)}% used</small></div>`;
  });
  slots.forEach(slot => {
    html += `<div class="board-cell time-slot-label">${timeFromMinutes(slot)}</div>`;
    techs.forEach(t => {
      const slotEnd = slot + 60;
      const jobs = scheduledInstancesFor(t.id, day)
        .filter(({ order }) => filteredOrders([order]).length)
        .filter(({ segment }) => {
          const start = minutes(segment.start);
          return start >= slot && start < slotEnd;
        })
        .sort((a, b) => minutes(a.segment.start) - minutes(b.segment.start));
      const startLabel = timeFromMinutes(slot);
      html += `<div class="board-cell time-drop-cell" data-drop-tech="${t.id}" data-drop-day="${day}" data-drop-start="${startLabel}">
        ${jobs.map(scheduledCard).join("") || (isTechAbsent(t.id, day) ? `<span class="muted">Absent</span>` : "")}
      </div>`;
    });
  });
  html += `</div>`;
  document.getElementById("dispatchBoard").innerHTML = html;
  bindDragAndDrop();
  document.querySelectorAll("[data-unschedule]").forEach(btn => btn.addEventListener("click", () => unschedule(btn.dataset.unschedule)));
  document.querySelectorAll("[data-status]").forEach(sel => sel.addEventListener("change", () => updateStatus(sel.dataset.status, sel.value)));
  document.querySelectorAll("[data-detail-order]").forEach(btn => btn.addEventListener("click", () => openDrawer(btn.dataset.detailOrder)));
}

function boardTimeSlots(techs) {
  if (!techs.length) return [minutes("08:00")];
  const earliest = Math.floor(Math.min(...techs.map(t => minutes(t.start))) / 60) * 60;
  const latest = Math.ceil(Math.max(...techs.map(t => minutes(t.end))) / 60) * 60;
  const slots = [];
  for (let slot = earliest; slot < latest; slot += 60) slots.push(slot);
  return slots;
}

function scheduledCard(instance) {
  const o = instance.order || instance;
  const segment = instance.segment || primarySegment(o);
  const end = segment?.start ? timeFromMinutes(minutes(segment.start) + Math.round((segment.duration || o.duration) * 60)) : "";
  const segmentLabel = scheduleSegments(o).length > 1 ? ` | segment ${segment.index + 1}/${scheduleSegments(o).length}` : "";
  return `<article class="scheduled-job status-${o.status.replace(/\s/g, "")}" draggable="true" data-drag-order="${o.id}">
    <div class="job-title">${segment?.start || "TBD"}-${end} ${o.title}</div>
    <div class="job-meta"><span>${o.id}</span><span>${o.priority}</span><span>${segment?.duration || o.duration}h${segmentLabel}</span></div>
    <div class="job-meta"><span>${o.parts}</span><span>${o.bay}</span></div>
    <div class="chips">${o.skills.map(s => `<span class="chip">${s}</span>`).join("")}</div>
    <select data-status="${o.id}">
      ${["Scheduled", "In Progress", "Blocked", "Complete"].map(s => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}
    </select>
    <button data-unschedule="${o.id}">Unschedule</button>
    <button data-detail-order="${o.id}">Details</button>
  </article>`;
}

function utilizationFor(techId, days) {
  const tech = state.technicians.find(t => t.id === techId);
  const capacity = days.reduce((sum) => sum + (minutes(tech.end) - minutes(tech.start)) / 60 * (tech.capacity / 100), 0);
  const load = state.orders.filter(o => o.status !== "Complete").reduce((sum, o) => {
    return sum + scheduleSegments(o).filter(s => s.techId === techId && days.includes(s.date)).reduce((segSum, s) => segSum + Number(s.duration || 0), 0);
  }, 0);
  return capacity ? (load / capacity) * 100 : 0;
}

function renderRecommendations() {
  const notes = state.recommendations || [];
  document.getElementById("recommendationCount").textContent = `${notes.length} notes`;
  document.getElementById("recommendations").innerHTML = notes.map(n => `<div class="note ${n.level || ""}"><strong>${n.title}</strong><p>${n.body}</p></div>`).join("") || `<p>No AI scheduling run yet.</p>`;
}

function renderAiPlan() {
  const plan = state.aiPlan;
  document.getElementById("planCount").textContent = plan ? `${plan.changes.length} changes` : "No plan";
  document.getElementById("aiPlan").innerHTML = plan
    ? `<div class="note"><strong>${plan.createdAt}</strong><p>${plan.summary}</p></div>${plan.changes.map(c => `<div class="note ${c.level || ""}"><strong>${c.title}</strong><p>${c.body}</p></div>`).join("")}`
    : `<p>Generate a morning plan to preview AI scheduling changes before applying them.</p>`;
}

function renderScenarioDiff() {
  const diff = state.scenarioDiff;
  const count = diff?.changes?.length || 0;
  document.getElementById("scenarioCount").textContent = count ? `${count} changes` : "No scenario";
  document.getElementById("scenarioDiff").innerHTML = diff
    ? `<div class="note"><strong>${diff.title}</strong><p>${diff.summary}</p></div>${diff.changes.map(c => `<div class="note ${c.level || ""}"><strong>${c.title}</strong><p>${c.body}</p></div>`).join("")}`
    : `<p>Use What Changed or mark a technician absent to preview rescheduling impact.</p>`;
}

function renderOrders() {
  document.getElementById("ordersTable").innerHTML = filteredOrders(state.orders).sort(byDuePriority).map(o => {
    const tech = state.technicians.find(t => t.id === o.techId);
    const party = [o.customer, o.dealer].filter(Boolean).join(" / ");
    return `<tr>
      <td><strong>${o.title}</strong><br><span class="job-meta">${o.id} | ${party || "No customer/dealer"} | ${o.boat}</span></td>
      <td>${o.workType}</td><td>${o.priority}<br><span class="job-meta">${o.customerUrgency || "Normal"}</span></td><td>${o.dueDate}${o.earliestStartDate ? `<br><span class="job-meta">Earliest ${o.earliestStartDate}</span>` : ""}</td>
      <td>${o.skills.map(s => `<span class="chip">${s}</span>`).join(" ")} ${(o.requiredCertifications || []).map(s => `<span class="chip cert">${s}</span>`).join(" ")}</td>
      <td>${o.parts}<br><span class="job-meta">${o.bay}</span></td>
      <td>${o.status}<br><span class="job-meta">${tech ? `${tech.name} ${scheduleSegments(o).map(s => `${s.date} ${s.start}`).join(", ")}` : ""}</span></td>
      <td class="mini-actions"><button data-detail-order="${o.id}">Details</button> <button data-edit-order="${o.id}">Edit</button> <button class="danger" data-delete-order="${o.id}">Delete</button></td>
    </tr>`;
  }).join("");
  document.querySelectorAll("[data-edit-order]").forEach(btn => btn.addEventListener("click", () => editOrder(btn.dataset.editOrder)));
  document.querySelectorAll("[data-delete-order]").forEach(btn => btn.addEventListener("click", () => deleteOrder(btn.dataset.deleteOrder)));
  document.querySelectorAll("[data-detail-order]").forEach(btn => btn.addEventListener("click", () => openDrawer(btn.dataset.detailOrder)));
}

function filteredOrders(orders) {
  return orders.filter(o => {
    const tech = state.technicians.find(t => t.id === o.techId);
    if (state.filters.team && tech?.area !== state.filters.team && o.status !== "Unscheduled") return false;
    if (state.filters.skill && !o.skills.includes(state.filters.skill)) return false;
    if (state.filters.status && o.status !== state.filters.status) return false;
    if (state.filters.parts && o.parts !== state.filters.parts) return false;
    if (state.filters.due && o.dueDate > state.filters.due) return false;
    if (state.filters.text) {
      const haystack = `${o.id} ${o.title} ${o.customer || ""} ${o.dealer || ""} ${o.boat} ${o.description} ${o.notes}`.toLowerCase();
      if (!haystack.includes(state.filters.text.toLowerCase())) return false;
    }
    return true;
  });
}

function scheduleSegments(order) {
  if (order.segments?.length) return order.segments;
  if (!order.techId || !order.scheduledDate || !order.start) return [];
  return [{ techId: order.techId, date: order.scheduledDate, start: order.start, duration: Number(order.duration), index: 0 }];
}

function primarySegment(order) {
  return scheduleSegments(order)[0] || null;
}

function scheduledInstancesFor(techId, day) {
  return state.orders.flatMap(order => scheduleSegments(order)
    .map((segment, index) => ({ order, segment: { ...segment, index } }))
    .filter(instance => instance.segment.techId === techId && instance.segment.date === day));
}

function applySchedule(order, segments) {
  order.segments = segments.map((segment, index) => ({ ...segment, index }));
  const first = order.segments[0];
  order.techId = first?.techId || "";
  order.scheduledDate = first?.date || "";
  order.start = first?.start || "";
  order.status = first ? "Scheduled" : "Unscheduled";
}

function clearSchedule(order) {
  Object.assign(order, { techId: "", scheduledDate: "", start: "", status: "Unscheduled", segments: [] });
}

function handleShortcut(event) {
  if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
  const key = event.key.toLowerCase();
  if (key === "g") generateMorningPlan();
  if (key === "a") approveMorningPlan();
  if (key === "s") optimizeSchedule();
  if ((event.metaKey || event.ctrlKey) && key === "z") undoLastAction();
  if ((event.metaKey || event.ctrlKey) && key === "y") redoLastAction();
  if (event.key === "Escape") closeDrawer();
}

function saveCurrentView() {
  const name = document.getElementById("saveViewName").value.trim();
  if (!name) return;
  snapshot();
  state.savedViews = state.savedViews.filter(v => v.name !== name);
  state.savedViews.push({ name, filters: { ...state.filters }, boardMode: state.boardMode });
  audit(`Saved view "${name}"`);
  document.getElementById("saveViewName").value = "";
  render();
}

function applySavedView() {
  const name = document.getElementById("savedViewSelect").value;
  const view = state.savedViews.find(v => v.name === name);
  if (!view) return;
  state.filters = { ...view.filters };
  state.boardMode = view.boardMode || state.boardMode;
  audit(`Applied saved view "${name}"`);
  render();
}

function renderConflictBanner() {
  const preview = assignmentConflictPreview();
  const risks = scheduleRisks();
  const banner = document.getElementById("conflictBanner");
  if (!preview.length && !risks.length) {
    banner.classList.remove("active");
    banner.textContent = "";
    return;
  }
  banner.classList.add("active");
  if (preview.length) {
    banner.textContent = `Assignment check: ${preview.slice(0, 4).join("; ")}`;
    return;
  }
  banner.textContent = `${risks.length} schedule risk${risks.length === 1 ? "" : "s"}: ${risks.slice(0, 3).map(r => r.title).join("; ")}`;
}

function assignmentConflictPreview() {
  const order = state.orders.find(o => o.id === state.selectedOrderId);
  if (!order) return [];
  const techId = document.getElementById("manualTech")?.value;
  const day = document.getElementById("boardDate")?.value || state.boardDate;
  const start = document.getElementById("manualStart")?.value || "08:00";
  const validation = validateManualAssignment(order, techId, day, start);
  return validation.errors.concat(validation.warnings);
}

function renderDashboard() {
  const risks = scheduleRisks();
  const days = [0,1,2,3,4].map(i => addDays(state.boardDate, i));
  const utilization = state.technicians.filter(t => t.active).map(t => `${t.name}: ${Math.round(utilizationFor(t.id, days))}%`).join(" | ");
  const confidence = Math.max(0, Math.round(100 - risks.filter(r => r.level === "error").length * 18 - risks.filter(r => r.level === "warning").length * 7));
  const missingSkills = skillGaps();
  document.getElementById("riskCount").textContent = `${risks.length} risks`;
  document.getElementById("riskList").innerHTML = `
    <div class="note"><strong>Schedule Confidence ${confidence}%</strong><p>${utilization || "No active technicians."}</p></div>
    ${missingSkills.length ? `<div class="note warning"><strong>Missing Skills</strong><p>${missingSkills.join(", ")}</p></div>` : ""}
    ${risks.map(r => `<div class="note ${r.level || "warning"}"><strong>${r.title}</strong><p>${r.body}</p></div>`).join("") || `<p>No current schedule risks.</p>`}
  `;
  const auditEvents = durableAuditEvents || state.auditLog || [];
  document.getElementById("auditCount").textContent = `${auditEvents.length} events`;
  document.getElementById("auditLog").innerHTML = `
    ${state.errorLog?.length ? `<div class="note error"><strong>Recent Errors</strong><p>${state.errorLog.slice(0, 3).map(e => `${e.at}: ${e.text}`).join("<br>")}</p></div>` : ""}
    ${durableAuditEvents ? `<div class="note"><strong>Durable Backend Audit</strong><p>Showing persisted backend events from /api/audit.</p></div>` : ""}
    ${auditEvents.slice(0, 40).map(renderAuditEvent).join("") || `<p>No audit events yet.</p>`}
  `;
  renderReadinessPanel();
}

function renderAuditEvent(event) {
  if (event.action) {
    const when = event.createdAt ? new Date(event.createdAt * 1000).toLocaleString() : "";
    const entity = [event.entityType, event.entityId].filter(Boolean).join(" ");
    const actor = [event.actor, event.role].filter(Boolean).join(" / ");
    const changes = event.payload?.changes ? Object.keys(event.payload.changes).join(", ") : "";
    const detail = changes ? `Changed ${changes}.` : JSON.stringify(event.payload || {});
    return `<div class="audit-item"><strong>${when || event.action} ${event.action}</strong><p>${entity || "app_state"} by ${actor || "system"}. ${detail}</p></div>`;
  }
  return `<div class="audit-item"><strong>${event.at}</strong><p>${event.text}</p></div>`;
}

function renderReadinessPanel() {
  const panel = document.getElementById("readinessPanel");
  if (!panel) return;
  if (!operationalReadiness) {
    panel.innerHTML = `<div class="note warning"><strong>Not checked</strong><p>Refresh readiness to verify backend, roles, data integrity, backups, and error logging.</p></div>`;
    return;
  }
  const checks = operationalReadiness.checks || [];
  const errors = operationalReadiness.recentErrors || [];
  const findings = operationalReadiness.findings || [];
  const backup = operationalReadiness.backups;
  panel.innerHTML = `
    <div class="note ${operationalReadiness.ok ? "" : "error"}">
      <strong>${operationalReadiness.ok ? "Ready for shop use" : "Readiness attention required"}</strong>
      <p>${operationalReadiness.service || "legend-service-scheduler"} | ${operationalReadiness.environment || "local"}${operationalReadiness.database ? ` | ${operationalReadiness.database}` : ""}</p>
    </div>
    ${backup ? `<div class="note"><strong>Backups</strong><p>${backup.enabled ? "Enabled" : "Disabled"}; ${backup.count || 0} snapshot(s); retention ${backup.retention || "n/a"}; latest ${backup.latest || "none"}.</p></div>` : ""}
    <div class="readiness-list">
      ${checks.map(check => `
        <div class="readiness-row ${check.ok ? "ok" : "bad"}">
          <strong>${check.ok ? "OK" : "Fix"}</strong>
          <span>${check.name}</span>
          <small>${check.detail || ""}</small>
        </div>
      `).join("") || `<p>No readiness checks returned.</p>`}
    </div>
    ${findings.length ? `<div class="note warning"><strong>Integrity Findings</strong><p>${findings.slice(0, 4).map(f => `${f.code}: ${f.message}`).join("<br>")}</p></div>` : ""}
    ${errors.length ? `<div class="note error"><strong>Backend Errors</strong><p>${errors.slice(0, 3).map(e => `${e.source}: ${e.message}`).join("<br>")}</p></div>` : ""}
  `;
}

function scheduleRisks() {
  const risks = [];
  const today = fmtDate(new Date());
  state.orders.forEach(o => {
    if (o.status !== "Complete" && o.dueDate < today) risks.push({ level: "error", title: `${o.id} overdue`, body: `${o.title} was due ${o.dueDate}.` });
    if (o.earliestStartDate && scheduleSegments(o).some(segment => segment.date < o.earliestStartDate)) risks.push({ level: "error", title: `${o.id} before earliest start`, body: `${o.title} is scheduled before ${o.earliestStartDate}.` });
    if (["Waiting on Parts", "Backordered"].includes(o.parts) && o.priority !== "Low") risks.push({ level: "warning", title: `${o.id} waiting on parts`, body: `${o.priority} priority ${o.workType} is ${o.parts}.` });
    if (o.qualityHold) risks.push({ level: "error", title: `${o.id} quality hold`, body: `${o.title} is on quality hold.` });
    if (o.rework) risks.push({ level: "warning", title: `${o.id} rework`, body: `${o.title} is flagged as rework.` });
    if (o.status === "Scheduled" && !isPartsSchedulable(o)) risks.push({ level: "warning", title: `${o.id} scheduled without parts`, body: `${o.title} is scheduled while parts are ${o.parts}.` });
    scheduleSegments(o).forEach(segment => {
      if (isTechAbsent(segment.techId, segment.date)) risks.push({ level: "error", title: `${o.id} assigned to absent tech`, body: `${techName(segment.techId)} is absent on ${segment.date}.` });
      const certMissing = missingCertifications(o, state.technicians.find(t => t.id === segment.techId));
      if (certMissing.length) risks.push({ level: "warning", title: `${o.id} certification gap`, body: `${techName(segment.techId)} is missing ${certMissing.join(", ")}.` });
    });
  });
  state.absences.filter(a => a.techId && a.date).forEach(a => risks.push({ level: "warning", title: `${techName(a.techId)} absent ${a.date}`, body: a.reason || "Marked unavailable for scheduling." }));
  return risks;
}

function techName(techId) {
  return state.technicians.find(t => t.id === techId)?.name || "Unknown technician";
}

function continuityTechIdFor(order) {
  if (order.continuityTechId) return order.continuityTechId;
  const related = state.orders
    .filter(candidate =>
      candidate.id !== order.id &&
      candidate.boat === order.boat &&
      candidate.techId &&
      ["Scheduled", "In Progress", "Blocked", "Complete"].includes(candidate.status)
    )
    .sort((a, b) => scheduleSignature(b).localeCompare(scheduleSignature(a)));
  return related[0]?.techId || "";
}

function isTechAbsent(techId, day) {
  return state.absences.some(a => a.techId === techId && a.date === day);
}

function missingCertifications(order, tech) {
  if (!tech) return order.requiredCertifications || [];
  return (order.requiredCertifications || []).filter(cert => !(tech.certifications || []).includes(cert));
}

function openDrawer(orderId) {
  state.activeOrderId = orderId;
  renderDrawer();
}

function closeDrawer() {
  state.activeOrderId = null;
  renderDrawer();
}

function renderDrawer() {
  const drawer = document.getElementById("detailDrawer");
  const order = state.orders.find(o => o.id === state.activeOrderId);
  if (!order) {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    return;
  }
  const tech = state.technicians.find(t => t.id === order.techId);
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.getElementById("drawerTitle").textContent = `${order.id} ${order.title}`;
  document.getElementById("drawerBody").innerHTML = `
    <section class="drawer-section">
      <h3>Summary</h3>
      <p>${[order.customer, order.dealer].filter(Boolean).join(" / ") || "No customer/dealer recorded"}</p>
      <p>${order.boat}</p>
      <p>${order.workType} | ${order.priority} | ${order.customerUrgency || "Normal"} urgency | Due ${order.dueDate}${order.earliestStartDate ? ` | Earliest start ${order.earliestStartDate}` : ""}</p>
      <p>${tech ? `Assigned to ${tech.name}: ${scheduleSignature(order)}` : "Unassigned"}</p>
      <p>${continuityTechIdFor(order) ? `Continuity target: ${techName(continuityTechIdFor(order))}` : "Continuity target: auto from unit history"}</p>
      <div class="chips">${(order.requiredCertifications || []).map(c => `<span class="chip cert">${c}</span>`).join("")}</div>
      <div class="drawer-grid">
        <label>Parts <select data-update-field="parts">${["Ready", "Staged", "Waiting on Parts", "Backordered"].map(v => `<option ${order.parts === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>Bay <select data-update-field="bay">${state.bays.map(v => `<option ${order.bay === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>Actual Hours <input type="number" min="0" step="0.25" value="${order.actualHours || 0}" data-update-field="actualHours"></label>
        <label>Status <select data-update-field="status">${["Unscheduled", "Scheduled", "In Progress", "Blocked", "Complete"].map(v => `<option ${order.status === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      </div>
      <label class="check-row"><input type="checkbox" data-flag="qualityHold" ${order.qualityHold ? "checked" : ""}> Quality hold</label>
      <label class="check-row"><input type="checkbox" data-flag="rework" ${order.rework ? "checked" : ""}> Rework</label>
    </section>
    <section class="drawer-section">
      <h3>Time & Notes</h3>
      <div class="drawer-grid">
        <label>Technician <select data-time-tech>${state.technicians.filter(t => t.active).map(t => `<option value="${t.id}" ${order.techId === t.id ? "selected" : ""}>${t.name}</option>`).join("")}</select></label>
        <label>Hours <input type="number" min="0.25" step="0.25" value="0.25" data-time-hours></label>
      </div>
      <textarea data-time-note placeholder="Technician note, blocker, or work completed"></textarea>
      <button data-add-time="${order.id}">Add Time Entry</button>
      ${(order.timeEntries || []).map(entry => `<p><strong>${entry.hours}h</strong> ${techName(entry.techId)} - ${entry.note || "No note"} <span class="muted">${entry.date || ""}</span></p>`).join("") || "<p>No time entries yet.</p>"}
    </section>
    <section class="drawer-section">
      <h3>Operations</h3>
      <button data-split-operations="${order.id}">Split Into Operation Jobs</button>
      ${order.operations.map(op => `<label class="check-row"><input type="checkbox" data-operation="${op.id}" ${op.done ? "checked" : ""}> ${op.sequence}. ${op.name}</label>`).join("")}
    </section>
    <section class="drawer-section">
      <h3>Checklist</h3>
      ${order.checklist.map(item => `<label class="check-row"><input type="checkbox" data-checklist="${item.id}" ${item.done ? "checked" : ""}> ${item.text}</label>`).join("")}
      <div class="inline-entry">
        <input data-new-checklist="${order.id}" placeholder="Add checklist item">
        <button data-add-checklist="${order.id}">Add Item</button>
      </div>
    </section>
    <section class="drawer-section">
      <h3>Dependencies</h3>
      <textarea data-update-field="dependencies">${order.dependencies || ""}</textarea>
    </section>
    <section class="drawer-section">
      <h3>Unit History</h3>
      ${(order.unitHistory || []).map(h => `<p>${h}</p>`).join("") || "<p>No history yet.</p>"}
    </section>
    <section class="drawer-section">
      <h3>Attachments / Photos</h3>
      <input type="file" multiple data-attachments="${order.id}">
      ${(order.attachments || []).map(a => `<p>${a.url ? `<a href="${a.url}" target="_blank">${a.name}</a>` : a.name} (${Math.round((a.size || 0) / 1024)} KB) - ${a.addedAt}</p>`).join("") || "<p>No attachments yet.</p>"}
    </section>
  `;
  bindDrawerEvents(order.id);
}

function bindDrawerEvents(orderId) {
  document.querySelectorAll("[data-update-field]").forEach(input => {
    input.addEventListener("change", () => updateOrderField(orderId, input.dataset.updateField, input.type === "number" ? Number(input.value) : input.value));
  });
  document.querySelectorAll("[data-flag]").forEach(input => {
    input.addEventListener("change", () => updateOrderField(orderId, input.dataset.flag, input.checked));
  });
  document.querySelectorAll("[data-operation]").forEach(input => {
    input.addEventListener("change", () => toggleOperation(orderId, input.dataset.operation, input.checked));
  });
  document.querySelectorAll("[data-checklist]").forEach(input => {
    input.addEventListener("change", () => toggleChecklist(orderId, input.dataset.checklist, input.checked));
  });
  document.querySelectorAll("[data-attachments]").forEach(input => {
    input.addEventListener("change", () => addAttachments(orderId, input.files));
  });
  document.querySelectorAll("[data-split-operations]").forEach(btn => {
    btn.addEventListener("click", () => splitOperations(orderId));
  });
  document.querySelectorAll("[data-add-time]").forEach(btn => {
    btn.addEventListener("click", () => {
      const hours = Number(document.querySelector("[data-time-hours]")?.value || 0);
      const note = document.querySelector("[data-time-note]")?.value || "";
      const techId = document.querySelector("[data-time-tech]")?.value || "";
      addTimeEntry(orderId, hours, note, techId, "drawer");
    });
  });
  document.querySelectorAll("[data-add-checklist]").forEach(btn => {
    btn.addEventListener("click", () => {
      const text = document.querySelector(`[data-new-checklist="${btn.dataset.addChecklist}"]`)?.value || "";
      addChecklistItem(btn.dataset.addChecklist, text, "drawer");
    });
  });
}

function updateOrderField(orderId, field, value) {
  const order = state.orders.find(o => o.id === orderId);
  if (!order) return;
  if (field === "status" && value === "Complete") {
    const blockers = completionBlockers(order);
    if (blockers.length) {
      alert(`Cannot complete ${order.id} yet:\n${blockers.join("\n")}`);
      render();
      return;
    }
  }
  snapshot();
  order[field] = value;
  if (field === "actualHours" && Number(value) > 0) recordActualDuration(order, Number(value));
  addHistory(order, `${field} updated to ${value}`);
  audit(`${order.id} ${field} updated`);
  render();
}

function completionBlockers(order) {
  const blockers = [];
  if (order.qualityHold) blockers.push("Quality hold is still active.");
  const openOperations = (order.operations || []).filter(op => !op.done);
  const openChecklist = (order.checklist || []).filter(item => !item.done);
  if (openOperations.length) blockers.push(`Open operations: ${openOperations.map(op => op.name).join(", ")}.`);
  if (openChecklist.length) blockers.push(`Open checklist items: ${openChecklist.map(item => item.text).join(", ")}.`);
  if (order.rework) blockers.push("Rework flag is still active.");
  return blockers;
}

function recordActualDuration(order, hours) {
  const wt = state.workTypes.find(t => t.name === order.workType);
  if (!wt) return;
  const previous = Number(wt.learnedDuration || wt.duration || 0);
  wt.actualSamples ||= [];
  wt.actualSamples.push(hours);
  wt.actualSamples = wt.actualSamples.slice(-20);
  wt.learnedDuration = Math.round((wt.actualSamples.reduce((sum, h) => sum + h, 0) / wt.actualSamples.length) * 4) / 4;
  addHistory(order, `Learning loop updated ${wt.name} average from ${previous || wt.duration}h to ${wt.learnedDuration}h`);
}

function addTimeEntry(orderId, hours, note = "", techId = "", source = "technician") {
  const order = state.orders.find(o => o.id === orderId);
  const amount = Math.round(Number(hours || 0) * 4) / 4;
  if (!order || amount <= 0) return;
  snapshot();
  order.timeEntries ||= [];
  const entry = {
    id: uid("time"),
    techId: techId || order.techId || "",
    hours: amount,
    note: String(note || "").trim(),
    date: new Date().toLocaleString(),
    source
  };
  order.timeEntries.unshift(entry);
  order.actualHours = Math.round((Number(order.actualHours || 0) + amount) * 4) / 4;
  recordActualDuration(order, order.actualHours);
  addHistory(order, `${amount}h logged by ${techName(entry.techId)}${entry.note ? `: ${entry.note}` : ""}`);
  audit(`${order.id} ${amount}h time entry added`);
  render();
}

function toggleOperation(orderId, operationId, done) {
  const order = state.orders.find(o => o.id === orderId);
  const op = order?.operations.find(o => o.id === operationId);
  if (!op) return;
  snapshot();
  op.done = done;
  addHistory(order, `Operation ${op.name} marked ${done ? "done" : "not done"}`);
  syncParentOperationFromChild(order);
  audit(`${order.id} operation ${op.name} ${done ? "completed" : "reopened"}`);
  render();
}

function syncParentOperationFromChild(child) {
  if (!child?.parentId) return;
  const parent = state.orders.find(order => order.id === child.parentId);
  if (!parent) return;
  const parentOp = (parent.operations || []).find(op => op.childOrderId === child.id);
  if (!parentOp) return;
  const childOperationsDone = !(child.operations || []).length || (child.operations || []).every(op => op.done);
  const childChecklistDone = !(child.checklist || []).length || (child.checklist || []).every(item => item.done);
  const childDone = child.status === "Complete" || (childOperationsDone && childChecklistDone);
  if (parentOp.done !== childDone) {
    parentOp.done = childDone;
    addHistory(parent, `${child.id} ${childDone ? "completed" : "reopened"} operation ${parentOp.name}`);
  }
  const checklistItem = (parent.checklist || []).find(item => item.text === parentOp.name);
  if (checklistItem) checklistItem.done = childDone;
  const allChildrenDone = (parent.operations || []).length > 0 && parent.operations.every(op => op.done);
  if (allChildrenDone && parent.status !== "Complete") {
    parent.status = "Complete";
    parent.qualityHold = false;
    addHistory(parent, "All split operation jobs complete");
  } else if (!allChildrenDone && parent.status === "Complete") {
    parent.status = "In Progress";
    parent.qualityHold = true;
    addHistory(parent, "Split operation job reopened");
  }
}

function toggleChecklist(orderId, itemId, done) {
  const order = state.orders.find(o => o.id === orderId);
  const item = order?.checklist.find(i => i.id === itemId);
  if (!item) return;
  snapshot();
  item.done = done;
  addHistory(order, `Checklist ${item.text} marked ${done ? "done" : "not done"}`);
  audit(`${order.id} checklist ${item.text} ${done ? "completed" : "reopened"}`);
  render();
}

function addChecklistItem(orderId, text, source = "dispatcher") {
  const order = state.orders.find(o => o.id === orderId);
  const label = String(text || "").trim();
  if (!order || !label) return;
  snapshot();
  order.checklist ||= [];
  order.checklist.push({ id: uid("check"), text: label, done: false, source });
  addHistory(order, `Checklist item added: ${label}`);
  audit(`${order.id} checklist item added`);
  render();
}

function addHistory(order, text) {
  order.unitHistory ||= [];
  order.unitHistory.unshift(`${fmtDate(new Date())}: ${text}`);
}

async function addAttachments(orderId, files) {
  const order = state.orders.find(o => o.id === orderId);
  if (!order || !files?.length) return;
  snapshot();
  order.attachments ||= [];
  for (const file of [...files]) {
    const uploaded = await uploadAttachment(orderId, file);
    order.attachments.push(uploaded || { id: uid("att"), name: file.name, size: file.size, type: file.type || "unknown", addedAt: new Date().toLocaleString() });
  }
  addHistory(order, `${files.length} attachment(s) added`);
  audit(`${order.id} ${files.length} attachment(s) added`);
  render();
}

async function uploadAttachment(orderId, file) {
  if (!backendOnline || !canUseBackend()) return null;
  try {
    const response = await fetch(`/api/attachments?orderId=${encodeURIComponent(orderId)}&filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {
        ...apiHeaders({ json: false }),
        "Content-Type": file.type || "application/octet-stream"
      },
      body: await file.arrayBuffer()
    });
    if (!response.ok) throw new Error(`Attachment upload failed: ${response.status}`);
    const data = await response.json();
    return data.attachment;
  } catch (error) {
    console.warn("Attachment upload failed; keeping local metadata only.", error);
    return null;
  }
}

function splitOperations(orderId) {
  const parent = state.orders.find(o => o.id === orderId);
  if (!parent || parent.operations?.some(op => op.childOrderId)) return;
  snapshot();
  const operationDuration = Math.max(.5, Math.round((Number(parent.duration) / Math.max(parent.operations.length, 1)) * 4) / 4);
  parent.operations.forEach((op, index) => {
    const childId = nextWorkOrderId();
    const child = {
      ...parent,
      id: childId,
      title: `${parent.id} / ${op.sequence}. ${op.name}`,
      duration: operationDuration,
      status: "Unscheduled",
      techId: "",
      scheduledDate: "",
      start: "",
      parentId: parent.id,
      dependencies: index === 0 ? parent.dependencies : `${parent.id} operation ${index} complete`,
      operations: [{ ...op, id: uid("op"), done: false, childOrderId: "" }],
      checklist: [{ id: uid("check"), text: op.name, done: false }],
      unitHistory: [`Split from ${parent.id}`],
      attachments: []
    };
    op.childOrderId = childId;
    state.orders.push(child);
  });
  parent.status = "Blocked";
  parent.qualityHold = true;
  addHistory(parent, `Split into ${parent.operations.length} operation jobs`);
  audit(`${parent.id} split into operation-level jobs`);
  render();
}

function bindDragAndDrop() {
  document.querySelectorAll("[data-drag-order]").forEach(card => {
    card.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", card.dataset.dragOrder);
      e.dataTransfer.effectAllowed = "move";
    });
  });
  document.querySelectorAll("[data-drop-tech]").forEach(cell => {
    cell.addEventListener("dragover", e => {
      e.preventDefault();
      cell.classList.add("drop-target");
    });
    cell.addEventListener("dragleave", () => cell.classList.remove("drop-target"));
    cell.addEventListener("drop", e => {
      e.preventDefault();
      cell.classList.remove("drop-target");
      dropAssign(e.dataTransfer.getData("text/plain"), cell.dataset.dropTech, cell.dataset.dropDay, cell.dataset.dropStart || "");
    });
  });
}

function renderTechs() {
  document.getElementById("techCards").innerHTML = state.technicians.map(t => `<article class="person-card">
    <h2>${t.name}</h2><p>${t.role} | ${t.area} | ${t.active ? "Active" : "Inactive"}</p>
    <div class="chips">${t.skills.map(s => `<span class="chip">${s}</span>`).join("")}</div>
    <div class="chips">${(t.certifications || []).map(s => `<span class="chip cert">${s}</span>`).join("")}</div>
    <p>${t.start}-${t.end} | ${t.capacity}% capacity</p>
    <div class="mini-actions"><button data-edit-tech="${t.id}">Edit</button> <button class="danger" data-delete-tech="${t.id}">Delete</button></div>
  </article>`).join("");
  document.querySelectorAll("[data-edit-tech]").forEach(btn => btn.addEventListener("click", () => editTech(btn.dataset.editTech)));
  document.querySelectorAll("[data-delete-tech]").forEach(btn => btn.addEventListener("click", () => deleteTech(btn.dataset.deleteTech)));
}

function renderBays() {
  const usage = state.orders.reduce((counts, order) => {
    if (order.bay) counts[order.bay] = (counts[order.bay] || 0) + 1;
    return counts;
  }, {});
  document.getElementById("bayCards").innerHTML = state.bays.map(bay => {
    const availability = bayAvailabilityFor(bay);
    const outages = availability.outages || [];
    return `<article class="type-card">
    <h2>${bay}</h2>
    <p>${usage[bay] || 0} active or historical work order${usage[bay] === 1 ? "" : "s"}</p>
    <p>Available ${availability.start} - ${availability.end}</p>
    <p>${outages.length ? `Outages: ${outages.map(item => item.date).join(", ")}` : "No outage dates."}</p>
    <div class="mini-actions"><button data-edit-bay="${bay}">Edit</button> <button class="danger" data-delete-bay="${bay}">Delete</button></div>
  </article>`;
  }).join("");
  document.querySelectorAll("[data-edit-bay]").forEach(btn => btn.addEventListener("click", () => editBay(btn.dataset.editBay)));
  document.querySelectorAll("[data-delete-bay]").forEach(btn => btn.addEventListener("click", () => deleteBay(btn.dataset.deleteBay)));
}

function renderTypes() {
  document.getElementById("typeCards").innerHTML = state.workTypes.map(t => `<article class="type-card">
    <h2>${t.name}</h2><p>Default ${t.duration}h | Learned ${t.learnedDuration || t.duration}h</p>
    <div class="chips">${t.skills.map(s => `<span class="chip">${s}</span>`).join("")}</div>
    <p>${t.notes || ""}</p>
    <div class="mini-actions"><button data-edit-type="${t.id}">Edit</button> <button class="danger" data-delete-type="${t.id}">Delete</button></div>
  </article>`).join("");
  document.querySelectorAll("[data-edit-type]").forEach(btn => btn.addEventListener("click", () => editType(btn.dataset.editType)));
  document.querySelectorAll("[data-delete-type]").forEach(btn => btn.addEventListener("click", () => deleteType(btn.dataset.deleteType)));
}

function renderMobile() {
  const techId = document.getElementById("mobileTech").value || state.technicians[0]?.id;
  const day = document.getElementById("mobileDate").value || state.boardDate;
  const jobs = scheduledInstancesFor(techId, day).sort((a,b) => a.segment.start - b.segment.start);
  document.getElementById("mobileJobs").innerHTML = jobs.map(({ order: o, segment }) => `<article class="mobile-job">
    <h2>${segment.start} ${o.title}</h2>
    <p>${o.boat} | ${o.workType} | ${segment.duration}h of ${o.duration}h | ${o.priority}</p>
    <div class="chips">${o.skills.map(s => `<span class="chip">${s}</span>`).join("")}</div>
    <p>${o.description}</p><p>${o.notes || ""}</p>
    <div class="mobile-checklist">
      ${(o.checklist || []).map(item => `<label class="check-row"><input type="checkbox" data-mobile-checklist="${o.id}:${item.id}" ${item.done ? "checked" : ""}> ${item.text}</label>`).join("") || `<p>No checklist items.</p>`}
      <div class="inline-entry">
        <input data-mobile-new-checklist="${o.id}" placeholder="Add checklist item">
        <button data-mobile-add-checklist="${o.id}">Add</button>
      </div>
    </div>
    <div class="mobile-time-entry">
      <label>Add Hours <input type="number" min="0.25" step="0.25" value="0.25" data-mobile-time-hours="${o.id}"></label>
      <textarea data-mobile-time-note="${o.id}" placeholder="Technician note"></textarea>
      <button data-mobile-add-time="${o.id}">Log Time</button>
      <p>${o.actualHours || 0}h logged${(o.timeEntries || [])[0]?.note ? ` | Last: ${(o.timeEntries || [])[0].note}` : ""}</p>
    </div>
    <div class="mobile-attachments">
      <label>Photos <input type="file" accept="image/*" capture="environment" multiple data-mobile-attachments="${o.id}"></label>
      <p>${(o.attachments || []).length} attachment${(o.attachments || []).length === 1 ? "" : "s"} on file</p>
    </div>
    <select data-status="${o.id}">${["Scheduled", "In Progress", "Blocked", "Complete"].map(s => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
  </article>`).join("") || `<p>No assigned jobs for this technician/date.</p>`;
  document.querySelectorAll("#mobileJobs [data-status]").forEach(sel => sel.addEventListener("change", () => updateStatus(sel.dataset.status, sel.value)));
  document.querySelectorAll("#mobileJobs [data-mobile-add-time]").forEach(btn => btn.addEventListener("click", () => {
    const orderId = btn.dataset.mobileAddTime;
    const hours = Number(document.querySelector(`[data-mobile-time-hours="${orderId}"]`)?.value || 0);
    const note = document.querySelector(`[data-mobile-time-note="${orderId}"]`)?.value || "";
    addTimeEntry(orderId, hours, note, techId, "mobile");
  }));
  document.querySelectorAll("#mobileJobs [data-mobile-checklist]").forEach(input => input.addEventListener("change", () => {
    const [orderId, itemId] = input.dataset.mobileChecklist.split(":");
    toggleChecklist(orderId, itemId, input.checked);
  }));
  document.querySelectorAll("#mobileJobs [data-mobile-add-checklist]").forEach(btn => btn.addEventListener("click", () => {
    const orderId = btn.dataset.mobileAddChecklist;
    const text = document.querySelector(`[data-mobile-new-checklist="${orderId}"]`)?.value || "";
    addChecklistItem(orderId, text, "mobile");
  }));
  document.querySelectorAll("#mobileJobs [data-mobile-attachments]").forEach(input => {
    input.addEventListener("change", () => addAttachments(input.dataset.mobileAttachments, input.files));
  });
}

function optimizeSchedule() {
  snapshot();
  const notes = [];
  const targetDays = [0,1,2,3,4].map(i => addDays(state.boardDate, i));
  const unscheduled = state.orders.filter(o => o.status === "Unscheduled").sort(byDependencyPriority);
  const schedules = buildScheduleIndex(targetDays);
  const baySchedules = buildBayScheduleIndex(targetDays);
  const finishIndex = buildFinishIndex();
  const weights = schedulerWeights(state.schedulerMode);
  const pending = [...unscheduled];
  const pendingIds = new Set(pending.map(o => o.id));
  let progress = true;

  while (pending.length && progress) {
    progress = false;
    for (let index = 0; index < pending.length; index += 1) {
      const order = pending[index];
      if (!isPartsSchedulable(order)) {
        notes.push({
          level: "warning",
          title: `${order.id} held for parts`,
          body: `${order.title} was not scheduled because parts readiness is ${order.parts}. Mark it Ready or Staged before scheduling.`
        });
        pending.splice(index, 1);
        pendingIds.delete(order.id);
        index -= 1;
        progress = true;
        continue;
      }
      const dependencyWindow = earliestDependencyWindow(order, finishIndex, pendingIds);
      if (dependencyWindow.blocked.length) continue;
      let candidates = [];
      const disqualified = [];
      state.technicians.filter(t => t.active).forEach(tech => {
        const missing = order.skills.filter(s => !tech.skills.includes(s));
        const certMissing = missingCertifications(order, tech);
        if (missing.length || certMissing.length) {
          disqualified.push(`${tech.name}: ${[missing.length ? `missing skills ${missing.join(", ")}` : "", certMissing.length ? `missing certifications ${certMissing.join(", ")}` : ""].filter(Boolean).join("; ")}`);
          return;
        }
        const plan = findScheduleForOrder(order, tech, targetDays, dependencyWindow, schedules, baySchedules);
        const first = plan.segments[0];
        const day = first?.date || dependencyWindow.day;
        const continuityTechId = continuityTechIdFor(order);
        const dueDelta = Math.max(0, Math.round((new Date(order.dueDate) - new Date(day)) / MS_DAY));
        const overduePenalty = day > order.dueDate ? 80 : 0;
        const skillScore = 120 * weights.skills;
        const certScore = (order.requiredCertifications?.length || 0) * 20;
        const preferredScore = order.preferredTechId && order.preferredTechId === tech.id ? 25 : 0;
        const continuityScore = continuityTechId && continuityTechId === tech.id ? 22 * weights.continuity : 0;
        const urgencyScore = urgencyWeight(order.customerUrgency) * 9 * weights.urgency;
        const priorityScore = priorityWeight(order.priority) * 12 * weights.priority;
        const dueScore = (Math.max(0, 35 - dueDelta * 6) - overduePenalty) * weights.due;
        const load = utilizationFor(tech.id, targetDays);
        const loadScore = Math.max(0, 25 - load / 5) * weights.utilization;
        const warrantyScore = state.schedulerMode === "warranty" && order.workType === "Warranty Repair" ? 35 : 0;
        const capacityPenalty = plan.segments.length ? 0 : 100;
        const score = skillScore + certScore + preferredScore + continuityScore + urgencyScore + priorityScore + dueScore + loadScore + warrantyScore - capacityPenalty - plan.absencePenalty;
        candidates.push({ tech, day, slot: first ? minutes(first.start) : null, segments: plan.segments, missing, certMissing, score, plannedDuration: effectiveDuration(order), continuityTechId, continuityScore, urgencyScore });
      });
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates.find(c => c.segments.length) || candidates[0];
    if (!best || !best.segments.length) {
      const reason = candidates.length
        ? "Qualified technicians have no available capacity after dependency constraints in the selected week."
        : `No active technician satisfies hard skill/certification constraints${disqualified.length ? ` (${disqualified.join("; ")})` : ""}.`;
      notes.push({ level: "error", title: `${order.id} could not be scheduled`, body: `${order.title} was not scheduled. ${reason} Increase capacity, reduce duration, move the board date, split the work into operations, or assign manually as an override.` });
      pending.splice(index, 1);
      pendingIds.delete(order.id);
      index -= 1;
      progress = true;
      continue;
    }
    applySchedule(order, best.segments);
    best.segments.forEach(segment => {
      const block = { start: minutes(segment.start), end: minutes(segment.start) + Math.round(segment.duration * 60), orderId: order.id };
      schedules[segment.techId][segment.date].push(block);
      schedules[segment.techId][segment.date].sort((a,b) => a.start - b.start);
      baySchedules[order.bay] ||= {};
      baySchedules[order.bay][segment.date] ||= [];
      baySchedules[order.bay][segment.date].push(block);
      baySchedules[order.bay][segment.date].sort((a,b) => a.start - b.start);
    });
    const lastSegment = best.segments[best.segments.length - 1];
    finishIndex[order.id] = finishFromBlock(lastSegment.date, { start: minutes(lastSegment.start), end: minutes(lastSegment.start) + Math.round(lastSegment.duration * 60) });
    const fit = best.missing.length ? `Warning: missing ${best.missing.join(", ")}.` : "Full required-skill match.";
    const certFit = best.certMissing.length ? ` Missing certifications: ${best.certMissing.join(", ")}.` : (order.requiredCertifications?.length ? " Required certifications matched." : "");
    const multiDay = best.segments.length > 1 ? ` Multi-day plan: ${best.segments.map(s => `${s.date} ${s.start} (${s.duration}h)`).join(", ")}.` : "";
    const preferred = order.preferredTechId === best.tech.id ? " Preferred technician matched." : "";
    const continuity = best.continuityTechId === best.tech.id ? ` Continuity preserved with ${best.tech.name}.` : "";
    const urgency = ` Customer urgency ${order.customerUrgency || "Normal"} contributed ${Math.round(best.urgencyScore || 0)} points.`;
    const level = best.missing.length || best.certMissing.length ? "warning" : "";
    const dependencyText = dependencyWindow.reasons.length ? ` Dependency-aware sequencing: ${dependencyWindow.reasons.join("; ")}.` : "";
    notes.push({
      level,
      title: `${order.id} -> ${best.tech.name} on ${best.day} at ${order.start}`,
      body: `${fit}${certFit}${preferred}${continuity} Parts are ${order.parts}; ${order.bay} has capacity.${dependencyText}${multiDay} ${state.schedulerMode} mode used ${best.plannedDuration}h planned duration. Chosen for ${best.tech.area} availability, ${order.priority.toLowerCase()} priority, ${urgency} due ${order.dueDate}, and workload balance. Score ${Math.round(best.score)}.`
    });
    pending.splice(index, 1);
    pendingIds.delete(order.id);
    index -= 1;
    progress = true;
    }
  }

  pending.forEach(order => {
    const deps = earliestDependencyWindow(order, finishIndex, pendingIds).blocked;
    notes.push({
      level: "error",
      title: `${order.id} blocked by dependencies`,
      body: `${order.title} was not scheduled because ${deps.join(", ")} must be scheduled or completed first.`
    });
  });

  notes.unshift(...skillGaps().map(g => ({ level: "warning", title: `Skill gap: ${g}`, body: `At least one unscheduled or active work order requires ${g}, but no active technician has that skill.` })));
  state.recommendations = notes;
  audit(`AI scheduler processed ${unscheduled.length} unscheduled orders`);
  save();
  render();
}

function generateMorningPlan() {
  const beforeRaw = JSON.stringify(state);
  const before = normalizeState(JSON.parse(beforeRaw));
  optimizeSchedule();
  const planned = normalizeState(JSON.parse(JSON.stringify(state)));
  const changes = planned.orders
    .filter(after => {
      const prev = before.orders.find(o => o.id === after.id);
      return prev && prev.status === "Unscheduled" && after.status === "Scheduled";
    })
    .map(after => {
      const tech = planned.technicians.find(t => t.id === after.techId);
      return {
        level: "",
        title: `${after.id} -> ${tech?.name || "Unassigned"} ${after.scheduledDate} ${after.start}`,
        body: `${after.title} scheduled in ${after.bay}; ${after.parts}; ${after.skills.join(", ")}.`
      };
    });
  state = before;
  state.aiPlan = {
    createdAt: new Date().toLocaleString(),
    summary: `${changes.length} assignments proposed in ${planned.schedulerMode || "balanced"} mode. Review conflicts and approve when ready.`,
    changes,
    plannedState: planned
  };
  audit(`Generated morning AI plan with ${changes.length} proposed assignments`);
  render();
}

function generateWhatChangedPlan(title = "Reschedule Scenario") {
  const before = normalizeState(JSON.parse(JSON.stringify(state)));
  optimizeSchedule();
  const planned = normalizeState(JSON.parse(JSON.stringify(state)));
  const changes = scheduleChangeList(before, planned);
  state = before;
  state.scenarioDiff = {
    title,
    summary: `${changes.length} schedule changes detected if the current scenario is replanned in ${planned.schedulerMode || "balanced"} mode.`,
    changes,
    plannedState: planned
  };
  audit(`Generated what-changed scenario with ${changes.length} differences`);
  render();
}

function scheduleChangeList(before, planned) {
  const beforeMap = Object.fromEntries(before.orders.map(o => [o.id, scheduleSignature(o)]));
  const beforeDuration = Object.fromEntries(before.orders.map(o => [o.id, Number(o.duration || 0)]));
  return planned.orders
    .filter(o => beforeMap[o.id] !== scheduleSignature(o) || beforeDuration[o.id] !== Number(o.duration || 0))
    .map(o => ({
      level: o.status === "Unscheduled" ? "warning" : "",
      title: `${o.id} ${o.status}`,
      body: `${o.title}: ${beforeMap[o.id] || "new"} -> ${scheduleSignature(o) || "unscheduled"}${beforeDuration[o.id] !== Number(o.duration || 0) ? `; duration ${beforeDuration[o.id]}h -> ${o.duration}h` : ""}`
    }));
}

function scheduleSignature(order) {
  return scheduleSegments(order).map(s => `${techName(s.techId)} ${s.date} ${s.start} ${s.duration}h`).join("; ");
}

function markAbsentAndReplan() {
  const techId = document.getElementById("absenceTech").value;
  const date = document.getElementById("absenceDate").value || state.boardDate;
  if (!techId || !date) return alert("Choose a technician and date first.");
  snapshot();
  state.absences = state.absences.filter(a => !(a.techId === techId && a.date === date));
  state.absences.push({ techId, date, reason: "Dispatcher marked absent" });
  state.orders.forEach(order => {
    if (scheduleSegments(order).some(segment => segment.techId === techId && segment.date === date)) clearSchedule(order);
  });
  audit(`${techName(techId)} marked absent on ${date}`);
  generateWhatChangedPlan(`${techName(techId)} absent ${date}`);
}

function markJobOverrunAndReplan() {
  const orderId = document.getElementById("overrunOrder").value;
  const extraHours = Math.round(Number(document.getElementById("overrunHours").value || 0) * 4) / 4;
  if (!orderId || extraHours <= 0) return alert("Choose a scheduled job and extra hours first.");
  const original = normalizeState(JSON.parse(JSON.stringify(state)));
  const scenario = normalizeState(JSON.parse(JSON.stringify(state)));
  state = scenario;
  const order = state.orders.find(o => o.id === orderId);
  if (!order || !scheduleSegments(order).length) {
    state = original;
    return alert("Choose a scheduled job first.");
  }
  const impacted = impactedOrdersForOverrun(order);
  order.duration = Math.round((Number(order.duration || 0) + extraHours) * 4) / 4;
  impacted.forEach(impactedOrder => clearSchedule(impactedOrder));
  optimizeSchedule();
  const planned = normalizeState(JSON.parse(JSON.stringify(state)));
  const changes = scheduleChangeList(original, planned);
  state = original;
  state.scenarioDiff = {
    title: `${orderId} runs ${extraHours}h long`,
    summary: `${changes.length} schedule changes detected if ${orderId} needs ${extraHours} extra hour(s). Current schedule was not changed.`,
    changes,
    plannedState: planned
  };
  audit(`Generated job-overrun scenario for ${orderId} with ${extraHours} extra hour(s)`);
  render();
}

function impactedOrdersForOverrun(order) {
  const segments = scheduleSegments(order);
  const impacted = new Set([order.id]);
  segments.forEach(segment => {
    const start = minutes(segment.start || "08:00");
    state.orders.forEach(candidate => {
      if (candidate.id === order.id || !scheduleSegments(candidate).length || candidate.status === "Complete") return;
      if (scheduleSegments(candidate).some(candidateSegment =>
        candidateSegment.date === segment.date &&
        minutes(candidateSegment.start || "08:00") >= start &&
        (candidateSegment.techId === segment.techId || candidate.bay === order.bay)
      )) {
        impacted.add(candidate.id);
      }
    });
  });
  return state.orders.filter(candidate => impacted.has(candidate.id));
}

function approveMorningPlan() {
  if (!state.aiPlan?.plannedState) return;
  snapshot();
  const plan = state.aiPlan;
  state = normalizeState(JSON.parse(JSON.stringify(plan.plannedState)));
  state.aiPlan = null;
  audit(`Approved morning AI plan with ${plan.changes.length} assignments`);
  render();
}

async function exportState() {
  if (!canWriteOperations()) {
    alert("Export is limited to dispatcher, manager, and admin roles.");
    return;
  }
  let payload = state;
  let filename = `legend-service-scheduler-${fmtDate(new Date())}.json`;
  if (backendOnline && canUseBackend()) {
    try {
      const response = await fetch("/api/backup", { headers: apiHeaders() });
      if (!response.ok) throw new Error(`Backup export failed: ${response.status}`);
      payload = await response.json();
      filename = `legend-service-scheduler-backup-${fmtDate(new Date())}.json`;
    } catch (error) {
      console.warn("Backend backup export failed; exporting browser state only.", error);
    }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  audit(payload.format === "legend-service-scheduler-backup-v1" ? "Exported full backend backup" : "Exported scheduler data");
  render();
}

async function exportSalesforce() {
  if (!canWriteOperations()) {
    alert("Salesforce export is limited to dispatcher, manager, and admin roles.");
    return;
  }
  let payload = salesforceExportPayload(state);
  if (backendOnline && canUseBackend()) {
    try {
      const response = await fetch("/api/export/salesforce", { headers: apiHeaders() });
      if (!response.ok) throw new Error(`Salesforce export failed: ${response.status}`);
      payload = await response.json();
    } catch (error) {
      console.warn("Backend Salesforce export failed; exporting browser state only.", error);
    }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `legend-service-scheduler-salesforce-${fmtDate(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(url);
  audit(`Exported ${payload.records.length} Salesforce work order record(s)`);
  render();
}

function salesforceExportPayload(sourceState) {
  const technicians = Object.fromEntries((sourceState.technicians || []).map(tech => [tech.id, tech]));
  return {
    format: "legend-service-scheduler-salesforce-export-v1",
    exportedAt: new Date().toISOString(),
    source: "legend-service-scheduler",
    records: (sourceState.orders || []).map(order => ({
      Id: order.id,
      WorkOrderNumber: order.id,
      Subject: order.title || order.id,
      Description: order.description || order.notes || "",
      AccountName: order.customer || order.boat || "",
      DealerName: order.dealer || "",
      AssetName: order.boat || "",
      WorkType: order.workType || "",
      Status: order.status || "Unscheduled",
      Priority: order.priority || "Medium",
      CustomerUrgency: order.customerUrgency || "Normal",
      DueDate: order.dueDate || "",
      EarliestStartDate: order.earliestStartDate || "",
      EstimatedDuration: Number(order.duration || 0),
      ActualHours: Number(order.actualHours || 0),
      TimeEntries: order.timeEntries || [],
      PartsReadiness: order.parts || "",
      ServiceTerritory: order.bay || "",
      Bay: order.bay || "",
      AssignedTechnicianId: order.techId || "",
      AssignedTechnicianName: technicians[order.techId]?.name || "",
      ScheduledDate: order.scheduledDate || "",
      ScheduledStart: order.start || "",
      RequiredSkills: order.skills || [],
      RequiredCertifications: order.requiredCertifications || [],
      PreferredTechnicianId: order.preferredTechId || "",
      ContinuityTechnicianId: order.continuityTechId || "",
      ReworkFlag: Boolean(order.rework),
      QualityHold: Boolean(order.qualityHold),
      Dependencies: order.dependencies || "",
      ScheduleSegments: order.segments || [],
      Operations: order.operations || [],
      Checklist: order.checklist || [],
      UnitHistory: order.unitHistory || [],
      Attachments: (order.attachments || []).map(attachment => ({
        Name: attachment.name,
        ContentType: attachment.type,
        Size: attachment.size,
        Url: attachment.url || ""
      }))
    }))
  };
}

async function resetSeedData() {
  if (!canWriteOperations()) {
    alert("Reset Seed Data is limited to dispatcher, manager, and admin roles.");
    return;
  }
  if (!confirm("Reset all scheduler data to the realistic Legend Boats seed set?")) return;
  snapshot();
  const nextState = seed();
  if (backendOnline && canUseBackend()) {
    try {
      const response = await fetch("/api/demo/reset", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ state: nextState })
      });
      if (!response.ok) throw new Error(`Demo reset failed: ${response.status}`);
      const body = await response.json().catch(() => ({}));
      if (body.version) remoteVersion = body.version;
      await loadRemoteState();
      audit("Reset backend demo training data");
      render();
      return;
    } catch (error) {
      backendOnline = false;
      logError(error.message || "Demo reset failed");
    }
  }
  state = nextState;
  save();
  audit("Reset local demo training data");
  render();
}

function importState(event) {
  if (!canManageOperations()) {
    alert("Import / Restore is limited to manager and admin roles.");
    if (event?.target) event.target.value = "";
    return;
  }
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const payload = JSON.parse(reader.result);
      snapshot();
      if (payload.format === "legend-service-scheduler-backup-v1") {
        await restoreBackup(payload, file.name);
      } else {
        state = normalizeState(payload);
        audit(`Imported scheduler data from ${file.name}`);
      }
      render();
    } catch {
      alert("Import failed. Please choose a valid scheduler JSON export.");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

async function restoreBackup(payload, filename) {
  if (!canManageOperations()) {
    alert("Backup restore is limited to manager and admin roles.");
    return;
  }
  if (!backendOnline || !canUseBackend()) {
    state = normalizeState(payload.state || payload);
    audit(`Loaded backup state from ${filename} in browser-only mode`);
    return;
  }
  const response = await fetch("/api/restore", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Backup restore failed: ${response.status}`);
  await loadRemoteState();
  audit(`Restored backend backup from ${filename}`);
}

function importSalesforceFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const payload = JSON.parse(reader.result);
      snapshot();
      if (backendOnline && canUseBackend()) {
        const response = await fetch("/api/import/salesforce", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`Salesforce import failed: ${response.status}`);
        await loadRemoteState();
      } else {
        state.orders.push(...normalizeSalesforceRecords(payload));
      }
      audit(`Imported Salesforce work orders from ${file.name}`);
      render();
    } catch (error) {
      logError(error.message || "Salesforce import failed");
      alert("Salesforce import failed. Use a JSON export with records or Work Order fields.");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function normalizeSalesforceRecords(payload) {
  const records = Array.isArray(payload) ? payload : payload.records || [];
  return records.map((record, index) => {
    const workType = record.workType || record.WorkType || record.Type || "Warranty Repair";
    const wt = state.workTypes.find(t => t.name === workType) || state.workTypes[0];
    const segments = arrayField(record.segments || record.ScheduleSegments);
    const status = record.status || record.Status || (segments.length ? "Scheduled" : "Unscheduled");
    return {
      id: record.id || record.Id || `SF-${String(index + 1).padStart(4, "0")}`,
      title: record.title || record.Subject || record.WorkOrderNumber || "Salesforce Work Order",
      customer: record.customer || record.CustomerName || record.AccountName || "",
      dealer: record.dealer || record.DealerName || record.Dealer || "",
      boat: record.boat || record.AssetName || record.UnitName || record.AccountName || "Salesforce import",
      description: record.description || record.Description || "",
      workType: wt?.name || workType,
      priority: record.priority || record.Priority || "Medium",
      customerUrgency: record.customerUrgency || record.CustomerUrgency || record.Urgency || "Normal",
      dueDate: record.dueDate || record.DueDate || state.boardDate,
      earliestStartDate: record.earliestStartDate || record.EarliestStartDate || record.ReadyDate || record.DropoffDate || record.ArrivalDate || "",
      duration: Number(record.duration || record.EstimatedDuration || learnedDurationForType(wt) || 2),
      durationLocked: Boolean(record.duration || record.EstimatedDuration),
      skills: arrayField(record.skills || record.Skills || record.RequiredSkills, [...(wt?.skills || [])]),
      requiredCertifications: arrayField(record.requiredCertifications || record.RequiredCertifications),
      preferredTechId: record.preferredTechId || record.PreferredTechnicianId || "",
      continuityTechId: record.continuityTechId || record.ContinuityTechnicianId || "",
      parts: record.parts || record.PartsReadiness || "Ready",
      bay: record.bay || record.Bay || record.ServiceTerritory || bayForWorkType(wt?.name || workType),
      status,
      techId: record.techId || record.AssignedTechnicianId || segments[0]?.techId || "",
      scheduledDate: record.scheduledDate || record.ScheduledDate || segments[0]?.date || "",
      start: record.start || record.ScheduledStart || segments[0]?.start || "",
      segments,
      notes: record.notes || record.Notes || "Imported from Salesforce",
      operations: arrayField(record.operations || record.Operations, operationsForWorkType(wt?.name || workType)),
      checklist: arrayField(record.checklist || record.Checklist, checklistForWorkType(wt?.name || workType)),
      dependencies: record.dependencies || record.Dependencies || "",
      actualHours: Number(record.actualHours || record.ActualHours || 0),
      timeEntries: arrayField(record.timeEntries || record.TimeEntries),
      rework: boolField(record.rework ?? record.ReworkFlag),
      qualityHold: boolField(record.qualityHold ?? record.QualityHold),
      unitHistory: arrayField(record.unitHistory || record.UnitHistory, ["Imported from Salesforce"]),
      attachments: arrayField(record.attachments || record.Attachments).map(normalizeSalesforceAttachment)
    };
  });
}

function arrayField(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.split(",").map(item => item.trim()).filter(Boolean);
  return [...fallback];
}

function boolField(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "1"].includes(value.toLowerCase());
  return Boolean(value);
}

function normalizeSalesforceAttachment(attachment) {
  return {
    id: attachment.id || attachment.Id || uid("att"),
    name: attachment.name || attachment.Name || attachment.Filename || "Salesforce attachment",
    type: attachment.type || attachment.ContentType || "unknown",
    size: Number(attachment.size || attachment.Size || 0),
    url: attachment.url || attachment.Url || "",
    addedAt: attachment.addedAt || attachment.CreatedDate || new Date().toLocaleString()
  };
}

function schedulerWeights(mode) {
  return {
    delivery: { skills: 1, priority: 1.1, due: 1.8, utilization: .7, urgency: 1.5, continuity: 1 },
    utilization: { skills: 1, priority: .8, due: .9, utilization: 1.8, urgency: .8, continuity: .9 },
    warranty: { skills: 1.1, priority: 1.5, due: 1.2, utilization: .8, urgency: 1.4, continuity: 1.2 },
    balanced: { skills: 1, priority: 1, due: 1, utilization: 1, urgency: 1, continuity: 1 }
  }[mode] || { skills: 1, priority: 1, due: 1, utilization: 1, urgency: 1, continuity: 1 };
}

function byDependencyPriority(a, b) {
  const depDelta = dependencyIdsFor(a).length - dependencyIdsFor(b).length;
  return depDelta || byDuePriority(a, b);
}

function effectiveDuration(order) {
  if (order.durationLocked) return Number(order.duration || 1);
  const wt = state.workTypes.find(t => t.name === order.workType);
  return learnedDurationForType(wt) || Number(order.duration || 1);
}

function plannedDuration(order) {
  return Math.max(0.25, Math.round(effectiveDuration(order) * 4) / 4);
}

function learnedDurationForType(workType) {
  if (!workType) return 0;
  return Number(workType.learnedDuration || workType.duration || 0);
}

function dependencyIdsFor(order) {
  const ids = new Set((order.dependencies || "").match(/\bWO-\d+\b/g) || []);
  if (order.parentId) {
    const sequence = Number(order.operations?.[0]?.sequence || 0);
    if (sequence > 1) {
      const previous = state.orders.find(candidate =>
        candidate.parentId === order.parentId &&
        Number(candidate.operations?.[0]?.sequence || 0) === sequence - 1
      );
      if (previous) ids.add(previous.id);
    }
  }
  if (order.workType === "PDI") {
    state.orders.forEach(candidate => {
      if (candidate.id !== order.id && candidate.boat === order.boat && ["Rigging Install", "Mechanical Inspection", "Warranty Repair", "Fiberglass Touch-Up", "Electronics Install"].includes(candidate.workType) && candidate.status !== "Complete") {
        ids.add(candidate.id);
      }
    });
  }
  if (order.workType === "Wash & Detail") {
    state.orders.forEach(candidate => {
      if (candidate.id !== order.id && candidate.boat === order.boat && !["Wash & Detail"].includes(candidate.workType) && candidate.status !== "Complete") {
        ids.add(candidate.id);
      }
    });
  }
  return [...ids].filter(id => id !== order.id);
}

function earliestDependencyWindow(order, finishIndex, pendingIds = new Set()) {
  let window = { day: state.boardDate, minute: 0 };
  const blocked = [];
  const reasons = [];
  dependencyIdsFor(order).forEach(id => {
    const dependency = state.orders.find(o => o.id === id);
    if (!dependency || dependency.status === "Complete") return;
    const finish = finishIndex[id];
    if (!finish) {
      blocked.push(id);
      return;
    }
    const delayed = shiftDayMinute(finish.day, finish.minute, dependencyDelayMinutes(order, dependency));
    if (delayed.day > window.day || (delayed.day === window.day && delayed.minute > window.minute)) {
      window = delayed;
    }
    reasons.push(`${id} finishes before ${order.id} can start`);
  });
  return { ...window, blocked: blocked.filter(id => pendingIds.has(id) || !finishIndex[id]), reasons };
}

function dependencyDelayMinutes(order, dependency) {
  const dependencyText = `${dependency.title || ""} ${dependency.workType || ""} ${(dependency.operations || []).map(op => op.name).join(" ")} ${(order.dependencies || "")}`.toLowerCase();
  if (dependencyText.includes("cure")) return 16 * 60;
  if (order.parentId && order.parentId === dependency.parentId) return 15;
  return 30;
}

function shiftDayMinute(day, minute, addMinutes) {
  let shiftedDay = day;
  let shiftedMinute = minute + addMinutes;
  while (shiftedMinute >= 24 * 60) {
    shiftedDay = addDays(shiftedDay, 1);
    shiftedMinute -= 24 * 60;
  }
  return { day: shiftedDay, minute: shiftedMinute };
}

function buildFinishIndex() {
  return Object.fromEntries(state.orders
    .filter(order => scheduleSegments(order).length)
    .map(order => {
      const last = scheduleSegments(order).slice(-1)[0];
      const end = minutes(last.start) + Math.round(Number(last.duration || order.duration) * 60);
      return [order.id, shiftDayMinute(last.date, 0, end)];
    }));
}

function finishFromBlock(day, block) {
  return shiftDayMinute(day, 0, block.end);
}

function buildScheduleIndex(days) {
  const index = {};
  state.technicians.forEach(t => {
    index[t.id] = {};
    days.forEach(day => {
      index[t.id][day] = state.orders.flatMap(o => scheduleSegments(o)
        .filter(s => s.techId === t.id && s.date === day)
        .map(s => ({ start: minutes(s.start || t.start), end: minutes(s.start || t.start) + Math.round(Number(s.duration || o.duration) * 60), orderId: o.id })))
        .sort((a,b) => a.start - b.start);
    });
  });
  return index;
}

function buildBayScheduleIndex(days) {
  const index = {};
  state.bays.forEach(bay => {
    index[bay] = {};
    days.forEach(day => {
      index[bay][day] = [
        ...bayAvailabilityBlocks(bay, day),
        ...state.orders.filter(o => o.bay === bay)
        .flatMap(o => scheduleSegments(o).filter(s => s.date === day)
          .map(s => ({ start: minutes(s.start || "08:00"), end: minutes(s.start || "08:00") + Math.round(Number(s.duration || o.duration) * 60), orderId: o.id })))
      ]
        .sort((a,b) => a.start - b.start);
    });
  });
  return index;
}

function bayAvailabilityBlocks(bay, day) {
  const availability = bayAvailabilityFor(bay);
  if ((availability.outages || []).some(item => item.date === day)) {
    return [{ start: 0, end: 24 * 60, orderId: `resource-outage:${bay}` }];
  }
  const start = minutes(availability.start || "08:00");
  const end = minutes(availability.end || "17:00");
  const blocks = [];
  if (start > 0) blocks.push({ start: 0, end: start, orderId: `resource-closed:${bay}` });
  if (end < 24 * 60) blocks.push({ start: end, end: 24 * 60, orderId: `resource-closed:${bay}` });
  if (end <= start) blocks.push({ start: 0, end: 24 * 60, orderId: `resource-closed:${bay}` });
  return blocks;
}

function nextCompatibleSlot(tech, techBlocks, bayBlocks, durationHours) {
  return nextSlot(tech, [...techBlocks, ...bayBlocks], durationHours);
}

function nextCompatibleSlotAfter(tech, techBlocks, bayBlocks, durationHours, minimumStart) {
  const guard = minimumStart > 0 ? [{ start: 0, end: minimumStart }] : [];
  return nextSlot(tech, [...guard, ...techBlocks, ...bayBlocks], durationHours);
}

function findScheduleForOrder(order, tech, targetDays, dependencyWindow, schedules, baySchedules) {
  let remaining = effectiveDuration(order);
  const segments = [];
  let absencePenalty = 0;
  for (const day of targetDays) {
    if (day < dependencyWindow.day || remaining <= 0) continue;
    if (!canStartOnDate(order, day)) continue;
    if (isTechAbsent(tech.id, day)) {
      absencePenalty += 60;
      continue;
    }
    const minimumStart = day === dependencyWindow.day ? dependencyWindow.minute : 0;
    let dayOpen = true;
    while (remaining > 0 && dayOpen) {
      const slotDuration = Math.min(remaining, maxContiguousSlotHours(tech, schedules[tech.id][day], baySchedules[order.bay]?.[day] || [], minimumStart));
      if (slotDuration <= 0) {
        dayOpen = false;
        continue;
      }
      const slot = nextCompatibleSlotAfter(tech, schedules[tech.id][day], baySchedules[order.bay]?.[day] || [], slotDuration, minimumStart);
      if (slot == null) {
        dayOpen = false;
        continue;
      }
      const segment = { techId: tech.id, date: day, start: timeFromMinutes(slot), duration: Math.round(slotDuration * 4) / 4 };
      segments.push(segment);
      const block = { start: slot, end: slot + Math.round(segment.duration * 60), orderId: order.id };
      schedules[tech.id][day].push(block);
      schedules[tech.id][day].sort((a,b) => a.start - b.start);
      baySchedules[order.bay] ||= {};
      baySchedules[order.bay][day] ||= [];
      baySchedules[order.bay][day].push(block);
      baySchedules[order.bay][day].sort((a,b) => a.start - b.start);
      remaining = Math.round((remaining - segment.duration) * 4) / 4;
    }
  }
  segments.forEach(segment => {
    const techDay = schedules[segment.techId][segment.date];
    const bayDay = baySchedules[order.bay][segment.date];
    const start = minutes(segment.start);
    const end = start + Math.round(segment.duration * 60);
    const removeSegment = block => !(block.orderId === order.id && block.start === start && block.end === end);
    schedules[segment.techId][segment.date] = techDay.filter(removeSegment);
    baySchedules[order.bay][segment.date] = bayDay.filter(removeSegment);
  });
  return { segments: remaining <= 0 ? segments : [], absencePenalty };
}

function maxContiguousSlotHours(tech, techBlocks, bayBlocks, minimumStart) {
  const start = minutes(tech.start);
  const end = start + Math.round((minutes(tech.end) - start) * (tech.capacity / 100));
  const blocks = [...(minimumStart > 0 ? [{ start: 0, end: minimumStart }] : []), ...techBlocks, ...bayBlocks].sort((a,b) => a.start - b.start);
  let cursor = start;
  let best = 0;
  for (const block of blocks) {
    if (block.end <= start) continue;
    if (block.start >= end) break;
    const blockStart = Math.max(block.start, start);
    const blockEnd = Math.min(block.end, end);
    best = Math.max(best, blockStart - cursor);
    cursor = Math.max(cursor, blockEnd);
  }
  best = Math.max(best, end - cursor);
  return Math.max(0, Math.round((best / 60) * 4) / 4);
}

function isPartsSchedulable(order) {
  return ["Ready", "Staged"].includes(order.parts);
}

function nextSlot(tech, blocks, durationHours) {
  const duration = Math.round(durationHours * 60);
  const start = minutes(tech.start);
  const end = minutes(tech.end);
  const allowed = Math.round((end - start) * (tech.capacity / 100));
  if (duration > allowed) return null;
  let cursor = start;
  for (const b of blocks.sort((a,b) => a.start - b.start)) {
    if (cursor + duration <= b.start) return cursor;
    cursor = Math.max(cursor, b.end);
  }
  return cursor + duration <= start + allowed ? cursor : null;
}

function skillGaps() {
  const activeSkills = new Set(state.technicians.filter(t => t.active).flatMap(t => t.skills));
  const required = new Set(state.orders.filter(o => o.status !== "Complete").flatMap(o => o.skills));
  return [...required].filter(s => !activeSkills.has(s));
}

function validateManualAssignment(order, techId, day, start) {
  const tech = state.technicians.find(t => t.id === techId);
  const errors = [];
  const warnings = [];
  if (!tech) errors.push("Choose an active technician.");
  if (!isPartsSchedulable(order)) errors.push(`${order.id} parts readiness is ${order.parts}.`);
  if (!canStartOnDate(order, day)) warnings.push(`${order.id} cannot normally start before ${order.earliestStartDate}.`);
  if (tech && isTechAbsent(tech.id, day)) errors.push(`${tech.name} is marked absent on ${day}.`);
  const missing = tech ? order.skills.filter(s => !tech.skills.includes(s)) : order.skills;
  if (missing.length) warnings.push(`${tech?.name || "Technician"} is missing skills: ${missing.join(", ")}.`);
  const certMissing = missingCertifications(order, tech);
  if (certMissing.length) warnings.push(`${tech?.name || "Technician"} is missing certifications: ${certMissing.join(", ")}.`);
  const startMin = minutes(start);
  const plannedHours = plannedDuration(order);
  const endMin = startMin + Math.round(plannedHours * 60);
  if (tech && (startMin < minutes(tech.start) || endMin > minutes(tech.end))) errors.push(`${order.id} is outside ${tech.name}'s shift.`);
  const availability = bayAvailabilityFor(order.bay);
  if ((availability.outages || []).some(item => item.date === day)) errors.push(`${order.bay} is unavailable on ${day}.`);
  if (startMin < minutes(availability.start) || endMin > minutes(availability.end)) errors.push(`${order.id} is outside ${order.bay} availability (${availability.start}-${availability.end}).`);
  const techConflicts = buildScheduleIndex([day])[techId]?.[day]?.filter(b => b.orderId !== order.id && startMin < b.end && endMin > b.start) || [];
  const bayConflicts = (buildBayScheduleIndex([day])[order.bay]?.[day] || []).filter(b => !String(b.orderId).startsWith("resource-") && b.orderId !== order.id && startMin < b.end && endMin > b.start);
  if (techConflicts.length) errors.push(`${tech?.name || "Technician"} already has work in that time window.`);
  if (bayConflicts.length) errors.push(`${order.bay} is already booked in that time window.`);
  return { errors, warnings };
}

function manualAssign() {
  const order = state.orders.find(o => o.id === state.selectedOrderId);
  if (!order) return alert("Select an unscheduled work order first.");
  const techId = document.getElementById("manualTech").value;
  const day = document.getElementById("boardDate").value;
  const start = document.getElementById("manualStart").value;
  const validation = validateManualAssignment(order, techId, day, start);
  if (validation.errors.length && !confirm(`${validation.errors.join("\n")}\n\nAssign anyway as a dispatcher override?`)) return;
  snapshot();
  applySchedule(order, [{ techId, date: day, start, duration: plannedDuration(order) }]);
  state.selectedOrderId = null;
  state.recommendations.unshift({ level: validation.errors.length || validation.warnings.length ? "warning" : "", title: `${order.id} manually assigned`, body: `Manual override placed ${order.title} on ${day} at ${start}. ${validation.errors.concat(validation.warnings).join(" ")}` });
  audit(`${order.id} manually assigned`);
  render();
}

function dropAssign(orderId, techId, day, startOverride = "") {
  const order = state.orders.find(o => o.id === orderId);
  const tech = state.technicians.find(t => t.id === techId);
  if (!order || !tech) return;
  const schedules = buildScheduleIndex([day]);
  const baySchedules = buildBayScheduleIndex([day]);
  const requestedSlot = startOverride ? minutes(startOverride) : null;
  const slot = requestedSlot ?? nextCompatibleSlot(
    tech,
    schedules[techId][day].filter(b => b.orderId !== orderId),
    (baySchedules[order.bay]?.[day] || []).filter(b => b.orderId !== orderId),
    plannedDuration(order)
  );
  const missing = order.skills.filter(s => !tech.skills.includes(s));
  const validation = validateManualAssignment(order, techId, day, slot != null ? timeFromMinutes(slot) : tech.start);
  if (validation.errors.length && !confirm(`${validation.errors.join("\n")}\n\nMove anyway as a dispatcher override?`)) return;
  snapshot();
  if (!isPartsSchedulable(order)) {
    state.recommendations.unshift({
      level: "warning",
      title: `${order.id} moved despite parts status`,
      body: `${order.title} is marked ${order.parts}. This is a manual override and should be verified before work starts.`
    });
  }
  if (!slot) {
    state.recommendations.unshift({
      level: "error",
      title: `${order.id} was not moved`,
      body: `${tech.name} does not have enough open capacity on ${day} for ${plannedDuration(order)}h.`
    });
    render();
    return;
  }
  applySchedule(order, [{ techId, date: day, start: timeFromMinutes(slot), duration: plannedDuration(order) }]);
  state.selectedOrderId = null;
  state.recommendations.unshift({
    level: missing.length ? "warning" : "",
    title: `${order.id} manually moved to ${tech.name}`,
    body: missing.length
      ? `Manual override scheduled ${order.title} on ${day} at ${order.start}, but ${tech.name} is missing ${missing.join(", ")}.`
      : `Manual override scheduled ${order.title} on ${day} at ${order.start} with a full skill match${startOverride ? " from a time-slot drop" : ""}.`
  });
  audit(`${order.id} moved to ${tech.name} on ${day}`);
  render();
}

function unschedule(id) {
  snapshot();
  const o = state.orders.find(x => x.id === id);
  clearSchedule(o);
  audit(`${id} unscheduled`);
  render();
}
function updateStatus(id, status) {
  const o = state.orders.find(x => x.id === id);
  if (!o) return;
  if (status === "Complete") {
    const blockers = completionBlockers(o);
    if (blockers.length) {
      alert(`Cannot complete ${o.id} yet:\n${blockers.join("\n")}`);
      render();
      return;
    }
  }
  snapshot();
  o.status = status;
  addHistory(o, `Status changed to ${status}`);
  syncParentOperationFromChild(o);
  audit(`${id} status changed to ${status}`);
  render();
}

function applyTypeDefaults() {
  const t = state.workTypes.find(x => x.name === document.getElementById("orderType").value);
  if (!t) return;
  document.getElementById("orderDuration").value = learnedDurationForType(t);
  document.getElementById("orderSkills").value = t.skills.join(", ");
  document.getElementById("orderCerts").value = "";
  document.getElementById("orderBay").value = bayForWorkType(t.name);
}

function saveOrder(e) {
  e.preventDefault();
  snapshot();
  const id = document.getElementById("orderId").value || `WO-${Math.floor(1000 + Math.random() * 9000)}`;
  const existing = state.orders.find(o => o.id === id);
  const data = {
    id,
    title: document.getElementById("orderTitle").value,
    customer: document.getElementById("orderCustomer").value,
    dealer: document.getElementById("orderDealer").value,
    boat: document.getElementById("orderBoat").value,
    workType: document.getElementById("orderType").value,
    priority: document.getElementById("orderPriority").value,
    customerUrgency: document.getElementById("orderUrgency").value,
    dueDate: document.getElementById("orderDue").value,
    earliestStartDate: document.getElementById("orderEarliestStart").value,
    duration: Number(document.getElementById("orderDuration").value),
    durationLocked: true,
    skills: parseList(document.getElementById("orderSkills").value),
    requiredCertifications: parseList(document.getElementById("orderCerts").value),
    preferredTechId: document.getElementById("orderPreferredTech").value,
    continuityTechId: document.getElementById("orderContinuityTech").value,
    parts: document.getElementById("orderParts").value,
    bay: document.getElementById("orderBay").value,
    status: document.getElementById("orderStatus").value,
    description: document.getElementById("orderDescription").value,
    notes: document.getElementById("orderNotes").value,
    techId: existing?.techId || "",
    scheduledDate: existing?.scheduledDate || "",
    start: existing?.start || ""
  };
  if (existing) {
    Object.assign(existing, data);
    if (existing.status === "Unscheduled") clearSchedule(existing);
    audit(`${id} updated`);
  } else {
    state.orders.push({ ...data, operations: operationsForWorkType(data.workType), checklist: checklistForWorkType(data.workType), dependencies: dependencyHint(data.workType), actualHours: 0, timeEntries: [], rework: false, qualityHold: false, unitHistory: [`${id} created for ${data.customer || data.dealer || data.boat}`], attachments: [] });
    audit(`${id} created`);
  }
  clearOrderForm(); render();
}
function editOrder(id) {
  const o = state.orders.find(x => x.id === id);
  showView("orders");
  document.getElementById("orderId").value = o.id;
  document.getElementById("orderTitle").value = o.title;
  document.getElementById("orderCustomer").value = o.customer || "";
  document.getElementById("orderDealer").value = o.dealer || "";
  document.getElementById("orderBoat").value = o.boat;
  document.getElementById("orderType").value = o.workType;
  document.getElementById("orderPriority").value = o.priority;
  document.getElementById("orderUrgency").value = o.customerUrgency || "Normal";
  document.getElementById("orderDue").value = o.dueDate;
  document.getElementById("orderEarliestStart").value = o.earliestStartDate || "";
  document.getElementById("orderDuration").value = o.duration;
  document.getElementById("orderSkills").value = o.skills.join(", ");
  document.getElementById("orderCerts").value = (o.requiredCertifications || []).join(", ");
  document.getElementById("orderPreferredTech").value = o.preferredTechId || "";
  document.getElementById("orderContinuityTech").value = o.continuityTechId || "";
  document.getElementById("orderParts").value = o.parts || "Ready";
  document.getElementById("orderBay").value = o.bay || bayForWorkType(o.workType);
  document.getElementById("orderStatus").value = o.status;
  document.getElementById("orderDescription").value = o.description;
  document.getElementById("orderNotes").value = o.notes;
}
function deleteOrder(id) { snapshot(); state.orders = state.orders.filter(o => o.id !== id); audit(`${id} deleted`); render(); }
function clearOrderForm() { document.getElementById("orderForm").reset(); document.getElementById("orderId").value = ""; applyTypeDefaults(); }

function fillSampleBatch() {
  const base = state.boardDate || fmtDate(new Date());
  document.getElementById("batchOrders").value = [
    `Install VHF antenna | Dealer demo / 18 ProSport | Electronics Install | High | ${addDays(base, 2)} | Parts staged in electronics cage`,
    `Repair rub rail fasteners | Customer Brooks / 20 XTR | Warranty Repair | Medium | ${addDays(base, 3)} | Confirm photos before closing`,
    `Delivery detail | Stock Unit LB-4520 | Wash & Detail | Medium | ${addDays(base, 1)} | Needed before showroom handoff`
  ].join("\n");
}

function saveBatchOrders(e) {
  e.preventDefault();
  snapshot();
  const lines = document.getElementById("batchOrders").value.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const created = [];
  lines.forEach(line => {
    const parts = line.split("|").map(p => p.trim());
    if (parts.length < 5) return;
    const [title, boat, workType, priority, dueDate, notes = ""] = parts;
    const wt = state.workTypes.find(t => t.name.toLowerCase() === workType.toLowerCase()) || state.workTypes[0];
    const party = inferCustomerDealer(boat);
    created.push({
      id: nextWorkOrderId(),
      title,
      customer: party.customer,
      dealer: party.dealer,
      boat,
      workType: wt.name,
      priority: ["Critical", "High", "Medium", "Low"].includes(priority) ? priority : "Medium",
      customerUrgency: notes.toLowerCase().includes("escalated") || notes.toLowerCase().includes("urgent") ? "Escalated" : notes.toLowerCase().includes("delivery") ? "Delivery Promise" : "Normal",
      dueDate,
      duration: learnedDurationForType(wt),
      skills: [...wt.skills],
      requiredCertifications: [],
      preferredTechId: "",
      continuityTechId: "",
      parts: notes.toLowerCase().includes("waiting") ? "Waiting on Parts" : notes.toLowerCase().includes("staged") ? "Staged" : "Ready",
      bay: bayForWorkType(wt.name),
      status: "Unscheduled",
      techId: "",
      scheduledDate: "",
      start: "",
      description: wt.notes || "",
      notes
      , operations: operationsForWorkType(wt.name),
      checklist: checklistForWorkType(wt.name),
      dependencies: dependencyHint(wt.name),
      actualHours: 0,
      timeEntries: [],
      rework: false,
      qualityHold: false,
      unitHistory: [],
      attachments: []
    });
  });
  state.orders.push(...created);
  document.getElementById("batchOrders").value = "";
  state.recommendations.unshift({
    level: created.length ? "" : "warning",
    title: `${created.length} batch work orders created`,
    body: created.length ? `Added ${created.map(o => o.id).join(", ")} to the unscheduled queue.` : "No valid batch rows were found."
  });
  audit(`Batch created ${created.length} work orders`);
  render();
}

function nextWorkOrderId() {
  const max = state.orders.reduce((highest, o) => {
    const n = Number(String(o.id).replace(/\D/g, ""));
    return Number.isFinite(n) ? Math.max(highest, n) : highest;
  }, 1000);
  return `WO-${max + 1}`;
}

function saveTech(e) {
  e.preventDefault();
  snapshot();
  const id = document.getElementById("techId").value || uid("tech");
  const data = {
    id, name: document.getElementById("techName").value, role: document.getElementById("techRole").value,
    skills: parseList(document.getElementById("techSkills").value), certifications: parseList(document.getElementById("techCerts").value), start: document.getElementById("techStart").value,
    end: document.getElementById("techEnd").value, capacity: Number(document.getElementById("techCapacity").value),
    area: document.getElementById("techArea").value, active: document.getElementById("techActive").checked
  };
  const existing = state.technicians.find(t => t.id === id);
  if (existing) { Object.assign(existing, data); audit(`${data.name} technician updated`); } else { state.technicians.push(data); audit(`${data.name} technician created`); }
  clearTechForm(); render();
}
function editTech(id) {
  const t = state.technicians.find(x => x.id === id);
  showView("techs");
  document.getElementById("techId").value = t.id;
  document.getElementById("techName").value = t.name;
  document.getElementById("techRole").value = t.role;
  document.getElementById("techSkills").value = t.skills.join(", ");
  document.getElementById("techCerts").value = (t.certifications || []).join(", ");
  document.getElementById("techStart").value = t.start;
  document.getElementById("techEnd").value = t.end;
  document.getElementById("techCapacity").value = t.capacity;
  document.getElementById("techArea").value = t.area;
  document.getElementById("techActive").checked = t.active;
}
function deleteTech(id) { snapshot(); state.technicians = state.technicians.filter(t => t.id !== id); audit(`Technician ${id} deleted`); render(); }
function clearTechForm() { document.getElementById("techForm").reset(); document.getElementById("techId").value = ""; document.getElementById("techActive").checked = true; }

function saveBay(e) {
  e.preventDefault();
  const name = document.getElementById("bayName").value.trim();
  if (!name) return;
  snapshot();
  const existed = state.bays.includes(name);
  if (!existed) {
    state.bays.push(name);
    state.bays.sort((a, b) => a.localeCompare(b));
  }
  state.bayAvailability ||= {};
  state.bayAvailability[name] = {
    start: document.getElementById("bayStart").value || "08:00",
    end: document.getElementById("bayEnd").value || "17:00",
    outages: document.getElementById("bayOutages").value.split(",").map(date => date.trim()).filter(Boolean).map(date => ({
      date,
      reason: document.getElementById("bayOutageReason").value.trim()
    }))
  };
  audit(`${name} schedulable resource ${existed ? "updated" : "created"}`);
  clearBayForm();
  render();
}

function editBay(name) {
  const availability = bayAvailabilityFor(name);
  document.getElementById("bayName").value = name;
  document.getElementById("bayStart").value = availability.start;
  document.getElementById("bayEnd").value = availability.end;
  document.getElementById("bayOutages").value = (availability.outages || []).map(item => item.date).join(", ");
  document.getElementById("bayOutageReason").value = (availability.outages || []).find(item => item.reason)?.reason || "";
}

function deleteBay(name) {
  const inUse = state.orders.some(order => order.bay === name);
  if (inUse) {
    alert(`${name} is assigned to one or more work orders and cannot be deleted.`);
    return;
  }
  if (!confirm(`Delete ${name} from schedulable resources?`)) return;
  snapshot();
  state.bays = state.bays.filter(bay => bay !== name);
  if (state.bayAvailability) delete state.bayAvailability[name];
  audit(`${name} schedulable resource deleted`);
  clearBayForm();
  render();
}

function clearBayForm() {
  document.getElementById("bayForm").reset();
  document.getElementById("bayName").value = "";
  document.getElementById("bayStart").value = "08:00";
  document.getElementById("bayEnd").value = "17:00";
  document.getElementById("bayOutages").value = "";
  document.getElementById("bayOutageReason").value = "";
}

function saveType(e) {
  e.preventDefault();
  snapshot();
  const id = document.getElementById("typeId").value || uid("type");
  const data = {
    id, name: document.getElementById("typeName").value, duration: Number(document.getElementById("typeDuration").value),
    skills: parseList(document.getElementById("typeSkills").value), notes: document.getElementById("typeNotes").value
  };
  const existing = state.workTypes.find(t => t.id === id);
  if (existing) { Object.assign(existing, data); audit(`${data.name} work type updated`); } else { state.workTypes.push(data); audit(`${data.name} work type created`); }
  clearTypeForm(); render();
}
function editType(id) {
  const t = state.workTypes.find(x => x.id === id);
  showView("types");
  document.getElementById("typeId").value = t.id;
  document.getElementById("typeName").value = t.name;
  document.getElementById("typeDuration").value = t.duration;
  document.getElementById("typeSkills").value = t.skills.join(", ");
  document.getElementById("typeNotes").value = t.notes;
}
function deleteType(id) { snapshot(); state.workTypes = state.workTypes.filter(t => t.id !== id); audit(`Work type ${id} deleted`); render(); }
function clearTypeForm() { document.getElementById("typeForm").reset(); document.getElementById("typeId").value = ""; }

function snapshot() {
  lastSnapshot = JSON.stringify(state);
  redoSnapshot = null;
}

function audit(text) {
  state.auditLog ||= [];
  state.auditLog.unshift({ at: new Date().toLocaleString(), text });
  state.auditLog = state.auditLog.slice(0, 200);
}

function logError(text) {
  state.errorLog ||= [];
  state.errorLog.unshift({ at: new Date().toLocaleString(), text });
  state.errorLog = state.errorLog.slice(0, 100);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  reportErrorEvent(text);
}

async function reportErrorEvent(text, detail = {}) {
  if (!backendOnline || !canUseBackend()) return;
  try {
    await fetch("/api/errors", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        source: "frontend",
        message: text,
        detail: {
          ...detail,
          path: typeof location !== "undefined" ? location.pathname : "",
          version: remoteVersion
        }
      })
    });
  } catch (error) {
    console.warn("Backend error reporting failed.", error);
  }
}

function currentRole() {
  return session?.user?.role || "dispatcher";
}

function canWriteOperations() {
  return ["admin", "manager", "dispatcher"].includes(currentRole());
}

function canManageOperations() {
  return ["admin", "manager"].includes(currentRole());
}

function applyRolePermissions() {
  const role = currentRole();
  if (document.body) document.body.dataset.role = role;
  updateRoleHint();
  const canWrite = canWriteOperations();
  const canAdmin = canManageOperations();
  const writeIds = ["optimizeBtn", "approvePlanBtn", "manualAssignBtn", "markAbsentBtn", "markOverrunBtn", "seedBtn", "exportBtn", "salesforceImportBtn", "salesforceExportBtn"];
  writeIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !canWrite;
  });
  ["importBtn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !canAdmin;
  });
  ["techForm", "typeForm", "bayForm"].forEach(id => {
    document.querySelectorAll(`#${id} input, #${id} select, #${id} textarea, #${id} button`).forEach(el => { el.disabled = !canAdmin; });
  });
  const visibleViewsByRole = {
    technician: ["mobile"],
    dispatcher: ["dispatch", "orders", "mobile"],
    manager: ["dispatch", "dashboard", "orders", "techs", "types", "mobile"],
    admin: ["dispatch", "dashboard", "orders", "techs", "types", "mobile"]
  };
  const visible = visibleViewsByRole[role] || visibleViewsByRole.dispatcher;
  document.querySelectorAll(".tab").forEach(tab => {
    tab.hidden = !visible.includes(tab.dataset.view);
  });
  if (document.querySelector(".tab.active")?.hidden) {
    showView(firstVisibleView());
  }
}

function undoLastAction() {
  if (!lastSnapshot) return;
  redoSnapshot = JSON.stringify(state);
  state = normalizeState(JSON.parse(lastSnapshot));
  lastSnapshot = null;
  audit("Undid last action");
  render();
}

function redoLastAction() {
  if (!redoSnapshot) return;
  lastSnapshot = JSON.stringify(state);
  state = normalizeState(JSON.parse(redoSnapshot));
  redoSnapshot = null;
  audit("Redid last action");
  render();
}

init();
