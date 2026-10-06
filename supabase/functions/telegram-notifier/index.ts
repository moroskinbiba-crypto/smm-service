import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function api(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok || data?.error || data?.error_code) {
    throw new Error(data?.error?.message || data?.error_msg || data?.description || data?.message || "External API error");
  }
  return data;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second),
  };
}

function platformLabel(platform: string) {
  return ({ telegram: "Telegram", vk: "VK", max: "MAX", ok: "Одноклассники", instagram: "Instagram" } as Record<string,string>)[platform] ?? platform;
}

async function sendTelegram(token: string, chatId: number, text: string) {
  await api("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const botToken = Deno.env.get("TGRML_NOTIFY_BOT_TOKEN") ?? "";
  if (!url || !serviceKey || !botToken) return json({ ok: false, error: "Missing configuration" }, 500);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: config } = await admin.rpc("get_scheduler_config");
  const scheduler = Array.isArray(config) ? config[0] : config;
  const cronToken = scheduler?.cron_token ?? "";
  if (!cronToken || req.headers.get("x-cron-token") !== cronToken) return json({ ok: false, error: "Unauthorized" }, 401);
  if (scheduler?.enabled !== true) return json({ ok: true, enabled: false });

  const { data: subscriptions, error: subError } = await admin.from("telegram_notification_subscriptions")
    .select("user_id,workspace_id,telegram_user_id,chat_id,enabled")
    .eq("enabled", true);
  if (subError) return json({ ok: false, error: subError.message }, 500);

  const workspaceIds = [...new Set((subscriptions ?? []).map((s:any) => s.workspace_id).filter(Boolean))];
  if (!workspaceIds.length) return json({ ok: true, threshold_messages: 0, daily_messages: 0, workspaces: 0 });

  const [{ data: workspaces }, { data: summaries, error: summaryError }] = await Promise.all([
    admin.from("workspaces").select("id,name,timezone").in("id", workspaceIds),
    admin.rpc("get_telegram_notification_summaries"),
  ]);
  if (summaryError) return json({ ok: false, error: summaryError.message }, 500);

  const workspaceMap = new Map((workspaces ?? []).map((w:any) => [String(w.id), w]));
  const summaryMap = new Map<string, any[]>();
  for (const row of summaries ?? []) {
    const key = String(row.workspace_id);
    const list = summaryMap.get(key) ?? [];
    list.push(row);
    summaryMap.set(key, list);
  }

  let thresholdMessages = 0;
  let dailyMessages = 0;

  for (const workspaceId of workspaceIds) {
    const recipients = (subscriptions ?? []).filter((s:any) => s.workspace_id === workspaceId);
    if (!recipients.length) continue;

    const workspace = workspaceMap.get(String(workspaceId));
    const timeZone = workspace?.timezone || "Europe/Moscow";
    const localNow = zonedParts(new Date(), timeZone);
    const rows = summaryMap.get(String(workspaceId)) ?? [];

    for (const row of rows) {
      const currentThousands = Math.floor(Number(row.total_views ?? 0) / 1000);
      const { data: milestone } = await admin.from("notification_platform_milestones")
        .select("notified_thousand")
        .eq("workspace_id", workspaceId)
        .eq("platform", row.platform)
        .maybeSingle();
      const previous = Number(milestone?.notified_thousand ?? 0);
      if (currentThousands > previous) {
        for (let n = previous + 1; n <= currentThousands; n++) {
          const text = "📈 " + platformLabel(row.platform) + ": " + (n * 1000).toLocaleString("ru-RU") + " просмотров.";
          for (const recipient of recipients) {
            try {
              await sendTelegram(botToken, Number(recipient.chat_id), text);
              thresholdMessages++;
            } catch {}
          }
        }
        await admin.from("notification_platform_milestones").upsert({
          workspace_id: workspaceId,
          platform: row.platform,
          notified_thousand: currentThousands,
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (localNow.hour >= 21) {
      const today = localNow.year + "-" + String(localNow.month).padStart(2, "0") + "-" + String(localNow.day).padStart(2, "0");
      const { data: already } = await admin.from("notification_daily_runs")
        .select("local_date")
        .eq("workspace_id", workspaceId)
        .eq("local_date", today)
        .maybeSingle();

      if (!already) {
        const dailyRows = rows.filter((row:any) => Number(row.daily_published ?? 0) > 0);
        const lines = dailyRows.map((row:any) =>
          platformLabel(row.platform) + ": " + Number(row.daily_published ?? 0).toLocaleString("ru-RU") +
          " пост., " + Number(row.daily_views ?? 0).toLocaleString("ru-RU") + " просмотров, " +
          Number(row.daily_likes ?? 0).toLocaleString("ru-RU") + " лайков, " +
          Number(row.daily_comments ?? 0).toLocaleString("ru-RU") + " комм., " +
          Number(row.daily_reposts ?? 0).toLocaleString("ru-RU") + " репостов."
        );
        const total = rows.reduce((acc:any, row:any) => ({
          published: acc.published + Number(row.daily_published ?? 0),
          views: acc.views + Number(row.daily_views ?? 0),
          likes: acc.likes + Number(row.daily_likes ?? 0),
          comments: acc.comments + Number(row.daily_comments ?? 0),
          reposts: acc.reposts + Number(row.daily_reposts ?? 0),
        }), { published:0, views:0, likes:0, comments:0, reposts:0 });

        const text = "📊 TGRMLposting — статистика за сутки\n\n" +
          (lines.length ? lines.join("\n") : "За сегодня публикаций нет.") +
          "\n\nИтого: " + total.published.toLocaleString("ru-RU") + " пост., " +
          total.views.toLocaleString("ru-RU") + " просмотров, " +
          total.likes.toLocaleString("ru-RU") + " лайков, " +
          total.comments.toLocaleString("ru-RU") + " комментариев, " +
          total.reposts.toLocaleString("ru-RU") + " репостов.";

        for (const recipient of recipients) {
          try {
            await sendTelegram(botToken, Number(recipient.chat_id), text);
            dailyMessages++;
          } catch {}
        }

        await admin.from("notification_daily_runs").upsert({
          workspace_id: workspaceId,
          local_date: today,
          sent_at: new Date().toISOString(),
        });
      }
    }
  }

  return json({ ok: true, threshold_messages: thresholdMessages, daily_messages: dailyMessages, workspaces: workspaceIds.length });
});
