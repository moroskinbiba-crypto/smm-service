import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function maxRequest(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch("https://platform-api2.max.ru" + path, {
    ...init,
    headers: {
      Authorization: token,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok || data?.error || data?.code >= 400) {
    throw new Error(data?.message || data?.error || "MAX API error");
  }
  return data;
}

function getText(update: any) {
  return String(
    update?.message?.body?.text ??
    update?.message?.text ??
    update?.body?.text ??
    update?.body?.message ??
    "",
  ).trim();
}

function parseCode(text: string) {
  const match = text.match(/^\/connect(?:@\w+)?\s+([A-Za-z0-9_-]{6,80})\s*$/i);
  return match?.[1] ?? null;
}

async function markChat(admin: any, update: any) {
  const chatId = Number(update?.chat_id ?? update?.message?.recipient?.chat_id ?? 0);
  if (!chatId) return;
  let title: string | null = null;
  try {
    const chat = await maxRequest("/chats/" + encodeURIComponent(String(chatId)), Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "");
    title = chat.title || chat.name || null;
  } catch {}
  await admin.from("max_service_chats").upsert({
    chat_id: chatId,
    title,
    is_channel: update?.is_channel === true,
    last_seen_at: new Date().toISOString(),
    active: true,
  });
}

async function claimRequest(admin: any, update: any, code: string) {
  const chatId = Number(update?.chat_id ?? update?.message?.recipient?.chat_id ?? 0);
  if (!chatId) return false;

  const { data: request, error: requestError } = await admin.from("max_connection_requests")
    .select("id,workspace_id,user_id,code,expires_at,claimed_at")
    .eq("code", code)
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (requestError) throw requestError;
  if (!request) return false;

  const token = Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "";
  if (!token) throw new Error("MAX_CONNECT_BOT_TOKEN is not configured");

  const chat = await maxRequest("/chats/" + encodeURIComponent(String(chatId)), token).catch(() => ({}));
  const title = chat.title || chat.name || "MAX";

  const { data: account, error: accountError } = await admin.from("social_accounts").insert({
    user_id: request.user_id,
    workspace_id: request.workspace_id,
    platform: "max",
    external_id: String(chatId),
    display_name: title,
    username: chat.link ? String(chat.link) : null,
    status: "pending",
    metadata: {
      connection_method: "service_bot",
      bot_username: Deno.env.get("MAX_CONNECT_BOT_USERNAME") ?? null,
      chat_type: chat.type ?? null,
      is_channel: update?.is_channel === true,
    },
  }).select("id").single();
  if (accountError) throw accountError;

  try {
    await admin.rpc("upsert_social_account_secret", {
      p_social_account_id: account.id,
      p_access_token: token,
    });

    const { error: updateError } = await admin.from("social_accounts")
      .update({ status: "connected", last_error: null, updated_at: new Date().toISOString() })
      .eq("id", account.id);
    if (updateError) throw updateError;

    await admin.from("max_connection_requests").update({
      claimed_at: new Date().toISOString(),
      claimed_chat_id: chatId,
    }).eq("id", request.id);

    await admin.from("max_service_chats").upsert({
      chat_id: chatId,
      title,
      is_channel: update?.is_channel === true,
      last_seen_at: new Date().toISOString(),
      active: true,
    });

    await maxRequest("/messages?chat_id=" + encodeURIComponent(String(chatId)), token, {
      method: "POST",
      body: JSON.stringify({ text: "✅ Канал подключён к SMM-сервису." }),
    }).catch(() => undefined);

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("social_accounts").update({ status: "error", last_error: message }).eq("id", account.id);
    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response({ ok: false, error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("MAX_WEBHOOK_SECRET") ?? "";
  if (expectedSecret) {
    const provided = req.headers.get("X-Max-Bot-Api-Secret") ?? "";
    if (provided !== expectedSecret) return response({ ok: false, error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return response({ ok: false, error: "Missing Supabase configuration" }, 500);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  let update: any = {};
  try { update = await req.json(); } catch { return response({ ok: false, error: "Invalid JSON" }, 400); }

  try {
    const type = String(update?.update_type ?? "");

    if (type === "bot_added" || type === "chat_title_changed" || type === "bot_admin_permissions_changed") {
      await markChat(admin, update);
    }

    if (type === "message_created") {
      const code = parseCode(getText(update));
      if (code) await claimRequest(admin, update, code);
    }

    if (type === "bot_removed") {
      const chatId = Number(update?.chat_id ?? 0);
      if (chatId) await admin.from("max_service_chats").update({ active: false, last_seen_at: new Date().toISOString() }).eq("chat_id", chatId);
    }

    return response({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 200);
  }
});
