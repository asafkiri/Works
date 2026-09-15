# Employee store gifts (v71)

Managers grant an amount and a description from **הקפה לעובדים → employee → הוסף מתנה**. The manager sees each employee's current-month charge and remaining store gift separately, with the grant, use and refund history. Unspent gifts carry across months.

An employee is shown their gift only while a balance is left: the gift tile, the gift history and every gift wording on the purchase screen and its home tile appear when the balance is above zero, and are gone once it reaches zero — including for an employee who had a gift and spent it. The manager's view always shows the gift, so a new grant can be given at any time.

A grant given by mistake can be deleted from its row in the manager's gift history, for as long as the employee has not started using it. The button is shown only to a manager, and only while the derived history proves the whole grant is still untouched. A deleted grant leaves the ledger entirely: it disappears from both roles' history, with no cancellation row and no trace in the balances around it.

## Accounting behavior

- A grant never pays an existing debt. Only purchases recorded after the grant can use it.
- Each new purchase uses available gift credit first; only the remainder is included in payroll deductions, limit calculations, team totals and accountant print/image exports.
- A salary payment does not change the gift balance. Gifts do not become salary payments, advances or negative purchases.
- Money is calculated in integer agorot. A 100 ₪ gift following a 300 ₪ purchase leaves 300 ₪ chargeable; subsequent 40 ₪ and 80 ₪ purchases leave 320 ₪ chargeable and zero gift credit.
- Deleting/reducing a purchase refunds its debt portion first and then its gift portion. A gift refund becomes available at the correction time; it does not pay another purchase already recorded. Increasing an existing purchase adds the difference to its charge and does not draw on a later gift.
- Deleting a grant is offered only while the balance has stayed at or above that grant's amount ever since it was given, which is exactly the case where no purchase could have drawn on it. The deletion then lowers the gift balance by the granted amount and changes no purchase, no charge and no existing debt. A grant whose credit was used — even partly, and even if the purchase was later refunded — is not offered.
- A deletion cannot take money the employee already spent. It is replayed at its own timestamp: if a purchase recorded before it consumed part of the grant, the deletion lapses with no effect, the purchase keeps its cover, and another grant's unused credit is never removed in its place. The gift balance therefore never goes negative and a purchase is never re-charged after the fact.

## Persistence and compatibility

The existing `payments/{employeeId}/{pushId}` financial ledger is used for manager-authored grants, with `kind: "store_gift"`, `giftCents`, a description in `note`, `monthKey`, a server `createdAt`, and **`amount: 0`**. This reuses the payment path's existing manager-write/employee-own-read permissions. Current payment readers explicitly exclude gift entries; zero `amount` also keeps legacy salary sums from treating a grant as a payment. The employee purchase path cannot create a grant recognized by the gift calculator.

Purchases retain their existing `takings/{employeeId}/{pushId}` shape. `store-gifts.js` replays grants and purchases in server timestamp order, with a deterministic key tie-break, instead of saving a balance from a device's cache. Concurrent purchases therefore share a single derived balance without double spending. At an identical grant/purchase timestamp, the purchase remains chargeable rather than receiving a retroactive gift.

A deleted grant keeps its record and gains a server-timestamped `canceledAt`, written by a transaction that refuses a repeat deletion, an entry whose `giftCents` no longer matches the amount shown, and anything that is not a gift. A `canceledAt` earlier than `createdAt` or still unresolved is ignored, and old clients keep reading the entry as the zero-`amount` gift it already was. The record is kept only to keep that guarantee, not to be displayed: the first replay decides which deletions take effect, and a second replay drops those grants completely, so nothing about them reaches either role's history and no surrounding row keeps a balance that counted them. Replaying without a grant that is provably unused leaves every purchase split unchanged, which is what makes the two passes agree. A deletion that lapsed is kept visible to the manager on the grant's row, since that gift is still live.

Manager corrections use a transaction on the existing purchase. The transaction checks the original snapshot, preserves `giftOriginalCents`, and appends a `giftRevisions/{revisionId}` event with its server timestamp and new `priceCents`. Deletion is an audited zero-price correction with `deletedAt`, not removal of the funding history. A stale correction aborts without overwriting a newer edit. Financial history must be retained to reconstruct outstanding gifts.

No production records are migrated. The UI uses the existing Realtime Database paths; there is no new Cloud Function. Deleting writes to the grant a manager already wrote, under the same path permissions. Deployed database rules are external to this repository and are not changed by this feature. All participating clients should load v71 for gift-aware purchase and payroll views; an older client reads a deleted grant as still granted, so the balance it shows is stale until it reloads.

## Verification

Run `npm test --prefix functions`. The gift tests cover old debt, partial/full use, concurrent ordering, accumulated and cross-year gifts, agorot, invalid input, purchase deletion/refunds, repeated corrections, stale edits, deletion of an unused grant, the deleted grant leaving no row and no stale balance behind it, a used grant that cannot be deleted, a purchase racing a deletion, deleting one of several grants, and the actual application payroll readers, gift summary, gift history and accountant HTML. The manager's delete action itself is exercised against a stubbed database, including the re-check that catches a purchase recorded while the confirmation dialog is open.

Mobile UI verification with a local Firebase stub also covered manager grants, employees without purchases, employee purchase previews, duplicate clicks, failed-save recovery, manager correction/deletion, report contents and 360–1280 px layouts. The application's own employee purchase screen was rendered at 390 px from its real markup, CSS and render output in four states — manager with a deletable grant, employee with a balance, employee who spent it, employee whose grant was deleted — confirming that the last two contain no gift wording at all. It does not write employee data or exercise production Firebase rules.
