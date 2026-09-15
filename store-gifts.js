/* Store-only gifts. Monetary calculations use integer agorot throughout.
 * Grants are typed, zero-payment entries in the existing manager-controlled
 * payments/{employeeId} ledger; they are never salary payments or debt credits.
 * Replay server-timestamped events instead of decrementing a client-side balance:
 * concurrent purchases cannot spend the same gift twice. Corrections refund at
 * correction time, so neither a new grant nor a refund pays an older debt.
 * A mistaken grant is cancelled by a timestamped event on the grant itself,
 * never by deleting it: a purchase that already drew on it keeps its cover.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StoreGifts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function cents(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && Number.isSafeInteger(Math.round(n * 100))
      ? Math.round(n * 100) : 0;
  }

  function parseAmount(value) {
    const text = String(value == null ? "" : value).trim();
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null;
    const result = Number(text.replace(",", "."));
    return Number.isFinite(result) && Number.isSafeInteger(Math.round(result * 100))
      ? Math.round(result * 100) : null;
  }

  function isGift(entry) {
    return !!entry && entry.kind === "store_gift";
  }

  function validTime(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  function compute(takings, payments) {
    const events = [], items = {}, history = [], grants = {}, live = new Map();
    let balanceCents = 0, grantedCents = 0;
    // Lowest balance seen since each live grant: while it stays at or above the
    // granted amount, that gift is provably still untouched and can be cancelled.
    const trackLow = () => live.forEach(state => {
      if (balanceCents < state.lowCents) state.lowCents = balanceCents;
    });
    Object.entries(payments || {}).forEach(([id, entry]) => {
      if (!isGift(entry) || !validTime(entry.createdAt) ||
          !Number.isSafeInteger(entry.giftCents) || entry.giftCents <= 0) return;
      events.push({ id, at: entry.createdAt, order: 1, type: "grant", entry });
      if (validTime(entry.canceledAt) && entry.canceledAt >= entry.createdAt)
        events.push({ id: id + "/cancel", grantId: id, at: entry.canceledAt, order: 3, type: "cancel" });
    });
    Object.entries(takings || {}).forEach(([id, entry]) => {
      if (!entry || !validTime(entry.createdAt)) return;
      const original = Number.isSafeInteger(entry.giftOriginalCents) && entry.giftOriginalCents >= 0
        ? entry.giftOriginalCents : cents(entry.price);
      events.push({ id, at: entry.createdAt, order: 0, type: "purchase", entry, priceCents: original });
      Object.entries(entry.giftRevisions || {}).forEach(([revisionId, revision]) => {
        if (!revision || !validTime(revision.at) || revision.at < entry.createdAt ||
            !Number.isSafeInteger(revision.priceCents) || revision.priceCents < 0) return;
        events.push({ id: id + "/" + revisionId, takingId: id, at: revision.at,
          order: 2, type: "revision", priceCents: revision.priceCents });
      });
    });
    // Purchases at the exact grant timestamp stay debts: never apply a gift
    // retroactively. Firebase push IDs break ties consistently on every device.
    // A cancellation is last at its timestamp, so a purchase racing it wins.
    events.sort((a, b) => a.at - b.at || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    events.forEach(event => {
      if (event.type === "grant") {
        balanceCents += event.entry.giftCents;
        grantedCents += event.entry.giftCents;
        grants[event.id] = { id: event.id, at: event.at, giftCents: event.entry.giftCents,
          name: event.entry.note || "מתנה לחג", canceledAt: null, canceled: false, removable: false };
        live.set(event.id, { grantId: event.id, giftCents: event.entry.giftCents, lowCents: balanceCents });
        history.push({ id: event.id, type: "grant", at: event.at,
          name: event.entry.note || "מתנה לחג", amountCents: event.entry.giftCents, balanceCents });
      } else if (event.type === "cancel") {
        const state = live.get(event.grantId);
        if (!state) return;
        live.delete(event.grantId);
        const grant = grants[event.grantId];
        grant.canceledAt = event.at;
        // Money the employee already spent is not taken back, and the credit of
        // another grant is never removed in its place: the cancellation lapses.
        if (state.lowCents < state.giftCents) return;
        grant.canceled = true;
        balanceCents -= state.giftCents;
        grantedCents -= state.giftCents;
        trackLow();
        history.push({ id: event.id, type: "cancel", at: event.at,
          name: grant.name, amountCents: state.giftCents, balanceCents });
      } else if (event.type === "purchase") {
        const giftCents = Math.min(balanceCents, event.priceCents);
        balanceCents -= giftCents;
        trackLow();
        items[event.id] = { ...event.entry, id: event.id, priceCents: event.priceCents,
          giftCents, chargeCents: event.priceCents - giftCents };
        if (giftCents) history.push({ id: event.id, type: "use", at: event.at,
          name: event.entry.name, amountCents: giftCents, balanceCents });
      } else {
        const item = items[event.takingId];
        if (!item) return;
        const delta = event.priceCents - item.priceCents;
        if (delta >= 0) {
          // Editing an existing purchase never draws on a later gift/refund.
          item.chargeCents += delta;
        } else {
          const removed = -delta;
          const debtRefund = Math.min(item.chargeCents, removed);
          const giftRefund = Math.min(item.giftCents, removed - debtRefund);
          item.chargeCents -= debtRefund;
          item.giftCents -= giftRefund;
          balanceCents += giftRefund;
          if (giftRefund) history.push({ id: event.id, type: "refund", at: event.at,
            name: item.name, amountCents: giftRefund, balanceCents });
        }
        item.priceCents = event.priceCents;
      }
    });
    live.forEach(state => { grants[state.grantId].removable = state.lowCents >= state.giftCents; });
    history.forEach(row => {
      if (row.type !== "grant") return;
      const grant = grants[row.id];
      row.removable = grant.removable;
      row.canceledAt = grant.canceledAt;
      row.canceled = grant.canceled;
    });
    return { items, grants, history: history.reverse(), balanceCents, grantedCents,
      usedCents: grantedCents - balanceCents };
  }

  // Called inside a per-purchase Firebase transaction. Retain the original
  // purchase and append an immutable correction; deletion is a zero-price edit.
  function sameValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key =>
      Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
  }

  function reviseTaking(current, expected, revisionId, name, priceCents, timestamp, deleted) {
    if (!current || current.deletedAt || !sameValue(current, expected) ||
        !Number.isSafeInteger(priceCents) || priceCents < 0) return;
    const original = Number.isSafeInteger(current.giftOriginalCents) && current.giftOriginalCents >= 0
      ? current.giftOriginalCents : cents(current.price);
    return { ...current, name, price: priceCents / 100, giftOriginalCents: original,
      giftRevisions: { ...(current.giftRevisions || {}),
        [revisionId]: { priceCents, at: timestamp } },
      ...(deleted ? { deletedAt: timestamp } : {}) };
  }

  // Called inside a transaction on the grant entry. The grant is kept and stamped
  // with its cancellation time; compute() decides whether that cancellation can
  // still take effect, so a purchase saved in the meantime is never re-charged.
  function cancelGrant(current, giftCents, timestamp) {
    if (!isGift(current) || current.canceledAt || !validTime(current.createdAt) ||
        !Number.isSafeInteger(current.giftCents) || current.giftCents !== giftCents) return;
    return { ...current, canceledAt: timestamp };
  }

  return { cents, parseAmount, isGift, compute, reviseTaking, cancelGrant };
});
