# Employee store gifts (v70)

Managers grant an amount and a description from **הקפה לעובדים → employee → הוסף מתנה**. Employees see their current-month charge and their remaining store gift separately, with a preview of the gift/charge split when entering the full purchase price. Gift history is available to both roles, including grants, use, refunds and cancellations. Unspent gifts carry across months.

A grant given by mistake can be cancelled from its row in the manager's gift history, for as long as the employee has not started using it. The button is shown only to a manager, and only while the derived history proves the whole grant is still untouched; employees never see it.

## Accounting behavior

- A grant never pays an existing debt. Only purchases recorded after the grant can use it.
- Each new purchase uses available gift credit first; only the remainder is included in payroll deductions, limit calculations, team totals and accountant print/image exports.
- A salary payment does not change the gift balance. Gifts do not become salary payments, advances or negative purchases.
- Money is calculated in integer agorot. A 100 ₪ gift following a 300 ₪ purchase leaves 300 ₪ chargeable; subsequent 40 ₪ and 80 ₪ purchases leave 320 ₪ chargeable and zero gift credit.
- Deleting/reducing a purchase refunds its debt portion first and then its gift portion. A gift refund becomes available at the correction time; it does not pay another purchase already recorded. Increasing an existing purchase adds the difference to its charge and does not draw on a later gift.
- Cancelling a grant is offered only while the balance has stayed at or above that grant's amount ever since it was given, which is exactly the case where no purchase could have drawn on it. Cancelling then lowers the gift balance by the granted amount and changes no purchase, no charge and no existing debt. A grant whose credit was used — even partly, and even if the purchase was later refunded — is not offered.
- A cancellation cannot take money the employee already spent. It is replayed at its own timestamp: if a purchase recorded before it consumed part of the grant, the cancellation lapses with no effect, the purchase keeps its cover, and another grant's unused credit is never removed in its place. The gift balance therefore never goes negative and a purchase is never re-charged after the fact.

## Persistence and compatibility

The existing `payments/{employeeId}/{pushId}` financial ledger is used for manager-authored grants, with `kind: "store_gift"`, `giftCents`, a description in `note`, `monthKey`, a server `createdAt`, and **`amount: 0`**. This reuses the payment path's existing manager-write/employee-own-read permissions. Current payment readers explicitly exclude gift entries; zero `amount` also keeps legacy salary sums from treating a grant as a payment. The employee purchase path cannot create a grant recognized by the gift calculator.

Purchases retain their existing `takings/{employeeId}/{pushId}` shape. `store-gifts.js` replays grants and purchases in server timestamp order, with a deterministic key tie-break, instead of saving a balance from a device's cache. Concurrent purchases therefore share a single derived balance without double spending. At an identical grant/purchase timestamp, the purchase remains chargeable rather than receiving a retroactive gift.

A cancelled grant keeps its ledger entry and gains a server-timestamped `canceledAt`, written by a transaction that refuses a repeat cancellation, an entry whose `giftCents` no longer matches the amount shown, and anything that is not a gift. The grant is not removed: the funding history stays readable, the cancellation appears in both roles' gift history, and a `canceledAt` earlier than `createdAt` or still unresolved is ignored. Old clients continue to read the entry as the zero-`amount` gift it already was.

Manager corrections use a transaction on the existing purchase. The transaction checks the original snapshot, preserves `giftOriginalCents`, and appends a `giftRevisions/{revisionId}` event with its server timestamp and new `priceCents`. Deletion is an audited zero-price correction with `deletedAt`, not removal of the funding history. A stale correction aborts without overwriting a newer edit. Financial history must be retained to reconstruct outstanding gifts.

No production records are migrated. The UI uses the existing Realtime Database paths; there is no new Cloud Function. Cancelling writes to the grant a manager already wrote, under the same path permissions. Deployed database rules are external to this repository and are not changed by this feature. All participating clients should load v70 for gift-aware purchase and payroll views; a v69 client reads a cancelled grant as still granted, so the balance it shows is stale until it reloads.

## Verification

Run `npm test --prefix functions`. The gift tests cover old debt, partial/full use, concurrent ordering, accumulated and cross-year gifts, agorot, invalid input, deletion/refunds, repeated corrections, stale edits, cancellation of an unused grant, a used grant that cannot be cancelled, a purchase racing a cancellation, cancelling one of several grants, and the actual application payroll readers, gift history and accountant HTML. The manager's cancel action itself is exercised against a stubbed database, including the re-check that catches a purchase recorded while the confirmation dialog is open.

Mobile UI verification with a local Firebase stub also covered manager grants, employees without purchases, employee purchase previews, duplicate clicks, failed-save recovery, manager correction/deletion, report contents and 360–1280 px layouts. The cancel row was rendered from the application's own CSS and history HTML at 390 px. It does not write employee data or exercise production Firebase rules.
