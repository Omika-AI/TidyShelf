import db from "../db.server";

/**
 * Hide a product from all sales channel publications.
 * Saves a snapshot of each publication for later restoration.
 */
export async function hideProduct(admin, shopId, productId) {
  // Get current publications for the product
  const response = await admin.graphql(`
    query getProductPublications($productId: ID!) {
      product(id: $productId) {
        id
        resourcePublicationsV2(first: 50) {
          nodes {
            isPublished
            publication {
              id
              name
            }
          }
        }
      }
    }
  `, {
    variables: { productId },
  });

  const data = await response.json();
  const publications = data.data?.product?.resourcePublicationsV2?.nodes || [];
  const publishedOnes = publications.filter((p) => p.isPublished);

  if (publishedOnes.length === 0) {
    return { success: true, reason: "Product already unpublished from all channels" };
  }

  const results = [];

  for (const pub of publishedOnes) {
    const publicationId = pub.publication.id;

    // Save snapshot
    await db.productSnapshot.upsert({
      where: {
        shopId_productId_collectionId_action_status: {
          shopId,
          productId,
          collectionId: publicationId, // reuse collectionId field to store publicationId
          action: "HIDDEN",
          status: "ACTIVE",
        },
      },
      create: {
        shopId,
        productId,
        collectionId: publicationId,
        publicationId,
        action: "HIDDEN",
        status: "ACTIVE",
      },
      update: {},
    });

    // Unpublish from this publication
    const unpubResponse = await admin.graphql(`
      mutation unpublishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) {
          publishable {
            ... on Product {
              id
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        id: productId,
        input: [{ publicationId }],
      },
    });

    const unpubData = await unpubResponse.json();
    const errors = unpubData.data?.publishableUnpublish?.userErrors || [];

    results.push({
      publicationId,
      publicationName: pub.publication.name,
      success: errors.length === 0,
      errors,
    });
  }

  const allSucceeded = results.every((r) => r.success);
  return {
    success: allSucceeded,
    publications: results,
  };
}

/**
 * Restore product visibility by re-publishing to all saved publications.
 */
export async function restoreProductVisibility(admin, shopId, productId) {
  const snapshots = await db.productSnapshot.findMany({
    where: {
      shopId,
      productId,
      action: "HIDDEN",
      status: "ACTIVE",
    },
  });

  if (snapshots.length === 0) {
    return { success: true, reason: "No hidden snapshots to restore" };
  }

  const results = [];

  for (const snapshot of snapshots) {
    const publicationId = snapshot.publicationId;

    const pubResponse = await admin.graphql(`
      mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable {
            ... on Product {
              id
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        id: productId,
        input: [{ publicationId }],
      },
    });

    const pubData = await pubResponse.json();
    const errors = pubData.data?.publishablePublish?.userErrors || [];

    // Delete any existing RESTORED snapshots to avoid unique constraint violation
    await db.productSnapshot.deleteMany({
      where: {
        shopId,
        productId,
        collectionId: snapshot.collectionId,
        action: "HIDDEN",
        status: "RESTORED",
      },
    });

    // Mark snapshot as restored
    await db.productSnapshot.update({
      where: { id: snapshot.id },
      data: { status: "RESTORED", restoredAt: new Date() },
    });

    results.push({
      publicationId,
      success: errors.length === 0,
      errors,
    });
  }

  const allSucceeded = results.every((r) => r.success);
  return {
    success: allSucceeded,
    publications: results,
  };
}
