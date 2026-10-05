import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return new Response(JSON.stringify({ error: "Missing server configuration" }), { status: 500, headers: { "content-type": "application/json" } });
  const supabase = createClient(url, serviceKey);
  const provided = req.headers.get("x-run-key") ?? "";
  const { data: config, error: configError } = await supabase.from("internal_config").select("x_key").eq("id", 1).maybeSingle();
  if (configError || !config || provided !== config.x_key) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  const now = new Date().toISOString();
  const { count, error } = await supabase.from("post_targets").select("id, posts!inner(status, scheduled_at)", { count: "exact", head: true })
    .eq("status", "pending")
    .or("next_attempt_at.is.null,next_attempt_at.lte." + now)
    .in("posts.status", ["scheduled", "publishing"])
    .lte("posts.scheduled_at", now);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ ok: true, scheduler: "ready", due_targets: count ?? 0, timestamp: now }), { headers: { "content-type": "application/json" } });
});