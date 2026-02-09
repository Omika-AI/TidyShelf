import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../services/settings.server";
import { runFullSync, restoreAllHidden } from "../services/sync.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const [deprioritizedCount, hiddenCount, restoredCount, recentActivity] = await Promise.all([
    db.productSnapshot.count({
      where: { shopId: shop.id, action: "PUSHED_TO_END", status: "ACTIVE" },
    }),
    db.productSnapshot.count({
      where: { shopId: shop.id, action: "HIDDEN", status: "ACTIVE" },
    }),
    db.productSnapshot.count({
      where: { shopId: shop.id, status: "RESTORED" },
    }),
    db.activityLog.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return {
    shop,
    stats: { deprioritizedCount, hiddenCount, restoredCount },
    recentActivity,
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "runSync") {
    const result = await runFullSync(admin, session.shop);
    return { syncResult: result };
  }

  if (intent === "restoreAllHidden") {
    const result = await restoreAllHidden(admin, session.shop);
    return { syncResult: result };
  }

  return null;
};

export default function Dashboard() {
  const { shop, stats, recentActivity } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSyncing = navigation.state === "submitting";

  return (
    <s-page title="Dashboard">
      {actionData?.syncResult && (
        <s-banner tone="info" dismissible>
          Sync complete: {actionData.syncResult.message}
        </s-banner>
      )}

      <s-box paddingBlockEnd="400">
        <div className="dp-kpi-grid">
          <div className="dp-kpi-card">
            <span className="dp-kpi-label">Deprioritized</span>
            <span className="dp-kpi-value">{stats.deprioritizedCount}</span>
          </div>
          <div className="dp-kpi-card">
            <span className="dp-kpi-label">Hidden</span>
            <span className="dp-kpi-value">{stats.hiddenCount}</span>
          </div>
          <div className="dp-kpi-card">
            <span className="dp-kpi-label">Restored</span>
            <span className="dp-kpi-value">{stats.restoredCount}</span>
          </div>
          <div className="dp-kpi-card">
            <span className="dp-kpi-label">Status</span>
            <span className="dp-kpi-value">{shop.enabled ? "Active" : "Paused"}</span>
          </div>
        </div>
      </s-box>

      <s-box paddingBlockEnd="400">
        <div style={{ display: "flex", gap: "12px" }}>
          <Form method="post">
            <input type="hidden" name="intent" value="runSync" />
            <s-button variant="primary" type="submit" disabled={isSyncing || undefined}>
              {isSyncing ? "Syncing..." : "Run Full Sync"}
            </s-button>
          </Form>
          {stats.hiddenCount > 0 && (
            <Form method="post">
              <input type="hidden" name="intent" value="restoreAllHidden" />
              <s-button variant="secondary" tone="critical" type="submit" disabled={isSyncing || undefined}>
                {isSyncing ? "Restoring..." : `Restore ${stats.hiddenCount} Hidden`}
              </s-button>
            </Form>
          )}
        </div>
      </s-box>

      <s-card>
        <s-box padding="400">
          <h2 className="dp-section-header">Recent Activity</h2>
          {recentActivity.length === 0 ? (
            <p className="dp-helper-text">No activity yet. Activity will appear here when products are deprioritized or restored.</p>
          ) : (
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Action</th>
                  <th>Detail</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map((log) => (
                  <tr key={log.id}>
                    <td>{log.productTitle || log.productId}</td>
                    <td>
                      <span className={`dp-badge dp-badge--${log.action.toLowerCase()}`}>
                        {formatAction(log.action)}
                      </span>
                    </td>
                    <td>{log.detail}</td>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </s-box>
      </s-card>
    </s-page>
  );
}

function formatAction(action) {
  const labels = {
    DEPRIORITIZED: "Deprioritized",
    HIDDEN: "Hidden",
    RESTORED_POSITION: "Restored Position",
    RESTORED_VISIBILITY: "Restored Visibility",
    SKIPPED: "Skipped",
  };
  return labels[action] || action;
}
