import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { enqueue } from "../lib/whatsapp/inbox.server";
import { parseMeta, parseTwilio, verifyMeta, verifyTwilio } from "../lib/whatsapp/provider.server";

// Meta checks the webhook URL once with a GET and the verify token.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const token = process.env.META_WA_VERIFY_TOKEN;
  if (token && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === token) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
};

// Incoming messages from Meta (JSON) or Twilio (form). Both are signed; anything that
// isn't is refused. Replies are sent afterwards, so this answers straight away.
export const action = async ({ request }: ActionFunctionArgs) => {
  const raw = await request.text();
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    if (!verifyMeta(raw, request.headers.get("x-hub-signature-256"))) return new Response("Invalid signature", { status: 401 });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    enqueue(parseMeta(body));
    return new Response("ok");
  }
  const params = Object.fromEntries(new URLSearchParams(raw));
  const publicUrl = `${(process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "")}/webhooks/whatsapp`;
  if (!verifyTwilio(publicUrl, params, request.headers.get("x-twilio-signature"))) return new Response("Invalid signature", { status: 401 });
  const msg = parseTwilio(params);
  if (msg) enqueue([msg]);
  return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
};
