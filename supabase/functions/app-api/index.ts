import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  fetchMetrics,
  healthcheck,
  publish,
  telegramSyncInbox,
  telegramSendInboxReply,
  vkSyncInbox,
  vkSendInboxReply,
  maxSyncInbox,
  maxSendInboxReply,
  okSyncInbox,
  okSendInboxReply,
  type Platform,
  type MediaItem,
  type InboxItem,
} from "./social.ts";

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

async function userContext(req: Request) {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceRoleKey) throw new Error("Server configuration is incomplete");

  const authorization = req.headers.get("Authorization") ?? "";
  const jwt = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !user) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("suspended_at,suspended_reason")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.suspended_at) {
    throw Object.assign(new Error(profile.suspended_reason || "Аккаунт приостановлен администратором"), { status: 403 });
  }

  return { admin, user };
}

async function authContext(req: Request) {
  const base = await userContext(req);
  const { data, error } = await base.admin.rpc("get_workspace_for_user", { p_user_id: base.user.id });
  if (error) throw error;
  const workspace = Array.isArray(data) ? data[0] : data;
  if (!workspace?.workspace_id) throw new Error("Рабочее пространство не настроено");
  return { ...base, workspace };
}

async function isPlatformAdmin(admin: any, userId: string) {
  const { data, error } = await admin.from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.user_id);
}

async function requirePlatformAdmin(ctx: { admin: any; user: any }) {
  if (!(await isPlatformAdmin(ctx.admin, ctx.user.id))) {
    throw Object.assign(new Error("Доступ только для платформенного администратора"), { status: 403 });
  }
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

  const select = "id,body,media,status,scheduled_at,created_at,updated_at,workspace_id,approval_status,approval_requested_by,approval_approved_by,approval_comment,approval_updated_at,post_targets(id,social_account_id,platform,status,last_error,published_at,metrics,external_post_id,social_accounts(display_name,username,status))";

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

async function aiGenerate(inputText: string, mode: string, platform?: string) {
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    throw new Error("AI не настроен: добавьте OPENAI_API_KEY в секреты Edge Function");
  }

  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-5.5";
  const instructions: Record<string,string> = {
    improve: "Улучши исходный текст для SMM: сделай яснее, сильнее и живее, не меняя факты. Сохрани язык исходника.",
    shorten: "Сократи текст примерно вдвое, сохранив смысл, факты и призыв к действию.",
    sales: "Перепиши текст более продающе, но без агрессивного маркетинга и выдуманных обещаний.",
    headline: "Предложи 5 сильных вариантов короткого заголовка для этой публикации. Один вариант в строке.",
    variants: "Сделай 3 разных варианта публикации на основе исходника. Каждый вариант отдели пустой строкой.",
    adapt: "Адаптируй текст под конкретную площадку, учитывая её формат и привычный стиль аудитории.",
  };
  const instruction = instructions[mode] ?? instructions.improve;
  const platformHint = platform ? "Площадка: " + platform + "." : "";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model,
      instructions: instruction + " " + platformHint + " Не добавляй пояснения о своей работе. Верни только готовый результат.",
      input: inputText,
      max_output_tokens: 1200,
    }),
  });

  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || "Ошибка AI API");
  }
  const outputText = typeof data?.output_text === "string"
    ? data.output_text
    : Array.isArray(data?.output)
      ? data.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content.map((part: any) => part?.text).filter(Boolean) : []).join("\n")
      : "";
  if (!outputText.trim()) throw new Error("AI не вернул текст");
  return outputText.trim();
}

async function upsertInboxItems(ctx: any, account: any, items: InboxItem[]) {
  let inserted = 0;

  for (const item of items) {
    const { data: thread, error: threadError } = await ctx.admin.from("inbox_threads")
      .upsert({
        workspace_id: ctx.workspace.workspace_id,
        social_account_id: account.id,
        platform: account.platform,
        external_thread_id: item.external_thread_id,
        thread_type: item.thread_type,
        subject: item.subject ?? null,
        participant_name: item.participant_name ?? item.author_name ?? null,
        participant_external_id: item.participant_external_id ?? item.author_external_id ?? null,
        post_target_id: item.post_target_external_id ? null : null,
        last_message_at: item.sent_at,
        last_message_preview: item.body.slice(0, 500),
        updated_at: new Date().toISOString(),
      }, { onConflict: "social_account_id,external_thread_id,thread_type" })
      .select("id,unread_count")
      .single();

    if (threadError || !thread) {
      if (threadError) throw threadError;
      continue;
    }

    const { data: messageRows, error: messageError } = await ctx.admin.from("inbox_messages")
      .upsert({
        thread_id: thread.id,
        workspace_id: ctx.workspace.workspace_id,
        social_account_id: account.id,
        external_message_id: item.external_message_id,
        direction: "inbound",
        message_type: item.message_type,
        author_name: item.author_name,
        author_external_id: item.author_external_id,
        body: item.body,
        parent_external_id: item.parent_external_id ?? null,
        sent_at: item.sent_at,
        metadata: item.metadata ?? {},
      }, { onConflict: "social_account_id,external_message_id", ignoreDuplicates: true })
      .select("id");

    if (messageError) throw messageError;
    const wasInserted = Array.isArray(messageRows) && messageRows.length > 0;
    if (wasInserted) {
      inserted++;
      await ctx.admin.from("inbox_threads").update({
        unread_count: Number(thread.unread_count ?? 0) + 1,
        last_message_at: item.sent_at,
        last_message_preview: item.body.slice(0, 500),
        participant_name: item.participant_name ?? item.author_name ?? null,
        participant_external_id: item.participant_external_id ?? item.author_external_id ?? null,
        updated_at: new Date().toISOString(),
      }).eq("id", thread.id);
    }
  }

  return inserted;
}

async function syncAccountInbox(ctx: any, account: any) {
  const secret = await getSecret(ctx.admin, account.id);
  const metadata = account.metadata && typeof account.metadata === "object" ? account.metadata : {};
  let result: { items: InboxItem[]; metadata_patch?: Record<string, unknown> } = { items: [] };

  const targetsResult = await ctx.admin.from("post_targets")
    .select("external_post_id,published_at")
    .eq("social_account_id", account.id)
    .eq("status", "published")
    .not("external_post_id", "is", null)
    .order("published_at", { ascending: false })
    .limit(30);
  if (targetsResult.error) throw targetsResult.error;
  const targets = targetsResult.data ?? [];

  switch (account.platform as Platform) {
    case "telegram":
      result = await telegramSyncInbox(secret ?? {}, metadata);
      break;
    case "vk":
      result = await vkSyncInbox(secret ?? {}, account.external_id ?? "", targets);
      break;
    case "max":
      result = await maxSyncInbox(secret ?? {}, account.external_id ?? "", targets);
      break;
    case "ok":
      result = await okSyncInbox(secret ?? {}, metadata);
      break;
  }

  const inserted = await upsertInboxItems(ctx, account, result.items ?? []);

  if (result.metadata_patch && Object.keys(result.metadata_patch).length) {
    const nextMetadata = { ...metadata, ...result.metadata_patch };
    const { error } = await ctx.admin.from("social_accounts").update({
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    }).eq("id", account.id).eq("workspace_id", ctx.workspace.workspace_id);
    if (error) throw error;
  }

  return { inserted, scanned: result.items?.length ?? 0 };
}

async function listInboxThreads(ctx: any) {
  const { data, error } = await ctx.admin.from("inbox_threads")
    .select("id,platform,external_thread_id,thread_type,subject,participant_name,participant_external_id,avatar_url,post_target_id,unread_count,last_message_at,last_message_preview,status,created_at,updated_at,social_accounts(display_name,username,external_id)")
    .eq("workspace_id", ctx.workspace.workspace_id)
    .order("updated_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return data ?? [];
}

async function listInboxMessages(ctx: any, threadId: string) {
  const { data: thread, error: threadError } = await ctx.admin.from("inbox_threads")
    .select("id,workspace_id,social_account_id,platform,external_thread_id,thread_type,subject,participant_name,participant_external_id,unread_count")
    .eq("id", threadId)
    .eq("workspace_id", ctx.workspace.workspace_id)
    .maybeSingle();
  if (threadError) throw threadError;
  if (!thread) throw new Error("Диалог не найден");

  const { data: messages, error } = await ctx.admin.from("inbox_messages")
    .select("id,external_message_id,direction,message_type,author_name,author_external_id,body,parent_external_id,sent_at,read_at,metadata")
    .eq("thread_id", threadId)
    .eq("workspace_id", ctx.workspace.workspace_id)
    .order("sent_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);
  if (error) throw error;

  return { thread, messages: messages ?? [] };
}

async function sendInboxMessage(ctx: any, threadId: string, body: string) {
  const text = body.trim();
  if (!text) throw new Error("Введите текст ответа");
  if (text.length > 4000) throw new Error("Сообщение слишком длинное");

  const { data: thread, error: threadError } = await ctx.admin.from("inbox_threads")
    .select("id,social_account_id,platform,external_thread_id,thread_type,post_target_id")
    .eq("id", threadId)
    .eq("workspace_id", ctx.workspace.workspace_id)
    .maybeSingle();
  if (threadError) throw threadError;
  if (!thread) throw new Error("Диалог не найден");

  const account = await accountRow(ctx.admin, thread.social_account_id, ctx.workspace.workspace_id);
  const secret = await getSecret(ctx.admin, account.id);
  let sent: any;

  if (account.platform === "telegram") {
    sent = await telegramSendInboxReply(secret ?? {}, thread.external_thread_id, text);
  } else if (account.platform === "vk") {
    const parts = thread.external_thread_id.split(":");
    if (parts.length < 3) throw new Error("Не удалось определить VK-пост");
    sent = await vkSendInboxReply(secret ?? {}, parts[1], parts[2], null, text);
  } else if (account.platform === "max") {
    const isComment = thread.thread_type === "comment";
    const postId = thread.external_thread_id.startsWith("max-comment:") ? thread.external_thread_id.replace("max-comment:", "") : null;
    sent = await maxSendInboxReply(secret ?? {}, thread.external_thread_id.replace("max-comment:", ""), text, isComment, postId);
  } else if (account.platform === "ok") {
    sent = await okSendInboxReply(secret ?? {}, thread.external_thread_id, text);
  } else {
    throw new Error("Ответы для этой площадки пока не поддерживаются");
  }

  const { data: insertedMessage, error: insertError } = await ctx.admin.from("inbox_messages")
    .insert({
      thread_id: thread.id,
      workspace_id: ctx.workspace.workspace_id,
      social_account_id: account.id,
      external_message_id: sent.external_message_id,
      direction: "outbound",
      message_type: thread.thread_type,
      author_name: account.display_name || account.username || account.platform,
      author_external_id: account.external_id,
      body: text,
      parent_external_id: null,
      sent_at: sent.sent_at,
      metadata: sent,
    })
    .select("id,external_message_id,direction,message_type,author_name,author_external_id,body,parent_external_id,sent_at,read_at,metadata")
    .single();

  if (insertError) throw insertError;

  await ctx.admin.from("inbox_threads").update({
    last_message_at: sent.sent_at,
    last_message_preview: text.slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq("id", thread.id);

  return insertedMessage;
}

async function markInboxRead(ctx: any, threadId: string) {
  const { error: messageError } = await ctx.admin.from("inbox_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .eq("workspace_id", ctx.workspace.workspace_id)
    .eq("direction", "inbound")
    .is("read_at", null);
  if (messageError) throw messageError;

  const { error: threadError } = await ctx.admin.from("inbox_threads")
    .update({ unread_count: 0, updated_at: new Date().toISOString() })
    .eq("id", threadId)
    .eq("workspace_id", ctx.workspace.workspace_id);
  if (threadError) throw threadError;
}

async function publishPost(ctx: any, postId: string) {
  const { data: post, error: postError } = await ctx.admin.from("posts")
    .select("id,body,media,status,workspace_id,post_targets(id,social_account_id,platform,status,last_error,attempts)")
    .eq("id", postId)
    .eq("workspace_id", ctx.workspace.workspace_id)
    .maybeSingle();
  if (postError) throw postError;
  if (!post) throw new Error("Публикация не найдена");
  if (post.approval_status === "pending") throw new Error("Публикация ожидает согласования");
  if (post.approval_status === "rejected") throw new Error("Публикация отклонена. Отправьте её на согласование повторно.");
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
      case "admin-check":
        return json({ ok: true, is_admin: await isPlatformAdmin(ctx.admin, ctx.user.id) });
      case "admin-overview": {
        await requirePlatformAdmin(ctx);

        const [usersResult, profilesResult, workspacesResult, membersResult, accountsResult] = await Promise.all([
          ctx.admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
          ctx.admin.from("profiles").select("id,display_name,avatar_url,suspended_at,suspended_reason,created_at,updated_at"),
          ctx.admin.from("workspaces").select("id,name,owner_id,timezone,created_at,updated_at").order("created_at", { ascending: true }),
          ctx.admin.from("workspace_members").select("workspace_id,user_id,role,created_at"),
          ctx.admin.from("social_accounts").select("id,user_id,workspace_id,platform,external_id,display_name,username,status,created_at,updated_at").order("created_at", { ascending: true }),
        ]);

        if (usersResult.error) throw usersResult.error;
        if (profilesResult.error) throw profilesResult.error;
        if (workspacesResult.error) throw workspacesResult.error;
        if (membersResult.error) throw membersResult.error;
        if (accountsResult.error) throw accountsResult.error;

        const authUsers = usersResult.data.users ?? [];
        const profiles = profilesResult.data ?? [];
        const profileMap = new Map(profiles.map((profile: any) => [profile.id, profile]));
        const userMap = new Map(authUsers.map((user: any) => [user.id, user]));
        const adminIds = new Set<string>();

        const { data: admins, error: adminsError } = await ctx.admin.from("platform_admins").select("user_id");
        if (adminsError) throw adminsError;
        for (const row of admins ?? []) adminIds.add(row.user_id);

        const users = authUsers.map((user: any) => {
          const profile = profileMap.get(user.id) as any;
          return {
            id: user.id,
            email: user.email ?? null,
            display_name: profile?.display_name ?? null,
            created_at: user.created_at ?? null,
            last_sign_in_at: user.last_sign_in_at ?? null,
            suspended_at: profile?.suspended_at ?? null,
            suspended_reason: profile?.suspended_reason ?? null,
            banned_until: user.banned_until ?? null,
            is_admin: adminIds.has(user.id),
          };
        });

        const teams = (workspacesResult.data ?? []).map((workspace: any) => {
          const members = (membersResult.data ?? [])
            .filter((member: any) => member.workspace_id === workspace.id)
            .map((member: any) => {
              const user = userMap.get(member.user_id) as any;
              const profile = profileMap.get(member.user_id) as any;
              return {
                user_id: member.user_id,
                email: user?.email ?? null,
                display_name: profile?.display_name ?? null,
                role: member.role,
                created_at: member.created_at,
              };
            });

          const accounts = (accountsResult.data ?? [])
            .filter((account: any) => account.workspace_id === workspace.id)
            .map((account: any) => {
              const user = userMap.get(account.user_id) as any;
              return {
                id: account.id,
                user_id: account.user_id,
                email: user?.email ?? null,
                platform: account.platform,
                external_id: account.external_id,
                display_name: account.display_name,
                username: account.username,
                status: account.status,
                created_at: account.created_at,
              };
            });

          const owner = userMap.get(workspace.owner_id) as any;
          return {
            id: workspace.id,
            name: workspace.name,
            owner_id: workspace.owner_id,
            owner_email: owner?.email ?? null,
            timezone: workspace.timezone,
            created_at: workspace.created_at,
            members,
            accounts,
          };
        });

        return json({
          ok: true,
          summary: {
            users: users.length,
            teams: teams.length,
            social_accounts: accountsResult.data?.length ?? 0,
            suspended: users.filter((user: any) => user.suspended_at).length,
          },
          users,
          teams,
        });
      }
      case "admin-suspend-user": {
        await requirePlatformAdmin(ctx);
        const targetUserId = String(body.user_id || "");
        if (!targetUserId) throw new Error("Не указан пользователь");
        if (targetUserId === ctx.user.id) throw new Error("Нельзя приостановить собственный аккаунт");

        const { data: targetAdmin } = await ctx.admin.from("platform_admins")
          .select("user_id")
          .eq("user_id", targetUserId)
          .maybeSingle();
        if (targetAdmin) throw new Error("Нельзя изменить статус другого администратора");

        const suspended = body.suspended === true;
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

        const { error: profileError } = await ctx.admin.from("profiles")
          .update({
            suspended_at: suspended ? new Date().toISOString() : null,
            suspended_reason: suspended ? reason : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", targetUserId);
        if (profileError) throw profileError;

        const { error: banError } = await ctx.admin.auth.admin.updateUserById(targetUserId, {
          ban_duration: suspended ? "876000h" : "none",
        });
        if (banError) throw banError;

        return json({ ok: true, user_id: targetUserId, suspended });
      }
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
      case "ai-generate":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const text = typeof body.text === "string" ? body.text.trim() : "";
          const mode = typeof body.mode === "string" ? body.mode : "improve";
          const platform = typeof body.platform === "string" ? body.platform : undefined;
          if (!text) throw new Error("Введите исходный текст");
          if (text.length > 12000) throw new Error("Исходный текст слишком длинный");
          const generated = await aiGenerate(text, mode, platform);
          return json({ ok: true, text: generated, mode, platform: platform ?? null });
        }
      case "bulk-delete-posts":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const ids = Array.isArray(body.post_ids) ? [...new Set(body.post_ids.map(String).filter(Boolean))].slice(0, 100) : [];
          if (!ids.length) throw new Error("Не выбраны публикации");
          const { data: posts, error } = await ctx.admin.from("posts")
            .select("id,status,media")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .in("id", ids);
          if (error) throw error;
          for (const post of posts ?? []) {
            if (post.status === "publishing") continue;
            await deleteStoredMedia(ctx.admin, post.media);
            await ctx.admin.from("posts").delete().eq("id", post.id).eq("workspace_id", ctx.workspace.workspace_id);
          }
          return json({ ok: true, deleted: (posts ?? []).filter((post: any) => post.status !== "publishing").length });
        }
      case "bulk-reschedule-posts":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const ids = Array.isArray(body.post_ids) ? [...new Set(body.post_ids.map(String).filter(Boolean))].slice(0, 100) : [];
          const minutes = Number(body.delta_minutes);
          if (!ids.length) throw new Error("Не выбраны публикации");
          if (!Number.isFinite(minutes) || Math.abs(minutes) > 525600) throw new Error("Некорректное смещение времени");
          const { data: posts, error } = await ctx.admin.from("posts")
            .select("id,scheduled_at,status")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .in("id", ids);
          if (error) throw error;
          let updated = 0;
          for (const post of posts ?? []) {
            if (!post.scheduled_at || post.status === "publishing" || post.status === "published") continue;
            const next = new Date(new Date(post.scheduled_at).getTime() + minutes * 60000);
            if (next.getTime() <= Date.now()) throw new Error("Смещение создало время в прошлом");
            const { error: updateError } = await ctx.admin.from("posts").update({ scheduled_at: next.toISOString(), updated_at: new Date().toISOString() }).eq("id", post.id);
            if (updateError) throw updateError;
            updated++;
          }
          return json({ ok: true, updated });
        }
      case "bulk-clone-posts":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const ids = Array.isArray(body.post_ids) ? [...new Set(body.post_ids.map(String).filter(Boolean))].slice(0, 50) : [];
          if (!ids.length) throw new Error("Не выбраны публикации");
          const { data: posts, error } = await ctx.admin.from("posts")
            .select("id,body,media,post_targets(social_account_id,platform)")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .in("id", ids);
          if (error) throw error;
          const created: string[] = [];
          for (const post of posts ?? []) {
            const { data: copy, error: copyError } = await ctx.admin.from("posts").insert({
              workspace_id: ctx.workspace.workspace_id,
              user_id: ctx.user.id,
              body: post.body,
              media: post.media,
              status: "draft",
              scheduled_at: null,
              approval_status: "not_required",
            }).select("id").single();
            if (copyError) throw copyError;
            const targetRows = (post.post_targets ?? []).map((target: any) => ({
              post_id: copy.id,
              social_account_id: target.social_account_id,
              platform: target.platform,
              status: "waiting",
            }));
            if (targetRows.length) {
              const { error: targetError } = await ctx.admin.from("post_targets").insert(targetRows);
              if (targetError) throw targetError;
            }
            created.push(copy.id);
          }
          return json({ ok: true, created });
        }
      case "create-recurrence":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const sourcePostId = String(body.post_id || "");
          const intervalDays = Number(body.interval_days);
          const nextRunAt = body.next_run_at ? new Date(body.next_run_at).toISOString() : "";
          const maxRuns = body.max_runs == null || body.max_runs === "" ? null : Number(body.max_runs);
          if (!sourcePostId || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) throw new Error("Некорректный интервал повтора");
          if (!nextRunAt || new Date(nextRunAt).getTime() <= Date.now()) throw new Error("Следующий запуск должен быть в будущем");
          if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000)) throw new Error("Некорректное количество повторов");
          const { data: source, error: sourceError } = await ctx.admin.from("posts")
            .select("id,status")
            .eq("id", sourcePostId)
            .eq("workspace_id", ctx.workspace.workspace_id)
            .maybeSingle();
          if (sourceError) throw sourceError;
          if (!source) throw new Error("Публикация не найдена");
          const { data, error } = await ctx.admin.from("post_recurrences").insert({
            workspace_id: ctx.workspace.workspace_id,
            source_post_id: sourcePostId,
            interval_days: intervalDays,
            next_run_at: nextRunAt,
            max_runs: maxRuns,
            created_by: ctx.user.id,
            active: true,
          }).select("id").single();
          if (error) throw error;
          return json({ ok: true, recurrence_id: data.id });
        }
      case "list-recurrences":
        {
          const { data, error } = await ctx.admin.from("post_recurrences")
            .select("id,source_post_id,interval_days,next_run_at,end_at,max_runs,run_count,active,created_at,posts!inner(id,body,status,media)")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .order("next_run_at", { ascending: true });
          if (error) throw error;
          return json({ ok: true, recurrences: data ?? [] });
        }
      case "cancel-recurrence":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const { error } = await ctx.admin.from("post_recurrences")
            .update({ active: false, updated_at: new Date().toISOString() })
            .eq("id", String(body.recurrence_id || ""))
            .eq("workspace_id", ctx.workspace.workspace_id);
          if (error) throw error;
          return json({ ok: true });
        }
      case "request-approval":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const { data: post, error } = await ctx.admin.from("posts")
            .select("id,status,approval_status")
            .eq("id", String(body.post_id || ""))
            .eq("workspace_id", ctx.workspace.workspace_id)
            .maybeSingle();
          if (error) throw error;
          if (!post) throw new Error("Публикация не найдена");
          if (post.status === "publishing") throw new Error("Нельзя отправить на согласование публикацию во время отправки");

          await ctx.admin.from("post_approvals")
            .update({ status: "rejected", reviewed_at: new Date().toISOString(), comment: "Предыдущий запрос закрыт новым запросом" })
            .eq("post_id", post.id)
            .eq("status", "pending");

          const { error: postError } = await ctx.admin.from("posts").update({
            approval_status: "pending",
            approval_requested_by: ctx.user.id,
            approval_approved_by: null,
            approval_comment: null,
            approval_updated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", post.id);
          if (postError) throw postError;

          const { error: approvalError } = await ctx.admin.from("post_approvals").insert({
            workspace_id: ctx.workspace.workspace_id,
            post_id: post.id,
            requested_by: ctx.user.id,
            status: "pending",
          });
          if (approvalError) throw approvalError;
          return json({ ok: true, approval_status: "pending" });
        }
      case "review-approval":
        {
          if (!["owner", "admin", "approver"].includes(ctx.workspace.role)) {
            throw new Error("Согласовывать публикации может только руководитель или согласующий");
          }
          const postId = String(body.post_id || "");
          const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : "";
          if (!decision) throw new Error("Некорректное решение");
          const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim() : null;

          const { data: post, error: postError } = await ctx.admin.from("posts")
            .select("id,status,approval_status")
            .eq("id", postId)
            .eq("workspace_id", ctx.workspace.workspace_id)
            .maybeSingle();
          if (postError) throw postError;
          if (!post) throw new Error("Публикация не найдена");
          if (post.approval_status !== "pending") throw new Error("Эта публикация больше не ожидает согласования");

          const { data: approval, error: approvalLoadError } = await ctx.admin.from("post_approvals")
            .select("id")
            .eq("post_id", postId)
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (approvalLoadError) throw approvalLoadError;

          const { error: updatePostError } = await ctx.admin.from("posts").update({
            approval_status: decision,
            approval_approved_by: ctx.user.id,
            approval_comment: comment,
            approval_updated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", postId);
          if (updatePostError) throw updatePostError;

          if (approval) {
            const { error: updateApprovalError } = await ctx.admin.from("post_approvals").update({
              status: decision,
              reviewed_by: ctx.user.id,
              comment,
              reviewed_at: new Date().toISOString(),
            }).eq("id", approval.id);
            if (updateApprovalError) throw updateApprovalError;
          }

          return json({ ok: true, approval_status: decision });
        }
      case "list-approval-queue":
        {
          const { data, error } = await ctx.admin.from("posts")
            .select("id,body,media,status,scheduled_at,created_at,updated_at,approval_status,approval_requested_by,approval_comment,approval_updated_at,post_targets(id,platform,status,social_accounts(display_name,username))")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .eq("approval_status", "pending")
            .order("updated_at", { ascending: false })
            .limit(100);
          if (error) throw error;
          return json({ ok: true, posts: data ?? [], role: ctx.workspace.role });
        }
      case "sync-inbox":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const { data: accounts, error } = await ctx.admin.from("social_accounts")
            .select("id,platform,external_id,display_name,username,status,metadata")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .eq("status", "connected");
          if (error) throw error;

          let scanned = 0;
          let inserted = 0;
          const errors: string[] = [];
          for (const account of accounts ?? []) {
            try {
              const result = await syncAccountInbox(ctx, account);
              scanned += result.scanned;
              inserted += result.inserted;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push((account.display_name || account.platform) + ": " + message);
            }
          }
          return json({ ok: true, scanned, inserted, errors: errors.slice(0, 20) });
        }
      case "list-inbox":
        {
          const threads = await listInboxThreads(ctx);
          return json({ ok: true, threads });
        }
      case "get-inbox-thread":
        {
          const result = await listInboxMessages(ctx, String(body.thread_id || ""));
          return json({ ok: true, ...result });
        }
      case "send-inbox-message":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const message = await sendInboxMessage(ctx, String(body.thread_id || ""), String(body.text || ""));
          return json({ ok: true, message });
        }
      case "mark-inbox-read":
        {
          await markInboxRead(ctx, String(body.thread_id || ""));
          return json({ ok: true });
        }
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
