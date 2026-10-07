import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Metrics = Record<string, number>;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sanitizeExternalError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error ?? "Неизвестная ошибка");
  message = message
    .replace(/([?&](?:access_token|client_secret|refresh_token|token|api_key|code)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "https://api.telegram.org/bot[REDACTED]")
    .replace(/Authorization\s*:\s*[^\s]+/gi, "Authorization: [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  return message.slice(0, 1000);
}

function effectiveSecret(account: any, stored: any) {
  const method = String(account?.metadata?.connection_method ?? "");
  if (account?.platform === "telegram" && (method === "service_bot" || method === "business_bot")) {
    const token = Deno.env.get("TELEGRAM_SERVICE_BOT_TOKEN") ?? "";
    if (!token) throw new Error("Служебный Telegram-бот не настроен");
    return { access_token: token };
  }
  if (account?.platform === "max" && method === "service_bot") {
    const token = Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "";
    if (!token) throw new Error("Служебный MAX-бот не настроен");
    return { access_token: token };
  }
  return stored ?? {};
}

function isRetryableMetricsError(error: unknown) {
  const message = sanitizeExternalError(error);
  return !/(\b400\b|\b401\b|\b403\b|\b404\b|invalid|unauthorized|forbidden|permission|not found|неверн|не найден|unsupported|token)/i.test(message);
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

async function fetchMetrics(platform: string, accessToken: string, externalId: string, externalPostId: string, publicationType: string): Promise<Metrics> {
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
    let saved = 0;
    let shares = 0;
    try {
      const insights = await api(base + encodeURIComponent(externalPostId) + "/insights?metric=impressions,reach,plays,saved,shares&access_token=" + encodeURIComponent(accessToken));
      for (const item of Array.isArray(insights.data) ? insights.data : []) {
        const value = Number(item.values?.[0]?.value ?? 0);
        if (item.name === "impressions" || item.name === "reach" || item.name === "plays") views = Math.max(views, value);
        if (item.name === "saved") saved = value;
        if (item.name === "shares") shares = value;
      }
    } catch {}
    return {
      views,
      likes: Number(media.like_count ?? 0),
      comments: Number(media.comments_count ?? 0),
      reposts: shares,
      saves: saved,
    };
  }
  if (platform === "max") {
    const data = await api("https://platform-api2.max.ru/messages/" + encodeURIComponent(externalPostId), {
      headers: { Authorization: accessToken },
    });
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

async function notify(adminUrl: string, token: string) {
  try {
    await fetch(adminUrl + "/functions/v1/telegram-notifier", {
      method: "POST",
      headers: { "x-cron-token": token },
    });
  } catch {}
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json({ ok: false, error: "Missing server configuration" }, 500);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: config, error: configError } = await admin.rpc("get_scheduler_config");
  if (configError) return json({ ok: false, error: configError.message }, 500);
  const scheduler = Array.isArray(config) ? config[0] : config;
  const cronToken = scheduler?.cron_token ?? "";
  if (!cronToken || req.headers.get("x-cron-token") !== cronToken) return json({ ok: false, error: "Unauthorized" }, 401);
  if (scheduler?.enabled !== true) return json({ ok: true, enabled: false });

  const started = Date.now();
  let runId: number | null = null;
  const { data: runRow } = await admin.from("scheduler_runs").insert({ worker: "stats-worker" }).select("id").single();
  runId = runRow?.id ?? null;

  let queued = 0;
  let processed = 0;
  let failed = 0;

  try {
    const { data: enqueueCount, error: enqueueError } = await admin.rpc("enqueue_metrics_jobs", {
      p_workspace_id: null,
      p_limit: 1000,
      p_force: false,
    });
    if (enqueueError) throw enqueueError;
    queued = Number(enqueueCount ?? 0);

    const { data: jobs, error: dequeueError } = await admin.rpc("dequeue_metrics_jobs", {
      p_limit: 25,
      p_visibility_seconds: 300,
    });
    if (dequeueError) throw dequeueError;

    const messages = Array.isArray(jobs) ? jobs : [];
    async function processJob(job: any) {
      const targetId = String(job.target_id || "");
      if (!targetId) {
        await admin.rpc("archive_metrics_job", { p_msg_id: Number(job.msg_id) });
        return;
      }
      const { data: target, error: targetError } = await admin.from("post_targets")
        .select("id,platform,publication_type,social_account_id,external_post_id,metrics,posts!inner(workspace_id),social_accounts!inner(id,platform,external_id,status)")
        .eq("id", targetId)
        .maybeSingle();
      if (targetError || !target || target.status !== "published" || !target.external_post_id || target.social_accounts?.status !== "connected") {
        await admin.from("post_targets").update({
          metrics_queued_at: null,
          metrics_last_error: targetError?.message || "Target unavailable",
          metrics_next_attempt_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", targetId);
        await admin.rpc("archive_metrics_job", { p_msg_id: Number(job.msg_id) });
        return;
      }

      try {
        const stored = await secret(admin, target.social_accounts.id);
        const s = effectiveSecret(target.social_accounts, stored);
        const fresh = await fetchMetrics(
          target.social_accounts.platform,
          s?.access_token ?? "",
          target.social_accounts.external_id ?? "",
          target.external_post_id,
          target.publication_type || "feed",
        );
        if (!Object.keys(fresh).length) {
          await admin.from("post_targets").update({
            metrics_refreshed_at: new Date().toISOString(),
            metrics_queued_at: null,
            metrics_next_attempt_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            metrics_attempts: 0,
            metrics_last_error: null,
            updated_at: new Date().toISOString(),
          }).eq("id", targetId);
        } else {
          await admin.from("post_targets").update({
            metrics: { ...(target.metrics ?? {}), ...fresh },
            metrics_refreshed_at: new Date().toISOString(),
            metrics_queued_at: null,
            metrics_next_attempt_at: null,
            metrics_attempts: 0,
            metrics_last_error: null,
            updated_at: new Date().toISOString(),
          }).eq("id", targetId);
        }
        await admin.from("stats_cache").delete().eq("workspace_id", target.posts.workspace_id);
        processed++;
      } catch (error) {
        const message = sanitizeExternalError(error);
        const attempts = Number(target.metrics_attempts ?? job.read_count ?? 1) + 1;
        const retry = attempts < 5 && isRetryableMetricsError(error);
        const delayMinutes = Math.min(60, Math.pow(2, Math.max(0, attempts - 1)));
        await admin.from("post_targets").update({
          metrics_queued_at: null,
          metrics_attempts: attempts,
          metrics_next_attempt_at: retry ? new Date(Date.now() + delayMinutes * 60 * 1000).toISOString() : null,
          metrics_last_error: message,
          updated_at: new Date().toISOString(),
        }).eq("id", targetId);
        failed++;
      }
      try { await admin.rpc("archive_metrics_job", { p_msg_id: Number(job.msg_id) }); } catch {}
    }

    for (let i = 0; i < messages.length; i += 5) {
      const batch = messages.slice(i, i + 5);
      await Promise.all(batch.map(processJob));
    }

    await notify(url, cronToken);

    if (runId) await admin.from("scheduler_runs").update({
      status: "success",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      queued,
      claimed: messages.length,
      failed,
      details: { processed, jobs: messages.length },
    }).eq("id", runId);

    return json({ ok: true, queued, processed, failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) await admin.from("scheduler_runs").update({
      status: "error",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      queued,
      claimed: 0,
      failed,
      error: message,
    }).eq("id", runId);
    return json({ ok: false, error: message, queued, processed, failed }, 500);
  }
});
