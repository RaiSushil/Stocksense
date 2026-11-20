// Create and update suppliers from the supplier form, with validation.

import db from "../db.server";
import { setSupplierLeadTime } from "./suppliers.server";

export interface SupplierValues {
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
}

export type SupplierErrors = Partial<Record<keyof SupplierValues, string>>;


/** Splits a comma separated key column (vendorKey, categoryKey) into clean values. */
export function keyList(v: string | null | undefined) {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function readSupplierForm(form: FormData): SupplierValues {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  return {
    name: str("name"),
    email: str("email"),
    contactName: str("contactName"),
    phone: str("phone"),
    website: str("website"),
    address: str("address"),
    currency: str("currency"),
    paymentTerms: str("paymentTerms"),
    leadTime: str("leadTime"),
    minOrderValue: str("minOrderValue"),
    notes: str("notes"),
    vendors: form.getAll("vendors").map(String).filter(Boolean),
    categories: form.getAll("categories").map(String).filter(Boolean),
  };
}

export function supplierToValues(s: {
  name: string;
  email: string | null;
  contactName: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  currency: string | null;
  paymentTerms: string | null;
  defaultLeadTimeDays: number;
  minOrderValue: number;
  notes: string | null;
  vendorKey: string | null;
  categoryKey?: string | null;
}): SupplierValues {
  return {
    name: s.name,
    email: s.email ?? "",
    contactName: s.contactName ?? "",
    phone: s.phone ?? "",
    website: s.website ?? "",
    address: s.address ?? "",
    currency: s.currency ?? "",
    paymentTerms: s.paymentTerms ?? "",
    leadTime: String(s.defaultLeadTimeDays),
    minOrderValue: String(s.minOrderValue),
    notes: s.notes ?? "",
    vendors: keyList(s.vendorKey),
    categories: keyList(s.categoryKey),
  };
}

export async function validateSupplier(shop: string, v: SupplierValues, id?: string): Promise<SupplierErrors> {
  const e: SupplierErrors = {};
  if (!v.name) e.name = "Enter the supplier's name.";
  else if (v.name.length > 120) e.name = "Keep the name under 120 characters.";
  else {
    const clash = await db.supplier.findFirst({ where: { shop, name: v.name, ...(id ? { NOT: { id } } : {}) } });
    if (clash) e.name = "A supplier with this name already exists.";
  }
  if (v.email && !EMAIL.test(v.email)) e.email = "Enter a valid email, like orders@supplier.com.";
  if (v.phone && !/^[+()\d\s.-]{6,}$/.test(v.phone)) e.phone = "Use digits, spaces and + ( ) - only.";
  if (v.website && !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v.website)) e.website = "Enter a web address, like supplier.com.";
  const lead = Number(v.leadTime);
  if (!v.leadTime || !Number.isFinite(lead) || lead < 1 || lead > 365) e.leadTime = "Lead time must be between 1 and 365 days.";
  const mov = v.minOrderValue === "" ? 0 : Number(v.minOrderValue);
  if (!Number.isFinite(mov) || mov < 0) e.minOrderValue = "Minimum order value can't be negative.";
  return e;
}

/** Saves the supplier and assigns the chosen vendors' products to it. Returns the supplier id. */
export async function saveSupplier(shop: string, v: SupplierValues, id?: string) {
  const website = v.website && !/^https?:\/\//i.test(v.website) ? `https://${v.website}` : v.website;
  const data = {
    name: v.name,
    email: v.email || null,
    contactName: v.contactName || null,
    phone: v.phone || null,
    website: website || null,
    address: v.address || null,
    currency: v.currency || null,
    paymentTerms: v.paymentTerms || null,
    minOrderValue: v.minOrderValue === "" ? 0 : Number(v.minOrderValue),
    notes: v.notes || null,
    vendorKey: v.vendors.length ? v.vendors.join(",") : null,
    categoryKey: v.categories.length ? v.categories.join(",") : null,
  };
  let supplierId: string;
  if (id) {
    await db.supplier.updateMany({ where: { id, shop }, data });
    await setSupplierLeadTime(shop, id, Math.round(Number(v.leadTime)));
    supplierId = id;
  } else {
    const created = await db.supplier.create({ data: { ...data, shop, defaultLeadTimeDays: Math.round(Number(v.leadTime)) } });
    supplierId = created.id;
  }
  if (v.vendors.length) {
    // A vendor belongs to one supplier: take it off any other supplier first.
    const others = await db.supplier.findMany({ where: { shop, NOT: { id: supplierId }, vendorKey: { not: null } } });
    for (const o of others) {
      const keys = (o.vendorKey ?? "").split(",").map((k) => k.trim()).filter((k) => k && !v.vendors.includes(k));
      await db.supplier.update({ where: { id: o.id }, data: { vendorKey: keys.length ? keys.join(",") : null } });
    }
    await db.variant.updateMany({ where: { shop, vendor: { in: v.vendors } }, data: { supplierId } });
  }
  // Categories are applied after vendors, so a category preference wins over a vendor match.
  if (v.categories.length) await setPreferredForCategories(shop, supplierId, v.categories, { replace: true });
  return supplierId;
}

/**
 * Makes a supplier the preferred one for product categories: every product in those
 * categories is assigned to it now, new products in them are assigned on import, and
 * the categories are taken off any other supplier. With replace, the supplier's own
 * category list becomes exactly `categories`; otherwise they are added to it.
 */
export async function setPreferredForCategories(shop: string, supplierId: string, categories: string[], opts: { replace?: boolean } = {}) {
  const wanted = [...new Set(categories.map((c) => c.trim()).filter(Boolean))];
  const supplier = await db.supplier.findFirstOrThrow({ where: { id: supplierId, shop } });
  const own = opts.replace ? wanted : [...new Set([...keyList(supplier.categoryKey), ...wanted])];
  await db.supplier.update({ where: { id: supplierId }, data: { categoryKey: own.length ? own.join(",") : null } });
  if (!wanted.length) return;
  const others = await db.supplier.findMany({ where: { shop, NOT: { id: supplierId }, categoryKey: { not: null } } });
  for (const o of others) {
    const keys = keyList(o.categoryKey).filter((k) => !wanted.includes(k));
    await db.supplier.update({ where: { id: o.id }, data: { categoryKey: keys.length ? keys.join(",") : null } });
  }
  await db.variant.updateMany({ where: { shop, productType: { in: wanted } }, data: { supplierId } });
}

/** Product categories on the shop's products, with SKU counts and their preferred supplier. */
export async function categoryOptions(shop: string) {
  const groups = await db.variant.groupBy({ by: ["productType"], where: { shop, productType: { not: null } }, _count: true });
  const suppliers = await db.supplier.findMany({ where: { shop, categoryKey: { not: null } } });
  const owner = new Map<string, string>();
  for (const s of suppliers) for (const k of keyList(s.categoryKey)) owner.set(k, s.name);
  return groups
    .map((g) => ({ category: g.productType!, skus: g._count, supplier: owner.get(g.productType!) ?? null }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Vendors on the shop's products, with SKU counts and the supplier each is assigned to. */
export async function vendorOptions(shop: string) {
  const groups = await db.variant.groupBy({ by: ["vendor"], where: { shop, vendor: { not: null } }, _count: true });
  const suppliers = await db.supplier.findMany({ where: { shop, vendorKey: { not: null } } });
  const owner = new Map<string, string>();
  for (const s of suppliers) for (const k of keyList(s.vendorKey)) owner.set(k, s.name);
  return groups
    .map((g) => ({ vendor: g.vendor!, skus: g._count, supplier: owner.get(g.vendor!) ?? null }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
}
