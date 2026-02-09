/**
 * Given an inventory item ID, find the parent product and check if ALL variants
 * are out of stock (inventoryQuantity <= 0).
 *
 * Returns { product, isFullyOutOfStock } or null if product not found.
 */
export async function checkProductInventory(admin, inventoryItemId) {
  // First, find the inventory item to get the variant
  const inventoryResponse = await admin.graphql(`
    query getInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        id
        variant {
          id
          product {
            id
            title
          }
        }
      }
    }
  `, {
    variables: { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
  });

  const inventoryData = await inventoryResponse.json();
  const product = inventoryData.data?.inventoryItem?.variant?.product;

  if (!product) return null;

  // Now check all variants of the product
  const productResponse = await admin.graphql(`
    query getProductVariants($id: ID!) {
      product(id: $id) {
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
  `, {
    variables: { id: product.id },
  });

  const productData = await productResponse.json();
  const productNode = productData.data?.product;

  if (!productNode) return null;

  const variants = productNode.variants?.nodes || [];
  const isFullyOutOfStock = variants.length > 0 &&
    variants.every((v) => v.inventoryQuantity <= 0);

  return {
    product: {
      id: productNode.id,
      title: productNode.title,
      totalInventory: productNode.totalInventory,
    },
    isFullyOutOfStock,
  };
}

/**
 * Get all collections that contain a given product.
 * Returns array of { id, title, sortOrder }.
 */
export async function getProductCollections(admin, productId) {
  const collections = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const response = await admin.graphql(`
      query getProductCollections($productId: ID!, $cursor: String) {
        product(id: $productId) {
          collections(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              sortOrder
            }
          }
        }
      }
    `, {
      variables: { productId, cursor },
    });

    const data = await response.json();
    const connection = data.data?.product?.collections;

    if (!connection) break;

    for (const node of connection.nodes) {
      collections.push({
        id: node.id,
        title: node.title,
        sortOrder: node.sortOrder,
      });
    }

    hasNext = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return collections;
}
