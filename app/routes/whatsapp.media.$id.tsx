import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

// Chart images for WhatsApp. The id is random and expires after an hour.
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const media = await db.whatsappMedia.findUnique({ where: { id: params.id ?? "" } });
  if (!media || media.expiresAt < new Date()) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(media.data), {
    headers: { "Content-Type": media.mime, "Cache-Control": "private, max-age=3600", "X-Robots-Tag": "noindex" },
  });
};
