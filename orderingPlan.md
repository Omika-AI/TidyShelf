# Support "Push to End" for Non-MANUAL Collections (e.g. BEST_SELLING)

## Problem
`pushProductToEnd()` skips collections that don't use MANUAL sort order. Shopify's `collectionReorderProducts` mutation requires MANUAL sort. All 32 products were skipped during sync because "Home page" uses BEST_SELLING.

## Approach
Use Shopify's `collectionUpdate` mutation to switch the collection to MANUAL before reordering, and restore the original sort order when all managed products in that collection are restored.

**Flow:**
1. Product goes out of stock in a BEST_SELLING collection
2. App switches collection to MANUAL (freezing current order)
3. App pushes the product to end, saves snapshot with `originalSortOrder: "BEST_SELLING"`
4. When product comes back in stock, app restores its position
5. If no more active snapshots remain for that collection, app switches sort order back to BEST_SELLING

---

## Files to Modify

### 1. `prisma/schema.prisma` — Add `originalSortOrder` field
Add `originalSortOrder String?` to the `ProductSnapshot` model (after `originalPosition`).

Then run: `npx prisma migrate dev --name add-original-sort-order`

### 2. `app/services/collection-reorder.server.js` — Main changes

**Add helper: `updateCollectionSortOrder(admin, collectionId, sortOrder)`**
- Calls `collectionUpdate` GraphQL mutation to set `sortOrder` on a collection
- Returns `{ success, errors }`

**Modify: `pushProductToEnd()`**
- Remove the early-return skip for non-MANUAL collections (lines 32-39)
- Instead: if `sortOrder !== "MANUAL"`, check if another active snapshot already switched this collection
  - If no prior switch: call `updateCollectionSortOrder(admin, collectionId, "MANUAL")`, then re-fetch products
  - If already switched: proceed as-is (collection is already MANUAL)
- When saving snapshot, store `originalSortOrder`:
  - If we switched the collection: store the original sort order (e.g. `"BEST_SELLING"`)
  - If collection was already MANUAL but was switched by a prior push: propagate the `originalSortOrder` from the existing active snapshot
  - If collection is genuinely MANUAL: store `null`

**Add helper: `maybeRestoreCollectionSortOrder(admin, shopId, collectionId, snapshot)`**
- Count remaining ACTIVE `PUSHED_TO_END` snapshots for the collection
- If count > 0: do nothing (other products still pushed)
- If count === 0: find `originalSortOrder` from the restored snapshot (or search recent snapshots), call `updateCollectionSortOrder()` to restore it

**Modify: `restoreProductPosition()`**
- After marking snapshot as RESTORED, call `maybeRestoreCollectionSortOrder()`
- Also call it in the "product no longer in collection" branch

### 3. No changes needed to:
- `app/services/sync.server.js` — `result.skipped` handling still works; the path just won't be hit for sort-order reasons anymore
- `app/routes/webhooks.jsx` — No interface changes
- `app/services/inventory.server.js` — No changes

---

## Edge Cases Handled
- **Multiple products out of stock in same collection:** First push switches sort order, subsequent pushes detect it's already MANUAL and propagate `originalSortOrder`
- **Already-MANUAL collections:** `originalSortOrder` stays `null`, no sort order restoration attempted
- **Last product restored:** Only then does the sort order get restored
- **Race conditions:** `collectionUpdate` to MANUAL is idempotent
- **Failed sort order switch:** Returns failure, logged as FAILED action in activity log

---

## Verification Plan
1. Run `npx prisma migrate dev --name add-original-sort-order`
2. Start dev server (`npm run dev`)
3. Use Playwright to:
   - Run Full Sync on Dashboard
   - Verify products in BEST_SELLING collections are now DEPRIORITIZED (not SKIPPED)
   - Check Activity Log for "Pushed to end" entries instead of "Skipped"
   - Verify the collection sort order was switched to MANUAL in Shopify admin
4. If an out-of-stock product is restocked, verify:
   - Product position is restored
   - Collection sort order switches back to BEST_SELLING (when last product restored)
