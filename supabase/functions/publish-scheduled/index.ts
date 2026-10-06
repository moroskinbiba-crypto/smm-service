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

  const { data: claimed, error: claimError } = await supabase.rpc("claim_scheduled_targets", { p_limit: 20 });
  if (claimError) return new Response(JSON.stringify({ ok: false, error: claimError.message }), { status: 500, headers: { "content-type": "application/json" } });

  let published = 0;
  let failed = 0;
  for (const item of Array.isArray(claimed) ? claimed : []) {
    const { data: target, error: targetError } = await supabase.from("post_targets")
      .select("id,post_id,platform,social_account_id,attempts,posts!inner(id,body,media,status,workspace_id),social_accounts!inner(id,platform,external_id,metadata,status)")
      .eq("id", item.target_id)
      .maybeSingle();
    if (targetError || !target) {
      failed++;
      await supabase.from("post_targets").update({ status: "failed", last_error: targetError?.message || "Target not found" }).eq("id", item.target_id);
      continue;
    }

    try {
      const account = target.social_accounts;
      const post = target.posts;
      const secret = await getSecret(supabase, account.id);
      const media = await signedMedia(supabase, post.media);
      const externalPostId = await publish(account.platform, secret ?? {}, account.external_id ?? "", post.body ?? "", media, account.metadata ?? {});

      await supabase.from("post_targets").update({
        status: "published",
        external_post_id: externalPostId,
        published_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", target.id);
      await supabase.from("publication_logs").insert({ post_target_id: target.id, level: "info", message: "Публикация отправлена планировщиком", details: { platform: account.platform, external_post_id: externalPostId } });
      published++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("post_targets").update({ status: "failed", last_error: message, updated_at: new Date().toISOString() }).eq("id", target.id);
      await supabase.from("publication_logs").insert({ post_target_id: target.id, level: "error", message, details: { platform: target.platform } });
      failed++;
    }

    const { data: targets } = await supabase.from("post_targets").select("status").eq("post_id", target.post_id);
    const statuses = (targets ?? []).map((x: any) => x.status);
    const postStatus = statuses.length && statuses.every((s: string) => s === "published")
      ? "published"
      : statuses.some((s: string) => s === "published") && statuses.some((s: string) => s === "failed")
        ? "partially_published"
        : statuses.some((s: string) => s === "failed")
          ? "failed"
          : "publishing";
    await supabase.from("posts").update({ status: postStatus, updated_at: new Date().toISOString() }).eq("id", target.post_id);
  }

  return new Response(JSON.stringify({ ok: true, enabled: true, claimed: Array.isArray(claimed) ? claimed.length : 0, published, failed }), {
    headers: { "content-type": "application/json" },
  });
});
