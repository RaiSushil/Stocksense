import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { adminContext } from "../lib/context.server";
import { poCsv } from "../lib/po.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const po = await db.purchaseOrder.findFirst({ where: { id: params.id, shop: shop.id } });
  if (!po) return new Response("Not found", { status: 404 });
  return new Response(await poCsv(shop.id, po.id), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${po.number}.csv"` },
  });
};
