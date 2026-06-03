const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
let source = fs.readFileSync(path.join(root, "app.js"), "utf8");
source = source.replace(/\ninit\(\);\s*$/, `
globalThis.__api = {
  init,
  get state() { return state; },
  getElement(id) { return document.getElementById(id); }
};
`);

function createClassList() {
  const classes = new Set();
  return {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: name => classes.has(name),
    toggle(name, force) {
      const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
      if (shouldAdd) classes.add(name);
      else classes.delete(name);
      return shouldAdd;
    },
    toString: () => [...classes].join(" ")
  };
}

function createElement(id = "", tagName = "DIV", dataset = {}) {
  const listeners = {};
  return {
    id,
    tagName,
    dataset,
    style: {},
    files: [],
    value: "",
    checked: false,
    innerHTML: "",
    textContent: "",
    classList: createClassList(),
    attributes: {},
    addEventListener(type, handler) {
      listeners[type] ||= [];
      listeners[type].push(handler);
    },
    dispatch(type, event = {}) {
      const payload = {
        target: this,
        preventDefault() {},
        dataTransfer: { setData() {}, getData: () => "", effectAllowed: "" },
        ...event
      };
      (listeners[type] || []).forEach(handler => handler(payload));
    },
    click() {
      this.dispatch("click");
    },
    reset() {
      this.value = "";
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    }
  };
}

const elements = new Map();
const tabs = ["dispatch", "orders", "techs", "types", "mobile", "dashboard"].map(view => createElement(`tab-${view}`, "BUTTON", { view }));
const views = ["dispatch", "orders", "techs", "types", "mobile", "dashboard"].map(view => createElement(view, "SECTION"));
const boardButtons = ["day", "week"].map(board => createElement(`board-${board}`, "BUTTON", { board }));

function getElementById(id) {
  if (!elements.has(id)) {
    const tag = id.endsWith("Form") ? "FORM" : id.includes("Btn") ? "BUTTON" : id.includes("Date") ? "INPUT" : "DIV";
    elements.set(id, createElement(id, tag));
  }
  return elements.get(id);
}

const documentStub = {
  getElementById,
  querySelectorAll(selector) {
    if (selector === ".tab") return tabs;
    if (selector === ".view") return views;
    if (selector === "[data-board]") return boardButtons;
    return [];
  },
  querySelector() {
    return null;
  },
  addEventListener() {},
  createElement(tag) {
    return createElement("", tag.toUpperCase());
  }
};

const storage = new Map();
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
  FileReader: class {},
  Blob: class {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
    }
  },
  URL: {
    createObjectURL: () => "blob:scheduler",
    revokeObjectURL() {}
  },
  confirm: () => true,
  alert: message => {
    throw new Error(`Unexpected alert: ${message}`);
  },
  location: { protocol: "file:" },
  document: documentStub,
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  },
  fetch: async () => {
    throw new Error("file-mode launch should not call fetch");
  },
  EventSource: class {
    constructor() {
      throw new Error("file-mode launch should not open EventSource");
    }
  }
};

context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "app.js" });

(async () => {
  const api = context.__api;
  await api.init();

  assert.strictEqual(api.state.orders.length, 20, "seed orders should load during file-mode init");
  assert(api.getElement("metrics").innerHTML.includes("Unscheduled"), "metrics should render during init");
  assert(api.getElement("unscheduledQueue").innerHTML.includes("WO-"), "unscheduled queue should render work orders");
  assert(api.getElement("dispatchBoard").innerHTML.includes("board-grid"), "dispatch board should render");
  assert(api.getElement("dispatchBoard").innerHTML.includes("time-slots"), "day dispatch board should render a time-slot grid");
  assert(api.getElement("dispatchBoard").innerHTML.includes("data-drop-start=\"08:00\""), "day dispatch board should expose time-slot drop targets");
  assert.strictEqual(api.getElement("schedulerMode").value, "balanced", "scheduler mode should initialize");
  assert.strictEqual(
    JSON.stringify(api.state.savedViews.map(view => view.name).sort()),
    JSON.stringify(["Detail", "PDI", "Production", "Rigging", "Service", "Warranty", "Yard"].sort()),
    "seed state should include required shop saved views"
  );
  assert(api.getElement("savedViewSelect").innerHTML.includes("Warranty"), "saved view selector should render required shop views");

  const unscheduledBefore = api.state.orders.filter(o => o.status === "Unscheduled").length;
  api.getElement("optimizeBtn").click();
  const scheduled = api.state.orders.filter(o => o.status === "Scheduled");

  assert(scheduled.length > 0, "Schedule with AI button should schedule work orders");
  assert(
    api.state.orders.filter(o => o.status === "Unscheduled").length < unscheduledBefore,
    "AI scheduling should reduce unscheduled work"
  );
  assert(
    scheduled.every(order => {
      const tech = api.state.technicians.find(t => t.id === order.techId);
      return tech && order.scheduledDate && order.start && order.skills.every(skill => tech.skills.includes(skill));
    }),
    "scheduled jobs should have a tech, date, start time, and full required-skill match"
  );
  assert(api.getElement("dispatchBoard").innerHTML.includes("scheduled-job"), "dispatch board should render scheduled jobs after AI scheduling");
  assert(api.getElement("recommendations").innerHTML.includes("Full required-skill match"), "recommendations should explain skill-based assignment");
  assert(api.getElement("recommendationCount").textContent.endsWith("notes"), "recommendation count should render");
  const firstScheduled = scheduled[0];
  api.getElement("mobileTech").value = firstScheduled.techId;
  api.getElement("mobileDate").value = firstScheduled.scheduledDate;
  api.getElement("mobileTech").dispatch("change");
  assert(api.getElement("mobileJobs").innerHTML.includes(firstScheduled.id), "mobile technician view should render assigned work");
  assert(api.getElement("mobileJobs").innerHTML.includes("data-mobile-checklist"), "mobile technician view should render checklist controls");

  console.log("file-mode launch validation passed");
})();
