import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { publish } from "./social.ts";

async function signedMedia(admin: any, media: any) {
  const items = Array.isArray(media) ? media : [];
  return Promise.all(items.map(async (item: any, index: number) => {
    const { data } = await admin.storage.from("media").createSignedUrl(String(item?.path ?? ""), 3600);
    return {
      path: String(item?.path ?? ""),
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

async function processRecurrences(admin: any) {
  const now = new Date();
  const { data: recurrences, error } = await admin.from("post_recurrences")
    .select("id,workspace_id,source_post_id,interval_days,next_run_at,end_at,max_runs,run_count")
    .eq("active", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(20);
  if (error) throw error;

  let created = 0;
  for (const recurrence of recurrences ?? []) {
    if (recurrence.max_runs !== null && Number(recurrence.run_count) >= Number(recurrence.max_runs)) {
      await admin.from("post_recurrences").update({ active: false, updated_at: new Date().toISOString() }).eq("id", recurrence.id);
      continue;
    }

    const { data: source, error: sourceError } = await admin.from("posts")
      .select("id,user_id,body,media,post_targets(social_account_id,platform)")
      .eq("id", recurrence.source_post_id)
      .eq("workspace_id", recurrence.workspace_id)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) {
      await admin.from("post_recurrences").update({ active: false, updated_at: new Date().toISOString() }).eq("id", recurrence.id);
      continue;
    }

    const scheduledAt = new Date(recurrence.next_run_at).toISOString();
    const { data: cloned, error: cloneError } = await admin.from("posts").insert({
      workspace_id: recurrence.workspace_id,
      user_id: source.user_id,
      body: source.body ?? "",
      media: source.media ?? [],
      status: "scheduled",
      scheduled_at: scheduledAt,
      approval_status: "not_required",
    }).select("id").single();
    if (cloneError) throw cloneError;

    const targets = (source.post_targets ?? []).map((target: any) => ({
      post_id: cloned.id,
      social_account_id: target.social_account_id,
      platform: target.platform,
      status: "pending",
    }));
    if (targets.length) {
      const { error: targetError } = await admin.from("post_targets").insert(targets);
      if (targetError) throw targetError;
    }

    const nextRun = new Date(new Date(recurrence.next_run_at).getTime() + Number(recurrence.interval_days) * 86400000);
    const nextCount = Number(recurrence.run_count) + 1;
    const shouldStop =
      (recurrence.max_runs !== null && nextCount >= Number(recurrence.max_runs)) ||
      (recurrence.end_at && nextRun.getTime() > new Date(recurrence.end_at).getTime());

    await admin.from("post_recurrences").update({
      run_count: nextCount,
      next_run_at: nextRun.toISOString(),
      active: !shouldStop,
      updated_at: new Date().toISOString(),
    }).eq("id", recurrence.id);

    created++;
  }
  return created;
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

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return new Response(JSON.stringify({ ok: false, error: "Missing server configuration" }), { status: 500, headers: { "content-type": "application/json" } });

  const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: config, error: configError } = await supabase.rpc("get_scheduler_config");
  if (configError) return new Response(JSON.stringify({ ok: false, error: configError.message }), { status: 500, headers: { "content-type": "application/json" } });

  const scheduler = Array.isArray(config) ? config[0] : config;
  const expectedToken = scheduler?.cron_token ?? "";
  const enabled = scheduler?.enabled === true;
  const providedToken = req.headers.get("x-cron-token") ?? "";
  if (!expectedToken || providedToken !== expectedToken) return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  if (!enabled) return new Response(JSON.stringify({ ok: true, enabled: false, claimed: 0 }), { headers: { "content-type": "application/json" } });

  await processRecurrences(supabase);
  const { data: claimed, error: claimError } = await supabase.rpc("claim_scheduled_targets", { p_limit: 20 });
  if (claimError) return new Response(JSON.stringify({ ok: false, error: claimError.message }), { status: 500, headers: { "content-type": "application/json" } });

  let published = 0;
  let failed = 0;
  const affectedPosts = new Set<string>();

  for (const item of Array.isArray(claimed) ? claimed : []) {
    const { data: target, error: targetError } = await supabase.from("post_targets")
      .select("id,post_id,platform,publication_type,social_account_id,attempts,posts!inner(id,body,media,status,workspace_id),social_accounts!inner(id,platform,external_id,metadata,status)")
      .eq("id", item.target_id)
      .maybeSingle();

    if (targetError || !target) {
      failed++;
      await supabase.from("post_targets").update({ status: "failed", last_error: targetError?.message || "Target not found", updated_at: new Date().toISOString() }).eq("id", item.target_id);
      continue;
    }

    affectedPosts.add(target.post_id);

    try {
      const account = target.social_accounts;
      const post = target.posts;
      const secret = await getSecret(supabase, account.id);
      const media = await signedMedia(supabase, post.media);
      const externalPostId = await publish(account.platform, secret ?? {}, account.external_id ?? "", post.body ?? "", media, account.metadata ?? {}, target.publication_type || "feed");

      await supabase.from("post_targets").update({
        status: "published",
        external_post_id: externalPostId,
        published_at: new Date().toISOString(),
        next_attempt_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", target.id);
      await supabase.from("publication_logs").insert({
        post_target_id: target.id,
        level: "info",
        message: "Публикация отправлена планировщиком",
        details: { platform: account.platform, external_post_id: externalPostId, attempts: target.attempts },
      });
      published++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = Number(target.attempts ?? item.attempts ?? 1);
      const retry = attempts < 5;
      const retryMinutes = Math.min(15, Math.pow(2, Math.max(0, attempts - 1)));

      await supabase.from("post_targets").update({
        status: retry ? "pending" : "failed",
        last_error: message,
        next_attempt_at: retry ? new Date(Date.now() + retryMinutes * 60 * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("id", target.id);

      await supabase.from("publication_logs").insert({
        post_target_id: target.id,
        level: "error",
        message,
        details: { platform: target.platform, attempts, retry, next_attempt_at: retry ? new Date(Date.now() + retryMinutes * 60 * 1000).toISOString() : null },
      });
      failed++;
    }
  }

  for (const postId of affectedPosts) {
    await refreshPostStatus(supabase, postId);
    const { data: post } = await supabase.from("posts").select("status").eq("id", postId).maybeSingle();
    if (post?.status) await runScheduledAutomations(supabase, postId, post.status);
  }

  return new Response(JSON.stringify({
    ok: true,
    enabled: true,
    claimed: Array.isArray(claimed) ? claimed.length : 0,
    published,
    failed,
    affected_posts: affectedPosts.size,
  }), {
    headers: { "content-type": "application/json" },
  });
});
