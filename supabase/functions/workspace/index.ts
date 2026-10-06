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

  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("suspended_at,suspended_reason")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) return json({ ok: false, error: profileError.message }, 500);
  if (profile?.suspended_at) {
    return json({ ok: false, error: profile.suspended_reason || "Аккаунт приостановлен администратором" }, 403);
  }

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
      case "set-member-role": {
        const targetUserId = String(body.user_id || "");
        const role = typeof body.role === "string" ? body.role : "";
        if (!targetUserId || !["owner","admin","editor","publisher","approver","viewer"].includes(role)) {
          throw new Error("Некорректные данные роли");
        }

        const { data: actor, error: actorError } = await admin.from("workspace_members")
          .select("workspace_id,role")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (actorError) throw actorError;
        if (!actor || !["owner","admin"].includes(actor.role)) throw new Error("Изменять роли может только руководитель");
        if (actor.role === "admin" && role === "owner") throw new Error("Только владелец может назначать владельца");

        const { data: target, error: targetError } = await admin.from("workspace_members")
          .select("workspace_id,role")
          .eq("workspace_id", actor.workspace_id)
          .eq("user_id", targetUserId)
          .maybeSingle();
        if (targetError) throw targetError;
        if (!target) throw new Error("Участник не найден");
        if (target.role === "owner") throw new Error("Владельца нельзя изменить здесь");
        if (actor.role === "admin" && target.role === "admin" && targetUserId !== user.id) {
          throw new Error("Администратор не может изменять другого администратора");
        }
        if (actor.role === "admin" && role === "admin") {
          throw new Error("Только владелец может назначать администраторов");
        }

        const { error } = await admin.from("workspace_members")
          .update({ role })
          .eq("workspace_id", actor.workspace_id)
          .eq("user_id", targetUserId);
        if (error) throw error;
        return json({ ok: true, user_id: targetUserId, role });
      }
      case "list-invites": {
        const { data, error } = await admin.rpc("list_workspace_invites_for_user", { p_user_id: user.id });
        if (error) throw error;
        return json({ ok: true, invites: data ?? [] });
      }
      case "create-invite": {
        const role = typeof body.role === "string" ? body.role : "editor";
        if (!["editor","publisher","approver","viewer","admin"].includes(role)) {
          throw new Error("Недопустимая роль приглашения");
        }
        const { data: currentMember, error: memberError } = await admin.from("workspace_members")
          .select("workspace_id,role")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (memberError) throw memberError;
        if (!currentMember || !["owner","admin"].includes(currentMember.role)) {
          throw new Error("Создавать приглашения может только руководитель");
        }
        if (currentMember.role === "admin" && role === "admin") {
          throw new Error("Только владелец может приглашать администраторов");
        }

        const { data, error } = await admin.rpc("create_workspace_invite_for_user", {
          p_user_id: user.id,
          p_expires_in_hours: typeof body.expires_in_hours === "number" ? body.expires_in_hours : 168,
        });
        if (error) throw error;
        const invite = Array.isArray(data) ? data[0] : data;
        if (!invite?.invite_id) throw new Error("Не удалось создать приглашение");

        const { error: roleError } = await admin.from("workspace_invites")
          .update({ role })
          .eq("id", invite.invite_id)
          .eq("workspace_id", currentMember.workspace_id);
        if (roleError) throw roleError;

        return json({ ok: true, invite: { ...invite, role } });
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
