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
  dropAssign,
  assignmentConflictPreview,
  deleteBay,
  saveBay,
  splitOperations,
  updateStatus,
  completionBlockers,
  addTimeEntry,
  addChecklistItem,
  markJobOverrunAndReplan,
  toggleOperation,
  toggleChecklist,
  validateManualAssignment,
  filteredOrders,
  plannedDuration,
  scheduleSegments,
  normalizeState,
  get state() { return state; },
  setState(value) { state = normalizeState(value); }
};
`);

const storage = new Map();
const documentStub = {
  values: {},
  getElementById(id) {
    return {
      value: this.values[id] || "",
      checked: false,
      innerHTML: "",
      classList: { add() {}, remove() {} },
      addEventListener() {},
      reset() { this.value = ""; }
    };
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener() {},
  createElement() { return {}; }
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
  fetch: async () => { throw new Error("fetch should not be called"); },
  alert: () => {},
  confirm: () => true
};

context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "app.js" });

function baseState(orders, overrides = {}) {
  return {
    selectedOrderId: null,
    activeOrderId: null,
    schedulerMode: "balanced",
    filters: { team: "", skill: "", status: "", parts: "", due: "", text: "" },
    savedViews: [],
    auditLog: [],
    errorLog: [],
    aiPlan: null,
    scenarioDiff: null,
    boardMode: "day",
    boardDate: "2026-06-03",
    recommendations: [],
    bays: ["Service Bay 1", "Electronics Bench"],
    workTypes: [
      { id: "wt-service", name: "Mechanical Inspection", duration: 12, learnedDuration: 12, skills: ["Mechanical"] },
      { id: "wt-electronics", name: "Electronics Install", duration: 3, learnedDuration: 3, skills: ["Electronics"] }
    ],
    technicians: [
      { id: "tech-a", name: "General Tech", role: "Tech", skills: ["Mechanical"], certifications: [], start: "08:00", end: "16:00", capacity: 100, area: "Service", active: true },
      { id: "tech-b", name: "Certified Electronics", role: "Tech", skills: ["Electronics", "Mechanical"], certifications: ["NMEA"], start: "08:00", end: "16:00", capacity: 100, area: "Electronics", active: true }
    ],
    absences: [],
    orders,
    ...overrides
  };
}

function order(overrides) {
  return {
    id: "WO-LAUNCH",
    title: "Launch test",
    customer: "Customer",
    dealer: "",
    boat: "Customer / 20 XTR",
    description: "",
    workType: "Mechanical Inspection",
    priority: "High",
    customerUrgency: "Normal",
    dueDate: "2026-06-05",
    duration: 12,
    skills: ["Mechanical"],
    requiredCertifications: [],
    preferredTechId: "",
    continuityTechId: "",
    status: "Unscheduled",
    techId: "",
    scheduledDate: "",
    start: "",
    segments: [],
    parts: "Ready",
    bay: "Service Bay 1",
    dependencies: "",
    notes: "",
    operations: [],
    checklist: [],
    attachments: [],
    ...overrides
  };
}

const api = context.__api;

api.setState(baseState([]));
const savedViewNames = api.state.savedViews.map(view => view.name).sort();
assert.strictEqual(
  JSON.stringify(savedViewNames),
  JSON.stringify(["Detail", "PDI", "Production", "Rigging", "Service", "Warranty", "Yard"].sort()),
  "required shop saved views should be backfilled during state normalization"
);
assert.strictEqual(
  api.state.savedViews.find(view => view.name === "Rigging").filters.team,
  "Rigging",
  "Rigging saved view should filter to the rigging team"
);
assert.strictEqual(
  api.state.savedViews.find(view => view.name === "Warranty").filters.skill,
  "Warranty",
  "Warranty saved view should filter to warranty work"
);
api.setState(baseState([
  order({ id: "WO-CUSTOMER", title: "Customer filter", customer: "Jamie Dewar", dealer: "", boat: "21 XTR" }),
  order({ id: "WO-DEALER", title: "Dealer filter", customer: "", dealer: "Sudbury Marine", boat: "Dealer stock LB-100" })
]));
api.state.filters.text = "Sudbury";
assert.deepStrictEqual(api.filteredOrders(api.state.orders).map(item => item.id), ["WO-DEALER"], "text filter should match explicit dealer names");
api.state.filters.text = "Jamie";
assert.deepStrictEqual(api.filteredOrders(api.state.orders).map(item => item.id), ["WO-CUSTOMER"], "text filter should match explicit customer names");

api.setState(baseState([
  order({
    id: "WO-FLEX",
    title: "Flexible work",
    duration: 2,
    priority: "Medium",
    customerUrgency: "Flexible",
    dueDate: "2026-06-06"
  }),
  order({
    id: "WO-ESC",
    title: "Escalated customer work",
    duration: 2,
    priority: "Medium",
    customerUrgency: "Escalated",
    dueDate: "2026-06-06"
  })
]));
api.optimizeSchedule();
const urgent = api.state.orders.find(o => o.id === "WO-ESC");
const flexible = api.state.orders.find(o => o.id === "WO-FLEX");
assert.strictEqual(urgent.start, "08:00", "escalated customer work should schedule before same-priority flexible work");
assert.notStrictEqual(flexible.start, "08:00", "flexible work should not take the first slot when escalated work is available");
assert(api.state.recommendations.some(r => r.body.includes("Customer urgency Escalated")), "AI explanation should include customer urgency scoring");

api.setState(baseState([
  order({
    id: "WO-HISTORY",
    title: "Prior related work",
    boat: "Customer Continuity / 20 XTR",
    duration: 2,
    status: "Complete",
    techId: "tech-b",
    scheduledDate: "2026-06-02",
    start: "08:00",
    segments: [{ techId: "tech-b", date: "2026-06-02", start: "08:00", duration: 2 }]
  }),
  order({
    id: "WO-CONT",
    title: "Follow-up related work",
    boat: "Customer Continuity / 20 XTR",
    duration: 2,
    priority: "Medium",
    customerUrgency: "Normal"
  })
]));
api.optimizeSchedule();
const continuity = api.state.orders.find(o => o.id === "WO-CONT");
assert.strictEqual(continuity.techId, "tech-b", "scheduler should preserve continuity with the technician from related unit history");
assert(api.state.recommendations.some(r => r.body.includes("Continuity preserved")), "AI explanation should mention continuity preservation");

api.setState(baseState([
  order({ id: "WO-MULTI", duration: 12 })
]));
api.optimizeSchedule();
const multi = api.state.orders.find(o => o.id === "WO-MULTI");
assert.strictEqual(multi.status, "Scheduled", "long jobs should schedule");
assert(api.scheduleSegments(multi).length > 1, "long jobs should split into multi-day schedule segments");
assert.strictEqual(api.scheduleSegments(multi).reduce((sum, s) => sum + s.duration, 0), 12, "segments should preserve full duration");

api.setState(baseState([
  order({
    id: "WO-CERT",
    workType: "Electronics Install",
    duration: 3,
    skills: ["Electronics"],
    requiredCertifications: ["NMEA"],
    preferredTechId: "tech-b",
    bay: "Electronics Bench"
  })
]));
api.optimizeSchedule();
const cert = api.state.orders.find(o => o.id === "WO-CERT");
assert.strictEqual(cert.techId, "tech-b", "scheduler should prefer certified preferred technician when available");
assert(api.state.recommendations.some(r => r.body.includes("Required certifications matched")), "AI explanation should mention certification matching");

api.setState(baseState([
  order({
    id: "WO-NO-SKILL",
    workType: "Fiberglass Touch-Up",
    duration: 2,
    skills: ["Fiberglass"],
    bay: "Service Bay 1"
  })
]));
api.optimizeSchedule();
const noSkill = api.state.orders.find(o => o.id === "WO-NO-SKILL");
assert.strictEqual(noSkill.status, "Unscheduled", "AI scheduler should treat missing skills as a hard constraint");
assert(api.state.recommendations.some(r => r.title.includes("WO-NO-SKILL") && r.body.includes("hard skill/certification constraints")), "AI scheduler should explain hard skill constraint failures");

api.setState(baseState([
  order({
    id: "WO-NO-CERT",
    workType: "Mechanical Inspection",
    duration: 2,
    skills: ["Mechanical"],
    requiredCertifications: ["Master Tech"],
    bay: "Service Bay 1"
  })
]));
api.optimizeSchedule();
const noCert = api.state.orders.find(o => o.id === "WO-NO-CERT");
assert.strictEqual(noCert.status, "Unscheduled", "AI scheduler should treat missing certifications as a hard constraint");
assert(api.state.recommendations.some(r => r.title.includes("WO-NO-CERT") && r.body.includes("missing certifications Master Tech")), "AI scheduler should explain hard certification constraint failures");

api.setState(baseState([
  order({ id: "WO-ABSENT", duration: 2 })
], {
  absences: [{ techId: "tech-a", date: "2026-06-03", reason: "Sick" }]
}));
api.optimizeSchedule();
const absent = api.state.orders.find(o => o.id === "WO-ABSENT");
assert(!api.scheduleSegments(absent).some(s => s.techId === "tech-a" && s.date === "2026-06-03"), "scheduler should not place work on an absent technician's day");

api.setState(baseState([
  order({ id: "WO-GATED", duration: 2, earliestStartDate: "2026-06-05" })
]));
api.optimizeSchedule();
const earliestGated = api.state.orders.find(o => o.id === "WO-GATED");
assert.strictEqual(earliestGated.status, "Scheduled", "earliest-start gated work should still schedule when capacity exists");
assert(api.scheduleSegments(earliestGated).every(s => s.date >= "2026-06-05"), "scheduler should not place work before the earliest start date");
const gateValidation = api.validateManualAssignment(order({ id: "WO-GATE-MANUAL", duration: 2, earliestStartDate: "2026-06-05" }), "tech-a", "2026-06-04", "08:00");
assert(gateValidation.warnings.some(e => e.includes("cannot normally start before 2026-06-05")), "manual assignment should warn before overriding earliest start");

api.setState(baseState([
  order({ id: "WO-BAY-OUTAGE", duration: 2, bay: "Service Bay 1", status: "Unscheduled" })
], {
  bayAvailability: {
    "Service Bay 1": { start: "08:00", end: "16:00", outages: [{ date: "2026-06-03", reason: "Maintenance" }] },
    "Electronics Bench": { start: "08:00", end: "16:00", outages: [] }
  }
}));
api.optimizeSchedule();
const bayOutageOrder = api.state.orders.find(o => o.id === "WO-BAY-OUTAGE");
assert(!api.scheduleSegments(bayOutageOrder).some(s => s.date === "2026-06-03"), "scheduler should not place work in a bay on an outage day");
const bayWindowValidation = api.validateManualAssignment(order({ id: "WO-BAY-WINDOW", duration: 2, bay: "Service Bay 1" }), "tech-a", "2026-06-03", "16:00");
assert(bayWindowValidation.errors.some(e => e.includes("Service Bay 1 is unavailable")), "manual assignment should block outage-day bay use");
const bayHoursValidation = api.validateManualAssignment(order({ id: "WO-BAY-HOURS", duration: 2, bay: "Service Bay 1" }), "tech-a", "2026-06-04", "15:00");
assert(bayHoursValidation.errors.some(e => e.includes("outside Service Bay 1 availability")), "manual assignment should block work outside bay availability");

api.setState(baseState([
  order({
    id: "WO-RUNS-LONG",
    duration: 2,
    status: "Scheduled",
    techId: "tech-a",
    scheduledDate: "2026-06-03",
    start: "08:00",
    segments: [{ techId: "tech-a", date: "2026-06-03", start: "08:00", duration: 2 }]
  }),
  order({
    id: "WO-AFTER-LONG",
    duration: 2,
    status: "Scheduled",
    techId: "tech-a",
    scheduledDate: "2026-06-03",
    start: "10:00",
    segments: [{ techId: "tech-a", date: "2026-06-03", start: "10:00", duration: 2 }]
  })
]));
documentStub.values.overrunOrder = "WO-RUNS-LONG";
documentStub.values.overrunHours = "2";
api.markJobOverrunAndReplan();
assert.strictEqual(
  api.state.orders.find(o => o.id === "WO-RUNS-LONG").duration,
  2,
  "job-overrun scenario should not mutate the live work order duration"
);
assert(api.state.scenarioDiff?.title.includes("WO-RUNS-LONG"), "job-overrun scenario should produce a what-changed diff");
assert(api.state.scenarioDiff.changes.some(change => change.body.includes("duration 2h -> 4h")), "job-overrun diff should show changed duration");
assert(api.state.scenarioDiff.changes.some(change => change.title.includes("WO-AFTER-LONG")), "job-overrun diff should include impacted downstream work");

const validation = api.validateManualAssignment(order({ parts: "Backordered", duration: 2 }), "tech-a", "2026-06-03", "08:00");
assert(validation.errors.some(e => e.includes("Backordered")), "manual assignment should block/conflict on missing parts before override");

api.setState(baseState([
  order({ id: "WO-DROP", duration: 2, status: "Unscheduled" })
]));
api.dropAssign("WO-DROP", "tech-a", "2026-06-03", "11:00");
const dropped = api.state.orders.find(o => o.id === "WO-DROP");
assert.strictEqual(dropped.start, "11:00", "time-slot drag/drop should honor the dropped start time");
assert.strictEqual(dropped.scheduledDate, "2026-06-03", "time-slot drag/drop should honor the dropped date");

api.setState(baseState([
  order({
    id: "WO-LEARN-SAMPLE",
    workType: "Mechanical Inspection",
    duration: 12,
    status: "Scheduled",
    techId: "tech-a",
    scheduledDate: "2026-06-03",
    start: "08:00",
    segments: [{ techId: "tech-a", date: "2026-06-03", start: "08:00", duration: 12 }]
  }),
  order({
    id: "WO-LEARN-FUTURE",
    workType: "Mechanical Inspection",
    duration: 12,
    durationLocked: false,
    status: "Unscheduled"
  }),
  order({
    id: "WO-LEARN-LOCKED",
    workType: "Mechanical Inspection",
    duration: 12,
    durationLocked: true,
    status: "Unscheduled"
  })
]));
api.addTimeEntry("WO-LEARN-SAMPLE", 6, "Actual repair was shorter", "tech-a", "mobile");
assert.strictEqual(
  api.state.workTypes.find(t => t.name === "Mechanical Inspection").learnedDuration,
  6,
  "actual-hours learning should update the work type learned duration"
);
assert.strictEqual(
  api.plannedDuration(api.state.orders.find(o => o.id === "WO-LEARN-FUTURE")),
  6,
  "future unlocked work should use learned duration for planning"
);
assert.strictEqual(
  api.plannedDuration(api.state.orders.find(o => o.id === "WO-LEARN-LOCKED")),
  12,
  "explicitly locked work durations should remain dispatcher-controlled"
);

documentStub.values.manualTech = "tech-b";
documentStub.values.boardDate = "2026-06-03";
documentStub.values.manualStart = "08:00";
api.setState(baseState([
  order({ id: "WO-PREVIEW", parts: "Backordered", skills: ["Trailer"], status: "Unscheduled" })
], { selectedOrderId: "WO-PREVIEW" }));
const preview = api.assignmentConflictPreview();
assert(preview.some(item => item.includes("Backordered")), "pre-assignment conflict preview should warn before assigning work without parts");
assert(preview.some(item => item.includes("missing skills")), "pre-assignment conflict preview should include skill warnings");

api.setState(baseState([
  order({
    id: "WO-MOBILE-CHECK",
    duration: 2,
    checklist: [{ id: "check-mobile", text: "Verify mobile checklist", done: false }]
  })
]));
api.toggleChecklist("WO-MOBILE-CHECK", "check-mobile", true);
assert.strictEqual(
  api.state.orders.find(o => o.id === "WO-MOBILE-CHECK").checklist[0].done,
  true,
  "mobile checklist controls should use the functional checklist toggle path"
);
api.addTimeEntry("WO-MOBILE-CHECK", 1.5, "Completed mobile time note", "tech-a", "mobile");
const timeLogged = api.state.orders.find(o => o.id === "WO-MOBILE-CHECK");
assert.strictEqual(timeLogged.actualHours, 1.5, "technician time entries should roll up into actual hours");
assert.strictEqual(timeLogged.timeEntries[0].note, "Completed mobile time note", "technician notes should be stored with the time entry");
assert(timeLogged.unitHistory[0].includes("1.5h logged"), "time entries should be visible in unit history");
api.addChecklistItem("WO-MOBILE-CHECK", "Confirm customer accessory bag", "mobile");
const checklistAdded = api.state.orders.find(o => o.id === "WO-MOBILE-CHECK");
assert(
  checklistAdded.checklist.some(item => item.text === "Confirm customer accessory bag" && item.source === "mobile"),
  "mobile technician workflow should add job-specific checklist items"
);
assert(checklistAdded.unitHistory[0].includes("Checklist item added"), "added checklist items should appear in unit history");

api.setState(baseState([
  order({
    id: "WO-OPS",
    duration: 4,
    operations: [
      { id: "op-one", sequence: 1, name: "Rigging", done: false },
      { id: "op-two", sequence: 2, name: "PDI", done: false }
    ],
    checklist: [
      { id: "check-one", text: "Rigging", done: false },
      { id: "check-two", text: "PDI", done: false }
    ]
  })
]));
api.splitOperations("WO-OPS");
let parentOps = api.state.orders.find(o => o.id === "WO-OPS");
const childIds = parentOps.operations.map(op => op.childOrderId);
assert.strictEqual(childIds.length, 2, "operation splitting should link parent operations to child jobs");
api.toggleOperation(childIds[0], api.state.orders.find(o => o.id === childIds[0]).operations[0].id, true);
api.toggleChecklist(childIds[0], api.state.orders.find(o => o.id === childIds[0]).checklist[0].id, true);
api.updateStatus(childIds[0], "Complete");
parentOps = api.state.orders.find(o => o.id === "WO-OPS");
assert.strictEqual(parentOps.operations[0].done, true, "completed child job should mark its parent operation done");
assert.strictEqual(parentOps.checklist[0].done, true, "completed child job should mark matching parent checklist item done");
assert.strictEqual(parentOps.status, "Blocked", "parent should remain blocked until all split child jobs complete");
api.toggleOperation(childIds[1], api.state.orders.find(o => o.id === childIds[1]).operations[0].id, true);
api.toggleChecklist(childIds[1], api.state.orders.find(o => o.id === childIds[1]).checklist[0].id, true);
api.updateStatus(childIds[1], "Complete");
parentOps = api.state.orders.find(o => o.id === "WO-OPS");
assert.strictEqual(parentOps.status, "Complete", "parent work order should complete once all split child jobs complete");
assert.strictEqual(parentOps.qualityHold, false, "parent quality hold should clear once all split child jobs complete");

api.setState(baseState([
  order({
    id: "WO-QA-GATE",
    duration: 2,
    status: "In Progress",
    qualityHold: true,
    operations: [{ id: "op-gate", sequence: 1, name: "Inspect", done: false }],
    checklist: [{ id: "check-gate", text: "QA signoff", done: false }]
  })
]));
let gated = api.state.orders.find(o => o.id === "WO-QA-GATE");
assert(api.completionBlockers(gated).some(item => item.includes("Quality hold")), "completion blockers should include active quality holds");
api.updateStatus("WO-QA-GATE", "Complete");
gated = api.state.orders.find(o => o.id === "WO-QA-GATE");
assert.strictEqual(gated.status, "In Progress", "quality-held work should not be marked complete");
api.toggleOperation("WO-QA-GATE", "op-gate", true);
api.toggleChecklist("WO-QA-GATE", "check-gate", true);
gated = api.state.orders.find(o => o.id === "WO-QA-GATE");
gated.qualityHold = false;
api.updateStatus("WO-QA-GATE", "Complete");
gated = api.state.orders.find(o => o.id === "WO-QA-GATE");
assert.strictEqual(gated.status, "Complete", "work should complete after quality hold and open checks are cleared");

api.setState(baseState([
  order({ id: "WO-BAY-IN-USE", bay: "Service Bay 1" })
]));
documentStub.values.bayName = "Service Bay 3";
api.saveBay({ preventDefault() {} });
assert(api.state.bays.includes("Service Bay 3"), "managers should be able to create schedulable bay resources");
api.deleteBay("Service Bay 3");
assert(!api.state.bays.includes("Service Bay 3"), "unused schedulable bay resources should be removable");
api.deleteBay("Service Bay 1");
assert(api.state.bays.includes("Service Bay 1"), "assigned bay resources should be protected from deletion");

console.log("launch-ready scheduler validation passed");
