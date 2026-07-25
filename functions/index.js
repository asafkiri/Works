"use strict";

const { randomUUID } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {
  TIME_ZONE,
  addIsoDays,
  buildEvents,
  dueReason,
  hasOpenShift,
  latestTokenOwners,
  localClock,
  messageDataFor,
  reminderState,
  tokensOwnedByEmployee,
} = require("./reminder-logic");

const SCHEDULE_REGION = "us-central1";
const CALLABLE_REGION = "europe-west1";
const DATABASE_URL =
  "https://mini-market-shalom-default-rtdb.firebaseio.com";
const CLAIM_LEASE_MS = 75_000;
const REMINDER_RETENTION_DAYS = 45;
const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

initializeApp({ databaseURL: DATABASE_URL });
const db = getDatabase();
const messaging = getMessaging();

function reminderRef(event) {
  return db.ref(
    `reminders/${event.employeeId}/${event.date}/${event.slot}`,
  );
}

function reminderClaimRef(event) {
  return db.ref(
    `reminderClaims/${event.employeeId}/${event.date}/${event.slot}`,
  );
}

async function claimEvent(event, nowMs, nowLocal) {
  const stateRef = reminderRef(event);
  const currentState = (await stateRef.get()).val() || {};
  if (!dueReason(currentState, event, nowMs, nowLocal)) return null;

  const claimRef = reminderClaimRef(event);
  const claimId = randomUUID();

  const result = await claimRef.transaction((current) => {
    const claim =
      current && typeof current === "object" ? current : {};
    if (claim.claimId && Number(claim.claimUntil || 0) > nowMs) {
      return;
    }
    return {
      claimId,
      claimUntil: nowMs + CLAIM_LEASE_MS,
      claimedAt: nowMs,
    };
  }, undefined, false);

  if (!result.committed) return null;
  if (result.snapshot.val()?.claimId !== claimId) return null;
  return { event, stateRef, claimRef, claimId };
}

async function releaseClaim(claim) {
  await claim.claimRef.transaction((current) => {
    if (!current || current.claimId !== claim.claimId) return;
    return null;
  }, undefined, false);
}

async function claimStillSendable(claim) {
  const checkedAt = Date.now();
  const [claimSnapshot, stateSnapshot] = await Promise.all([
    claim.claimRef.get(),
    claim.stateRef.get(),
  ]);
  const activeClaim = claimSnapshot.val();
  return Boolean(
    activeClaim &&
      activeClaim.claimId === claim.claimId &&
      dueReason(
        stateSnapshot.val() || {},
        claim.event,
        checkedAt,
        localClock(checkedAt),
      ),
  );
}

async function finalizeSuccess(claim) {
  const sentAt = Date.now();
  try {
    await claim.stateRef.transaction((current) => {
      const state =
        current && typeof current === "object" ? current : {};
      if (state.done === true) return state;

      const userAlreadySnoozed =
        Number(state.snoozeUntil || 0) > sentAt;
      return {
        ...state,
        sentCount: userAlreadySnoozed ? 0 : 1,
        lastSentAt: sentAt,
        snoozeUntil: userAlreadySnoozed
          ? state.snoozeUntil
          : null,
      };
    }, undefined, false);
  } finally {
    await releaseClaim(claim);
  }
}

async function finalizeAlreadyDone(claim) {
  const doneAt = Date.now();
  try {
    await claim.stateRef.transaction((current) => ({
      ...(current && typeof current === "object" ? current : {}),
      done: true,
      doneAt,
    }), undefined, false);
  } finally {
    await releaseClaim(claim);
  }
}

async function removeTokenIfUnchanged(row) {
  await Promise.allSettled(
    (row.locations || []).map(async ({ employeeId, key }) => {
      const ref = db.ref(`pushTokens/${employeeId}/${key}`);
      await ref.transaction((current) => {
        if (!current || current.token !== row.token) return;
        return null;
      }, undefined, false);
    }),
  );
}

async function sendDataToRows(data, tokenRows) {
  const rows = [...tokenRows.values()];
  let successCount = 0;
  const invalidRows = [];
  const errors = [];

  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500);
    try {
      const batch = await messaging.sendEachForMulticast({
        tokens: chunk.map((row) => row.token),
        data,
        webpush: {
          headers: {
            Urgency: "high",
            TTL: "300",
          },
        },
      });

      batch.responses.forEach((response, index) => {
        const row = chunk[index];
        if (response.success) {
          successCount += 1;
          return;
        }
        const code =
          response.error?.code || "messaging/unknown-error";
        errors.push(code);
        if (INVALID_TOKEN_CODES.has(code)) invalidRows.push(row);
      });
    } catch (error) {
      errors.push(error?.code || "messaging/send-failed");
    }
  }

  return { successCount, invalidRows, errors };
}

async function readRoots(names) {
  const snapshots = await Promise.all(
    names.map((name) => db.ref(name).get()),
  );
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      snapshots[index].val() || {},
    ]),
  );
}

async function pruneOldReminders(reminders, today) {
  const cutoff = addIsoDays(today, -REMINDER_RETENTION_DAYS);
  const removals = [];

  for (const [employeeId, dates] of Object.entries(reminders || {})) {
    for (const date of Object.keys(dates || {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) {
        removals.push(
          db.ref(`reminders/${employeeId}/${date}`).remove(),
        );
      }
      if (removals.length >= 100) break;
    }
    if (removals.length >= 100) break;
  }

  await Promise.allSettled(removals);
}

exports.sendShiftReminders = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: TIME_ZONE,
    region: SCHEDULE_REGION,
    memory: "256MiB",
    timeoutSeconds: 55,
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const nowLocal = localClock(startedAt);
    const dates = [nowLocal.date, addIsoDays(nowLocal.date, -1)];

    const data = await readRoots([
      "employees",
      "recurringShifts",
      "oneTimeShifts",
      "pushTokens",
      "reminders",
    ]);

    const events = buildEvents(data, dates);
    const tokenOwners = latestTokenOwners(data.pushTokens);
    const tokenMaps = {};
    const possible = [];

    for (const event of events.values()) {
      const state = reminderState(data.reminders, event);
      if (!dueReason(state, event, startedAt, nowLocal)) continue;

      tokenMaps[event.employeeId] ||= tokensOwnedByEmployee(
        tokenOwners,
        event.employeeId,
      );
      if (tokenMaps[event.employeeId].size === 0) continue;
      possible.push(event);
    }

    const claims = (
      await Promise.all(
        possible.map((event) =>
          claimEvent(event, startedAt, nowLocal),
        ),
      )
    ).filter(Boolean);

    if (claims.length === 0) {
      await pruneOldReminders(data.reminders, nowLocal.date);
      return;
    }

    // Re-read immediately before sending so edits/cancellations win.
    const freshPlans = await readRoots([
      "employees",
      "recurringShifts",
      "oneTimeShifts",
      "shifts",
    ]);
    const stillValid = buildEvents(freshPlans, dates);

    let sentEvents = 0;
    let removedTokens = 0;
    let skippedAlreadyDone = 0;

    for (const claim of claims) {
      if (!stillValid.has(claim.event.key)) {
        await releaseClaim(claim);
        continue;
      }
      if (!(await claimStillSendable(claim))) {
        await releaseClaim(claim);
        continue;
      }

      const hasRealOpenShift = hasOpenShift(
        freshPlans.shifts,
        claim.event.employeeId,
      );
      const alreadyPerformed =
        (claim.event.kind === "in" && hasRealOpenShift) ||
        (claim.event.kind === "out" && !hasRealOpenShift);

      if (alreadyPerformed) {
        await finalizeAlreadyDone(claim);
        skippedAlreadyDone += 1;
        continue;
      }

      const result = await sendDataToRows(
        messageDataFor(claim.event),
        tokenMaps[claim.event.employeeId],
      );

      for (const row of result.invalidRows) {
        await removeTokenIfUnchanged(row);
        removedTokens += row.locations.length;
      }

      if (result.successCount > 0) {
        await finalizeSuccess(claim);
        sentEvents += 1;
      } else {
        await releaseClaim(claim);
        logger.warn("Reminder push was not delivered", {
          employeeId: claim.event.employeeId,
          date: claim.event.date,
          slot: claim.event.slot,
          errors: result.errors,
        });
      }
    }

    await pruneOldReminders(data.reminders, nowLocal.date);
    logger.info("Shift reminder run completed", {
      candidates: possible.length,
      claimed: claims.length,
      sentEvents,
      skippedAlreadyDone,
      removedTokens,
      durationMs: Date.now() - startedAt,
    });
  },
);

async function employeeIdForUid(uid) {
  const [mappedSnapshot, employeesSnapshot] = await Promise.all([
    db.ref(`uidToEmp/${uid}`).get(),
    db.ref("employees").get(),
  ]);
  const mapped = mappedSnapshot.val();
  const employees = employeesSnapshot.val() || {};
  if (
    typeof mapped === "string" &&
    mapped &&
    employees[mapped]?.authUid === uid
  ) {
    return mapped;
  }

  return (
    Object.keys(employees).find(
      (id) => employees[id]?.authUid === uid,
    ) || null
  );
}

exports.sendPushTest = onCall(
  {
    region: CALLABLE_REGION,
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 2,
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "יש להתחבר כעובד כדי לשלוח בדיקה.",
      );
    }

    // Prevent accidental double taps or automated test spam.
    const rateRef = db.ref(`pushTestRate/${request.auth.uid}`);
    const rateNow = Date.now();
    const rateResult = await rateRef.transaction((lastSentAt) => {
      if (
        Number(lastSentAt || 0) > 0 &&
        rateNow - Number(lastSentAt) < 30_000
      ) {
        return;
      }
      return rateNow;
    }, undefined, false);
    if (!rateResult.committed) {
      throw new HttpsError(
        "resource-exhausted",
        "יש להמתין חצי דקה בין בדיקות.",
      );
    }

    const employeeId = await employeeIdForUid(request.auth.uid);
    if (!employeeId) {
      throw new HttpsError(
        "permission-denied",
        "החשבון אינו משויך לעובד.",
      );
    }

    const requestedToken =
      typeof request.data?.token === "string"
        ? request.data.token.trim()
        : "";
    if (requestedToken.length < 20 || requestedToken.length > 4096) {
      throw new HttpsError(
        "invalid-argument",
        "חסר מזהה המכשיר לבדיקת ההתראה.",
      );
    }

    const [employeeSnapshot, tokenSnapshot] = await Promise.all([
      db.ref(`employees/${employeeId}`).get(),
      db.ref("pushTokens").get(),
    ]);
    const employee = employeeSnapshot.val();
    if (!employee || employee.active === false) {
      throw new HttpsError(
        "failed-precondition",
        "העובד אינו פעיל.",
      );
    }

    const tokenOwners = latestTokenOwners(tokenSnapshot.val() || {});
    const requestedRow = tokenOwners.get(requestedToken);
    if (
      !requestedRow ||
      requestedRow.employeeId !== employeeId
    ) {
      throw new HttpsError(
        "failed-precondition",
        "המכשיר הנוכחי אינו רשום לעובד המחובר.",
      );
    }
    const tokenRows = new Map([[requestedToken, requestedRow]]);

    const delaySeconds = Math.min(
      10,
      Math.max(0, Number(request.data?.delaySeconds || 0)),
    );
    if (delaySeconds > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, delaySeconds * 1000),
      );
    }

    const result = await sendDataToRows(
      {
        kind: "test",
        time: "",
        date: "",
        slot: "test",
        employeeId,
        title: "🔔 בדיקת התראות",
        body: "ההתראות של שעון הנוכחות פועלות בהצלחה ✓",
        tag: "works-push-test",
      },
      tokenRows,
    );

    for (const row of result.invalidRows) {
      await removeTokenIfUnchanged(row);
    }

    if (result.successCount === 0) {
      logger.warn("Push test failed", {
        employeeId,
        errors: result.errors,
      });
      throw new HttpsError(
        "internal",
        "ההתראה לא נמסרה למכשיר.",
      );
    }

    logger.info("Push test sent", {
      employeeId,
      successCount: result.successCount,
    });
    return { successCount: result.successCount };
  },
);
