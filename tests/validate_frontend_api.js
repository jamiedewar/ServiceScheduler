const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
let source = fs.readFileSync(path.join(root, "app.js"), "utf8");
source = source.replace(/\ninit\(\);\s*$/, `
render = () => { globalThis.__renderCount = (globalThis.__renderCount || 0) + 1; };
globalThis.__api = {
  addAttachments,
  apiHeaders,
  exportSalesforce,
  exportState,
  loginAsSelectedUser,
  normalizeSalesforceRecords,
  pollRemoteState,
  refreshDurableAudit,
  refreshOperationalReadiness,
  resetSeedData,
  restoreBackup,
  saveRemoteState,
  startRealtimeSync,
  get eventSource() { return eventSource; },
  get operationalReadiness() { return operationalReadiness; },
  get durableAuditEvents() { return durableAuditEvents; },
  get state() { return state; },
  get backendOnline() { return backendOnline; },
  setBackendOnline(value) { backendOnline = value; },
  setSession(value) { session = value; },
  setRemoteVersion(value) { remoteVersion = value; }
};
`);

const listeners = {};
let eventSourceUrl = "";
let remoteState = null;
let downloadedFilename = "";
let alertMessage = "";
const fetchCalls = [];
const elementValues = { loginUser: "manager", loginPin: "1357" };

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body
  };
}

const storage = new Map();
const documentStub = {
  getElementById(id) {
    return {
      value: elementValues[id] || "",
      checked: false,
      innerHTML: "",
      classList: { add() {}, remove() {} },
      addEventListener() {},
      reset() {}
    };
  },
  querySelectorAll() {
    return [];
  },
  querySelector() {
    return null;
  },
  addEventListener() {},
  createElement(tag) {
    if (tag !== "a") return {};
    return {
      href: "",
      download: "",
      click() {
        downloadedFilename = this.download;
      }
    };
  }
};

const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  Date,
  Math,
  JSON,
  Array,
  Object,
  Number,
  String,
  Blob: class {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
    }
  },
  URL: {
    createObjectURL: () => "blob:backup",
    revokeObjectURL() {}
  },
  location: { protocol: "http:" },
  document: documentStub,
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  },
  EventSource: class {
    constructor(url) {
      eventSourceUrl = url;
      this.url = url;
    }
    addEventListener(type, handler) {
      listeners[type] = handler;
    }
    close() {}
  },
  confirm: () => true,
  alert: message => { alertMessage = message; },
  fetch: async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url) === "/api/backup") {
      return response({
        format: "legend-service-scheduler-backup-v1",
        state: remoteState,
        attachments: [],
        auditLog: [],
        salesforceImports: []
      });
    }
    if (String(url) === "/api/readiness") {
      return response({
        ok: true,
        service: "legend-service-scheduler",
        environment: "staging",
        database: "sqlite",
        checks: [
          { name: "database", ok: true, detail: "ready" },
          { name: "roles", ok: true, detail: "admin:1, dispatcher:1" }
        ],
        backups: { enabled: true, count: 2, retention: 20, latest: "scheduler-backup-v2.json" },
        recentErrors: [],
        findings: []
      });
    }
    if (String(url) === "/api/audit") {
      return response({
        events: [{
          actor: "dispatcher",
          role: "dispatcher",
          action: "schedule.change",
          entityType: "work_order",
          entityId: "WO-001",
          payload: { changes: { scheduledDate: { before: "", after: "2026-06-03" } } },
          createdAt: 1780462000
        }]
      });
    }
    if (String(url) === "/api/export/salesforce") {
      return response({
        format: "legend-service-scheduler-salesforce-export-v1",
        source: "legend-service-scheduler",
        records: [{
          WorkOrderNumber: "WO-001",
          Subject: "Exported order",
          PartsReadiness: "Ready",
          ScheduleSegments: []
        }]
      });
    }
    if (String(url) === "/api/restore") {
      remoteState = JSON.parse(options.body).state;
      remoteState._meta = { version: 4 };
      return response({ ok: true, version: 4 });
    }
    if (String(url) === "/api/demo/reset") {
      remoteState = JSON.parse(options.body).state;
      remoteState._meta = { version: 5 };
      return response({ ok: true, version: 5 });
    }
    if (String(url) === "/api/login") {
      return response({
        ok: true,
        token: "manager-token",
        expiresAt: 1780500000,
        user: { id: "manager", name: "Manager", role: "manager" }
      });
    }
    if (String(url).startsWith("/api/attachments")) {
      return response({
        ok: true,
        attachment: {
          id: "att-test",
          orderId: "WO-001",
          name: "photo.jpg",
          size: 16,
          type: "image/jpeg",
          addedAt: 1780462000,
          addedBy: "dispatcher",
          url: "/api/attachments/att-test"
        }
      });
    }
    if (String(url).startsWith("/api/state") && options.method === "POST") {
      return response({ ok: true, version: 3 });
    }
    if (String(url) === "/api/state") {
      return response(remoteState);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }
};

context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "app.js" });

(async () => {
  const api = context.__api;
  assert(api.state.orders.length >= 20, "seed orders should load");
  assert(api.state.userTechnicianLinks.technician, "seed state should link the technician login to a technician profile");
  api.setBackendOnline(true);
  api.setRemoteVersion(1);
  api.setSession({ token: "session-token", user: { id: "dispatcher", name: "Dispatcher", role: "dispatcher" } });
  assert.strictEqual(api.apiHeaders().Authorization, "Bearer session-token", "API headers should use bearer session token");
  await api.refreshOperationalReadiness();
  const readinessCall = fetchCalls.find(call => call.url === "/api/readiness");
  assert(readinessCall, "readiness refresh should call backend readiness endpoint");
  assert.strictEqual(readinessCall.options.headers.Authorization, "Bearer session-token", "readiness refresh should use bearer auth");
  assert.strictEqual(api.operationalReadiness.ok, true, "readiness state should be available to the dashboard");
  await api.refreshDurableAudit();
  assert(!fetchCalls.some(call => call.url === "/api/audit"), "dispatcher should not fetch manager-only durable audit");
  api.setSession({ token: "manager-token", user: { id: "manager", name: "Manager", role: "manager" } });
  await api.refreshDurableAudit();
  const auditCall = fetchCalls.find(call => call.url === "/api/audit");
  assert(auditCall, "manager audit refresh should call backend audit endpoint");
  assert.strictEqual(auditCall.options.headers.Authorization, "Bearer manager-token", "audit refresh should use manager bearer auth");
  assert.strictEqual(api.durableAuditEvents[0].action, "schedule.change", "durable audit events should populate dashboard state");
  api.setSession({ token: "session-token", user: { id: "dispatcher", name: "Dispatcher", role: "dispatcher" } });

  remoteState = JSON.parse(JSON.stringify(api.state));
  remoteState._meta = { version: 1 };
  await api.loginAsSelectedUser();
  const loginCall = fetchCalls.find(call => call.url === "/api/login");
  assert(loginCall, "login should call backend");
  assert.strictEqual(JSON.parse(loginCall.options.body).pin, "1357", "login should include optional PIN");
  api.setSession({ token: "session-token", user: { id: "dispatcher", name: "Dispatcher", role: "dispatcher" } });

  api.startRealtimeSync();
  assert.strictEqual(eventSourceUrl, "/api/events", "SSE should subscribe to /api/events");
  assert.strictEqual(typeof listeners.state, "function", "SSE state listener should be registered");

  const orderId = api.state.orders[0].id;
  await api.addAttachments(orderId, [{
    name: "photo.jpg",
    size: 16,
    type: "image/jpeg",
    arrayBuffer: async () => Buffer.from("fake-image-bytes")
  }]);
  const uploadCall = fetchCalls.find(call => call.url.startsWith("/api/attachments"));
  assert(uploadCall, "attachment upload should call backend");
  assert.strictEqual(uploadCall.options.method, "POST");
  assert.strictEqual(uploadCall.options.headers.Authorization, "Bearer session-token", "attachment upload should use bearer auth");
  assert(api.state.orders[0].attachments.some(a => a.url === "/api/attachments/att-test"), "uploaded attachment URL should be stored on order");

  remoteState = JSON.parse(JSON.stringify(api.state));
  remoteState.orders.push({ id: "WO-REMOTE", title: "Remote update", status: "Unscheduled" });
  remoteState._meta = { version: 2 };
  await listeners.state({ data: JSON.stringify({ version: 2 }) });
  assert(api.state.orders.some(order => order.id === "WO-REMOTE"), "SSE-triggered poll should apply remote state");

  await api.exportState();
  const backupCall = fetchCalls.find(call => call.url === "/api/backup");
  assert(backupCall, "export should request a full backend backup when online");
  assert.strictEqual(backupCall.options.headers.Authorization, "Bearer session-token", "backup export should use bearer auth");
  assert(downloadedFilename.startsWith("legend-service-scheduler-backup-"), "backup export should download a backup file");

  await api.exportSalesforce();
  const salesforceExportCall = fetchCalls.find(call => call.url === "/api/export/salesforce");
  assert(salesforceExportCall, "Salesforce export should request backend Salesforce export when online");
  assert.strictEqual(salesforceExportCall.options.headers.Authorization, "Bearer session-token", "Salesforce export should use bearer auth");
  assert(downloadedFilename.startsWith("legend-service-scheduler-salesforce-"), "Salesforce export should download a Salesforce file");
  const normalizedSalesforce = api.normalizeSalesforceRecords({
    records: [{
      Id: "SF-FRONTEND",
      Subject: "Imported rich record",
      AccountName: "Jamie Dewar",
      DealerName: "Sudbury Marine",
      AssetName: "21 XTR",
      Status: "Scheduled",
      PartsReadiness: "Staged",
      AssignedTechnicianId: "tech-1",
      ScheduledDate: "2026-06-03",
      ScheduledStart: "09:00",
      ScheduleSegments: [{ techId: "tech-1", date: "2026-06-03", start: "09:00", duration: 2 }],
      ReworkFlag: true,
      QualityHold: "true",
      TimeEntries: [{ hours: 1.5 }],
      Attachments: [{ Name: "front-photo.jpg", ContentType: "image/jpeg", Size: 33 }]
    }]
  });
  assert.strictEqual(normalizedSalesforce[0].status, "Scheduled", "frontend Salesforce import should preserve scheduled status");
  assert.strictEqual(normalizedSalesforce[0].customer, "Jamie Dewar", "frontend Salesforce import should preserve customer account");
  assert.strictEqual(normalizedSalesforce[0].dealer, "Sudbury Marine", "frontend Salesforce import should preserve dealer name");
  assert.strictEqual(normalizedSalesforce[0].boat, "21 XTR", "frontend Salesforce import should preserve asset/unit name");
  assert.strictEqual(normalizedSalesforce[0].segments[0].start, "09:00", "frontend Salesforce import should preserve schedule segments");
  assert.strictEqual(normalizedSalesforce[0].rework, true, "frontend Salesforce import should preserve rework flag");
  assert.strictEqual(normalizedSalesforce[0].qualityHold, true, "frontend Salesforce import should preserve quality hold");
  assert.strictEqual(normalizedSalesforce[0].timeEntries[0].hours, 1.5, "frontend Salesforce import should preserve time entries");
  assert.strictEqual(normalizedSalesforce[0].attachments[0].name, "front-photo.jpg", "frontend Salesforce import should normalize attachments");

  const backup = JSON.parse(JSON.stringify({
    format: "legend-service-scheduler-backup-v1",
    state: api.state,
    attachments: [],
    auditLog: [],
    salesforceImports: []
  }));
  backup.state.orders.push({ id: "WO-RESTORED", title: "Restored order", status: "Unscheduled" });
  api.setSession({ token: "manager-token", user: { id: "manager", name: "Manager", role: "manager" } });
  await api.restoreBackup(backup, "backup.json");
  const restoreCall = fetchCalls.find(call => call.url === "/api/restore");
  assert(restoreCall, "restore should post full backend backup");
  assert.strictEqual(restoreCall.options.headers.Authorization, "Bearer manager-token", "backup restore should use manager bearer auth");
  assert(api.state.orders.some(order => order.id === "WO-RESTORED"), "restore should reload restored remote state");
  api.setSession({ token: "session-token", user: { id: "dispatcher", name: "Dispatcher", role: "dispatcher" } });

  await api.resetSeedData();
  const demoResetCall = fetchCalls.find(call => call.url === "/api/demo/reset");
  assert(demoResetCall, "demo reset should post seed state to backend when online");
  assert.strictEqual(demoResetCall.options.method, "POST");
  assert.strictEqual(demoResetCall.options.headers.Authorization, "Bearer session-token", "demo reset should use bearer auth");
  assert(api.state.orders.length >= 20, "demo reset should reload realistic seed orders");

  api.setSession({ token: "technician-token", user: { id: "technician", name: "Technician", role: "technician" } });
  downloadedFilename = "";
  const callsBeforeTechExport = fetchCalls.length;
  await api.exportState();
  await api.exportSalesforce();
  await api.resetSeedData();
  await api.restoreBackup(backup, "backup.json");
  assert.strictEqual(fetchCalls.length, callsBeforeTechExport, "technician should not call export/reset endpoints");
  assert.strictEqual(downloadedFilename, "", "technician should not download protected exports");
  assert(alertMessage.includes("limited to manager"), "technician should see role-limited action feedback");
  const callsBeforeTechPhoto = fetchCalls.length;
  await api.addAttachments(api.state.orders[0].id, [{
    name: "technician-photo.jpg",
    size: 24,
    type: "image/jpeg",
    arrayBuffer: async () => Buffer.from("technician-photo-bytes")
  }]);
  const technicianUpload = fetchCalls.slice(callsBeforeTechPhoto).find(call => call.url.startsWith("/api/attachments"));
  assert(technicianUpload, "technician should be able to upload progress photos");
  assert.strictEqual(technicianUpload.options.headers.Authorization, "Bearer technician-token", "technician attachment upload should use technician bearer auth");
  assert(api.state.orders[0].attachments.some(a => a.url === "/api/attachments/att-test"), "technician-uploaded attachment metadata should remain on the order");
  await api.saveRemoteState("technician.progress");
  const technicianSave = fetchCalls.find(call =>
    call.url === "/api/state?action=technician.progress" &&
    call.options.headers.Authorization === "Bearer technician-token"
  );
  assert(technicianSave, "technician progress autosave should post to backend state endpoint with technician bearer auth");

  console.log("frontend API validation passed");
  process.exit(0);
})();
