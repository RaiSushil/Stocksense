import type { ActionFunctionArgs } from "react-router";
import { schedulerTick } from "../lib/jobs.server";

// POST /jobs/tick with header "Authorization: Bearer $CRON_SECRET".
// Use this from an external cron when running several app instances with
// DISABLE_SCHEDULER=true, so only one place decides what is due.
export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  await schedulerTick();
  return Response.json({ ok: true });
};
