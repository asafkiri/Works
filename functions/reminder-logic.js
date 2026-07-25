"use strict";

const TIME_ZONE = "Asia/Jerusalem";
const ORIGINAL_GRACE_MS = 3 * 60_000;
const SNOOZE_GRACE_MS = 5 * 60_000;

const localFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function isoDayNumber(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function addIsoDays(iso, amount) {
  const [year, month, day] = String(iso).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function dayOfWeek(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function localClock(ms) {
  const parts = Object.fromEntries(
    localFormatter
      .formatToParts(new Date(ms))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return {
    date,
    minute,
    linear: isoDayNumber(date) * 1440 + minute,
  };
}

function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function minutesOf(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizedDays(value) {
  const values = Array.isArray(value) ? value : Object.values(value || {});
  return values
    .filter((item) => item !== null && item !== undefined && item !== "")
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

function addEvent(map, employeeId, date, kind, time) {
  const slot = `${kind}-${time.replace(":", "")}`;
  const key = JSON.stringify([employeeId, date, slot]);
  if (map.has(key)) return;
  map.set(key, {
    key,
    employeeId,
    date,
    kind,
    time,
    slot,
    linear: isoDayNumber(date) * 1440 + minutesOf(time),
  });
}

function buildEvents(data, dates) {
  const employees = data.employees || {};
  const recurring = data.recurringShifts || {};
  const oneTime = data.oneTimeShifts || {};
  const events = new Map();

  for (const date of dates) {
    const dow = dayOfWeek(date);

    for (const shift of Object.values(recurring)) {
      if (!shift || !shift.employeeId) continue;
      const employee = employees[shift.employeeId];
      if (!employee || employee.active === false) continue;
      if (!normalizedDays(shift.daysOfWeek).includes(dow)) continue;
      if ((shift.cancelledDates || {})[date]) continue;

      const start = normalizeTime(shift.startTime);
      const end = normalizeTime(shift.endTime);
      if (!start || !end || minutesOf(end) <= minutesOf(start)) continue;
      addEvent(events, shift.employeeId, date, "in", start);
      addEvent(events, shift.employeeId, date, "out", end);
    }

    for (const shift of Object.values(oneTime)) {
      if (!shift || shift.date !== date || !shift.employeeId) continue;
      const employee = employees[shift.employeeId];
      if (!employee || employee.active === false) continue;

      const start = normalizeTime(shift.startTime);
      const end = normalizeTime(shift.endTime);
      if (!start || !end || minutesOf(end) <= minutesOf(start)) continue;
      addEvent(events, shift.employeeId, date, "in", start);
      addEvent(events, shift.employeeId, date, "out", end);
    }
  }

  return events;
}

function reminderState(reminders, event) {
  return reminders?.[event.employeeId]?.[event.date]?.[event.slot] || {};
}

function hasOpenShift(shifts, employeeId) {
  return Object.values(shifts || {}).some(
    (shift) =>
      shift &&
      shift.employeeId === employeeId &&
      shift.clockIn &&
      !shift.clockOut,
  );
}

function dueReason(currentState, event, nowMs, nowLocal) {
  const state =
    currentState && typeof currentState === "object" ? currentState : {};
  if (state.done === true) return null;
  if (Number(state.sentCount || 0) !== 0) return null;

  const snoozeUntil = Number(state.snoozeUntil || 0);
  if (snoozeUntil > 0) {
    if (snoozeUntil > nowMs) return null;
    if (nowMs - snoozeUntil > SNOOZE_GRACE_MS) return null;
    return "snooze";
  }

  if (Number(state.lastSentAt || 0) > 0) return null;
  const lateMs = (nowLocal.linear - event.linear) * 60_000;
  if (lateMs < 0 || lateMs > ORIGINAL_GRACE_MS) return null;
  return "scheduled";
}

function tokensForEmployee(pushTokens, employeeId) {
  const rows = pushTokens?.[employeeId] || {};
  const byToken = new Map();

  for (const [key, row] of Object.entries(rows)) {
    const token = typeof row?.token === "string" ? row.token.trim() : "";
    if (!token) continue;

    const previous = byToken.get(token);
    if (!previous) {
      byToken.set(token, {
        token,
        keys: [key],
        updatedAt: Number(row.updatedAt || 0),
      });
      continue;
    }

    previous.keys.push(key);
    previous.updatedAt = Math.max(
      previous.updatedAt,
      Number(row.updatedAt || 0),
    );
  }

  return byToken;
}

function latestTokenOwners(pushTokens) {
  const byToken = new Map();

  for (const [employeeId, rows] of Object.entries(pushTokens || {})) {
    for (const [key, row] of Object.entries(rows || {})) {
      const token =
        typeof row?.token === "string" ? row.token.trim() : "";
      if (!token) continue;

      const parsedUpdatedAt = Number(row.updatedAt || 0);
      const updatedAt = Number.isFinite(parsedUpdatedAt)
        ? parsedUpdatedAt
        : 0;
      const ownerKey = `${employeeId}/${key}`;
      const previous = byToken.get(token);
      if (!previous) {
        byToken.set(token, {
          token,
          employeeId,
          updatedAt,
          ownerKey,
          locations: [{ employeeId, key }],
        });
        continue;
      }

      previous.locations.push({ employeeId, key });
      if (
        updatedAt > previous.updatedAt ||
        (updatedAt === previous.updatedAt &&
          ownerKey > previous.ownerKey)
      ) {
        previous.employeeId = employeeId;
        previous.updatedAt = updatedAt;
        previous.ownerKey = ownerKey;
      }
    }
  }

  for (const row of byToken.values()) {
    row.keys = row.locations
      .filter((location) => location.employeeId === row.employeeId)
      .map((location) => location.key);
    delete row.ownerKey;
  }

  return byToken;
}

function tokensOwnedByEmployee(tokenOwners, employeeId) {
  return new Map(
    [...(tokenOwners || new Map()).entries()].filter(
      ([, row]) => row.employeeId === employeeId,
    ),
  );
}

function reminderCopy(event) {
  const isEntry = event.kind === "in";
  return {
    title: isEntry ? "🔔 תזכורת כניסה" : "🕔 תזכורת יציאה",
    body: isEntry
      ? `המשמרת שלך מתחילה ב-${event.time}. אם עדיין לא החתמת כניסה — זה הזמן.`
      : `המשמרת שלך מסתיימת ב-${event.time}. תזכור להחתים יציאה בטרמינל 👋`,
  };
}

function messageDataFor(event) {
  const copy = reminderCopy(event);
  return {
    kind: event.kind,
    time: event.time,
    date: event.date,
    slot: event.slot,
    employeeId: event.employeeId,
    title: copy.title,
    body: copy.body,
    tag: `works-${event.employeeId}-${event.date}-${event.slot}`,
  };
}

module.exports = {
  TIME_ZONE,
  ORIGINAL_GRACE_MS,
  SNOOZE_GRACE_MS,
  addIsoDays,
  buildEvents,
  dayOfWeek,
  dueReason,
  hasOpenShift,
  isoDayNumber,
  latestTokenOwners,
  localClock,
  messageDataFor,
  normalizeTime,
  normalizedDays,
  reminderState,
  tokensForEmployee,
  tokensOwnedByEmployee,
};
