import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function processRecurrences(admin: any) {
  const now = new Date();
  const { data: recurrences, error } = await admin.from("post_recurrences")
    .select("id,workspace_id,source_post_id,interval_days,next_run_at,end_at,max_runs,run_count")
    .eq("active", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(20);
  if (error) throw error;

  let created = 0;
  for (const recurrence of recurrences ?? []) {
    if (recurrence.max_runs !== null && Number(recurrence.run_count) >= Number(recurrence.max_runs)) {
      await admin.from("post_recurrences").update({ active: false, updated_at: new Date().toISOString() }).eq("id", recurrence.id);
      continue;
    }

    const { data: source, error: sourceError } = await admin.from("posts")
      .select("id,user_id,body,media,post_targets(social_account_id,platform,publication_type)")
      .eq("id", recurrence.source_post_id)
      .eq("workspace_id", recurrence.workspace_id)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) {
      await admin.from("post_recurrences").update({ active: false, updated_at: new Date().toISOString() }).eq("id", recurrence.id);
      continue;
    }

    const scheduledAt = new Date(recurrence.next_run_at).toISOString();
    const { data: cloned, error: cloneError } = await admin.from("posts").insert({
      workspace_id: recurrence.workspace_id,
      user_id: source.user_id,
      body: source.body ?? "",
      media: source.media ?? [],
      status: "scheduled",
      scheduled_at: scheduledAt,
      approval_status: "not_required",
    }).select("id").single();
    if (cloneError) throw cloneError;

    const targets = (source.post_targets ?? []).map((target: any) => ({
      post_id: cloned.id,
      social_account_id: target.social_account_id,
      platform: target.platform,
      publication_type: target.publication_type || "feed",
      status: "pending",
    }));
    if (targets.length) {
      const { error: targetError } = await admin.from("post_targets").insert(targets);
      if (targetError) throw targetError;
    }

    const nextRun = new Date(new Date(recurrence.next_run_at).getTime() + Number(recurrence.interval_days) * 86400000);
    const nextCount = Number(recurrence.run_count) + 1;
    const shouldStop =
      (recurrence.max_runs !== null && nextCount >= Number(recurrence.max_runs)) ||
      (recurrence.end_at && nextRun.getTime() > new Date(recurrence.end_at).getTime());

    await admin.from("post_recurrences").update({
      run_count: nextCount,
      next_run_at: nextRun.toISOString(),
      active: !shouldStop,
      updated_at: new Date().toISOString(),
    }).eq("id", recurrence.id);

    created++;
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
    const { data: recovered, error: recoverError } = await supabase.rpc("recover_stale_publication_targets", { p_limit: 200 });
    if (recoverError) throw recoverError;
    const { data: queued, error: queueError } = await supabase.rpc("enqueue_publication_jobs", { p_limit: 300 });
    if (queueError) throw queueError;

    const payload = { ok: true, enabled: true, created_recurrences: created, queued: Number(queued ?? 0), recovered: Number(recovered ?? 0) };
    if (runId) await supabase.from("scheduler_runs").update({
      status: "success", finished_at: new Date().toISOString(), duration_ms: Date.now() - started,
      queued: Number(queued ?? 0), recovered: Number(recovered ?? 0), details: payload,
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
