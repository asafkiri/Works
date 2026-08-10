"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in index.html`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const context = {};
vm.createContext(context);
vm.runInContext(
  `${extractFunction("autoCloseShiftValue")}\n${extractFunction("clearOpenShiftPointerValue")}`,
  context,
);

const autoCloseShiftValue = context.autoCloseShiftValue;
const clearOpenShiftPointerValue = context.clearOpenShiftPointerValue;
const HOUR = 60 * 60 * 1000;

test("a server-side clockOut always wins over a stale device", () => {
  const serverShift = {
    employeeId: "e1",
    clockIn: 1_000,
    clockOut: 5_000,
    employeeNote: "נשמרה יציאה ידנית",
  };
  const before = structuredClone(serverShift);

  assert.equal(autoCloseShiftValue(serverShift, 20 * HOUR, 12), undefined);
  assert.deepEqual(serverShift, before);
});

test("a transaction retry aborts when another device closed first", () => {
  const staleLocal = { employeeId: "e1", clockIn: 1_000, clockOut: null };
  const attempted = autoCloseShiftValue(staleLocal, 20 * HOUR, 12);
  assert.equal(attempted.autoCloseFlag, true);

  const currentServer = { ...staleLocal, clockOut: 8 * HOUR };
  assert.equal(autoCloseShiftValue(currentServer, 20 * HOUR, 12), undefined);
});

test("an offline retry uses an edited server clockIn and aborts below 12 hours", () => {
  const staleLocal = { employeeId: "e1", clockIn: HOUR, clockOut: null };
  assert.equal(autoCloseShiftValue(staleLocal, 20 * HOUR, 12).autoCloseFlag, true);

  const currentServer = { ...staleLocal, clockIn: 19 * HOUR };
  assert.equal(autoCloseShiftValue(currentServer, 20 * HOUR, 12), undefined);
});

test("a genuinely open 12-hour shift closes and preserves all other data", () => {
  const clockIn = 2 * HOUR;
  const openShift = {
    employeeId: "e1",
    clockIn,
    clockOut: null,
    employeeNote: "הערה",
    managerFeedback: "משוב",
    breaks: { b1: { start: 3 * HOUR, end: 4 * HOUR } },
    edited: false,
  };
  const before = structuredClone(openShift);
  const closed = autoCloseShiftValue(openShift, clockIn + 12 * HOUR, 12);

  assert.equal(closed.clockOut, clockIn + 12 * HOUR);
  assert.equal(closed.autoCloseFlag, true);
  assert.equal(closed.pendingReview, true);
  assert.equal(closed.employeeNote, "הערה");
  assert.equal(closed.managerFeedback, "משוב");
  assert.deepEqual(closed.breaks, openShift.breaks);
  assert.deepEqual(openShift, before);
});

test("an open shift below 12 hours is left untouched", () => {
  const openShift = { employeeId: "e1", clockIn: HOUR, clockOut: null };
  assert.equal(autoCloseShiftValue(openShift, 13 * HOUR - 1, 12), undefined);
});

test("invalid shifts and settings are never auto-closed", () => {
  assert.equal(autoCloseShiftValue(null, 20 * HOUR, 12), undefined);
  assert.equal(autoCloseShiftValue({ clockIn: "bad", clockOut: null }, 20 * HOUR, 12), undefined);
  assert.equal(autoCloseShiftValue({ clockIn: HOUR, clockOut: null }, NaN, 12), undefined);
  assert.equal(autoCloseShiftValue({ clockIn: HOUR, clockOut: null }, 20 * HOUR, 0), undefined);
});

test("the employee pointer is cleared only when it still points to that shift", () => {
  assert.equal(clearOpenShiftPointerValue("shift-old", "shift-old"), null);
  assert.equal(clearOpenShiftPointerValue("shift-new", "shift-old"), undefined);
  assert.equal(clearOpenShiftPointerValue(null, "shift-old"), undefined);
  assert.equal(clearOpenShiftPointerValue(undefined, "shift-old"), undefined);
});
