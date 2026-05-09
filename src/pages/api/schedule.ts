import type { APIRoute } from "astro";
import { kv } from "@vercel/kv";

const KV_KEY = "schedule-planner-state";
const PASSWORD = import.meta.env.SCHEDULE_PASSWORD;

export const GET: APIRoute = async () => {
  try {
    const data = await kv.get<{ overrides: Record<string, number>; holidays: string[] }>(KV_KEY);
    return new Response(JSON.stringify(data ?? { overrides: {}, holidays: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ overrides: {}, holidays: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (PASSWORD) {
    const auth = request.headers.get("x-schedule-password");
    if (auth !== PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  try {
    const body = await request.json();
    await kv.set(KV_KEY, body);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Failed to save" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
