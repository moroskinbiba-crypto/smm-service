import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceRoleKey) return json({ ok: false, error: "Server configuration is incomplete" }, 500);

  const authorization = req.headers.get("Authorization") ?? "";
  const jwt = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Unauthorized" }, 401);

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !user) return json({ ok: false, error: "Unauthorized" }, 401);

  let body: { action?: string; [key: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  try {
    switch (body.action) {
      case "bootstrap": {
        const { data, error } = await admin.rpc("ensure_workspace_for_user", {
          p_user_id: user.id,
          p_name: typeof body.name === "string" ? body.name : null,
          p_display_name: typeof body.display_name === "string" ? body.display_name : null,
          p_timezone: typeof body.timezone === "string" ? body.timezone : "Europe/Moscow",
        });
        if (error) throw error;
        return json({ ok: true, workspace: Array.isArray(data) ? data[0] : data });
      }
      case "get-workspace": {
        const { data, error } = await admin.rpc("get_workspace_for_user", { p_user_id: user.id });
        if (error) throw error;
        return json({ ok: true, workspace: Array.isArray(data) ? data[0] : data });
      }
      case "members": {
        const { data, error } = await admin.rpc("list_workspace_members_for_user", { p_user_id: user.id });
        if (error) throw error;
        return json({ ok: true, members: data ?? [] });
      }
      case "list-invites": {
        const { data, error } = await admin.rpc("list_workspace_invites_for_user", { p_user_id: user.id });
        if (error) throw error;
        return json({ ok: true, invites: data ?? [] });
      }
      case "create-invite": {
        const { data, error } = await admin.rpc("create_workspace_invite_for_user", {
          p_user_id: user.id,
          p_expires_in_hours: typeof body.expires_in_hours === "number" ? body.expires_in_hours : 168,
        });
        if (error) throw error;
        const invite = Array.isArray(data) ? data[0] : data;
        return json({ ok: true, invite });
      }
      case "revoke-invite": {
        const { data, error } = await admin.rpc("revoke_workspace_invite_for_user", {
          p_user_id: user.id,
          p_invite_id: body.invite_id,
        });
        if (error) throw error;
        return json({ ok: true, revoked: data === true });
      }
      case "accept-invite": {
        const { data, error } = await admin.rpc("accept_workspace_invite_for_user", {
          p_user_id: user.id,
          p_token: body.token,
        });
        if (error) throw error;
        return json({ ok: true, workspace: Array.isArray(data) ? data[0] : data });
      }
      default:
        return json({ ok: false, error: "Unknown action" }, 400);
    }
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error ?? "Request failed");
    return json({ ok: false, error: message });
  }
});
