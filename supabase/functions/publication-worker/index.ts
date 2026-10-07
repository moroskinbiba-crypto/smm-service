import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { publish } from "./social.ts";

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

function isRetryablePublishError(error: unknown) {
  const message = sanitizeExternalError(error);
  if (/(\b400\b|\b401\b|\b403\b|\b404\b|invalid|unauthorized|forbidden|permission|не найден|неверн|слишком длин|too long|unsupported|not allowed|token)/i.test(message)) {
    return false;
  }
  return true;
}

async function signedMedia(admin: any, media: any, workspaceId: string) {
  const items = Array.isArray(media) ? media : [];
  const prefix = workspaceId + "/";
  return Promise.all(items.map(async (item: any, index: number) => {
    const path = String(item?.path ?? "");
    if (path && !path.startsWith(prefix)) throw new Error("Медиафайл не принадлежит рабочему пространству");
    const { data } = await admin.storage.from("media").createSignedUrl(path, 3600);
    return {
      path,
      name: item?.name,
      type: item?.type,
      size: item?.size,
      order: typeof item?.order === "number" ? item.order : index,
      signed_url: data?.signedUrl ?? null,
    };
  }));
}

async function getSecret(admin: any, accountId: string) {
  const { data, error } = await admin.rpc("get_social_account_secret", { p_social_account_id: accountId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

async function refreshPostStatus(admin: any, postId: string) {
  const { data: targets } = await admin.from("post_targets").select("status").eq("post_id", postId);
  const statuses = (targets ?? []).map((x: any) => x.status);
  if (!statuses.length) return;

  const hasPending = statuses.some((s: string) => s === "pending" || s === "publishing");
  const hasFailed = statuses.some((s: string) => s === "failed");
  const hasPublished = statuses.some((s: string) => s === "published");

  const postStatus =
    statuses.every((s: string) => s === "published") ? "published" :
    hasPending ? "publishing" :
    hasFailed && hasPublished ? "partially_published" :
    hasFailed ? "failed" :
    "publishing";

  await admin.from("posts").update({ status: postStatus, updated_at: new Date().toISOString() }).eq("id", postId);
}

async function runScheduledAutomations(admin: any, postId: string, status: string) {
  const { data: post, error: postError } = await admin.from("posts")
    .select("id,workspace_id,status")
    .eq("id", postId)
    .maybeSingle();
  if (postError) throw postError;
  if (!post) return;

  const trigger = status === "published" ? "publication_success" : status === "failed" || status === "partially_published" ? "publication_failure" : null;
  if (!trigger) return;

  const { data: rules, error: rulesError } = await admin.from("automation_rules")
    .select("id")
    .eq("workspace_id", post.workspace_id)
    .eq("enabled", true)
    .eq("trigger_type", trigger);
  if (rulesError) throw rulesError;
  if (!rules?.length) return;

  const { data: members, error: membersError } = await admin.from("workspace_members")
    .select("user_id")
    .eq("workspace_id", post.workspace_id);
  if (membersError) throw membersError;

  const title = trigger === "publication_success" ? "Публикация успешно вышла" : "Ошибка публикации";
  const body = trigger === "publication_success"
    ? "Запланированная публикация успешно отправлена."
    : "Запланированная публикация завершилась ошибкой.";

  const rows = (members ?? []).map((member: any) => ({
    workspace_id: post.workspace_id,
    user_id: member.user_id,
    type: trigger,
    title,
    body,
  }));
  if (rows.length) {
    const { error } = await admin.from("notifications").insert(rows);
    if (error) throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json({ ok: false, error: "Missing server configuration" }, 500);

  const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: config, error: configError } = await supabase.rpc("get_scheduler_config");
  if (configError) return json({ ok: false, error: configError.message }, 500);
  const scheduler = Array.isArray(config) ? config[0] : config;
  if (!scheduler?.enabled) return json({ ok: true, enabled: false });
  const expectedToken = scheduler?.cron_token ?? "";
  if (!expectedToken || req.headers.get("x-cron-token") !== expectedToken) return json({ ok: false, error: "Unauthorized" }, 401);

  const started = Date.now();
  let runId: number | null = null;
  const { data: runRow } = await supabase.from("scheduler_runs").insert({
    worker: "publication-worker",
  }).select("id").single();
  runId = runRow?.id ?? null;

  let queued = 0;
  let published = 0;
  let failed = 0;
  let affectedPosts = new Set<string>();

  try {
    const { data: jobs, error: dequeueError } = await supabase.rpc("dequeue_publication_jobs", {
      p_limit: 25,
      p_visibility_seconds: 300,
    });
    if (dequeueError) throw dequeueError;

    const messages = Array.isArray(jobs) ? jobs : [];
    queued = messages.length;
    const targetIds = [...new Set(messages.map((job: any) => String(job.target_id || "")).filter(Boolean))];
    let claimed: any[] = [];
    if (targetIds.length) {
      const { data, error } = await supabase.rpc("claim_publication_targets", {
        p_target_ids: targetIds,
        p_limit: targetIds.length,
      });
      if (error) throw error;
      claimed = Array.isArray(data) ? data : [];
    }

    const claimedMap = new Map(claimed.map((x: any) => [String(x.target_id), x]));

    const processMessage = async (item: any) => {
      const targetId = String(item.target_id || "");
      const claim = claimedMap.get(targetId);
      if (!claim) {
        await supabase.rpc("archive_publication_job", { p_msg_id: Number(item.msg_id) });
        return;
      }

      const { data: target, error: targetError } = await supabase.from("post_targets")
        .select("id,post_id,platform,publication_type,social_account_id,attempts,lock_token,lock_until,publish_operation_id,posts!inner(id,body,media,status,workspace_id),social_accounts!inner(id,platform,external_id,metadata,status)")
        .eq("id", targetId)
        .eq("lock_token", claim.lock_token)
        .maybeSingle();

      if (targetError || !target) {
        failed++;
        await supabase.from("post_targets").update({
          status: "pending",
          next_attempt_at: new Date().toISOString(),
          lock_token: null,
          lock_until: null,
          queue_enqueued_at: null,
          last_error: targetError?.message || "Target not found",
          updated_at: new Date().toISOString(),
        }).eq("id", targetId).eq("lock_token", claim.lock_token);
        await supabase.rpc("archive_publication_job", { p_msg_id: Number(item.msg_id) });
        return;
      }

      affectedPosts.add(target.post_id);
      let externalPublished = false;
      try {
        const account = target.social_accounts;
        const post = target.posts;
        const storedSecret = await getSecret(supabase, account.id);
        const secret = effectiveSecret(account, storedSecret);
        const media = await signedMedia(supabase, post.media, post.workspace_id);
        const externalPostId = await publish(
          account.platform,
          secret ?? {},
          account.external_id ?? "",
          post.body ?? "",
          media,
          account.metadata ?? {},
          target.publication_type || "feed",
        );
        externalPublished = true;

        const { error: updateError } = await supabase.from("post_targets").update({
          status: "published",
          external_post_id: externalPostId,
          published_at: new Date().toISOString(),
          next_attempt_at: null,
          last_error: null,
          lock_token: null,
          lock_until: null,
          queue_enqueued_at: null,
          metrics_queued_at: null,
          metrics_refreshed_at: null,
          metrics_next_attempt_at: new Date().toISOString(),
          metrics_attempts: 0,
          metrics_last_error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", target.id).eq("lock_token", claim.lock_token);
        if (updateError) {
          const safe = sanitizeExternalError(updateError);
          await supabase.from("post_targets").update({
            status: "failed",
            attempts: 5,
            last_error: "Внешняя публикация подтверждена, но результат не сохранён: " + safe,
            next_attempt_at: null,
            lock_token: null,
            lock_until: null,
            queue_enqueued_at: null,
            updated_at: new Date().toISOString(),
          }).eq("id", target.id).eq("lock_token", claim.lock_token);
          await supabase.from("publication_logs").insert({
            post_target_id: target.id,
            level: "error",
            message: "Внешняя публикация выполнена; автоматический повтор запрещён во избежание дубля.",
            details: { platform: account.platform, publish_operation_id: target.publish_operation_id },
          });
          failed++;
          try { await supabase.rpc("archive_publication_job", { p_msg_id: Number(item.msg_id) }); } catch {}
          return;
        }

        await supabase.from("publication_logs").insert({
          post_target_id: target.id,
          level: "info",
          message: "Публикация отправлена очередью",
          details: {
            platform: account.platform,
            external_post_id: externalPostId,
            attempts: target.attempts,
            publish_operation_id: target.publish_operation_id,
          },
        });
        try {
          await supabase.rpc("enqueue_metrics_job_for_target", { p_target_id: target.id, p_delay_seconds: 60 });
        } catch {}
        await supabase.from("stats_cache").delete().eq("workspace_id", post.workspace_id);
        published++;
      } catch (error) {
        const message = sanitizeExternalError(error);
        const attempts = Number(target.attempts ?? claim.attempts ?? 1);
        if (externalPublished) {
          await supabase.from("post_targets").update({
            status: "failed",
            attempts: 5,
            last_error: "Внешняя публикация выполнена; автоматический повтор запрещён: " + message,
            next_attempt_at: null,
            lock_token: null,
            lock_until: null,
            queue_enqueued_at: null,
            updated_at: new Date().toISOString(),
          }).eq("id", target.id).eq("lock_token", claim.lock_token);
          await supabase.from("publication_logs").insert({
            post_target_id: target.id,
            level: "error",
            message: "Внешняя публикация выполнена; автоматический повтор запрещён во избежание дубля.",
            details: { platform: target.platform, attempts, publish_operation_id: target.publish_operation_id },
          });
          failed++;
          return;
        }
        const retry = attempts < 5 && isRetryablePublishError(error);
        const retryMinutes = Math.min(30, Math.pow(2, Math.max(0, attempts - 1)));
        const jitterSeconds = Math.floor(Math.random() * 30);
        const nextAttempt = retry ? new Date(Date.now() + retryMinutes * 60 * 1000 + jitterSeconds * 1000).toISOString() : null;

        await supabase.from("post_targets").update({
          status: retry ? "pending" : "failed",
          last_error: message,
          next_attempt_at: nextAttempt,
          lock_token: null,
          lock_until: null,
          queue_enqueued_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", target.id).eq("lock_token", claim.lock_token);

        await supabase.from("publication_logs").insert({
          post_target_id: target.id,
          level: "error",
          message,
          details: {
            platform: target.platform,
            attempts,
            retry,
            next_attempt_at: nextAttempt,
            publish_operation_id: target.publish_operation_id,
          },
        });
        failed++;
      }

      try { await supabase.rpc("archive_publication_job", { p_msg_id: Number(item.msg_id) }); } catch {}
    };

    for (let i = 0; i < messages.length; i += 5) {
      await Promise.all(messages.slice(i, i + 5).map(processMessage));
    }

    for (const postId of affectedPosts) {
      await refreshPostStatus(supabase, postId);
      const { data: post } = await supabase.from("posts").select("status").eq("id", postId).maybeSingle();
      if (post?.status) await runScheduledAutomations(supabase, postId, post.status);
    }

    if (runId) await supabase.from("scheduler_runs").update({
      status: "success",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      claimed: claimed.length,
      queued,
      published,
      failed,
      details: { messages: queued, claimed: claimed.length, affected_posts: affectedPosts.size },
    }).eq("id", runId);

    return json({ ok: true, queued, claimed: claimed.length, published, failed, affected_posts: affectedPosts.size });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) await supabase.from("scheduler_runs").update({
      status: "error",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      queued,
      published,
      failed,
      error: message,
    }).eq("id", runId);
    return json({ ok: false, error: message, queued, published, failed }, 500);
  }
});

