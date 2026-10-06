import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function tg(token: string, method: string, body?: Record<string, unknown>) {
  const r = await fetch("https://api.telegram.org/bot" + token + "/" + method, body ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } : {});
  const raw = await r.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!r.ok || data?.ok === false) throw new Error(data?.description || "Telegram API error");
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response({ ok: false, error: "Method not allowed" }, 405);

  const expected = Deno.env.get("TGRML_NOTIFY_WEBHOOK_SECRET") ?? "";
  if (expected && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) {
    return response({ ok: false, error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = Deno.env.get("TGRML_NOTIFY_BOT_TOKEN") ?? "";
  const username = Deno.env.get("TGRML_NOTIFY_BOT_USERNAME") ?? "";
  if (!supabaseUrl || !serviceKey || !token) return response({ ok: false, error: "Notification bot is not configured" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  let update: any = {};
  try { update = await req.json(); } catch { return response({ ok: false, error: "Invalid JSON" }, 400); }

  try {
    const text = String(update?.message?.text ?? "");
    const chatId = Number(update?.message?.chat?.id ?? 0);
    const userId = Number(update?.message?.from?.id ?? 0);
    const m = text.match(/^\/start\s+notify_([A-Za-z0-9_-]{8,80})\s*$/i);
    if (!chatId || !userId || !m?.[1]) return response({ ok: true });

    const code = m[1];
    const { data: request, error } = await admin.from("telegram_notification_requests")
      .select("id,user_id,workspace_id,code,expires_at,claimed_at")
      .eq("code", code)
      .is("claimed_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    if (!request) {
      await tg(token, "sendMessage", { chat_id: chatId, text: "⚠️ Ссылка для подключения уведомлений устарела. Запустите подключение в TGRMLposting ещё раз." }).catch(() => undefined);
      return response({ ok: true });
    }

    await admin.from("telegram_notification_subscriptions").upsert({
      user_id: request.user_id,
      workspace_id: request.workspace_id,
      telegram_user_id: userId,
      chat_id: chatId,
      bot_username: username || null,
      enabled: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    await admin.from("telegram_notification_requests").update({
      claimed_at: new Date().toISOString(),
      telegram_user_id: userId,
      chat_id: chatId,
    }).eq("id", request.id);

    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: "✅ Уведомления TGRMLposting подключены. Я буду присылать рубежи просмотров по площадкам и ежедневную общую статистику.",
    }).catch(() => undefined);

    return response({ ok: true });
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : String(error) }, 200);
  }
});
