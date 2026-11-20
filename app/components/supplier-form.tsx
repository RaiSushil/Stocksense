import { Form } from "react-router";
import type { ReactNode } from "react";
import { Btn, Card, Stack } from "./ui";

type Values = {
  name: string;
  email: string;
  contactName: string;
  phone: string;
  website: string;
  address: string;
  currency: string;
  paymentTerms: string;
  leadTime: string;
  minOrderValue: string;
  notes: string;
  vendors: string[];
  categories: string[];
};
type Errors = Partial<Record<keyof Values, string>>;

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="ss-annotated">
      <div className="ss-annotated-head">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="ss-annotated-body">{children}</div>
    </div>
  );
}

function F({
  label,
  name,
  values,
  errors,
  type = "text",
  placeholder,
  help,
  required,
  min,
  step,
  autoComplete,
}: {
  label: string;
  name: keyof Values;
  values: Values;
  errors: Errors;
  type?: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  min?: number;
  step?: string;
  autoComplete?: string;
}) {
  const err = errors[name];
  return (
    <div className={`ss-field${err ? " has-error" : ""}`}>
      <label className="ss-label" htmlFor={`sf-${name}`}>
        {label}
        {required && <span className="ss-req"> *</span>}
      </label>
      <input
        id={`sf-${name}`}
        className="ss-input"
        name={name}
        type={type}
        defaultValue={values[name] as string}
        placeholder={placeholder}
        required={required}
        min={min}
        step={step}
        autoComplete={autoComplete ?? "off"}
        aria-invalid={!!err}
        aria-describedby={err ? `sf-${name}-err` : undefined}
      />
      {err ? (
        <span className="ss-error" id={`sf-${name}-err`}>
          {err}
        </span>
      ) : (
        help && <span className="ss-help">{help}</span>
      )}
    </div>
  );
}

export function SupplierForm({
  values,
  errors,
  vendors,
  categories,
  currencies,
  paymentTerms,
  shopCurrency,
  busy,
  mode,
  side,
}: {
  values: Values;
  errors: Errors;
  vendors: { vendor: string; skus: number; supplier: string | null }[];
  categories: { category: string; skus: number; supplier: string | null }[];
  currencies: string[];
  paymentTerms: string[];
  shopCurrency: string;
  busy: boolean;
  mode: "create" | "edit";
  side?: ReactNode;
}) {
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <Form method="post" noValidate>
      <input type="hidden" name="intent" value="save" />
      <div className="ss-split">
        <Stack>
          {hasErrors && (
            <div className="ss-banner critical" role="alert">
              <div>
                <div className="ss-banner-title">Fix {Object.keys(errors).length === 1 ? "this field" : `these ${Object.keys(errors).length} fields`} to save</div>
                <div className="ss-banner-body">{Object.values(errors).join(" ")}</div>
              </div>
            </div>
          )}
          <Card>
            <Section title="Company" description="Who you buy from. The name appears on purchase orders.">
              <div className="ss-form-grid" style={{ ["--ss-min" as string]: "240px" }}>
                <F label="Supplier name" name="name" values={values} errors={errors} required placeholder="Loomcraft Mills" />
                <F label="Website" name="website" values={values} errors={errors} placeholder="loomcraft.com" />
              </div>
              <div className="ss-field">
                <label className="ss-label" htmlFor="sf-address">
                  Address
                </label>
                <textarea id="sf-address" className="ss-textarea" name="address" defaultValue={values.address} rows={2} placeholder="Street, city, postcode, country" />
              </div>
            </Section>
            <hr className="ss-divider" />
            <Section title="Contact" description="Approved purchase orders are emailed here with a CSV attached.">
              <div className="ss-form-grid" style={{ ["--ss-min" as string]: "220px" }}>
                <F label="Contact name" name="contactName" values={values} errors={errors} placeholder="Priya Shah" autoComplete="name" />
                <F label="Order email" name="email" type="email" values={values} errors={errors} placeholder="orders@loomcraft.com" autoComplete="email" />
                <F label="Phone" name="phone" type="tel" values={values} errors={errors} placeholder="+1 555 010 2030" autoComplete="tel" />
              </div>
            </Section>
            <hr className="ss-divider" />
            <Section title="Ordering terms" description="Lead time drives every forecast behind this supplier until received orders give a real average.">
              <div className="ss-form-grid" style={{ ["--ss-min" as string]: "180px" }}>
                <F label="Lead time (days)" name="leadTime" type="number" min={1} values={values} errors={errors} required help="Order placed to stock received" />
                <F label="Minimum order value" name="minOrderValue" type="number" min={0} step="0.01" values={values} errors={errors} help="0 if none" />
                <div className="ss-field">
                  <label className="ss-label" htmlFor="sf-currency">
                    Currency
                  </label>
                  <select id="sf-currency" className="ss-select" name="currency" defaultValue={values.currency || shopCurrency}>
                    {[...new Set([shopCurrency, ...currencies])].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="ss-field">
                  <label className="ss-label" htmlFor="sf-terms">
                    Payment terms
                  </label>
                  <select id="sf-terms" className="ss-select" name="paymentTerms" defaultValue={values.paymentTerms}>
                    <option value="">Not set</option>
                    {paymentTerms.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </Section>
            <hr className="ss-divider" />
            <Section title="Products" description="Pick the Shopify vendors this supplier makes. Their products are assigned now, and new ones are assigned automatically.">
              {vendors.length ? (
                <div className="ss-vendor-list">
                  {vendors.map((v) => (
                    <label key={v.vendor} className="ss-vendor">
                      <input type="checkbox" name="vendors" value={v.vendor} defaultChecked={values.vendors.includes(v.vendor)} />
                      <span className="ss-vendor-name">{v.vendor}</span>
                      <span className="ss-sku">
                        {v.skus} SKU{v.skus === 1 ? "" : "s"}
                        {v.supplier ? ` · now ${v.supplier}` : ""}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <span className="ss-muted ss-small">No vendors found on your products yet.</span>
              )}
            </Section>
            <hr className="ss-divider" />
            <Section
              title="Preferred for categories"
              description="Make this the preferred supplier for whole product categories. Every product in a ticked category is ordered from this supplier, including new ones. This wins over the vendor match."
            >
              {categories.length ? (
                <div className="ss-vendor-list">
                  {categories.map((c) => (
                    <label key={c.category} className="ss-vendor">
                      <input type="checkbox" name="categories" value={c.category} defaultChecked={values.categories.includes(c.category)} />
                      <span className="ss-vendor-name">{c.category}</span>
                      <span className="ss-sku">
                        {c.skus} SKU{c.skus === 1 ? "" : "s"}
                        {c.supplier ? ` · now ${c.supplier}` : ""}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <span className="ss-muted ss-small">
                  No categories yet. Set a product type or category on your products in Shopify and they appear here after the next sync.
                </span>
              )}
            </Section>
            <hr className="ss-divider" />
            <Section title="Notes" description="Anything your team should know when ordering. Included on the purchase order email.">
              <textarea className="ss-textarea" name="notes" defaultValue={values.notes} rows={3} placeholder="Ships Mondays only. Ask for Priya on rush orders." aria-label="Notes" />
            </Section>
          </Card>
        </Stack>
        <div className="ss-sticky">
          <Stack>
            <Card title={mode === "create" ? "Add supplier" : "Save changes"}>
              <Stack tight>
                <span className="ss-muted ss-small">
                  {mode === "create"
                    ? "Forecasts for the products you assign recalculate with this lead time as soon as you save."
                    : "Changing the lead time moves every forecast and reorder point behind this supplier."}
                </span>
                <Btn type="submit" variant="primary" block loading={busy}>
                  {mode === "create" ? "Add supplier" : "Save supplier"}
                </Btn>
                <Btn href="/app/suppliers" variant="ghost" block>
                  Cancel
                </Btn>
              </Stack>
            </Card>
            {side}
          </Stack>
        </div>
      </div>
    </Form>
  );
}
