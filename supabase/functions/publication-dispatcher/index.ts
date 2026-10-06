import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function run() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) throw new Error("Missing server configuration");

  const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const started = Date.now();
  let runId: number | null = null;

  const { data: runRow } = await supabase.from("scheduler_runs").insert({
    worker: "publication-dispatcher",
    details: { source: "cron" },
  }).select("id").single();
  runId = runRow?.id ?? null;

  try {
    const { data: config, error: configError } = await supabase.rpc("get_scheduler_config");
    if (configError) throw configError;
    const scheduler = Array.isArray(config) ? config[0] : config;
    const expectedToken = scheduler?.cron_token ?? "";
    const providedToken = Deno.env.get("PUBLICATION_DISPATCH_TOKEN") || "";
    if (providedToken && reqHeaderToken !== providedToken) throw new Error("Unauthorized");
    if (!providedToken) {
      throw new Error("Missing dispatcher token");
    }
    if (scheduler?.enabled !== true) {
      if (runId) await supabase.from("scheduler_runs").update({
        status: "success", finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
        details: { enabled: false },
      }).eq("id", runId);
      return { ok: true, enabled: false, queued: 0, recovered: 0 };
    }
    if (reqHeaderToken !== expectedToken) throw new Error("Unauthorized");

    const { data: recovered, error: recoverError } = await supabase.rpc("recover_stale_publication_targets", { p_limit: 200 });
    if (recoverError) throw recoverError;

    const { data: queued, error: queueError } = await supabase.rpc("enqueue_publication_jobs", { p_limit: 300 });
    if (queueError) throw queueError;

    const payload = { ok: true, enabled: true, queued: Number(queued ?? 0), recovered: Number(recovered ?? 0) };
    if (runId) await supabase.from("scheduler_runs").update({
      status: "success",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      queued: Number(queued ?? 0),
      recovered: Number(recovered ?? 0),
      details: payload,
    }).eq("id", runId);
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) await supabase.from("scheduler_runs").update({
      status: "error",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      error: message,
    }).eq("id", runId);
    throw error;
  }
}

let reqHeaderToken = "";
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  reqHeaderToken = req.headers.get("x-cron-token") ?? "";
  try {
    return json(await run());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, message === "Unauthorized" ? 401 : 500);
  }
});
