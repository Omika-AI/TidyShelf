import db from "../db.server";

/**
 * Push a product to the end of a collection (manual sort order only).
 * Saves a snapshot of the original position for later restoration.
 */
export async function pushProductToEnd(admin, shopId, productId, collectionId) {
  // Get products in the collection to find current position
  const response = await admin.graphql(`
    query getCollectionProducts($collectionId: ID!) {
      collection(id: $collectionId) {
        id
        sortOrder
        products(first: 250, sortKey: COLLECTION_DEFAULT) {
          nodes {
            id
          }
        }
      }
    }
  `, {
    variables: { collectionId },
  });

  const data = await response.json();
  const collection = data.data?.collection;

  if (!collection) {
    return { success: false, reason: "Collection not found" };
  }

  // Only reorder if collection uses MANUAL sort order
  if (collection.sortOrder !== "MANUAL") {
    return {
      success: false,
      reason: `Collection uses ${collection.sortOrder} sort order (not MANUAL)`,
      skipped: true,
    };
  }

  const products = collection.products?.nodes || [];
  const currentIndex = products.findIndex((p) => p.id === productId);

  if (currentIndex === -1) {
    return { success: false, reason: "Product not in collection" };
  }

  // Already at the end
  if (currentIndex === products.length - 1) {
    return { success: true, reason: "Product already at end" };
  }

  // Save snapshot of original position
  await db.productSnapshot.upsert({
    where: {
      shopId_productId_collectionId_action_status: {
        shopId,
        productId,
        collectionId,
        action: "PUSHED_TO_END",
        status: "ACTIVE",
      },
    },
    create: {
      shopId,
      productId,
      collectionId,
      originalPosition: currentIndex,
      action: "PUSHED_TO_END",
      status: "ACTIVE",
    },
    update: {},
  });

  // Build moves array: move the product after the last product in the collection
  const lastProductId = products[products.length - 1].id;

  const moveResponse = await admin.graphql(`
    mutation reorderProducts($collectionId: ID!, $moves: [MoveInput!]!) {
      collectionReorderProducts(id: $collectionId, moves: $moves) {
        job {
          id
          done
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    variables: {
      collectionId,
      moves: [{ id: productId, newPosition: (products.length - 1).toString() }],
    },
  });

  const moveData = await moveResponse.json();
  const userErrors = moveData.data?.collectionReorderProducts?.userErrors || [];

  if (userErrors.length > 0) {
    return { success: false, reason: userErrors.map((e) => e.message).join(", ") };
  }

  return { success: true };
}

/**
 * Restore a product to its original position in a collection.
 */
export async function restoreProductPosition(admin, shopId, productId, collectionId) {
  // Find the active snapshot
  const snapshot = await db.productSnapshot.findFirst({
    where: {
      shopId,
      productId,
      collectionId,
      action: "PUSHED_TO_END",
      status: "ACTIVE",
    },
  });

  if (!snapshot) {
    return { success: false, reason: "No active snapshot found" };
  }

  // Get current collection products to validate
  const response = await admin.graphql(`
    query getCollectionProducts($collectionId: ID!) {
      collection(id: $collectionId) {
        id
        products(first: 250, sortKey: COLLECTION_DEFAULT) {
          nodes {
            id
          }
        }
      }
    }
  `, {
    variables: { collectionId },
  });

  const data = await response.json();
  const products = data.data?.collection?.products?.nodes || [];
  const currentIndex = products.findIndex((p) => p.id === productId);

  if (currentIndex === -1) {
    // Product no longer in collection, just mark as restored
    // Delete any existing RESTORED snapshots to avoid unique constraint violation
    await db.productSnapshot.deleteMany({
      where: { shopId, productId, collectionId, action: "PUSHED_TO_END", status: "RESTORED" },
    });
    await db.productSnapshot.update({
      where: { id: snapshot.id },
      data: { status: "RESTORED", restoredAt: new Date() },
    });
    return { success: true, reason: "Product no longer in collection, snapshot cleared" };
  }

  // Clamp the target position to the collection size
  const targetPosition = Math.min(snapshot.originalPosition ?? 0, products.length - 1);

  const moveResponse = await admin.graphql(`
    mutation reorderProducts($collectionId: ID!, $moves: [MoveInput!]!) {
      collectionReorderProducts(id: $collectionId, moves: $moves) {
        job {
          id
          done
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    variables: {
      collectionId,
      moves: [{ id: productId, newPosition: targetPosition.toString() }],
    },
  });

  const moveData = await moveResponse.json();
  const userErrors = moveData.data?.collectionReorderProducts?.userErrors || [];

  if (userErrors.length > 0) {
    return { success: false, reason: userErrors.map((e) => e.message).join(", ") };
  }

  // Delete any existing RESTORED snapshots to avoid unique constraint violation
  await db.productSnapshot.deleteMany({
    where: { shopId, productId, collectionId, action: "PUSHED_TO_END", status: "RESTORED" },
  });

  // Mark snapshot as restored
  await db.productSnapshot.update({
    where: { id: snapshot.id },
    data: { status: "RESTORED", restoredAt: new Date() },
  });

  return { success: true };
}
