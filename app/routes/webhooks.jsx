import db from "../db.server";
import { authenticate } from "../shopify.server";
import { checkProductInventory } from "../services/inventory.server";
import { getOrCreateShop } from "../services/settings.server";
import { handleOutOfStock, handleBackInStock } from "../services/sync.server";

// In-memory concurrency guard to skip duplicate events for the same inventory item
const processingLock = new Map();

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "INVENTORY_LEVELS_UPDATE":
      await handleInventoryUpdate(shop, payload, admin);
      break;

    case "APP_UNINSTALLED":
      await handleAppUninstalled(shop);
      break;

    case "APP_SCOPES_UPDATE":
      break;

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      break;

    case "SHOP_REDACT":
      await handleShopRedact(shop);
      break;

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};

async function handleInventoryUpdate(shop, payload, admin) {
  if (!shop || !admin) return;

  const inventoryItemId = payload.inventory_item_id;
  if (!inventoryItemId) return;

  // Concurrency guard
  const lockKey = `${shop}:${inventoryItemId}`;
  if (processingLock.has(lockKey)) {
    console.log(`Skipping duplicate inventory update for ${lockKey}`);
    return;
  }

  processingLock.set(lockKey, true);

  try {
    // Load shop settings
    const shopRecord = await getOrCreateShop(shop);
    if (!shopRecord.enabled) return;

    // Check product inventory status
    const inventoryResult = await checkProductInventory(admin, inventoryItemId);
    if (!inventoryResult) return;

    const { product, isFullyOutOfStock } = inventoryResult;

    // Check for existing active snapshots
    const activeSnapshots = await db.productSnapshot.findMany({
      where: {
        shopId: shopRecord.id,
        productId: product.id,
        status: "ACTIVE",
      },
    });

    if (isFullyOutOfStock && activeSnapshots.length === 0) {
      // Product just went out of stock - deprioritize
      console.log(`Product ${product.title} is fully out of stock - deprioritizing`);
      await handleOutOfStock(admin, shopRecord, product.id, product.title);
    } else if (!isFullyOutOfStock && activeSnapshots.length > 0) {
      // Product is back in stock - restore
      console.log(`Product ${product.title} is back in stock - restoring`);
      await handleBackInStock(admin, shopRecord, product.id, product.title);
    }
  } catch (error) {
    console.error(`Error handling inventory update for ${shop}:`, error);
  } finally {
    // Release lock after a short delay to debounce rapid updates
    setTimeout(() => processingLock.delete(lockKey), 5000);
  }
}

async function handleAppUninstalled(shop) {
  if (!shop) return;

  try {
    const shopRecord = await db.shop.findUnique({ where: { domain: shop } });
    if (shopRecord) {
      await db.shop.delete({ where: { domain: shop } });
      console.log(`Deleted shop record for uninstalled shop: ${shop}`);
    }

    await db.session.deleteMany({ where: { shop } });
    console.log(`Deleted sessions for uninstalled shop: ${shop}`);
  } catch (error) {
    console.error(`Error cleaning up data for ${shop}:`, error);
  }
}

async function handleShopRedact(shop) {
  try {
    const shopRecord = await db.shop.findUnique({ where: { domain: shop } });
    if (shopRecord) {
      await db.shop.delete({ where: { domain: shop } });
      console.log(`Deleted shop and all related data for: ${shop}`);
    }

    await db.session.deleteMany({ where: { shop } });
    console.log(`Deleted sessions for: ${shop}`);
  } catch (error) {
    console.error(`Error deleting data for shop ${shop}:`, error);
  }
}
