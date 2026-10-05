import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: "Missing server configuration" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: config, error: configError } = await supabase.rpc("get_scheduler_config");
  if (configError) {
    return new Response(JSON.stringify({ ok: false, error: configError.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const scheduler = Array.isArray(config) ? config[0] : config;
  const expectedToken = scheduler?.cron_token ?? "";
  const enabled = scheduler?.enabled === true;
  const providedToken = req.headers.get("x-cron-token") ?? "";

  if (!expectedToken || providedToken !== expectedToken) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  if (!enabled) {
    return new Response(JSON.stringify({ ok: true, enabled: false, claimed: 0 }), {
      headers: { "content-type": "application/json" },
    });
  }

  const { data, error } = await supabase.rpc("claim_scheduled_targets", { p_limit: 20 });
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    enabled: true,
    claimed: Array.isArray(data) ? data.length : 0,
  }), {
    headers: { "content-type": "application/json" },
  });
});
