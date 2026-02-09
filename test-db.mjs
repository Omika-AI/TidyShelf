import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

// Import the pure function directly
import { getEffectiveBehavior } from "./app/services/settings.server.js";

const TEST_DOMAIN = `test-shop-${Date.now()}.myshopify.com`;

async function cleanup() {
  // Remove any test data by domain
  const shop = await prisma.shop.findUnique({ where: { domain: TEST_DOMAIN } });
  if (shop) {
    await prisma.shop.delete({ where: { id: shop.id } });
  }
}

async function runTests() {
  console.log("\n=== TidyShelf Database & Business Logic Tests ===\n");

  await cleanup();

  // ── Test 1: Shop upsert (create) ──
  console.log("Test 1: Shop upsert (create)");
  const shop = await prisma.shop.upsert({
    where: { domain: TEST_DOMAIN },
    create: { domain: TEST_DOMAIN },
    update: {},
    include: { collectionRules: true },
  });
  assert(!!shop.id, "Shop has an ID");
  assert(shop.domain === TEST_DOMAIN, "Domain is correct");
  assert(shop.enabled === true, "Default enabled=true");
  assert(shop.defaultBehavior === "PUSH_TO_END", "Default behavior=PUSH_TO_END");
  assert(shop.applyToAll === true, "Default applyToAll=true");

  // ── Test 2: Shop upsert (idempotent) ──
  console.log("\nTest 2: Shop upsert (idempotent)");
  const shop2 = await prisma.shop.upsert({
    where: { domain: TEST_DOMAIN },
    create: { domain: TEST_DOMAIN },
    update: {},
    include: { collectionRules: true },
  });
  assert(shop2.id === shop.id, "Same ID returned on re-upsert");

  // ── Test 3: Update settings ──
  console.log("\nTest 3: Update settings");
  const updated = await prisma.shop.update({
    where: { domain: TEST_DOMAIN },
    data: {
      enabled: false,
      defaultBehavior: "HIDE",
      applyToAll: false,
    },
  });
  assert(updated.enabled === false, "enabled changed to false");
  assert(updated.defaultBehavior === "HIDE", "defaultBehavior changed to HIDE");
  assert(updated.applyToAll === false, "applyToAll changed to false");

  // Reset for further tests
  await prisma.shop.update({
    where: { domain: TEST_DOMAIN },
    data: { enabled: true, defaultBehavior: "PUSH_TO_END", applyToAll: true },
  });

  // ── Test 4: Upsert collection rule ──
  console.log("\nTest 4: Upsert collection rule");
  const rule = await prisma.collectionRule.upsert({
    where: {
      shopId_collectionId: { shopId: shop.id, collectionId: "coll_123" },
    },
    create: {
      shopId: shop.id,
      collectionId: "coll_123",
      collectionTitle: "Summer Sale",
      behavior: "HIDE",
    },
    update: {
      collectionTitle: "Summer Sale",
      behavior: "HIDE",
    },
  });
  assert(!!rule.id, "Rule has ID");
  assert(rule.collectionId === "coll_123", "Rule collectionId correct");
  assert(rule.behavior === "HIDE", "Rule behavior=HIDE");

  // Add a second rule for later delete test
  await prisma.collectionRule.upsert({
    where: {
      shopId_collectionId: { shopId: shop.id, collectionId: "coll_456" },
    },
    create: {
      shopId: shop.id,
      collectionId: "coll_456",
      collectionTitle: "Winter Clearance",
      behavior: "PUSH_TO_END",
    },
    update: {
      collectionTitle: "Winter Clearance",
      behavior: "PUSH_TO_END",
    },
  });

  // ── Test 5a: getEffectiveBehavior — disabled shop ──
  console.log("\nTest 5a: getEffectiveBehavior — disabled shop");
  const disabledShop = {
    enabled: false,
    defaultBehavior: "PUSH_TO_END",
    applyToAll: true,
    collectionRules: [],
  };
  assert(
    getEffectiveBehavior(disabledShop, "any") === "EXCLUDE",
    "Disabled shop returns EXCLUDE"
  );

  // ── Test 5b: getEffectiveBehavior — matching rule ──
  console.log("\nTest 5b: getEffectiveBehavior — matching rule");
  const shopWithRule = {
    enabled: true,
    defaultBehavior: "PUSH_TO_END",
    applyToAll: true,
    collectionRules: [{ collectionId: "coll_123", behavior: "HIDE" }],
  };
  assert(
    getEffectiveBehavior(shopWithRule, "coll_123") === "HIDE",
    "Matching rule returns rule's behavior"
  );

  // ── Test 5c: getEffectiveBehavior — no rule, applyToAll=true ──
  console.log("\nTest 5c: getEffectiveBehavior — no rule, applyToAll=true");
  const shopApplyAll = {
    enabled: true,
    defaultBehavior: "PUSH_TO_END",
    applyToAll: true,
    collectionRules: [],
  };
  assert(
    getEffectiveBehavior(shopApplyAll, "coll_999") === "PUSH_TO_END",
    "No rule + applyToAll returns defaultBehavior"
  );

  // ── Test 5d: getEffectiveBehavior — no rule, applyToAll=false ──
  console.log("\nTest 5d: getEffectiveBehavior — no rule, applyToAll=false");
  const shopNotAll = {
    enabled: true,
    defaultBehavior: "PUSH_TO_END",
    applyToAll: false,
    collectionRules: [],
  };
  assert(
    getEffectiveBehavior(shopNotAll, "coll_999") === "EXCLUDE",
    "No rule + applyToAll=false returns EXCLUDE"
  );

  // ── Test 6: ProductSnapshot CRUD ──
  console.log("\nTest 6: ProductSnapshot CRUD");
  const snap = await prisma.productSnapshot.create({
    data: {
      shopId: shop.id,
      productId: "prod_001",
      collectionId: "coll_123",
      originalPosition: 5,
      action: "PUSHED_TO_END",
      status: "ACTIVE",
    },
  });
  assert(!!snap.id, "Snapshot created with ID");
  assert(snap.status === "ACTIVE", "Snapshot status=ACTIVE");

  const restored = await prisma.productSnapshot.update({
    where: { id: snap.id },
    data: { status: "RESTORED", restoredAt: new Date() },
  });
  assert(restored.status === "RESTORED", "Snapshot updated to RESTORED");
  assert(restored.restoredAt !== null, "restoredAt is set");

  // ── Test 7: ActivityLog CRUD ──
  console.log("\nTest 7: ActivityLog CRUD");
  const log = await prisma.activityLog.create({
    data: {
      shopId: shop.id,
      productId: "prod_001",
      productTitle: "Cool Widget",
      action: "PUSHED_TO_END",
      detail: "Moved to end of Summer Sale",
    },
  });
  assert(!!log.id, "ActivityLog created with ID");

  const logs = await prisma.activityLog.findMany({
    where: { shopId: shop.id },
  });
  assert(logs.length >= 1, "ActivityLog query by shop returns results");

  // ── Test 8: Delete collection rule ──
  console.log("\nTest 8: Delete collection rule");
  const rulesBefore = await prisma.collectionRule.findMany({
    where: { shopId: shop.id },
  });
  const beforeCount = rulesBefore.length;

  await prisma.collectionRule.deleteMany({
    where: { shopId: shop.id, collectionId: "coll_123" },
  });

  const rulesAfter = await prisma.collectionRule.findMany({
    where: { shopId: shop.id },
  });
  assert(
    rulesAfter.length === beforeCount - 1,
    `Removed exactly 1 rule (${beforeCount} → ${rulesAfter.length})`
  );
  assert(
    rulesAfter.some((r) => r.collectionId === "coll_456"),
    "Other rule (coll_456) still exists"
  );

  // ── Test 9: Cascade delete ──
  console.log("\nTest 9: Cascade delete");
  await prisma.shop.delete({ where: { id: shop.id } });

  const remainingRules = await prisma.collectionRule.findMany({
    where: { shopId: shop.id },
  });
  const remainingSnaps = await prisma.productSnapshot.findMany({
    where: { shopId: shop.id },
  });
  const remainingLogs = await prisma.activityLog.findMany({
    where: { shopId: shop.id },
  });
  assert(remainingRules.length === 0, "CollectionRules cascaded");
  assert(remainingSnaps.length === 0, "ProductSnapshots cascaded");
  assert(remainingLogs.length === 0, "ActivityLogs cascaded");

  // ── Test 10: Unique constraint ──
  console.log("\nTest 10: Unique constraint (duplicate snapshot)");
  // Re-create shop for this test
  const shop3 = await prisma.shop.create({ data: { domain: `unique-test-${Date.now()}.myshopify.com` } });
  await prisma.productSnapshot.create({
    data: {
      shopId: shop3.id,
      productId: "prod_dup",
      collectionId: "coll_dup",
      action: "PUSHED_TO_END",
      status: "ACTIVE",
    },
  });

  let threw = false;
  try {
    await prisma.productSnapshot.create({
      data: {
        shopId: shop3.id,
        productId: "prod_dup",
        collectionId: "coll_dup",
        action: "PUSHED_TO_END",
        status: "ACTIVE",
      },
    });
  } catch (e) {
    threw = true;
  }
  assert(threw, "Duplicate snapshot throws unique constraint error");

  // Clean up shop3
  await prisma.shop.delete({ where: { id: shop3.id } });

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Fatal error:", err);
  prisma.$disconnect();
  process.exit(1);
});
