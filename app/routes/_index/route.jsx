import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Index() {
  const { showForm } = useLoaderData();

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "#f6f6f7" }}>
      <div style={{ maxWidth: 480, padding: 32, textAlign: "center" }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>TidyShelf</h1>
        <p style={{ color: "#6b7280", marginBottom: 24 }}>
          Automatically deprioritize out-of-stock products in your collections.
        </p>
        {showForm && (
          <Form method="post" action="/auth/login" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ textAlign: "left" }}>
              <span style={{ fontWeight: 500 }}>Shop domain</span>
              <input
                type="text"
                name="shop"
                placeholder="my-shop.myshopify.com"
                style={{ display: "block", width: "100%", padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 8, marginTop: 4 }}
              />
            </label>
            <button
              type="submit"
              style={{ padding: "10px 20px", background: "#000", color: "#fff", borderRadius: 8, border: "none", fontWeight: 600, cursor: "pointer" }}
            >
              Log in
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}
