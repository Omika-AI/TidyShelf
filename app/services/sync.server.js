import db from "../db.server";
import { getEffectiveBehavior, getOrCreateShop } from "./settings.server";
import { getProductCollections } from "./inventory.server";
import { pushProductToEnd, restoreProductPosition } from "./collection-reorder.server";
import { hideProduct, restoreProductVisibility } from "./product-visibility.server";

/**
 * Handle a product that is fully out of stock.
 * Applies the configured behavior per collection.
 */
export async function handleOutOfStock(admin, shopRecord, productId, productTitle) {
  const collections = await getProductCollections(admin, productId);
  const results = [];

  for (const collection of collections) {
    const behavior = getEffectiveBehavior(shopRecord, collection.id);

    if (behavior === "EXCLUDE") {
      await logActivity(shopRecord.id, productId, productTitle, "SKIPPED", `Excluded collection: ${collection.title}`);
      results.push({ collection: collection.title, action: "SKIPPED" });
      continue;
    }

    if (behavior === "PUSH_TO_END") {
      const result = await pushProductToEnd(admin, shopRecord.id, productId, collection.id);

      if (result.skipped) {
        await logActivity(shopRecord.id, productId, productTitle, "SKIPPED", `${collection.title}: ${result.reason}`);
        results.push({ collection: collection.title, action: "SKIPPED", reason: result.reason });
      } else if (result.success) {
        await logActivity(shopRecord.id, productId, productTitle, "DEPRIORITIZED", `Pushed to end of ${collection.title}`);
        results.push({ collection: collection.title, action: "DEPRIORITIZED" });
      } else {
        await logActivity(shopRecord.id, productId, productTitle, "SKIPPED", `Failed in ${collection.title}: ${result.reason}`);
        results.push({ collection: collection.title, action: "FAILED", reason: result.reason });
      }
      continue;
    }

    if (behavior === "HIDE") {
      const result = await hideProduct(admin, shopRecord.id, productId);

      if (result.success) {
        await logActivity(shopRecord.id, productId, productTitle, "HIDDEN", `Hidden from storefront`);
        results.push({ collection: collection.title, action: "HIDDEN" });
      } else {
        await logActivity(shopRecord.id, productId, productTitle, "SKIPPED", `Failed to hide: ${JSON.stringify(result.publications)}`);
        results.push({ collection: collection.title, action: "FAILED" });
      }
      // Only hide once (it's product-level, not collection-level)
      break;
    }
  }

  // If no collections but behavior is HIDE, still hide the product
  if (collections.length === 0) {
    const behavior = shopRecord.applyToAll ? shopRecord.defaultBehavior : "EXCLUDE";
    if (behavior === "HIDE") {
      const result = await hideProduct(admin, shopRecord.id, productId);
      if (result.success) {
        await logActivity(shopRecord.id, productId, productTitle, "HIDDEN", "Hidden from storefront (no collections)");
        results.push({ action: "HIDDEN" });
      }
    }
  }

  return results;
}

/**
 * Handle a product that is back in stock.
 * Restores all active snapshots (positions and visibility).
 */
export async function handleBackInStock(admin, shopRecord, productId, productTitle) {
  const results = [];

  // Restore all PUSHED_TO_END snapshots
  const pushSnapshots = await db.productSnapshot.findMany({
    where: {
      shopId: shopRecord.id,
      productId,
      action: "PUSHED_TO_END",
      status: "ACTIVE",
    },
  });

  for (const snapshot of pushSnapshots) {
    const result = await restoreProductPosition(admin, shopRecord.id, productId, snapshot.collectionId);
    await logActivity(shopRecord.id, productId, productTitle, "RESTORED_POSITION",
      result.success ? `Restored in collection` : `Failed to restore: ${result.reason}`);
    results.push({ action: "RESTORED_POSITION", success: result.success });
  }

  // Restore all HIDDEN snapshots
  const restoreResult = await restoreProductVisibility(admin, shopRecord.id, productId);
  if (restoreResult.publications?.length > 0) {
    await logActivity(shopRecord.id, productId, productTitle, "RESTORED_VISIBILITY",
      `Re-published to ${restoreResult.publications.length} channel(s)`);
    results.push({ action: "RESTORED_VISIBILITY", success: restoreResult.success });
  }

  return results;
}

/**
 * Run a full sync of all products in the shop.
 * Iterates every product, checks inventory, applies rules.
 */
export async function runFullSync(admin, shopDomain) {
  const shopRecord = await getOrCreateShop(shopDomain);
  if (!shopRecord.enabled) return { synced: 0, message: "App is disabled" };

  let cursor = null;
  let hasNext = true;
  let processed = 0;

  while (hasNext) {
    const response = await admin.graphql(`
      query getProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            totalInventory
            variants(first: 100) {
              nodes {
                id
                inventoryQuantity
              }
            }
          }
        }
      }
    `, {
      variables: { cursor },
    });

    const data = await response.json();
    const connection = data.data?.products;
    if (!connection) break;

    for (const product of connection.nodes) {
      const variants = product.variants?.nodes || [];
      const isFullyOutOfStock = variants.length > 0 &&
        variants.every((v) => v.inventoryQuantity <= 0);

      // Check for existing active snapshots
      const activeSnapshots = await db.productSnapshot.findMany({
        where: {
          shopId: shopRecord.id,
          productId: product.id,
          status: "ACTIVE",
        },
      });

      if (isFullyOutOfStock) {
        if (activeSnapshots.length === 0) {
          // No snapshots - apply behavior
          await handleOutOfStock(admin, shopRecord, product.id, product.title);
        } else {
          // Has snapshots - check if behavior changed
          const collections = await getProductCollections(admin, product.id);
          const currentBehaviors = new Set(
            collections.map(c => getEffectiveBehavior(shopRecord, c.id))
          );
          // Also check default behavior for products with no collections
          if (collections.length === 0 && shopRecord.applyToAll) {
            currentBehaviors.add(shopRecord.defaultBehavior);
          }

          const snapshotActions = new Set(activeSnapshots.map(s => s.action));

          // Map behaviors to actions
          const behaviorNeedsHide = currentBehaviors.has("HIDE");
          const behaviorNeedsPush = currentBehaviors.has("PUSH_TO_END");
          const hasHiddenSnapshot = snapshotActions.has("HIDDEN");
          const hasPushedSnapshot = snapshotActions.has("PUSHED_TO_END");

          // If current behavior differs from snapshot action, restore and re-apply
          if (behaviorNeedsHide && !hasHiddenSnapshot) {
            // Restore pushed snapshots first
            await handleBackInStock(admin, shopRecord, product.id, product.title);
            // Then apply hide
            await handleOutOfStock(admin, shopRecord, product.id, product.title);
          } else if (behaviorNeedsPush && !hasPushedSnapshot) {
            // Restore hidden snapshots first
            await handleBackInStock(admin, shopRecord, product.id, product.title);
            // Then apply push
            await handleOutOfStock(admin, shopRecord, product.id, product.title);
          }
          // else: behavior matches snapshot, no action needed
        }
      } else if (!isFullyOutOfStock && activeSnapshots.length > 0) {
        await handleBackInStock(admin, shopRecord, product.id, product.title);
      }

      processed++;
    }

    hasNext = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return { synced: processed, message: `Processed ${processed} products` };
}

/**
 * Restore all hidden products back to their original publications.
 */
export async function restoreAllHidden(admin, shopDomain) {
  const shopRecord = await getOrCreateShop(shopDomain);

  const hiddenSnapshots = await db.productSnapshot.findMany({
    where: {
      shopId: shopRecord.id,
      action: "HIDDEN",
      status: "ACTIVE",
    },
  });

  if (hiddenSnapshots.length === 0) {
    return { synced: 0, message: "No hidden products to restore" };
  }

  // Group snapshots by productId
  const byProduct = new Map();
  for (const snap of hiddenSnapshots) {
    if (!byProduct.has(snap.productId)) byProduct.set(snap.productId, []);
    byProduct.get(snap.productId).push(snap);
  }

  let restored = 0;

  for (const [productId, snapshots] of byProduct) {
    const result = await restoreProductVisibility(admin, shopRecord.id, productId);

    // Get product title for logging
    let title = productId;
    try {
      const resp = await admin.graphql(`query ($id: ID!) { product(id: $id) { title } }`, {
        variables: { id: productId },
      });
      const d = await resp.json();
      title = d.data?.product?.title || productId;
    } catch {}

    if (result.publications?.length > 0) {
      await logActivity(shopRecord.id, productId, title, "RESTORED_VISIBILITY",
        `Re-published to ${result.publications.length} channel(s)`);
    }
    restored++;
  }

  return { synced: restored, message: `Restored ${restored} hidden products` };
}

/**
 * Log an activity event.
 */
async function logActivity(shopId, productId, productTitle, action, detail) {
  try {
    await db.activityLog.create({
      data: {
        shopId,
        productId,
        productTitle,
        action,
        detail,
      },
    });
  } catch (error) {
    console.error("Failed to log activity:", error);
  }
}
