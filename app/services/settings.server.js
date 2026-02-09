import db from "../db.server";

/**
 * Get or create a Shop record for the given domain.
 */
export async function getOrCreateShop(domain) {
  return db.shop.upsert({
    where: { domain },
    create: { domain },
    update: {},
    include: { collectionRules: true },
  });
}

/**
 * Update global settings for a shop.
 */
export async function updateSettings(domain, data) {
  return db.shop.update({
    where: { domain },
    data: {
      enabled: data.enabled,
      defaultBehavior: data.defaultBehavior,
      applyToAll: data.applyToAll,
    },
  });
}

/**
 * Add or update a collection-specific behavior rule.
 */
export async function upsertCollectionRule(shopId, collectionId, data) {
  return db.collectionRule.upsert({
    where: {
      shopId_collectionId: { shopId, collectionId },
    },
    create: {
      shopId,
      collectionId,
      collectionTitle: data.collectionTitle,
      behavior: data.behavior,
    },
    update: {
      collectionTitle: data.collectionTitle,
      behavior: data.behavior,
    },
  });
}

/**
 * Remove a collection-specific rule (falls back to global default).
 */
export async function deleteCollectionRule(shopId, collectionId) {
  return db.collectionRule.deleteMany({
    where: { shopId, collectionId },
  });
}

/**
 * Resolve the effective behavior for a given collection.
 * Priority: collection rule > global default.
 * Returns "PUSH_TO_END", "HIDE", or "EXCLUDE".
 */
export function getEffectiveBehavior(shopRecord, collectionId) {
  if (!shopRecord.enabled) return "EXCLUDE";

  const rule = shopRecord.collectionRules?.find(
    (r) => r.collectionId === collectionId,
  );

  if (rule) return rule.behavior;
  if (shopRecord.applyToAll) return shopRecord.defaultBehavior;

  return "EXCLUDE";
}
