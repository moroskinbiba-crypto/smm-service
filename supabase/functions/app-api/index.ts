import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchMetrics, healthcheck, publish, type Platform, type MediaItem } from "./social.ts";

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

const platforms = new Set(["telegram", "vk", "max", "ok"]);

async function authContext(req: Request) {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceRoleKey) throw new Error("Server configuration is incomplete");

  const authorization = req.headers.get("Authorization") ?? "";
  const jwt = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !user) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const { data, error } = await admin.rpc("get_workspace_for_user", { p_user_id: user.id });
  if (error) throw error;
  const workspace = Array.isArray(data) ? data[0] : data;
  if (!workspace?.workspace_id) throw new Error("Рабочее пространство не настроено");
  return { admin, user, workspace };
}

function canEdit(role: string) {
  return ["owner", "admin", "editor", "publisher"].includes(role);
}

function canManageAccounts(role: string) {
  return ["owner", "admin"].includes(role);
}

async function signedMedia(admin: any, media: unknown) {
  const items = Array.isArray(media) ? media : [];
  return Promise.all(items.map(async (raw: any, index) => {
    const path = typeof raw?.path === "string" ? raw.path : "";
    let signed_url: string | null = null;
    if (path) {
      const { data } = await admin.storage.from("media").createSignedUrl(path, 3600);
      signed_url = data?.signedUrl ?? null;
    }
    return {
      path,
      name: typeof raw?.name === "string" ? raw.name : undefined,
      type: typeof raw?.type === "string" ? raw.type : undefined,
      size: typeof raw?.size === "number" ? raw.size : undefined,
      order: typeof raw?.order === "number" ? raw.order : index,
      signed_url,
    };
  }));
}

async function deleteStoredMedia(admin: any, media: unknown) {
  const paths = (Array.isArray(media) ? media : [])
    .map((item: any) => typeof item?.path === "string" ? item.path : "")
    .filter(Boolean);

  if (!paths.length) return;
  await admin.storage.from("media").remove(paths);
}

async function getSecret(admin: any, accountId: string) {
  const { data, error } = await admin.rpc("get_social_account_secret", { p_social_account_id: accountId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

async function accountRow(admin: any, accountId: string, workspaceId: string) {
  const { data, error } = await admin.from("social_accounts")
    .select("id,user_id,platform,external_id,display_name,username,token_expires_at,status,last_error,metadata,created_at,updated_at")
    .eq("id", accountId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Аккаунт не найден");
  return data;
}

async function requireTargets(admin: any, workspaceId: string, ids: string[]) {
  const clean = [...new Set((ids ?? []).filter(Boolean))];
  if (!clean.length) throw new Error("Выберите хотя бы один аккаунт");
  const { data, error } = await admin.from("social_accounts")
    .select("id,platform,external_id,status")
    .eq("workspace_id", workspaceId)
    .in("id", clean);
  if (error) throw error;
  if ((data ?? []).length !== clean.length) throw new Error("Один из выбранных аккаунтов больше недоступен");
  return data;
}

function validateMedia(media: unknown) {
  const items = Array.isArray(media) ? media : [];
  if (items.length > 10) throw new Error("В одной публикации можно добавить не более 10 фото");
  for (const item of items) {
    const type = typeof item?.type === "string" ? item.type : "";
    const size = typeof item?.size === "number" ? item.size : 0;
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error("Поддерживаются только JPG, PNG и WebP");
    if (size > 50 * 1024 * 1024) throw new Error("Размер файла не должен превышать 50 МБ");
    if (typeof item?.path !== "string" || !item.path) throw new Error("У медиафайла отсутствует путь");
  }
  return items;
}

async function savePost(ctx: any, body: any) {
  if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав для публикации");
  const bodyText = typeof body.text === "string" ? body.text : "";
  const media = validateMedia(body.media);
  const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at).toISOString() : null;
  const targetAccounts = await requireTargets(ctx.admin, ctx.workspace.workspace_id, Array.isArray(body.target_account_ids) ? body.target_account_ids : []);

  if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now() && body.status !== "draft") {
    throw new Error("Дата и время публикации должны быть в будущем");
  }
  const desiredStatus = body.status === "canceled" ? "canceled" : (scheduledAt ? "scheduled" : "draft");
  const payload = {
    workspace_id: ctx.workspace.workspace_id,
    user_id: ctx.user.id,
    body: bodyText,
    media,
    status: desiredStatus,
    scheduled_at: scheduledAt,
    updated_at: new Date().toISOString(),
  };

  let postId = typeof body.post_id === "string" ? body.post_id : null;
  if (postId) {
    const { data: existing, error: existingError } = await ctx.admin.from("posts")
      .select("id,status")
      .eq("id", postId)
      .eq("workspace_id", ctx.workspace.workspace_id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw new Error("Публикация не найдена");
    if (existing.status === "publishing") throw new Error("Нельзя изменить публикацию во время отправки");

    const { error } = await ctx.admin.from("posts").update(payload).eq("id", postId);
    if (error) throw error;
    await ctx.admin.from("post_targets").delete().eq("post_id", postId);
  } else {
    const { data, error } = await ctx.admin.from("posts").insert(payload).select("id").single();
    if (error) throw error;
    postId = data.id;
  }

  const rows = targetAccounts.map((account: any) => ({
    post_id: postId,
    social_account_id: account.id,
    platform: account.platform,
    status: desiredStatus === "scheduled" ? "pending" : "waiting",
  }));
  const { error: targetError } = await ctx.admin.from("post_targets").insert(rows);
  if (targetError) throw targetError;

  return postId;
}

async function loadPosts(ctx: any, body: any) {
  const from = body.from ? new Date(body.from).toISOString() : new Date(Date.now() - 45 * 86400000).toISOString();
  const to = body.to ? new Date(body.to).toISOString() : new Date(Date.now() + 90 * 86400000).toISOString();

  const select = "id,body,media,status,scheduled_at,created_at,updated_at,workspace_id,post_targets(id,social_account_id,platform,status,last_error,published_at,metrics,external_post_id,social_accounts(display_name,username,status))";

  const [scheduledResult, unscheduledResult] = await Promise.all([
    ctx.admin.from("posts")
      .select(select)
      .eq("workspace_id", ctx.workspace.workspace_id)
      .not("scheduled_at", "is", null)
      .gte("scheduled_at", from)
      .lte("scheduled_at", to)
      .order("scheduled_at", { ascending: true })
      .limit(300),
    ctx.admin.from("posts")
      .select(select)
      .eq("workspace_id", ctx.workspace.workspace_id)
      .is("scheduled_at", null)
      .gte("created_at", from)
      .lte("created_at", to)
      .order("created_at", { ascending: false })
      .limit(300),
  ]);

  if (scheduledResult.error) throw scheduledResult.error;
  if (unscheduledResult.error) throw unscheduledResult.error;

  const byId = new Map<string, any>();
  for (const post of [...(scheduledResult.data ?? []), ...(unscheduledResult.data ?? [])]) byId.set(post.id, post);

  const posts = await Promise.all(
    [...byId.values()]
      .sort((a: any, b: any) => {
        const ad = new Date(a.scheduled_at ?? a.created_at).getTime();
        const bd = new Date(b.scheduled_at ?? b.created_at).getTime();
        return ad - bd;
      })
      .map(async (post: any) => ({
        ...post,
        media: await signedMedia(ctx.admin, post.media),
      })),
  );

  return { posts, workspace: ctx.workspace };
}

async function publishPost(ctx: any, postId: string) {
  const { data: post, error: postError } = await ctx.admin.from("posts")
    .select("id,body,media,status,workspace_id,post_targets(id,social_account_id,platform,status,last_error,attempts)")
    .eq("id", postId)
    .eq("workspace_id", ctx.workspace.workspace_id)
    .maybeSingle();
  if (postError) throw postError;
  if (!post) throw new Error("Публикация не найдена");
  if (!["draft", "scheduled", "failed", "partially_published"].includes(post.status)) throw new Error("Публикацию нельзя отправить из текущего состояния");

  const media = await signedMedia(ctx.admin, post.media);
  const targetIds = (post.post_targets ?? []).filter((t: any) => !["published"].includes(t.status));
  if (!targetIds.length) throw new Error("Нет целей для отправки");

  await ctx.admin.from("posts").update({ status: "publishing", updated_at: new Date().toISOString() }).eq("id", postId);

  const results: any[] = [];
  for (const target of targetIds) {
    try {
      const account = await accountRow(ctx.admin, target.social_account_id, ctx.workspace.workspace_id);
      const secret = await getSecret(ctx.admin, account.id);
      const externalPostId = await publish(account.platform as Platform, secret ?? {}, account.external_id ?? "", post.body ?? "", media as MediaItem[], account.metadata ?? {});
      await ctx.admin.from("post_targets").update({
        status: "published",
        external_post_id: externalPostId,
        published_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", target.id);
      await ctx.admin.from("publication_logs").insert({ post_target_id: target.id, level: "info", message: "Публикация отправлена", details: { platform: account.platform, external_post_id: externalPostId } });
      results.push({ target_id: target.id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.admin.from("post_targets").update({ status: "failed", last_error: message, updated_at: new Date().toISOString() }).eq("id", target.id);
      await ctx.admin.from("publication_logs").insert({ post_target_id: target.id, level: "error", message, details: { platform: target.platform } });
      results.push({ target_id: target.id, ok: false, error: message });
    }
  }

  const anyFailed = results.some(r => !r.ok);
  const anySuccess = results.some(r => r.ok);
  const status = anyFailed && anySuccess ? "partially_published" : anyFailed ? "failed" : "published";
  await ctx.admin.from("posts").update({ status, updated_at: new Date().toISOString() }).eq("id", postId);
  return { status, results };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const ctx = await authContext(req);
    const body = await req.json();
    switch (body.action) {
      case "bootstrap":
        return json({ ok: true, workspace: ctx.workspace });
      case "list-posts":
        return json({ ok: true, ...(await loadPosts(ctx, body)) });
      case "save-post":
        return json({ ok: true, post_id: await savePost(ctx, body) });
      case "delete-post":
        if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
        {
          const { data: post, error: loadError } = await ctx.admin.from("posts")
            .select("id,media,status")
            .eq("id", body.post_id)
            .eq("workspace_id", ctx.workspace.workspace_id)
            .maybeSingle();
          if (loadError) throw loadError;
          if (!post) throw new Error("Публикация не найдена");
          if (post.status === "publishing") throw new Error("Нельзя удалить публикацию во время отправки");
          await deleteStoredMedia(ctx.admin, post.media);
          const { error } = await ctx.admin.from("posts").delete().eq("id", body.post_id).eq("workspace_id", ctx.workspace.workspace_id);
          if (error) throw error;
        }
        return json({ ok: true });
      case "cancel-post":
        if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
        {
          const { data: post, error: loadError } = await ctx.admin.from("posts")
            .select("id,status")
            .eq("id", body.post_id)
            .eq("workspace_id", ctx.workspace.workspace_id)
            .maybeSingle();
          if (loadError) throw loadError;
          if (!post) throw new Error("Публикация не найдена");
          if (!["scheduled","publishing"].includes(post.status)) throw new Error("Отменить можно только запланированную или выполняющуюся публикацию");
          if (post.status === "publishing") throw new Error("Публикация уже отправляется");
          const { error: postError } = await ctx.admin.from("posts").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", body.post_id);
          if (postError) throw postError;
          const { error: targetError } = await ctx.admin.from("post_targets").update({ status: "canceled", last_error: null, updated_at: new Date().toISOString() }).eq("post_id", body.post_id);
          if (targetError) throw targetError;
        }
        return json({ ok: true });
      case "list-accounts":
        {
          const { data, error } = await ctx.admin.from("social_accounts")
            .select("id,platform,external_id,display_name,username,token_expires_at,status,last_error,metadata,created_at,updated_at")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .order("platform", { ascending: true })
            .order("display_name", { ascending: true });
          if (error) throw error;
          return json({ ok: true, accounts: data ?? [] });
        }
      case "connect-account":
        if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
        {
          const platform = String(body.platform || "");
          if (!platforms.has(platform)) throw new Error("Неподдерживаемая площадка");
          const accessToken = String(body.access_token || "").trim();
          if (!accessToken) throw new Error("Токен не указан");
          const metadata = typeof body.metadata === "object" && body.metadata ? body.metadata : {};
          const externalId = String(body.external_id || "").trim();
          const { data: account, error: accountError } = await ctx.admin.from("social_accounts").insert({
            user_id: ctx.user.id,
            workspace_id: ctx.workspace.workspace_id,
            platform,
            external_id: externalId,
            display_name: body.display_name || null,
            username: body.username || null,
            status: "pending",
            metadata,
            token_expires_at: body.token_expires_at ? new Date(body.token_expires_at).toISOString() : null,
          }).select("id").single();
          if (accountError) throw accountError;
          try {
            await ctx.admin.rpc("upsert_social_account_secret", {
              p_social_account_id: account.id,
              p_access_token: accessToken,
              p_refresh_token: body.refresh_token || null,
              p_expires_at: body.token_expires_at ? new Date(body.token_expires_at).toISOString() : null,
              p_client_secret: body.client_secret || null,
            });
            const secret = await getSecret(ctx.admin, account.id);
            const checked = await healthcheck(platform as Platform, secret ?? {}, externalId, metadata);
            const { data: updated, error: updateError } = await ctx.admin.from("social_accounts").update({
              status: "connected",
              last_error: null,
              display_name: body.display_name || checked.display_name || null,
              username: body.username || checked.username || null,
              updated_at: new Date().toISOString(),
            }).eq("id", account.id).select("*").single();
            if (updateError) throw updateError;
            return json({ ok: true, account: updated });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await ctx.admin.from("social_accounts").update({ status: "error", last_error: message }).eq("id", account.id);
            throw new Error(message);
          }
        }
      case "check-account":
        {
          const account = await accountRow(ctx.admin, body.account_id, ctx.workspace.workspace_id);
          const secret = await getSecret(ctx.admin, account.id);
          const checked = await healthcheck(account.platform as Platform, secret ?? {}, account.external_id ?? "", account.metadata ?? {});
          const { data, error } = await ctx.admin.from("social_accounts").update({
            status: "connected",
            last_error: null,
            display_name: account.display_name || checked.display_name || null,
            username: account.username || checked.username || null,
            updated_at: new Date().toISOString(),
          }).eq("id", account.id).select("id,platform,external_id,display_name,username,token_expires_at,status,last_error,metadata,created_at,updated_at").single();
          if (error) throw error;
          return json({ ok: true, account: data });
        }
      case "disconnect-account":
        if (!canManageAccounts(ctx.workspace.role)) throw new Error("Недостаточно прав");
        {
          const account = await accountRow(ctx.admin, body.account_id, ctx.workspace.workspace_id);
          await ctx.admin.rpc("delete_social_account_secret", { p_social_account_id: account.id });
          const { error } = await ctx.admin.from("social_accounts").delete().eq("id", account.id);
          if (error) throw error;
        }
        return json({ ok: true });
      case "publish-now":
        return json({ ok: true, ...(await publishPost(ctx, String(body.post_id))) });
      case "refresh-metrics":
        {
          const { data: targets, error: targetsError } = await ctx.admin.from("post_targets")
            .select("id,platform,social_account_id,external_post_id,social_accounts!inner(id,platform,external_id),posts!inner(workspace_id)")
            .eq("posts.workspace_id", ctx.workspace.workspace_id)
            .eq("status", "published")
            .limit(500);
          if (targetsError) throw targetsError;
          let refreshed = 0;
          const errors: string[] = [];
          for (const target of targets ?? []) {
            if (!target.external_post_id) continue;
            try {
              const account = target.social_accounts;
              const secret = await getSecret(ctx.admin, account.id);
              const metrics = await fetchMetrics(account.platform as Platform, secret ?? {}, account.external_id ?? "", target.external_post_id);
              if (Object.keys(metrics).length) {
                const { error } = await ctx.admin.from("post_targets").update({
                  metrics,
                  updated_at: new Date().toISOString(),
                }).eq("id", target.id);
                if (error) throw error;
                refreshed++;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push(message);
            }
          }
          return json({ ok: true, refreshed, errors: errors.slice(0, 20) });
        }
      case "stats":
        {
          const from = body.from ? new Date(body.from).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
          const to = body.to ? new Date(body.to).toISOString() : new Date().toISOString();
          const { data: posts, error: postsError } = await ctx.admin.from("posts")
            .select("id,status,scheduled_at,created_at")
            .eq("workspace_id", ctx.workspace.workspace_id);
          if (postsError) throw postsError;

          const { data: targets, error: targetsError } = await ctx.admin.from("post_targets")
            .select("id,platform,status,published_at,metrics,post_id,posts!inner(workspace_id)")
            .eq("posts.workspace_id", ctx.workspace.workspace_id);
          if (targetsError) throw targetsError;

          const scopedPosts = (posts ?? []).filter((p: any) => {
            const d = p.scheduled_at || p.created_at;
            return d >= from && d <= to;
          });
          const postIds = new Set(scopedPosts.map((p: any) => p.id));
          const scopedTargets = (targets ?? []).filter((t: any) => postIds.has(t.post_id));

          const emptyMetrics = () => ({
            published: 0,
            failed: 0,
            views: 0,
            likes: 0,
            comments: 0,
            reposts: 0,
          });

          const byPlatform: Record<string, any> = {};
          const daily: Record<string, any> = {};

          for (const t of scopedTargets) {
            byPlatform[t.platform] ||= { platform: t.platform, ...emptyMetrics() };
            const platform = byPlatform[t.platform];

            if (t.status === "published") platform.published++;
            if (t.status === "failed") platform.failed++;

            const m = t.metrics ?? {};
            platform.views += Number(m.views ?? 0);
            platform.likes += Number(m.likes ?? 0);
            platform.comments += Number(m.comments ?? 0);
            platform.reposts += Number(m.reposts ?? 0);

            if (t.status === "published" && t.published_at) {
              const day = String(t.published_at).slice(0, 10);
              daily[day] ||= { date: day, published: 0, views: 0, likes: 0, comments: 0, reposts: 0 };
              daily[day].published++;
              daily[day].views += Number(m.views ?? 0);
              daily[day].likes += Number(m.likes ?? 0);
              daily[day].comments += Number(m.comments ?? 0);
              daily[day].reposts += Number(m.reposts ?? 0);
            }
          }

          const enrich = (item: any) => {
            item.engagement = item.likes + item.comments + item.reposts;
            item.engagement_rate = item.views > 0 ? Number(((item.engagement / item.views) * 100).toFixed(2)) : 0;
            item.avg_views = item.published > 0 ? Math.round(item.views / item.published) : 0;
            item.avg_engagement = item.published > 0 ? Number((item.engagement / item.published).toFixed(2)) : 0;
            item.success_rate = item.published + item.failed > 0
              ? Number(((item.published / (item.published + item.failed)) * 100).toFixed(1))
              : 0;
            return item;
          };

          Object.values(byPlatform).forEach(enrich);
          Object.values(daily).forEach(enrich);

          const totals = Object.values(byPlatform).reduce((acc: any, item: any) => {
            acc.views += item.views;
            acc.likes += item.likes;
            acc.comments += item.comments;
            acc.reposts += item.reposts;
            acc.publishedTargets += item.published;
            acc.failedTargets += item.failed;
            return acc;
          }, { views: 0, likes: 0, comments: 0, reposts: 0, publishedTargets: 0, failedTargets: 0 });

          const engagement = totals.likes + totals.comments + totals.reposts;
          const activeDays = Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400000));

          return json({
            ok: true,
            summary: {
              posts: scopedPosts.length,
              published: scopedPosts.filter((p: any) => p.status === "published").length,
              scheduled: scopedPosts.filter((p: any) => p.status === "scheduled").length,
              failed: scopedPosts.filter((p: any) => p.status === "failed").length,
              views: totals.views,
              likes: totals.likes,
              comments: totals.comments,
              reposts: totals.reposts,
              engagement,
              engagement_rate: totals.views > 0 ? Number(((engagement / totals.views) * 100).toFixed(2)) : 0,
              avg_views_per_post: totals.publishedTargets > 0 ? Math.round(totals.views / totals.publishedTargets) : 0,
              avg_engagement_per_post: totals.publishedTargets > 0 ? Number((engagement / totals.publishedTargets).toFixed(2)) : 0,
              success_rate: totals.publishedTargets + totals.failedTargets > 0
                ? Number(((totals.publishedTargets / (totals.publishedTargets + totals.failedTargets)) * 100).toFixed(1))
                : 0,
              publications_per_day: Number((scopedPosts.length / activeDays).toFixed(2)),
            },
            by_platform: Object.values(byPlatform),
            daily: Object.values(daily).sort((a: any, b: any) => a.date.localeCompare(b.date)),
          });
        }
      default:
        return json({ ok: false, error: "Unknown action" }, 400);
    }
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as any).status) : 400;
    const message = error instanceof Error ? error.message : String(error ?? "Request failed");
    return json({ ok: false, error: message }, status >= 400 && status <= 599 ? status : 400);
  }
});
