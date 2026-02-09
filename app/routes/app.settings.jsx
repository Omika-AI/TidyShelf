import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { getOrCreateShop, updateSettings, upsertCollectionRule, deleteCollectionRule } from "../services/settings.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  return { shop };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const shop = await getOrCreateShop(session.shop);

  if (intent === "saveSettings") {
    await updateSettings(session.shop, {
      enabled: formData.get("enabled") === "true",
      defaultBehavior: formData.get("defaultBehavior"),
      applyToAll: formData.get("applyToAll") === "true",
    });
    return { success: true, message: "Settings saved" };
  }

  if (intent === "addCollectionRule") {
    const collectionId = formData.get("collectionId");
    const collectionTitle = formData.get("collectionTitle");
    const behavior = formData.get("behavior");

    if (!collectionId || !behavior) {
      return { error: "Collection and behavior are required" };
    }

    await upsertCollectionRule(shop.id, collectionId, {
      collectionTitle: collectionTitle || "Unknown",
      behavior,
    });
    return { success: true, message: "Collection rule added" };
  }

  if (intent === "deleteCollectionRule") {
    const collectionId = formData.get("collectionId");
    await deleteCollectionRule(shop.id, collectionId);
    return { success: true, message: "Collection rule removed" };
  }

  return null;
};

export default function Settings() {
  const { shop } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [enabled, setEnabled] = useState(shop.enabled);
  const [defaultBehavior, setDefaultBehavior] = useState(shop.defaultBehavior);
  const [applyToAll, setApplyToAll] = useState(shop.applyToAll);

  // Collection picker state
  const [newCollectionId, setNewCollectionId] = useState("");
  const [newCollectionTitle, setNewCollectionTitle] = useState("");
  const [newBehavior, setNewBehavior] = useState("PUSH_TO_END");
  const [pickerOpen, setPickerOpen] = useState(false);

  async function openCollectionPicker() {
    try {
      const selected = await shopify.resourcePicker({
        type: "collection",
        multiple: false,
      });
      if (selected && selected.length > 0) {
        setNewCollectionId(selected[0].id);
        setNewCollectionTitle(selected[0].title);
      }
    } catch (e) {
      console.error("Resource picker error:", e);
    }
  }

  return (
    <s-page title="Settings">
      {actionData?.success && (
        <s-banner tone="success" dismissible>
          {actionData.message}
        </s-banner>
      )}
      {actionData?.error && (
        <s-banner tone="critical" dismissible>
          {actionData.error}
        </s-banner>
      )}

      {/* Global Settings */}
      <s-card>
        <s-box padding="400">
          <h2 className="dp-section-header">Global Settings</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="saveSettings" />
            <div className="dp-field-stack">
              <div>
                <label className="dp-field-label">App Enabled</label>
                <select
                  name="enabled"
                  value={enabled ? "true" : "false"}
                  onChange={(e) => setEnabled(e.target.value === "true")}
                  className="dp-select"
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
                <p className="dp-helper-text">When disabled, no products will be deprioritized or hidden.</p>
              </div>

              <div>
                <label className="dp-field-label">Default Behavior</label>
                <select
                  name="defaultBehavior"
                  value={defaultBehavior}
                  onChange={(e) => setDefaultBehavior(e.target.value)}
                  className="dp-select"
                >
                  <option value="PUSH_TO_END">Push to End of Collection</option>
                  <option value="HIDE">Hide from Storefront</option>
                </select>
                <p className="dp-helper-text">
                  <strong>Push to End:</strong> Moves out-of-stock products to the last position in manually sorted collections.
                  <br />
                  <strong>Hide:</strong> Unpublishes out-of-stock products from all sales channels.
                </p>
              </div>

              <div>
                <label className="dp-field-label">Apply to All Collections</label>
                <select
                  name="applyToAll"
                  value={applyToAll ? "true" : "false"}
                  onChange={(e) => setApplyToAll(e.target.value === "true")}
                  className="dp-select"
                >
                  <option value="true">Yes - apply default to all collections</option>
                  <option value="false">No - only apply to collections with rules below</option>
                </select>
              </div>

              <s-button variant="primary" type="submit" disabled={isSubmitting || undefined}>
                {isSubmitting ? "Saving..." : "Save Settings"}
              </s-button>
            </div>
          </Form>
        </s-box>
      </s-card>

      {/* Collection Overrides */}
      <s-card>
        <s-box padding="400">
          <h2 className="dp-section-header">Collection Overrides</h2>
          <p className="dp-helper-text">Override the default behavior for specific collections.</p>

          {shop.collectionRules?.length > 0 ? (
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Behavior</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shop.collectionRules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.collectionTitle}</td>
                    <td>
                      <span className={`dp-badge dp-badge--${rule.behavior.toLowerCase()}`}>
                        {formatBehavior(rule.behavior)}
                      </span>
                    </td>
                    <td>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="deleteCollectionRule" />
                        <input type="hidden" name="collectionId" value={rule.collectionId} />
                        <s-button variant="plain" tone="critical" type="submit">Remove</s-button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="dp-helper-text" style={{ marginTop: 12 }}>No collection overrides yet.</p>
          )}

          <div className="dp-add-rule-form">
            <h3 className="dp-subsection-header">Add Collection Rule</h3>
            <Form method="post">
              <input type="hidden" name="intent" value="addCollectionRule" />
              <input type="hidden" name="collectionId" value={newCollectionId} />
              <input type="hidden" name="collectionTitle" value={newCollectionTitle} />
              <div className="dp-field-stack">
                <div>
                  <label className="dp-field-label">Collection</label>
                  <div className="dp-picker-row">
                    <s-button type="button" onClick={openCollectionPicker}>
                      {newCollectionTitle || "Select a collection"}
                    </s-button>
                  </div>
                </div>
                <div>
                  <label className="dp-field-label">Behavior</label>
                  <select
                    name="behavior"
                    value={newBehavior}
                    onChange={(e) => setNewBehavior(e.target.value)}
                    className="dp-select"
                  >
                    <option value="PUSH_TO_END">Push to End</option>
                    <option value="HIDE">Hide</option>
                    <option value="EXCLUDE">Exclude (skip this collection)</option>
                  </select>
                </div>
                <s-button variant="primary" type="submit" disabled={!newCollectionId || isSubmitting || undefined}>
                  Add Rule
                </s-button>
              </div>
            </Form>
          </div>
        </s-box>
      </s-card>
    </s-page>
  );
}

function formatBehavior(behavior) {
  const labels = {
    PUSH_TO_END: "Push to End",
    HIDE: "Hide",
    EXCLUDE: "Exclude",
  };
  return labels[behavior] || behavior;
}
