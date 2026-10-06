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

async function secret(admin: any, accountId: string) {
  const { data, error } = await admin.rpc("get_social_account_secret", { p_social_account_id: accountId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const map: Record<string,string> = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second),
  };
}

function utcForLocal(timeZone: string, year: number, month: number, day: number, hour = 0) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  const local = zonedParts(guess, timeZone);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const offset = localAsUtc - guess.getTime();
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0) - offset);
}

function previousLocalDay(date: {year:number;month:number;day:number}) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day));
  d.setUTCDate(d.getUTCDate() - 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function platformLabel(platform: string) {
  return ({ telegram: "Telegram", vk: "VK", max: "MAX", ok: "Одноклассники", instagram: "Instagram" } as Record<string,string>)[platform] ?? platform;
}

async function metricsFor(platform: string, accessToken: string, externalId: string, externalPostId: string, publicationType: string) {
  if (!accessToken || !externalPostId) return {};
  if (platform === "vk") {
    const ownerId = externalId.startsWith("-") ? externalId : "-" + externalId;
    if (publicationType === "clip") {
      const videoId = String(externalPostId).split("_").pop() || String(externalPostId);
      const data = await api("https://api.vk.com/method/video.get?" + new URLSearchParams({
        access_token: accessToken, v: "5.199", videos: ownerId + "_" + videoId, count: "1",
      }).toString());
      const video = data.response?.items?.[0] ?? data.response?.[0] ?? {};
      return {
        views: Number(video.views ?? video.views_count ?? 0),
        likes: Number(video.likes?.count ?? video.likes ?? 0),
        comments: Number(video.comments?.count ?? video.comments ?? 0),
        reposts: Number(video.reposts?.count ?? video.reposts ?? 0),
      };
    }
    const data = await api("https://api.vk.com/method/wall.getById?" + new URLSearchParams({
      access_token: accessToken, v: "5.199", posts: ownerId + "_" + externalPostId,
    }).toString());
    const post = data.response?.[0] ?? {};
    return {
      views: Number(post.views?.count ?? 0),
      likes: Number(post.likes?.count ?? 0),
      comments: Number(post.comments?.count ?? 0),
      reposts: Number(post.reposts?.count ?? 0),
    };
  }
  if (platform === "instagram") {
    const version = Deno.env.get("META_GRAPH_VERSION") || "v25.0";
    const base = "https://graph.facebook.com/" + version + "/";
    const media = await api(base + encodeURIComponent(externalPostId) + "?fields=like_count,comments_count&access_token=" + encodeURIComponent(accessToken));
    let views = 0;
    let shares = 0;
    try {
      const insights = await api(base + encodeURIComponent(externalPostId) + "/insights?metric=impressions,reach,plays,shares&access_token=" + encodeURIComponent(accessToken));
      for (const item of Array.isArray(insights.data) ? insights.data : []) {
        const value = Number(item.values?.[0]?.value ?? 0);
        if (["impressions","reach","plays"].includes(item.name)) views = Math.max(views, value);
        if (item.name === "shares") shares = value;
      }
    } catch {}
    return { views, likes: Number(media.like_count ?? 0), comments: Number(media.comments_count ?? 0), reposts: shares };
  }
  if (platform === "max") {
    const data = await api("https://platform-api2.max.ru/messages/" + encodeURIComponent(externalPostId), { headers: { Authorization: accessToken } });
    const stat = data.stat ?? {};
    return {
      views: Number(stat.views ?? stat.view_count ?? 0),
      likes: Number(stat.likes ?? stat.reactions?.likes ?? 0),
      comments: Number(stat.comments ?? stat.comments_count ?? 0),
      reposts: Number(stat.reposts ?? stat.repost_count ?? 0),
    };
  }
  return {};
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
  const botToken = Deno.env.get("TELEGRAM_SERVICE_BOT_TOKEN") ?? "";
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

  const workspaceIds = [...new Set((subscriptions ?? []).map((s:any)=>s.workspace_id).filter(Boolean))];
  let thresholdMessages = 0;
  let dailyMessages = 0;

  for (const workspaceId of workspaceIds) {
    const recipients = (subscriptions ?? []).filter((s:any)=>s.workspace_id===workspaceId);
    if (!recipients.length) continue;

    const { data: workspace } = await admin.from("workspaces").select("id,name,timezone").eq("id",workspaceId).maybeSingle();
    if (!workspace) continue;
    const timeZone = workspace.timezone || "Europe/Moscow";
    const now = new Date();
    const localNow = zonedParts(now, timeZone);
    const localToday = { year: localNow.year, month: localNow.month, day: localNow.day };
    const startToday = utcForLocal(timeZone, localToday.year, localToday.month, localToday.day, 0);
    const previousDay = previousLocalDay(localToday);
    const startPrevious = utcForLocal(timeZone, previousDay.year, previousDay.month, previousDay.day, 0);

    const { data: accounts } = await admin.from("social_accounts")
      .select("id,platform,external_id,metadata")
      .eq("workspace_id", workspaceId)
      .eq("status", "connected");

    const { data: targets } = await admin.from("post_targets")
      .select("id,platform,social_account_id,publication_type,status,published_at,external_post_id,metrics")
      .eq("status", "published")
      .in("social_account_id", (accounts ?? []).map((a:any)=>a.id));

    const accountMap = new Map((accounts ?? []).map((a:any)=>[a.id,a]));
    const totals: Record<string,{views:number;likes:number;comments:number;reposts:number;published:number}> = {};
    const daily: Record<string,{views:number;likes:number;comments:number;reposts:number;published:number}> = {};

    for (const target of targets ?? []) {
      const account = accountMap.get(target.social_account_id) as any;
      if (!account) continue;
      let metrics = target.metrics ?? {};
      try {
        const s = await secret(admin, account.id);
        const fresh = await metricsFor(account.platform, s?.access_token ?? "", account.external_id ?? "", target.external_post_id ?? "", target.publication_type || "feed");
        if (Object.keys(fresh).length) {
          metrics = { ...metrics, ...fresh };
          await admin.from("post_targets").update({ metrics, updated_at: new Date().toISOString() }).eq("id", target.id);
        }
      } catch {}
      const platform = account.platform;
      totals[platform] ||= { views:0, likes:0, comments:0, reposts:0, published:0 };
      totals[platform].views += Number(metrics.views ?? 0);
      totals[platform].likes += Number(metrics.likes ?? 0);
      totals[platform].comments += Number(metrics.comments ?? 0);
      totals[platform].reposts += Number(metrics.reposts ?? 0);
      totals[platform].published += 1;

      const publishedAt = target.published_at ? new Date(target.published_at) : null;
      if (publishedAt && publishedAt >= startToday && publishedAt < now) {
        daily[platform] ||= { views:0, likes:0, comments:0, reposts:0, published:0 };
        daily[platform].views += Number(metrics.views ?? 0);
        daily[platform].likes += Number(metrics.likes ?? 0);
        daily[platform].comments += Number(metrics.comments ?? 0);
        daily[platform].reposts += Number(metrics.reposts ?? 0);
        daily[platform].published += 1;
      }
    }

    for (const [platform, value] of Object.entries(totals)) {
      const currentThousands = Math.floor(value.views / 1000);
      const { data: milestone } = await admin.from("notification_platform_milestones")
        .select("notified_thousand")
        .eq("workspace_id", workspaceId)
        .eq("platform", platform)
        .maybeSingle();
      const previous = Number(milestone?.notified_thousand ?? 0);
      if (currentThousands > previous) {
        for (let n = previous + 1; n <= currentThousands; n++) {
          const text = "📈 " + platformLabel(platform) + ": " + (n * 1000).toLocaleString("ru-RU") + " просмотров.";
          for (const recipient of recipients) {
            try { await sendTelegram(botToken, Number(recipient.chat_id), text); thresholdMessages++; } catch {}
          }
        }
        await admin.from("notification_platform_milestones").upsert({
          workspace_id: workspaceId, platform, notified_thousand: currentThousands, updated_at: new Date().toISOString(),
        });
      }
    }

    if (localNow.hour >= 21) {
      const { data: already } = await admin.from("notification_daily_runs")
        .select("local_date")
        .eq("workspace_id", workspaceId)
        .eq("local_date", `${localToday.year}-${String(localToday.month).padStart(2,"0")}-${String(localToday.day).padStart(2,"0")}`)
        .maybeSingle();
      if (!already) {
        const lines = Object.entries(daily).map(([platform, value]) =>
          platformLabel(platform) + ": " + value.published + " пост., " + value.views.toLocaleString("ru-RU") + " просмотров, " +
          value.likes.toLocaleString("ru-RU") + " лайков, " + value.comments.toLocaleString("ru-RU") + " комм., " + value.reposts.toLocaleString("ru-RU") + " репостов."
        );
        const total = Object.values(daily).reduce((acc, value) => ({
          published: acc.published + value.published,
          views: acc.views + value.views,
          likes: acc.likes + value.likes,
          comments: acc.comments + value.comments,
          reposts: acc.reposts + value.reposts,
        }), { published:0, views:0, likes:0, comments:0, reposts:0 });

        const text = "📊 TGRMLposting — статистика за сутки\n\n" +
          (lines.length ? lines.join("\n") : "За сегодня публикаций нет.") +
          "\n\nИтого: " + total.published + " пост., " + total.views.toLocaleString("ru-RU") +
          " просмотров, " + total.likes.toLocaleString("ru-RU") + " лайков, " + total.comments.toLocaleString("ru-RU") +
          " комментариев, " + total.reposts.toLocaleString("ru-RU") + " репостов.";
        for (const recipient of recipients) {
          try { await sendTelegram(botToken, Number(recipient.chat_id), text); dailyMessages++; } catch {}
        }
        await admin.from("notification_daily_runs").upsert({
          workspace_id: workspaceId,
          local_date: `${localToday.year}-${String(localToday.month).padStart(2,"0")}-${String(localToday.day).padStart(2,"0")}`,
          sent_at: new Date().toISOString(),
        });
      }
    }
  }

  return json({ ok: true, threshold_messages: thresholdMessages, daily_messages: dailyMessages });
});
