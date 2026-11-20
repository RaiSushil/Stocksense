// Deletes everything StockSense holds for one store (shop/redact). Every table with
// store data is keyed by shop, so this never touches another store's records.
import db from "../db.server";

export async function deleteShopData(shop: string) {
  const threads = await db.askThread.findMany({ where: { shop }, select: { id: true } });
  await db.$transaction([
    db.askMessage.deleteMany({ where: { threadId: { in: threads.map((t) => t.id) } } }),
    db.askThread.deleteMany({ where: { shop } }),
    db.purchaseOrderLine.deleteMany({ where: { po: { shop } } }),
    db.purchaseOrder.deleteMany({ where: { shop } }),
    db.alert.deleteMany({ where: { shop } }),
    db.forecast.deleteMany({ where: { shop } }),
    db.accuracySnapshot.deleteMany({ where: { shop } }),
    db.salesDaily.deleteMany({ where: { shop } }),
    db.processedOrder.deleteMany({ where: { shop } }),
    db.inventoryLevel.deleteMany({ where: { shop } }),
    db.variant.deleteMany({ where: { shop } }),
    db.leadTimeObservation.deleteMany({ where: { shop } }),
    db.supplier.deleteMany({ where: { shop } }),
    db.promotion.deleteMany({ where: { shop } }),
    db.location.deleteMany({ where: { shop } }),
    db.apiKey.deleteMany({ where: { shop } }),
    db.webhookEndpoint.deleteMany({ where: { shop } }),
    db.pendingAction.deleteMany({ where: { shop } }),
    db.whatsappLink.deleteMany({ where: { shop } }),
    db.whatsappCode.deleteMany({ where: { shop } }),
    db.whatsappMedia.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { id: shop } }),
  ]);
}
