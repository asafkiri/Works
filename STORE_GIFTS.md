# Employee store gifts (v69)

Managers grant an amount and a description from **הקפה לעובדים → employee → הוסף מתנה**. Employees see their current-month charge and their remaining store gift separately, with a preview of the gift/charge split when entering the full purchase price. Gift history is available to both roles, including grants, use and refunds. Unspent gifts carry across months.

## Accounting behavior

- A grant never pays an existing debt. Only purchases recorded after the grant can use it.
- Each new purchase uses available gift credit first; only the remainder is included in payroll deductions, limit calculations, team totals and accountant print/image exports.
- A salary payment does not change the gift balance. Gifts do not become salary payments, advances or negative purchases.
- Money is calculated in integer agorot. A 100 ₪ gift following a 300 ₪ purchase leaves 300 ₪ chargeable; subsequent 40 ₪ and 80 ₪ purchases leave 320 ₪ chargeable and zero gift credit.
- Deleting/reducing a purchase refunds its debt portion first and then its gift portion. A gift refund becomes available at the correction time; it does not pay another purchase already recorded. Increasing an existing purchase adds the difference to its charge and does not draw on a later gift.

## Persistence and compatibility

The existing `payments/{employeeId}/{pushId}` financial ledger is used for manager-authored grants, with `kind: "store_gift"`, `giftCents`, a description in `note`, `monthKey`, a server `createdAt`, and **`amount: 0`**. This reuses the payment path's existing manager-write/employee-own-read permissions. Current payment readers explicitly exclude gift entries; zero `amount` also keeps legacy salary sums from treating a grant as a payment. The employee purchase path cannot create a grant recognized by the gift calculator.

Purchases retain their existing `takings/{employeeId}/{pushId}` shape. `store-gifts.js` replays grants and purchases in server timestamp order, with a deterministic key tie-break, instead of saving a balance from a device's cache. Concurrent purchases therefore share a single derived balance without double spending. At an identical grant/purchase timestamp, the purchase remains chargeable rather than receiving a retroactive gift.

Manager corrections use a transaction on the existing purchase. The transaction checks the original snapshot, preserves `giftOriginalCents`, and appends a `giftRevisions/{revisionId}` event with its server timestamp and new `priceCents`. Deletion is an audited zero-price correction with `deletedAt`, not removal of the funding history. A stale correction aborts without overwriting a newer edit. Financial history must be retained to reconstruct outstanding gifts.

No production records are migrated. The UI uses the existing Realtime Database paths; there is no new Cloud Function. Deployed database rules are external to this repository and are not changed by this feature. All participating clients should load v69 for gift-aware purchase and payroll views.

## Verification

Run `npm test --prefix functions`. The gift tests cover old debt, partial/full use, concurrent ordering, accumulated and cross-year gifts, agorot, invalid input, deletion/refunds, repeated corrections, stale edits, and the actual application payroll readers and accountant HTML.

Mobile UI verification with a local Firebase stub also covered manager grants, employees without purchases, employee purchase previews, duplicate clicks, failed-save recovery, manager correction/deletion, report contents and 360–1280 px layouts. It does not write employee data or exercise production Firebase rules.
