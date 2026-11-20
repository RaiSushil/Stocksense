import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>StockSense: never run out of stock again</h1>
        <p className={styles.text}>
          StockSense forecasts demand for every SKU you carry, warns you weeks before a bestseller runs dry, and writes the purchase
          order for you.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Predict before you run out</strong>. A demand curve per variant, with seasonality, promotions, supplier lead times
            and a confidence range.
          </li>
          <li>
            <strong>Alerts that actually matter</strong>. Ranked by revenue at risk, with same-day velocity and lead-time drift alerts.
          </li>
          <li>
            <strong>Ask your inventory anything</strong>. Plain-English answers grounded in your own data, and draft purchase orders
            waiting for your approval.
          </li>
        </ul>
      </div>
    </div>
  );
}
