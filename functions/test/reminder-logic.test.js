"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEvents,
  dueReason,
  hasOpenShift,
  latestTokenOwners,
  localClock,
  messageDataFor,
  normalizeTime,
  normalizedDays,
  reminderState,
  tokensForEmployee,
  tokensOwnedByEmployee,
} = require("../reminder-logic");

test("localClock uses Asia/Jerusalem summer time", () => {
  const clock = localClock(Date.parse("2026-07-25T17:36:00Z"));
  assert.equal(clock.date, "2026-07-25");
  assert.equal(clock.minute, 20 * 60 + 36);
});

test("time and Firebase day arrays are normalized safely", () => {
  assert.equal(normalizeTime("7:05"), "07:05");
  assert.equal(normalizeTime("24:00"), null);
  assert.deepEqual(normalizedDays([null, 1, null, 3]), [1, 3]);
});

test("recurring and one-time duplicates produce one slot", () => {
  const data = {
    employees: { e1: { active: true } },
    recurringShifts: {
      r1: {
        employeeId: "e1",
        daysOfWeek: [6],
        startTime: "08:00",
        endTime: "14:00",
      },
    },
    oneTimeShifts: {
      o1: {
        employeeId: "e1",
        date: "2026-07-25",
        startTime: "08:00",
        endTime: "14:00",
      },
    },
  };
  const events = buildEvents(data, ["2026-07-25"]);
  assert.equal(events.size, 2);
  assert.deepEqual(
    [...events.values()].map((event) => event.slot).sort(),
    ["in-0800", "out-1400"],
  );
});

test("cancelled recurring shifts and inactive employees are skipped", () => {
  const data = {
    employees: {
      e1: { active: true },
      e2: { active: false },
    },
    recurringShifts: {
      cancelled: {
        employeeId: "e1",
        daysOfWeek: [6],
        startTime: "08:00",
        endTime: "14:00",
        cancelledDates: { "2026-07-25": true },
      },
      inactive: {
        employeeId: "e2",
        daysOfWeek: [6],
        startTime: "09:00",
        endTime: "15:00",
      },
    },
  };
  assert.equal(buildEvents(data, ["2026-07-25"]).size, 0);
});

test("real open shifts are found even when the employee pointer is stale", () => {
  const shifts = {
    closed: {
      employeeId: "e1",
      clockIn: 100,
      clockOut: 200,
    },
    orphanOpen: {
      employeeId: "e1",
      clockIn: 300,
      clockOut: null,
    },
    otherEmployee: {
      employeeId: "e2",
      clockIn: 400,
      clockOut: null,
    },
  };
  assert.equal(hasOpenShift(shifts, "e1"), true);
  assert.equal(hasOpenShift({ closed: shifts.closed }, "e1"), false);
  assert.equal(hasOpenShift(shifts, "e3"), false);
});

test("scheduled and snoozed reminders become due once", () => {
  const events = buildEvents(
    {
      employees: { e1: { active: true } },
      oneTimeShifts: {
        o1: {
          employeeId: "e1",
          date: "2026-07-25",
          startTime: "20:35",
          endTime: "21:00",
        },
      },
    },
    ["2026-07-25"],
  );
  const event = [...events.values()].find((item) => item.kind === "in");
  const nowMs = Date.parse("2026-07-25T17:36:00Z");
  const nowLocal = localClock(nowMs);

  assert.equal(dueReason({}, event, nowMs, nowLocal), "scheduled");
  assert.equal(
    dueReason({ sentCount: 1, lastSentAt: nowMs }, event, nowMs, nowLocal),
    null,
  );
  assert.equal(
    dueReason(
      { sentCount: 0, lastSentAt: nowMs - 60_000, snoozeUntil: nowMs },
      event,
      nowMs,
      nowLocal,
    ),
    "snooze",
  );
  assert.equal(
    dueReason(
      { sentCount: 0, snoozeUntil: nowMs + 60_000 },
      event,
      nowMs,
      nowLocal,
    ),
    null,
  );
  assert.equal(dueReason({ done: true }, event, nowMs, nowLocal), null);
  assert.deepEqual(
    Object.keys(messageDataFor(event)).sort(),
    [
      "body",
      "date",
      "employeeId",
      "kind",
      "slot",
      "tag",
      "time",
      "title",
    ],
  );
  assert.equal(
    Object.values(messageDataFor(event)).every(
      (value) => typeof value === "string",
    ),
    true,
  );
});

test("reminder state and tokens are selected and deduplicated", () => {
  const event = {
    employeeId: "e1",
    date: "2026-07-25",
    slot: "in-0800",
  };
  assert.deepEqual(
    reminderState(
      {
        e1: {
          "2026-07-25": {
            "in-0800": { done: true },
          },
        },
      },
      event,
    ),
    { done: true },
  );

  const tokens = tokensForEmployee(
    {
      e1: {
        a: { token: "same", updatedAt: 1 },
        b: { token: "same", updatedAt: 2 },
        c: { token: "other", updatedAt: 3 },
      },
    },
    "e1",
  );
  assert.equal(tokens.size, 2);
  assert.deepEqual(tokens.get("same").keys.sort(), ["a", "b"]);
});

test("a shared device token belongs only to its latest employee", () => {
  const owners = latestTokenOwners({
    e1: {
      old: { token: "shared", updatedAt: 100 },
      invalidDuplicate: { token: "shared", updatedAt: 50 },
      own: { token: "only-e1", updatedAt: 300 },
    },
    e2: {
      current: { token: "shared", updatedAt: 200 },
    },
  });

  assert.equal(owners.get("shared").employeeId, "e2");
  assert.deepEqual(owners.get("shared").locations, [
    { employeeId: "e1", key: "old" },
    { employeeId: "e1", key: "invalidDuplicate" },
    { employeeId: "e2", key: "current" },
  ]);
  assert.deepEqual(
    [...tokensOwnedByEmployee(owners, "e1").keys()],
    ["only-e1"],
  );
  assert.deepEqual(
    [...tokensOwnedByEmployee(owners, "e2").keys()],
    ["shared"],
  );
});
