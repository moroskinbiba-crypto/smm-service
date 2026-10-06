import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function tg(token: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, body ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } : {});
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok || data?.ok === false) throw new Error(data?.description || "Telegram API error");
  return data;
}

function parseConnectCode(text: string) {
  const m = text.match(/^\/connect(?:@\w+)?\s+([A-Za-z0-9_-]{8,80})\s*$/i);
  return m?.[1] ?? null;
}

function parseStartCode(text: string) {
  const m = text.match(/^\/start\s+([A-Za-z0-9_-]{8,80})\s*$/i);
  return m?.[1] ?? null;
}

async function claimChannel(admin: any, update: any, code: string, token: string, botUsername: string) {
  const chat = update?.channel_post?.chat;
  if (!chat?.id) return false;

  const { data: request, error } = await admin.from("telegram_connection_requests")
    .select("id,workspace_id,user_id,mode,code,expires_at,claimed_at")
    .eq("mode", "channel")
    .eq("code", code)
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  if (!request) return false;

  const metadata = {
    connection_method: "service_bot",
    bot_username: botUsername || null,
    chat_type: chat.type || null,
    chat_username: chat.username || null,
  };

  const { data: existing } = await admin.from("social_accounts")
    .select("id")
    .eq("workspace_id", request.workspace_id)
    .eq("platform", "telegram")
    .eq("external_id", String(chat.id))
    .maybeSingle();

  let accountId = existing?.id ?? null;
  if (!accountId) {
    const { data: account, error: accountError } = await admin.from("social_accounts").insert({
      user_id: request.user_id,
      workspace_id: request.workspace_id,
      platform: "telegram",
      external_id: String(chat.id),
      display_name: chat.title || chat.username || "Telegram",
      username: chat.username ? "@" + chat.username : null,
      status: "pending",
      metadata,
    }).select("id").single();
    if (accountError) throw accountError;
    accountId = account.id;
  } else {
    await admin.from("social_accounts").update({
      user_id: request.user_id,
      display_name: chat.title || chat.username || "Telegram",
      username: chat.username ? "@" + chat.username : null,
      metadata,
      status: "pending",
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", accountId);
  }

  await admin.rpc("upsert_social_account_secret", { p_social_account_id: accountId, p_access_token: token });

  const { data: updated, error: updateError } = await admin.from("social_accounts").update({
    status: "connected",
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", accountId).select("id").single();
  if (updateError) throw updateError;

  await admin.from("telegram_connection_requests").update({
    claimed_at: new Date().toISOString(),
    claimed_chat_id: Number(chat.id),
  }).eq("id", request.id);

  await admin.from("telegram_service_chats").upsert({
    chat_id: Number(chat.id),
    workspace_id: request.workspace_id,
    user_id: request.user_id,
    title: chat.title || null,
    username: chat.username || null,
    chat_type: chat.type || null,
    can_post_messages: true,
    active: true,
    updated_at: new Date().toISOString(),
  });

  await tg(token, "sendMessage", {
    chat_id: chat.id,
    text: "✅ Канал подключён к SMM-сервису. Его можно выбрать в редакторе публикации.",
  }).catch(() => undefined);

  return Boolean(updated);
}

async function registerBusinessUser(admin: any, update: any, code: string, token: string, botUsername: string) {
  const from = update?.message?.from;
  if (!from?.id) return false;

  const { data: request, error } = await admin.from("telegram_connection_requests")
    .select("id,workspace_id,user_id,mode,code,expires_at,claimed_at")
    .eq("mode", "business")
    .eq("code", code)
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  if (!request) return false;

  await admin.from("telegram_connection_requests").update({
    telegram_user_id: Number(from.id),
  }).eq("id", request.id);

  await tg(token, "sendMessage", {
    chat_id: update.message.chat.id,
    text: "✅ Пользователь Telegram найден.

Теперь откройте Telegram → Настройки → Telegram Business → Чат-боты и подключите @" +
      botUsername.replace(/^@/, "") + ". Разрешите этому боту управление историями (Stories). После подключения сервис автоматически получит доступ и добавит аккаунт.",
  }).catch(() => undefined);

  return true;
}

async function claimBusinessConnection(admin: any, update: any, token: string, botUsername: string) {
  const connection = update?.business_connection;
  if (!connection?.id || !connection?.user?.id) return false;

  const telegramUserId = Number(connection.user.id);
  let { data: request } = await admin.from("telegram_connection_requests")
    .select("id,workspace_id,user_id,mode,code,expires_at,claimed_at")
    .eq("mode", "business")
    .eq("telegram_user_id", telegramUserId)
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!request) {
    const existing = await admin.from("telegram_business_connections")
      .select("workspace_id,user_id")
      .eq("connection_id", String(connection.id))
      .maybeSingle();
    if (existing.data?.workspace_id) {
      await admin.from("telegram_business_connections").update({
        telegram_user_id: telegramUserId,
        user_chat_id: Number(connection.user_chat_id ?? 0) || null,
        rights: connection.rights ?? {},
        is_enabled: connection.is_enabled !== false,
        updated_at: new Date().toISOString(),
      }).eq("connection_id", String(connection.id));
      return true;
    }
    return false;
  }

  const metadata = {
    connection_method: "business_bot",
    bot_username: botUsername || null,
    business_connection_id: String(connection.id),
    business_user_id: String(connection.user.id),
    business_user_chat_id: String(connection.user_chat_id ?? ""),
    rights: connection.rights ?? {},
  };

  const { data: existing } = await admin.from("social_accounts")
    .select("id")
    .eq("workspace_id", request.workspace_id)
    .eq("platform", "telegram")
    .eq("external_id", String(connection.id))
    .maybeSingle();

  let accountId = existing?.id ?? null;
  if (!accountId) {
    const { data: account, error: accountError } = await admin.from("social_accounts").insert({
      user_id: request.user_id,
      workspace_id: request.workspace_id,
      platform: "telegram",
      external_id: String(connection.id),
      display_name: connection.user?.first_name || connection.user?.username || "Telegram Business",
      username: connection.user?.username ? "@" + connection.user.username : null,
      status: "pending",
      metadata,
    }).select("id").single();
    if (accountError) throw accountError;
    accountId = account.id;
  } else {
    await admin.from("social_accounts").update({
      user_id: request.user_id,
      display_name: connection.user?.first_name || connection.user?.username || "Telegram Business",
      username: connection.user?.username ? "@" + connection.user.username : null,
      metadata,
      status: "pending",
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", accountId);
  }

  await admin.rpc("upsert_social_account_secret", { p_social_account_id: accountId, p_access_token: token });

  await admin.from("telegram_business_connections").upsert({
    connection_id: String(connection.id),
    workspace_id: request.workspace_id,
    user_id: request.user_id,
    telegram_user_id: telegramUserId,
    user_chat_id: Number(connection.user_chat_id ?? 0) || null,
    rights: connection.rights ?? {},
    is_enabled: connection.is_enabled !== false,
    updated_at: new Date().toISOString(),
  });

  const canManageStories = connection.rights?.can_manage_stories === true;
  const status = connection.is_enabled !== false && canManageStories ? "connected" : "error";
  const lastError = canManageStories ? null : "Telegram Business подключён, но не выдано право «Управление историями».";

  await admin.from("social_accounts").update({
    status,
    last_error: lastError,
    updated_at: new Date().toISOString(),
  }).eq("id", accountId);

  await admin.from("telegram_connection_requests").update({
    claimed_at: new Date().toISOString(),
    business_connection_id: String(connection.id),
  }).eq("id", request.id);

  await tg(token, "sendMessage", {
    chat_id: Number(connection.user_chat_id ?? 0),
    text: canManageStories
      ? "✅ Telegram Business подключён. В SMM-сервисе теперь доступна публикация Stories."
      : "⚠️ Telegram Business подключён, но боту не дано право управления Stories.",
  }).catch(() => undefined);

  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response({ ok: false, error: "Method not allowed" }, 405);

  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
  if (expected && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) {
    return response({ ok: false, error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = Deno.env.get("TELEGRAM_SERVICE_BOT_TOKEN") ?? "";
  const botUsername = Deno.env.get("TELEGRAM_SERVICE_BOT_USERNAME") ?? "";

  if (!supabaseUrl || !serviceKey || !token) {
    return response({ ok: false, error: "Telegram service bot is not configured" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  let update: any = {};
  try { update = await req.json(); } catch { return response({ ok: false, error: "Invalid JSON" }, 400); }

  try {
    const type = String(update?.update_id != null ? (
      update?.business_connection ? "business_connection" :
      update?.channel_post ? "channel_post" :
      update?.message?.chat?.type === "private" ? "private_message" :
      update?.my_chat_member ? "my_chat_member" : "unknown"
    ) : "unknown");

    if (type === "channel_post") {
      const text = String(update.channel_post?.text ?? update.channel_post?.caption ?? "");
      const code = parseConnectCode(text);
      if (code) await claimChannel(admin, update, code, token, botUsername);
    } else if (type === "private_message") {
      const text = String(update.message?.text ?? "");
      const code = parseStartCode(text);
      if (code) await registerBusinessUser(admin, update, code, token, botUsername);
    } else if (type === "business_connection") {
      await claimBusinessConnection(admin, update, token, botUsername);
    } else if (type === "my_chat_member") {
      const chat = update.my_chat_member?.chat;
      if (chat?.id) {
        await admin.from("telegram_service_chats").upsert({
          chat_id: Number(chat.id),
          title: chat.title || null,
          username: chat.username || null,
          chat_type: chat.type || null,
          can_post_messages: update.my_chat_member?.new_chat_member?.status === "administrator",
          active: update.my_chat_member?.new_chat_member?.status !== "kicked",
          updated_at: new Date().toISOString(),
        });
      }
    }

    return response({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 200);
  }
});
