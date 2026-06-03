const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
let source = fs.readFileSync(path.join(root, "app.js"), "utf8");
source = source.replace(/\ninit\(\);\s*$/, `
render = () => {};
save = () => {};
snapshot = () => {};
audit = () => {};
globalThis.__api = {
  optimizeSchedule,
  normalizeState,
  get state() { return state; },
  setState(value) { state = normalizeState(value); }
};
`);

const storage = new Map();
const documentStub = {
  getElementById() {
    return {
      value: "",
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
  createElement() {
    return {};
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
  Blob: class {},
  URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
  location: { protocol: "file:" },
  document: documentStub,
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  },
  EventSource: class {},
  FileReader: class {},
  fetch: async () => { throw new Error("fetch should not be called in scheduler validation"); },
  alert: () => {},
  confirm: () => true
};

context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "app.js" });

function baseState(orders) {
  return {
    selectedOrderId: null,
    activeOrderId: null,
    schedulerMode: "balanced",
    filters: { team: "", skill: "", status: "", parts: "", due: "", text: "" },
    savedViews: [],
    auditLog: [],
    aiPlan: null,
    boardMode: "day",
    boardDate: "2026-06-03",
    recommendations: [],
    bays: ["Rigging Bay", "PDI Lane"],
    workTypes: [
      { id: "wt-rig", name: "Rigging Install", duration: 7.5, learnedDuration: 7.5, skills: ["Rigging"], description: "" },
      { id: "wt-pdi", name: "PDI", duration: 2, learnedDuration: 2, skills: ["PDI"], description: "" },
      { id: "wt-detail", name: "Wash & Detail", duration: 2, learnedDuration: 2, skills: ["Detailing"], description: "" }
    ],
    technicians: [
      { id: "tech-rig", name: "Rig Tech", role: "Tech", skills: ["Rigging"], start: "08:00", end: "16:00", capacity: 100, area: "Rigging", active: true },
      { id: "tech-pdi", name: "PDI Tech", role: "Tech", skills: ["PDI"], start: "08:00", end: "16:00", capacity: 100, area: "PDI", active: true },
      { id: "tech-detail", name: "Detail Tech", role: "Tech", skills: ["Detailing"], start: "08:00", end: "16:00", capacity: 100, area: "Detail", active: true }
    ],
    orders,
    users: [],
    attachments: []
  };
}

function order(overrides) {
  return {
    id: "WO-TEST",
    title: "Test order",
    boat: "V20 DC / HIN-TEST",
    customer: "Test Customer",
    workType: "PDI",
    priority: "High",
    dueDate: "2026-06-03",
    duration: 2,
    skills: ["PDI"],
    status: "Unscheduled",
    techId: null,
    scheduledDate: null,
    start: null,
    parts: "Ready",
    bay: "PDI Lane",
    dependencies: "",
    notes: "",
    description: "",
    operations: [],
    attachments: [],
    ...overrides
  };
}

const api = context.__api;

api.setState(baseState([
  order({
    id: "WO-2001",
    title: "Install motor",
    workType: "Rigging Install",
    duration: 7.5,
    skills: ["Rigging"],
    bay: "Rigging Bay"
  }),
  order({
    id: "WO-2002",
    title: "Final PDI",
    dependencies: "WO-2001 complete"
  })
]));
api.optimizeSchedule();

const rigging = api.state.orders.find(o => o.id === "WO-2001");
const pdi = api.state.orders.find(o => o.id === "WO-2002");
assert.strictEqual(rigging.status, "Scheduled", "dependency prerequisite should schedule");
assert.strictEqual(rigging.techId, "tech-rig", "rigging should match rigging skill");
assert.strictEqual(rigging.scheduledDate, "2026-06-03", "rigging should use the first board day");
assert.strictEqual(rigging.start, "08:00", "rigging should start at shift open");
assert.strictEqual(pdi.status, "Scheduled", "dependent PDI should schedule after prerequisite");
assert.strictEqual(pdi.techId, "tech-pdi", "PDI should match PDI skill");
assert(pdi.scheduledDate > rigging.scheduledDate || pdi.start > rigging.start, "PDI should not schedule before its dependency");
assert.strictEqual(pdi.scheduledDate, "2026-06-04", "PDI should move to the next day when dependency plus delay cannot fit");
assert(api.state.recommendations.some(r => r.title.includes("WO-2002") && r.body.includes("Dependency-aware sequencing")), "dependent recommendation should explain sequencing");

api.setState(baseState([
  order({
    id: "WO-3001",
    title: "Blocked detail",
    workType: "Wash & Detail",
    duration: 2,
    skills: ["Detailing"],
    parts: "Backordered",
    bay: "PDI Lane"
  }),
  order({
    id: "WO-3002",
    title: "Ready PDI",
    workType: "PDI",
    duration: 2,
    skills: ["PDI"],
    parts: "Ready",
    bay: "PDI Lane"
  })
]));
api.optimizeSchedule();

const held = api.state.orders.find(o => o.id === "WO-3001");
const ready = api.state.orders.find(o => o.id === "WO-3002");
assert.strictEqual(held.status, "Unscheduled", "parts-held work should remain unscheduled");
assert.strictEqual(ready.status, "Scheduled", "parts-held work should not stop other ready work from scheduling");
assert(api.state.recommendations.some(r => r.title.includes("WO-3001 held for parts")), "held work should be reported");

console.log("scheduler dependency validation passed");
