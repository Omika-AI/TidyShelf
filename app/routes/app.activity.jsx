import { useLoaderData, useSearchParams, Link } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../services/settings.server";
import db from "../db.server";

const PAGE_SIZE = 50;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const skip = (page - 1) * PAGE_SIZE;

  const [logs, total] = await Promise.all([
    db.activityLog.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    db.activityLog.count({ where: { shopId: shop.id } }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return { logs, total, page, totalPages };
};

export default function Activity() {
  const { logs, total, page, totalPages } = useLoaderData();

  return (
    <s-page title="Activity Log">
      <s-card>
        <s-box padding="400">
          <p className="dp-helper-text">{total} total events</p>

          {logs.length === 0 ? (
            <p className="dp-helper-text" style={{ marginTop: 16 }}>
              No activity logged yet. Events will appear here when products are deprioritized, hidden, or restored.
            </p>
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
                {logs.map((log) => (
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

          {totalPages > 1 && (
            <div className="dp-pagination">
              {page > 1 && (
                <Link to={`/app/activity?page=${page - 1}`} className="dp-pagination-link">
                  Previous
                </Link>
              )}
              <span className="dp-pagination-info">
                Page {page} of {totalPages}
              </span>
              {page < totalPages && (
                <Link to={`/app/activity?page=${page + 1}`} className="dp-pagination-link">
                  Next
                </Link>
              )}
            </div>
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
