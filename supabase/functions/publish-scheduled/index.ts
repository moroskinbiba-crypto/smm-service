import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function processRecurrences(admin: any) {
  const now = new Date();
  const { data: recurrences, error } = await admin.from("post_recurrences")
    .select("id")
    .eq("active", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(50);
  if (error) throw error;

  let created = 0;
  for (const recurrence of recurrences ?? []) {
    const { data: cloneId, error: cloneError } = await admin.rpc("create_recurrence_instance", {
      p_recurrence_id: recurrence.id,
    });
    if (cloneError) throw cloneError;
    if (cloneId) created++;
  }
  return created;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json({ ok: false, error: "Missing server configuration" }, 500);

  const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const started = Date.now();
  let runId: number | null = null;

  try {
    const { data: config, error: configError } = await supabase.rpc("get_scheduler_config");
    if (configError) throw configError;
    const scheduler = Array.isArray(config) ? config[0] : config;
    const expectedToken = scheduler?.cron_token ?? "";
    if (!expectedToken || req.headers.get("x-cron-token") !== expectedToken) return json({ ok: false, error: "Unauthorized" }, 401);
    if (scheduler?.enabled !== true) return json({ ok: true, enabled: false, created_recurrences: 0, queued: 0, recovered: 0 });

    const { data: runRow } = await supabase.from("scheduler_runs").insert({
      worker: "recurrence-dispatcher",
      details: { source: "cron" },
    }).select("id").single();
    runId = runRow?.id ?? null;

    const created = await processRecurrences(supabase);

    const payload = { ok: true, enabled: true, created_recurrences: created, queued: 0, recovered: 0 };
    if (runId) await supabase.from("scheduler_runs").update({
      status: "success",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      details: payload,
    }).eq("id", runId);
    return json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) await supabase.from("scheduler_runs").update({
      status: "error", finished_at: new Date().toISOString(), duration_ms: Date.now() - started, error: message,
    }).eq("id", runId);
    return json({ ok: false, error: message }, 500);
  }
});
