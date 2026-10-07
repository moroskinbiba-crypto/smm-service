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

function json(body: Record<string, unknown>, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors, ...extraHeaders },
  });
}

const platforms = new Set(["telegram", "vk", "max", "ok", "instagram"]);

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
  const selectedWorkspaceId = (req.headers.get("x-workspace-id") || "").trim() || null;
  const { data, error } = await base.admin.rpc("get_workspace_for_user", {
    p_user_id: base.user.id,
    p_workspace_id: selectedWorkspaceId,
  });
  if (error) throw error;
  const workspace = Array.isArray(data) ? data[0] : data;
  if (!workspace?.workspace_id) throw new Error("Рабочее пространство не настроено");

  const { data: memberState, error: memberStateError } = await base.admin.from("workspace_members")
    .select("member_suspended_at,member_suspended_reason")
    .eq("workspace_id", workspace.workspace_id)
    .eq("user_id", base.user.id)
    .maybeSingle();
  if (memberStateError) throw memberStateError;
  if (memberState?.member_suspended_at) {
    throw Object.assign(
      new Error(memberState.member_suspended_reason || "Участие в этом рабочем пространстве приостановлено"),
      { status: 403 },
    );
  }
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

async function signedMedia(admin: any, media: unknown, workspaceId: string) {
  const items = Array.isArray(media) ? media : [];
  const prefix = workspaceId + "/";
  return Promise.all(items.map(async (raw: any, index) => {
    const path = typeof raw?.path === "string" ? raw.path : "";
    if (path && !path.startsWith(prefix)) throw new Error("Недопустимый путь к медиафайлу");
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

async function deleteStoredMedia(admin: any, media: unknown, workspaceId: string) {
  const prefix = workspaceId + "/";
  const paths = (Array.isArray(media) ? media : [])
    .map((item: any) => typeof item?.path === "string" ? item.path : "")
    .filter((path: string) => path.startsWith(prefix));

  if (!paths.length) return;
  await admin.storage.from("media").remove(paths);
}

async function getSecret(admin: any, accountId: string) {
  const { data, error } = await admin.rpc("get_social_account_secret", { p_social_account_id: accountId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
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

function sanitizeExternalError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error ?? "Неизвестная ошибка");
  message = message
    .replace(/([?&](?:access_token|client_secret|refresh_token|token|api_key|code)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "https://api.telegram.org/bot[REDACTED]")
    .replace(/Authorization\s*:\s*[^\s]+/gi, "Authorization: [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  return message.slice(0, 1000);
}

function zonedLocalDateTimeToUtc(dateText: string, timeText: string, timeZone: string) {
  const m = dateText.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  const t = timeText.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) throw new Error("Некорректные дата или время");
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(t[1]), minute = Number(t[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Некорректные дата или время");
  }
  const rough = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(rough);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(guess);
    const map: Record<string,string> = {};
    for (const p of parts) map[p.type] = p.value;
    const seenUtc = Date.UTC(
      Number(map.year), Number(map.month) - 1, Number(map.day),
      Number(map.hour) % 24, Number(map.minute), Number(map.second),
    );
    guess = new Date(rough - (seenUtc - rough));
  }
  return guess.toISOString();
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

function validateMedia(media: unknown, workspaceId?: string) {
  const items = Array.isArray(media) ? media : [];
  if (items.length > 10) throw new Error("В одной публикации можно добавить не более 10 медиафайлов");
  for (const item of items) {
    const type = typeof item?.type === "string" ? item.type : "";
    const size = typeof item?.size === "number" ? item.size : 0;
    if (!/^(image\/(jpeg|png|webp)|video\/(mp4|quicktime|webm|x-matroska))$/.test(type)) {
      throw new Error("Поддерживаются JPG, PNG, WebP и видео MP4/MOV/WEBM/MKV");
    }
    if (size > 50 * 1024 * 1024) throw new Error("Размер файла не должен превышать 50 МБ");
    if (typeof item?.path !== "string" || !item.path) throw new Error("У медиафайла отсутствует путь");
    if (workspaceId && !item.path.startsWith(workspaceId + "/")) throw new Error("Медиафайл не принадлежит текущему рабочему пространству");
  }
  return items;
}

async function savePost(ctx: any, body: any) {
  if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав для публикации");
  const bodyText = typeof body.text === "string" ? body.text : "";
  const media = validateMedia(body.media, ctx.workspace.workspace_id);
  const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at).toISOString() : null;
  if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now() && body.status !== "draft") {
    throw new Error("Дата и время публикации должны быть в будущем");
  }

  const targetAccounts = await requireTargets(
    ctx.admin,
    ctx.workspace.workspace_id,
    Array.isArray(body.target_account_ids) ? body.target_account_ids : [],
  );
  const publicationTypes = typeof body.target_publication_types === "object" && body.target_publication_types
    ? body.target_publication_types
    : {};
  const targets = targetAccounts.map((account: any) => ({
    social_account_id: account.id,
    platform: account.platform,
    publication_type: typeof publicationTypes[account.id] === "string" ? publicationTypes[account.id] : "feed",
  }));
  if (targets.some((target: any) => target.platform === "telegram" && target.publication_type === "story")) {
    throw new Error("Stories от имени Telegram-канала требуют отдельного пользовательского Telegram API-подключения и пока не доступны через обычного бота.");
  }

  const desiredStatus = body.status === "canceled" ? "canceled" : (scheduledAt ? "scheduled" : "draft");
  const { data, error } = await ctx.admin.rpc("save_post_bundle", {
    p_post_id: typeof body.post_id === "string" ? body.post_id : null,
    p_workspace_id: ctx.workspace.workspace_id,
    p_user_id: ctx.user.id,
    p_body: bodyText,
    p_media: media,
    p_status: desiredStatus,
    p_scheduled_at: scheduledAt,
    p_targets: targets,
  });
  if (error) throw error;
  return data;
}

async function loadPosts(ctx: any, body: any) {
  const from = body.from ? new Date(body.from).toISOString() : new Date(Date.now() - 45 * 86400000).toISOString();
  const to = body.to ? new Date(body.to).toISOString() : new Date(Date.now() + 90 * 86400000).toISOString();

  const select = "id,body,media,status,scheduled_at,created_at,updated_at,workspace_id,approval_status,approval_requested_by,approval_approved_by,approval_comment,approval_updated_at,post_targets(id,social_account_id,platform,publication_type,status,last_error,published_at,metrics,external_post_id,social_accounts(display_name,username,status))";

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
        media: await signedMedia(ctx.admin, post.media, ctx.workspace.workspace_id),
      })),
  );

  return { posts, workspace: ctx.workspace };
}

function randomToken(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function createOAuthState(ctx: any, provider: string) {
  const state = randomToken(24);
  const { error } = await ctx.admin.from("oauth_states").insert({
    user_id: ctx.user.id,
    workspace_id: ctx.workspace.workspace_id,
    provider,
    state,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  return state;
}

async function consumeOAuthState(ctx: any, provider: string, state: string) {
  const { data, error } = await ctx.admin.from("oauth_states")
    .select("id")
    .eq("state", state)
    .eq("provider", provider)
    .eq("user_id", ctx.user.id)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("OAuth-сеанс недействителен или истёк");
  await ctx.admin.from("oauth_states").delete().eq("id", data.id);
}

async function requireOAuthConfig(key: string, value: string) {
  if (!value) throw new Error("OAuth не настроен: отсутствует " + key + " в секретах Edge Function");
}

async function runAutomations(ctx: any, triggerType: string, title: string, body: string, notificationType: string) {
  const { data: rules, error } = await ctx.admin.from("automation_rules")
    .select("id,trigger_type,action_type,enabled")
    .eq("workspace_id", ctx.workspace.workspace_id)
    .eq("enabled", true)
    .eq("trigger_type", triggerType);
  if (error) throw error;
  if (!rules?.length) return;
  const { data: members, error: membersError } = await ctx.admin.from("workspace_members")
    .select("user_id")
    .eq("workspace_id", ctx.workspace.workspace_id);
  if (membersError) throw membersError;
  await createWorkspaceNotifications(ctx,(members??[]).map((row:any)=>row.user_id),title,body,notificationType);
}

async function createWorkspaceNotifications(ctx: any, users: string[], title: string, body: string, type: string) {
  const uniqueUsers = [...new Set(users.filter(Boolean))];
  if (!uniqueUsers.length) return;
  const rows = uniqueUsers.map(userId => ({
    workspace_id: ctx.workspace.workspace_id,
    user_id: userId,
    type,
    title,
    body,
  }));
  const { error } = await ctx.admin.from("notifications").insert(rows);
  if (error) throw error;
}

async function fetchCompetitorSnapshot(ctx: any, competitor: any) {
  const { data: accounts, error: accountsError } = await ctx.admin.from("social_accounts")
    .select("id,platform,external_id,metadata")
    .eq("workspace_id", ctx.workspace.workspace_id)
    .eq("platform", competitor.platform)
    .eq("status", "connected")
    .limit(1);
  if (accountsError) throw accountsError;
  const account = accounts?.[0];
  if (!account) throw new Error("Для " + competitor.platform + " нужен хотя бы один подключённый аккаунт этой площадки");

  const storedSecret = await getSecret(ctx.admin, account.id);
  const secret = effectiveSecret(account, storedSecret);
  if (competitor.platform === "vk") {
    if (!secret?.access_token) throw new Error("VK token не найден");
    const groupId = String(competitor.external_ref).replace(/^-/, "");
    const group = await jsonResponseForAppApi("https://api.vk.com/method/groups.getById?" + new URLSearchParams({
      access_token: secret.access_token, v: "5.199", group_id: groupId,
    }).toString());
    const info = Array.isArray(group.response) ? group.response[0] : group.response?.groups?.[0];
    const wall = await jsonResponseForAppApi("https://api.vk.com/method/wall.get?" + new URLSearchParams({
      access_token: secret.access_token, v: "5.199", owner_id: "-" + groupId, count: "100",
    }).toString());
    const posts = Array.isArray(wall.response?.items) ? wall.response.items : [];
    const sevenDays = Date.now() - 7 * 86400000;
    const recent = posts.filter((post: any) => Number(post.date ?? 0) * 1000 >= sevenDays);
    const avgViews = posts.length ? Math.round(posts.reduce((sum: number, p: any) => sum + Number(p.views?.count ?? 0), 0) / posts.length) : 0;
    const avgEngagement = posts.length ? Number((posts.reduce((sum: number, p: any) => sum + Number(p.likes?.count ?? 0) + Number(p.comments?.count ?? 0) + Number(p.reposts?.count ?? 0), 0) / posts.length).toFixed(2)) : 0;
    const lastPost = posts[0]?.date ? new Date(Number(posts[0].date) * 1000).toISOString() : null;
    return {
      followers: Number(info?.members_count ?? info?.followers_count ?? 0),
      posts_7d: recent.length,
      avg_views: avgViews,
      avg_engagement: avgEngagement,
      last_post_at: lastPost,
      metadata: { platform: "vk", group_id: groupId, sample_posts: posts.length },
    };
  }

  if (competitor.platform === "telegram") {
    if (!secret?.access_token) throw new Error("Telegram token не найден");
    const base = "https://api.telegram.org/bot" + secret.access_token;
    const chat = await jsonResponseForAppApi(base + "/getChat?chat_id=" + encodeURIComponent(competitor.external_ref));
    const members = await jsonResponseForAppApi(base + "/getChatMemberCount?chat_id=" + encodeURIComponent(competitor.external_ref));
    return {
      followers: Number(members.result ?? 0),
      posts_7d: 0,
      avg_views: 0,
      avg_engagement: 0,
      last_post_at: null,
      metadata: { platform: "telegram", title: chat.result?.title ?? null, username: chat.result?.username ?? null, note: "Для Telegram Bot API статистика публикаций конкурента доступна только при соответствующем доступе бота к каналу." },
    };
  }

  throw new Error("Автоматический сбор пока поддержан для VK и Telegram");
}

async function jsonResponseForAppApi(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.error || data?.error_code) {
    throw new Error(data?.error_msg || data?.description || data?.error?.message || "Внешний API вернул ошибку");
  }
  return data;
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
  const storedSecret = await getSecret(ctx.admin, account.id);
  const secret = effectiveSecret(account, storedSecret);
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
  const storedSecret = await getSecret(ctx.admin, account.id);
  const secret = effectiveSecret(account, storedSecret);
  let sent: any;

  const { data: latestInbound, error: latestInboundError } = await ctx.admin.from("inbox_messages")
    .select("metadata")
    .eq("thread_id", thread.id)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestInboundError) throw latestInboundError;

  if (account.platform === "telegram") {
    sent = await telegramSendInboxReply(secret ?? {}, thread.external_thread_id, text);
  } else if (account.platform === "vk") {
    const parts = thread.external_thread_id.split(":");
    if (parts.length < 3) throw new Error("Не удалось определить VK-пост");
    const replyTo = latestInbound?.metadata?.vk_comment_id ? String(latestInbound.metadata.vk_comment_id) : null;
    sent = await vkSendInboxReply(secret ?? {}, parts[1], parts[2], replyTo, text);
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
    .select("id,body,media,status,workspace_id,approval_status,post_targets(id,social_account_id,platform,publication_type,status,last_error,attempts,publish_operation_id)")
    .eq("id", postId)
    .eq("workspace_id", ctx.workspace.workspace_id)
    .maybeSingle();
  if (postError) throw postError;
  if (!post) throw new Error("Публикация не найдена");
  if (post.approval_status === "pending") throw new Error("Публикация ожидает согласования");
  if (post.approval_status === "rejected") throw new Error("Публикация отклонена. Отправьте её на согласование повторно.");
  if (!["draft", "scheduled", "failed", "partially_published"].includes(post.status)) throw new Error("Публикацию нельзя отправить из текущего состояния");

  const media = await signedMedia(ctx.admin, post.media, ctx.workspace.workspace_id);
  const targetIds = (post.post_targets ?? []).filter((t: any) => !["published"].includes(t.status));
  if (!targetIds.length) throw new Error("Нет целей для отправки");

  await ctx.admin.from("posts").update({ status: "publishing", updated_at: new Date().toISOString() }).eq("id", postId);

  const results: any[] = [];
  for (const target of targetIds) {
    try {
      const account = await accountRow(ctx.admin, target.social_account_id, ctx.workspace.workspace_id);
      const storedSecret = await getSecret(ctx.admin, account.id);
      const secret = effectiveSecret(account, storedSecret);
      const externalPostId = await publish(account.platform as Platform, secret, account.external_id ?? "", post.body ?? "", media as MediaItem[], account.metadata ?? {}, target.publication_type || "feed");
      const { error: confirmError } = await ctx.admin.from("post_targets").update({
        status: "published",
        external_post_id: externalPostId,
        published_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", target.id);
      if (confirmError) {
        const safe = sanitizeExternalError(confirmError);
        await ctx.admin.from("publication_logs").insert({
          post_target_id: target.id,
          level: "error",
          message: "Публикация отправлена внешней площадке, но результат не удалось сохранить. Автоматический повтор отключён.",
          details: { platform: account.platform, publish_operation_id: target.publish_operation_id ?? null },
        });
        await ctx.admin.from("post_targets").update({
          status: "failed",
          last_error: "Внешняя публикация подтверждена, но результат не сохранён: " + safe,
          next_attempt_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", target.id);
        results.push({ target_id: target.id, ok: false, error: "Публикация отправлена, но требует ручной проверки" });
        continue;
      }
      await ctx.admin.from("publication_logs").insert({ post_target_id: target.id, level: "info", message: "Публикация отправлена", details: { platform: account.platform, external_post_id: externalPostId } });
      results.push({ target_id: target.id, ok: true });
    } catch (error) {
      const message = sanitizeExternalError(error);
      await ctx.admin.from("post_targets").update({ status: "failed", last_error: message, updated_at: new Date().toISOString() }).eq("id", target.id);
      await ctx.admin.from("publication_logs").insert({ post_target_id: target.id, level: "error", message, details: { platform: target.platform } });
      results.push({ target_id: target.id, ok: false, error: message });
    }
  }

  const anyFailed = results.some(r => !r.ok);
  const anySuccess = results.some(r => r.ok);
  const status = anyFailed && anySuccess ? "partially_published" : anyFailed ? "failed" : "published";
  await ctx.admin.from("posts").update({ status, updated_at: new Date().toISOString() }).eq("id", postId);
  if (status === "published") {
    await runAutomations(ctx,"publication_success","Публикация успешно вышла","Публикация была отправлена во все выбранные площадки.","publication_success");
  } else if (status === "failed" || status === "partially_published") {
    await runAutomations(ctx,"publication_failure","Ошибка публикации","Одна или несколько площадок не приняли публикацию.","publication_failure");
  }
  return { status, results };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const ctx = await authContext(req);
    const body = await req.json();
    const action = String(body.action || "");
    const basicLimit = await ctx.admin.rpc("consume_api_rate_limit", {
      p_key: "user:" + ctx.user.id,
      p_limit: 120,
      p_window_seconds: 60,
    });
    if (basicLimit.error) throw basicLimit.error;
    const basic = Array.isArray(basicLimit.data) ? basicLimit.data[0] : basicLimit.data;
    if (basic?.allowed !== true) {
      const resetAt = basic?.reset_at ? new Date(basic.reset_at).toISOString() : new Date(Date.now() + 60000).toISOString();
      const retryAfter = Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000));
      return json({ ok: false, error: "Слишком много запросов. Попробуйте через несколько секунд.", retry_at: resetAt }, 429, { "Retry-After": String(retryAfter) });
    }
    const heavyActions = new Set(["stats","refresh-metrics","sync-inbox","content-insights","refresh-competitor","ai-generate","publish-now","import-posts"]);
    if (heavyActions.has(action)) {
      const heavyLimit = await ctx.admin.rpc("consume_api_rate_limit", {
        p_key: "heavy:" + ctx.user.id,
        p_limit: 30,
        p_window_seconds: 60,
      });
      if (heavyLimit.error) throw heavyLimit.error;
      const heavy = Array.isArray(heavyLimit.data) ? heavyLimit.data[0] : heavyLimit.data;
      if (heavy?.allowed !== true) {
        const resetAt = heavy?.reset_at ? new Date(heavy.reset_at).toISOString() : new Date(Date.now() + 60000).toISOString();
        const retryAfter = Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000));
        return json({ ok: false, error: "Слишком много тяжёлых операций. Попробуйте позже.", retry_at: resetAt }, 429, { "Retry-After": String(retryAfter) });
      }
    }
    switch (action) {
      case "admin-check":
        return json({ ok: true, is_admin: await isPlatformAdmin(ctx.admin, ctx.user.id) });
      case "admin-overview": {
        await requirePlatformAdmin(ctx);

        const [usersResult, profilesResult, workspacesResult, membersResult, accountsResult] = await Promise.all([
          ctx.admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
          ctx.admin.from("profiles").select("id,display_name,avatar_url,suspended_at,suspended_reason,created_at,updated_at"),
          ctx.admin.from("workspaces").select("id,name,owner_id,timezone,workspace_kind,max_members,created_at,updated_at").order("created_at", { ascending: true }),
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
            workspace_kind: workspace.workspace_kind,
            max_members: workspace.max_members,
            member_count: members.length,
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
      case "admin-set-workspace-limit": {
        await requirePlatformAdmin(ctx);
        const workspaceId = String(body.workspace_id || "");
        const maxMembers = Number(body.max_members);
        if (!workspaceId || !Number.isInteger(maxMembers)) throw new Error("Некорректный лимит команды");
        const { data, error } = await ctx.admin.rpc("admin_set_workspace_limit", {
          p_workspace_id: workspaceId,
          p_max_members: maxMembers,
        });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        return json({ ok: true, workspace_id: workspaceId, max_members: row?.max_members ?? maxMembers });
      }
      case "admin-suspend-user": {
        await requirePlatformAdmin(ctx);
        const targetUserId = String(body.user_id || "");
        if (!targetUserId) throw new Error("Не указан пользователь");
        if (targetUserId === ctx.user.id) throw new Error("Нельзя приостановить собственный аккаунт");

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
          await deleteStoredMedia(ctx.admin, post.media, ctx.workspace.workspace_id);
          const { error } = await ctx.admin.from("posts").delete().eq("id", body.post_id).eq("workspace_id", ctx.workspace.workspace_id);
          if (error) throw error;
        }
        return json({ ok: true });
      case "reschedule-post":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const postId = String(body.post_id || "");
          const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at).toISOString() : "";
          if (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) throw new Error("Новое время должно быть в будущем");
          const { data: post, error: loadError } = await ctx.admin.from("posts")
            .select("id,status")
            .eq("id", postId)
            .eq("workspace_id", ctx.workspace.workspace_id)
            .maybeSingle();
          if (loadError) throw loadError;
          if (!post) throw new Error("Публикация не найдена");
          if (["publishing","published"].includes(post.status)) throw new Error("Эту публикацию нельзя перенести");
          const { error } = await ctx.admin.from("posts").update({
            scheduled_at: scheduledAt,
            status: "scheduled",
            updated_at: new Date().toISOString(),
          }).eq("id", postId);
          if (error) throw error;
          return json({ ok: true, scheduled_at: scheduledAt });
        }
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
      case "list-account-groups":
        {
          const { data: groups, error: groupError } = await ctx.admin.from("account_groups")
            .select("id,name,description,created_by,created_at,updated_at")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .order("name", { ascending: true });
          if (groupError) throw groupError;
          const ids = (groups ?? []).map((g:any)=>g.id);
          let members:any[] = [];
          if (ids.length) {
            const { data, error } = await ctx.admin.from("account_group_members")
              .select("group_id,social_account_id")
              .in("group_id", ids);
            if (error) throw error;
            members = data ?? [];
          }
          return json({
            ok: true,
            groups: (groups ?? []).map((g:any)=>({
              ...g,
              account_ids: members.filter((m:any)=>m.group_id===g.id).map((m:any)=>m.social_account_id),
            })),
          });
        }
      case "create-account-group":
      case "update-account-group":
        {
          if (!["owner","admin","editor"].includes(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const groupId = body.action === "update-account-group" ? String(body.group_id || "") : "";
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const description = typeof body.description === "string" ? body.description.trim() : "";
          const accountIds = Array.isArray(body.account_ids)
            ? [...new Set(body.account_ids.map(String).filter(Boolean))].slice(0, 100)
            : [];
          if (!name) throw new Error("Введите название группы");
          if (groupId) {
            const { data: existing, error: existingError } = await ctx.admin.from("account_groups")
              .select("id")
              .eq("id", groupId)
              .eq("workspace_id", ctx.workspace.workspace_id)
              .maybeSingle();
            if (existingError) throw existingError;
            if (!existing) throw new Error("Группа не найдена");
          }

          const { data: accountsForGroup, error: accountsError } = await ctx.admin.from("social_accounts")
            .select("id")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .in("id", accountIds);
          if (accountsError) throw accountsError;
          if ((accountsForGroup ?? []).length !== accountIds.length) throw new Error("Некоторые аккаунты не принадлежат текущему рабочему пространству");

          let finalGroupId = groupId;
          if (!finalGroupId) {
            const { data: created, error } = await ctx.admin.from("account_groups")
              .insert({
                workspace_id: ctx.workspace.workspace_id,
                name,
                description: description || null,
                created_by: ctx.user.id,
              })
              .select("id")
              .single();
            if (error) throw error;
            finalGroupId = created.id;
          } else {
            const { error } = await ctx.admin.from("account_groups")
              .update({ name, description: description || null, updated_at: new Date().toISOString() })
              .eq("id", finalGroupId)
              .eq("workspace_id", ctx.workspace.workspace_id);
            if (error) throw error;
            await ctx.admin.from("account_group_members").delete().eq("group_id", finalGroupId);
          }

          if (accountIds.length) {
            const { error } = await ctx.admin.from("account_group_members").insert(accountIds.map((id:string)=>({
              group_id: finalGroupId,
              social_account_id: id,
            })));
            if (error) throw error;
          }
          return json({ ok: true, group_id: finalGroupId });
        }
      case "delete-account-group":
        {
          if (!["owner","admin","editor"].includes(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const groupId = String(body.group_id || "");
          const { error } = await ctx.admin.from("account_groups").delete()
            .eq("id", groupId)
            .eq("workspace_id", ctx.workspace.workspace_id);
          if (error) throw error;
          return json({ ok: true });
        }
      case "list-accounts":
        {
          const { data, error } = await ctx.admin.from("social_accounts")
            .select("id,platform,external_id,display_name,username,token_expires_at,status,last_error,metadata,created_at,updated_at")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .order("platform", { ascending: true })
            .order("display_name", { ascending: true });
          if (error) throw error;
          return json({ ok: true, accounts: (data ?? []).map((account:any)=>({
            ...account,
            last_error: account.last_error ? sanitizeExternalError(account.last_error) : null,
          })) });
        }
      case "telegram-notifications-start": {
        const token = Deno.env.get("TGRML_NOTIFY_BOT_TOKEN") ?? "";
        const username = Deno.env.get("TGRML_NOTIFY_BOT_USERNAME") ?? "";
        const webhookSecret = Deno.env.get("TGRML_NOTIFY_WEBHOOK_SECRET") ?? "";
        const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
        if (!token || !username || !webhookSecret) throw new Error("Telegram-бот уведомлений ещё не настроен");
        const webhookUrl = (supabaseUrl.endsWith("/") ? supabaseUrl.slice(0,-1) : supabaseUrl) + "/functions/v1/telegram-notify-webhook";
        const webhook = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: webhookSecret,
            allowed_updates: ["message"],
            drop_pending_updates: false,
          }),
        });
        const webhookBody = await webhook.json().catch(()=>({}));
        if (!webhook.ok || webhookBody?.ok !== true) throw new Error("Не удалось настроить webhook бота уведомлений: " + (webhookBody?.description || "неизвестная ошибка"));
        const code = randomToken(10);
        const { error } = await ctx.admin.from("telegram_notification_requests").insert({
          user_id: ctx.user.id,
          workspace_id: ctx.workspace.workspace_id,
          code,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });
        if (error) throw error;
        return json({
          ok: true,
          bot_username: username,
          code,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          start_url: `https://t.me/${username.replace(/^@/, "")}?start=notify_${code}`,
        });
      }
      case "telegram-notifications-stop": {
        await ctx.admin.from("telegram_notification_subscriptions")
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .eq("user_id", ctx.user.id);
        return json({ ok: true });
      }
      case "telegram-service-status":
        {
          const token = Deno.env.get("TELEGRAM_SERVICE_BOT_TOKEN") ?? "";
          const username = Deno.env.get("TELEGRAM_SERVICE_BOT_USERNAME") ?? "";
          return json({ ok: true, configured: Boolean(token && username), bot_username: username || null });
        }
      case "telegram-service-start":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
          const mode = "channel";
          if (body.mode === "business") {
            throw new Error("Telegram Business не используется для Stories каналов. Подключите Telegram-канал обычным способом.");
          }
          const token = Deno.env.get("TELEGRAM_SERVICE_BOT_TOKEN") ?? "";
          const username = Deno.env.get("TELEGRAM_SERVICE_BOT_USERNAME") ?? "";
          const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          if (!token || !username) throw new Error("Служебный Telegram-бот ещё не настроен");
          if (!webhookSecret) throw new Error("TELEGRAM_WEBHOOK_SECRET ещё не настроен");
          if (!supabaseUrl) throw new Error("SUPABASE_URL не настроен");

          const webhookUrl = (supabaseUrl.endsWith("/") ? supabaseUrl.slice(0, -1) : supabaseUrl) + "/functions/v1/telegram-webhook";
          const webhook = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url: webhookUrl,
              secret_token: webhookSecret,
              allowed_updates: ["my_chat_member", "channel_post", "message", "business_connection"],
              drop_pending_updates: false,
            }),
          });
          const webhookBody = await webhook.json().catch(() => ({}));
          if (!webhook.ok || webhookBody?.ok !== true) {
            throw new Error("Не удалось настроить Telegram Webhook: " + (webhookBody?.description || "неизвестная ошибка"));
          }

          const code = randomToken(12).slice(0, 24);
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          const { error } = await ctx.admin.from("telegram_connection_requests").insert({
            workspace_id: ctx.workspace.workspace_id,
            user_id: ctx.user.id,
            mode,
            code,
            expires_at: expiresAt,
          });
          if (error) throw error;

          if (mode === "channel") {
            return json({
              ok: true,
              mode,
              code,
              expires_at: expiresAt,
              bot_username: username,
              instructions: "Добавьте служебного Telegram-бота в нужный канал как администратора с правом публикации, затем отправьте в канале сообщение /connect " + code,
            });
          }

          return json({
            ok: true,
            mode,
            code,
            expires_at: expiresAt,
            bot_username: username,
            start_url: "https://t.me/" + username.replace(/^@/, "") + "?start=" + code,
            instructions: "Откройте ссылку, нажмите Start, затем подключите этого бота в Telegram Business и разрешите управление историями.",
          });
        }
      case "max-service-status":
        {
          const token = Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "";
          const username = Deno.env.get("MAX_CONNECT_BOT_USERNAME") ?? "";
          return json({ ok: true, configured: Boolean(token && username), bot_username: username || null });
        }
      case "max-service-start":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
          const token = Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "";
          const username = Deno.env.get("MAX_CONNECT_BOT_USERNAME") ?? "";
          const webhookSecret = Deno.env.get("MAX_WEBHOOK_SECRET") ?? "";
          if (!token || !username) throw new Error("Служебный MAX-бот ещё не настроен");
          if (!webhookSecret) throw new Error("MAX_WEBHOOK_SECRET ещё не настроен");
          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          if (supabaseUrl) {
            const subscriptionBody: Record<string, unknown> = {
              url: (supabaseUrl.endsWith("/") ? supabaseUrl.slice(0, -1) : supabaseUrl) + "/functions/v1/max-webhook",
              update_types: ["bot_added", "bot_removed", "chat_title_changed", "bot_admin_permissions_changed", "message_created"],
            };
            subscriptionBody.secret = webhookSecret;
            const webhookResponse = await fetch("https://platform-api2.max.ru/subscriptions", {
              method: "POST",
              headers: { Authorization: token, "content-type": "application/json" },
              body: JSON.stringify(subscriptionBody),
            });
            if (!webhookResponse.ok) {
              const webhookBody = await webhookResponse.text();
              throw new Error("MAX Webhook не настроен: HTTP " + webhookResponse.status + " " + webhookBody.slice(0, 300));
            }
          }
          const bytes = crypto.getRandomValues(new Uint8Array(12));
          const code = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("").slice(0, 16);
          const { error } = await ctx.admin.from("max_connection_requests").insert({
            workspace_id: ctx.workspace.workspace_id,
            user_id: ctx.user.id,
            code,
            expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          });
          if (error) throw error;
          return json({
            ok: true,
            code,
            expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            bot_username: username,
            instructions: "Добавьте бота в канал как администратора, затем отправьте в канале сообщение /connect " + code,
          });
        }
      case "max-connect-info":
        {
          const botToken = Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "";
          const botUsername = Deno.env.get("MAX_CONNECT_BOT_USERNAME") ?? "";
          if (!botToken || !botUsername) {
            return json({ ok: true, configured: false });
          }
          let bot: any = {};
          try { bot = await jsonResponseForAppApi("https://platform-api2.max.ru/me", { headers: { Authorization: botToken } }); } catch {}
          return json({ ok: true, configured: true, bot_username: bot.username || botUsername, bot_name: bot.name || botUsername });
        }
      case "max-connect-service-bot":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
          const chatId = String(body.chat_id || "").trim();
          const token = Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "";
          if (!token || !chatId) throw new Error("Служебный MAX-бот не настроен или chat_id не указан");
          const chat = await jsonResponseForAppApi("https://platform-api2.max.ru/chats/" + encodeURIComponent(chatId), { headers: { Authorization: token } });
          const metadata = { connection_method: "service_bot", bot_username: Deno.env.get("MAX_CONNECT_BOT_USERNAME") ?? null, chat_type: chat.type ?? null };
          const { data: account, error: accountError } = await ctx.admin.from("social_accounts").insert({
            user_id: ctx.user.id,
            workspace_id: ctx.workspace.workspace_id,
            platform: "max",
            external_id: chatId,
            display_name: chat.title || chat.name || "MAX",
            username: chat.link ? String(chat.link) : null,
            status: "pending",
            metadata,
          }).select("id").single();
          if (accountError) throw accountError;
          try {
            await ctx.admin.rpc("upsert_social_account_secret", { p_social_account_id: account.id, p_access_token: token });
            const storedSecret = await getSecret(ctx.admin, account.id);
  const secret = effectiveSecret(account, storedSecret);
            const checked = await healthcheck("max", secret ?? {}, chatId, metadata);
            const { data: updated, error: updateError } = await ctx.admin.from("social_accounts").update({
              status: "connected",
              last_error: null,
              display_name: chat.title || chat.name || checked.display_name || "MAX",
              username: checked.username || null,
              updated_at: new Date().toISOString(),
            }).eq("id", account.id).select("*").single();
            if (updateError) throw updateError;
            return json({ ok: true, account: updated });
          } catch (error) {
            const message = sanitizeExternalError(error);
            await ctx.admin.from("social_accounts").update({ status: "error", last_error: message }).eq("id", account.id);
            throw new Error(message);
          }
        }
      case "max-resolve-chat":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
          const chatId = String(body.chat_id || "").trim();
          const token = Deno.env.get("MAX_CONNECT_BOT_TOKEN") ?? "";
          if (!token || !chatId) throw new Error("Не настроен служебный MAX-бот или не указан chat_id");
          const chat = await jsonResponseForAppApi("https://platform-api2.max.ru/chats/" + encodeURIComponent(chatId), { headers: { Authorization: token } });
          const admins = await jsonResponseForAppApi("https://platform-api2.max.ru/chats/" + encodeURIComponent(chatId) + "/members/me", { headers: { Authorization: token } }).catch(()=>null);
          return json({ ok: true, chat: { chat_id: String(chat.chat_id ?? chat.id ?? chatId), title: chat.title || chat.name || "MAX", type: chat.type || null, bot_member: admins } });
        }
      case "oauth-vk-start":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
          const appId = Deno.env.get("VK_APP_ID") ?? "";
          const redirectUri = Deno.env.get("VK_REDIRECT_URI") ?? "";
          await requireOAuthConfig("VK_APP_ID", appId);
          await requireOAuthConfig("VK_REDIRECT_URI", redirectUri);
          const state = await createOAuthState(ctx, "vk");
          const params = new URLSearchParams({
            client_id: appId,
            display: "page",
            redirect_uri: redirectUri,
            scope: "groups,wall,photos,video,stories,offline",
            response_type: "code",
            v: "5.199",
            state,
          });
          return json({ ok: true, provider: "vk", url: "https://oauth.vk.com/authorize?" + params.toString() });
        }
      case "oauth-vk-complete":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const code = String(body.code || "");
          const state = String(body.state || "");
          if (!code || !state) throw new Error("VK OAuth не вернул code/state");
          await consumeOAuthState(ctx, "vk", state);
          const appId = Deno.env.get("VK_APP_ID") ?? "";
          const appSecret = Deno.env.get("VK_APP_SECRET") ?? "";
          const redirectUri = Deno.env.get("VK_REDIRECT_URI") ?? "";
          await requireOAuthConfig("VK_APP_ID", appId);
          await requireOAuthConfig("VK_APP_SECRET", appSecret);
          await requireOAuthConfig("VK_REDIRECT_URI", redirectUri);

          const tokenResponse = await fetch("https://oauth.vk.com/access_token?" + new URLSearchParams({
            client_id: appId,
            client_secret: appSecret,
            redirect_uri: redirectUri,
            code,
          }).toString());
          const tokenText = await tokenResponse.text();
          let tokenData: any = {};
          try { tokenData = tokenText ? JSON.parse(tokenText) : {}; } catch { tokenData = {}; }
          if (!tokenResponse.ok || tokenData.error) throw new Error(tokenData.error_description || tokenData.error || "VK не выдал токен");

          const accessToken = String(tokenData.access_token || "");
          if (!accessToken) throw new Error("VK не выдал access token");
          const groups = await jsonResponseForAppApi("https://api.vk.com/method/groups.get?" + new URLSearchParams({
            access_token: accessToken,
            v: "5.199",
            filter: "admin",
            extended: "1",
            fields: "name,screen_name,photo_100",
            count: "500",
          }).toString());

          return json({
            ok: true,
            provider: "vk",
            access_token: accessToken,
            groups: Array.isArray(groups.response?.items) ? groups.response.items.map((group:any)=>({
              id: String(group.id),
              name: group.name,
              screen_name: group.screen_name ?? null,
              photo_100: group.photo_100 ?? null,
            })) : [],
          });
        }
      case "oauth-meta-start":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
          const appId = Deno.env.get("META_APP_ID") ?? "";
          const redirectUri = Deno.env.get("META_REDIRECT_URI") ?? "";
          await requireOAuthConfig("META_APP_ID", appId);
          await requireOAuthConfig("META_REDIRECT_URI", redirectUri);
          const state = await createOAuthState(ctx, "meta");
          const params = new URLSearchParams({
            client_id: appId,
            redirect_uri: redirectUri,
            response_type: "code",
            state,
            scope: "pages_show_list,instagram_basic,instagram_content_publish,pages_read_engagement",
          });
          return json({ ok: true, provider: "meta", url: "https://www.facebook.com/v25.0/dialog/oauth?" + params.toString() });
        }
      case "oauth-meta-complete":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const code = String(body.code || "");
          const state = String(body.state || "");
          if (!code || !state) throw new Error("Meta OAuth не вернул code/state");
          await consumeOAuthState(ctx, "meta", state);
          const appId = Deno.env.get("META_APP_ID") ?? "";
          const appSecret = Deno.env.get("META_APP_SECRET") ?? "";
          const redirectUri = Deno.env.get("META_REDIRECT_URI") ?? "";
          await requireOAuthConfig("META_APP_ID", appId);
          await requireOAuthConfig("META_APP_SECRET", appSecret);
          await requireOAuthConfig("META_REDIRECT_URI", redirectUri);

          const tokenResponse = await fetch("https://graph.facebook.com/v25.0/oauth/access_token?" + new URLSearchParams({
            client_id: appId,
            client_secret: appSecret,
            redirect_uri: redirectUri,
            code,
          }).toString());
          const tokenText = await tokenResponse.text();
          let tokenData: any = {};
          try { tokenData = tokenText ? JSON.parse(tokenText) : {}; } catch { tokenData = {}; }
          if (!tokenResponse.ok || tokenData.error) throw new Error(tokenData.error?.message || tokenData.error_description || "Meta не выдал токен");

          const userToken = String(tokenData.access_token || "");
          if (!userToken) throw new Error("Meta не выдал access token");

          const pages = await jsonResponseForAppApi("https://graph.facebook.com/v25.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=" + encodeURIComponent(userToken));
          const accounts: any[] = [];
          for (const page of Array.isArray(pages.data) ? pages.data : []) {
            if (!page.instagram_business_account?.id || !page.access_token) continue;
            const ig = await jsonResponseForAppApi("https://graph.facebook.com/v25.0/" + encodeURIComponent(page.instagram_business_account.id) + "?fields=id,username,name,profile_picture_url,account_type&access_token=" + encodeURIComponent(page.access_token));
            accounts.push({
              page_id: String(page.id),
              page_name: page.name,
              page_access_token: String(page.access_token),
              instagram_id: String(ig.id),
              instagram_username: ig.username || null,
              instagram_name: ig.name || null,
              profile_picture_url: ig.profile_picture_url || null,
              account_type: ig.account_type || null,
            });
          }

          return json({ ok: true, provider: "meta", accounts });
        }
      case "oauth-connect-vk":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const accessToken = String(body.access_token || "").trim();
          const groupId = String(body.group_id || "").trim();
          if (!accessToken || !groupId) throw new Error("Не выбран аккаунт VK");
          const metadata = { oauth: true, oauth_provider: "vk" };
          const { data: account, error: accountError } = await ctx.admin.from("social_accounts").insert({
            user_id: ctx.user.id,
            workspace_id: ctx.workspace.workspace_id,
            platform: "vk",
            external_id: groupId,
            display_name: body.group_name || null,
            username: body.group_screen_name ? "@" + String(body.group_screen_name).replace(/^@/, "") : null,
            status: "pending",
            metadata,
          }).select("id").single();
          if (accountError) throw accountError;
          try {
            await ctx.admin.rpc("upsert_social_account_secret", { p_social_account_id: account.id, p_access_token: accessToken });
            const storedSecret = await getSecret(ctx.admin, account.id);
  const secret = effectiveSecret(account, storedSecret);
            const checked = await healthcheck("vk", secret ?? {}, groupId, metadata);
            const { data: updated, error: updateError } = await ctx.admin.from("social_accounts").update({
              status: "connected",
              last_error: null,
              display_name: body.group_name || checked.display_name || null,
              username: body.group_screen_name ? "@" + String(body.group_screen_name).replace(/^@/, "") : checked.username || null,
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
      case "oauth-connect-meta":
        {
          if (!canManageAccounts(ctx.workspace.role)) throw new Error("Подключать аккаунты может только руководитель");
          const accessToken = String(body.page_access_token || "").trim();
          const instagramId = String(body.instagram_id || "").trim();
          if (!accessToken || !instagramId) throw new Error("Не выбран Instagram-аккаунт");
          const metadata = {
            oauth: true,
            oauth_provider: "meta",
            page_id: body.page_id ? String(body.page_id) : null,
            page_name: body.page_name ? String(body.page_name) : null,
            account_type: body.account_type ? String(body.account_type) : null,
          };
          const { data: account, error: accountError } = await ctx.admin.from("social_accounts").insert({
            user_id: ctx.user.id,
            workspace_id: ctx.workspace.workspace_id,
            platform: "instagram",
            external_id: instagramId,
            display_name: body.instagram_name || body.instagram_username || "Instagram",
            username: body.instagram_username ? "@" + String(body.instagram_username).replace(/^@/, "") : null,
            status: "pending",
            metadata,
          }).select("id").single();
          if (accountError) throw accountError;
          try {
            await ctx.admin.rpc("upsert_social_account_secret", { p_social_account_id: account.id, p_access_token: accessToken });
            const storedSecret = await getSecret(ctx.admin, account.id);
  const secret = effectiveSecret(account, storedSecret);
            const checked = await healthcheck("instagram", secret ?? {}, instagramId, metadata);
            const { data: updated, error: updateError } = await ctx.admin.from("social_accounts").update({
              status: "connected",
              last_error: null,
              display_name: body.instagram_name || checked.display_name || null,
              username: body.instagram_username ? "@" + String(body.instagram_username).replace(/^@/, "") : checked.username || null,
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
            const storedSecret = await getSecret(ctx.admin, account.id);
  const secret = effectiveSecret(account, storedSecret);
            const checked = await healthcheck(platform as Platform, secret ?? {}, externalId, metadata);
            const nextMetadata = checked?.metadata_patch ? { ...metadata, ...checked.metadata_patch } : metadata;
            const { data: updated, error: updateError } = await ctx.admin.from("social_accounts").update({
              status: "connected",
              last_error: null,
              display_name: body.display_name || checked.display_name || null,
              username: body.username || checked.username || null,
              metadata: nextMetadata,
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
          const storedSecret = await getSecret(ctx.admin, account.id);
          const checked = await healthcheck(account.platform as Platform, effectiveSecret(account, storedSecret), account.external_id ?? "", account.metadata ?? {});
          const nextMetadata = checked?.metadata_patch ? { ...(account.metadata ?? {}), ...checked.metadata_patch } : (account.metadata ?? {});
          const { data, error } = await ctx.admin.from("social_accounts").update({
            status: "connected",
            last_error: null,
            display_name: account.display_name || checked.display_name || null,
            username: account.username || checked.username || null,
            metadata: nextMetadata,
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
      case "list-automation-rules":
        {
          const { data, error } = await ctx.admin.from("automation_rules")
            .select("id,name,trigger_type,action_type,enabled,config,created_at,updated_at")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .order("created_at", { ascending: false });
          if (error) throw error;
          return json({ ok: true, rules: data ?? [] });
        }
      case "create-automation-rule":
        {
          if (!["owner","admin"].includes(ctx.workspace.role)) throw new Error("Настраивать автоматизацию может только руководитель");
          const triggerType = String(body.trigger_type || "");
          const actionType = String(body.action_type || "notify_team");
          const name = String(body.name || "").trim();
          if (!["publication_success","publication_failure","approval_requested","approval_reviewed"].includes(triggerType)) throw new Error("Неизвестный триггер");
          if (actionType !== "notify_team") throw new Error("Неизвестное действие");
          if (!name) throw new Error("Укажите название правила");
          const { data, error } = await ctx.admin.from("automation_rules").insert({
            workspace_id: ctx.workspace.workspace_id,
            name,
            trigger_type: triggerType,
            action_type: actionType,
            enabled: true,
            config: typeof body.config === "object" && body.config ? body.config : {},
            created_by: ctx.user.id,
          }).select("id").single();
          if (error) throw error;
          return json({ ok: true, rule_id: data.id });
        }
      case "toggle-automation-rule":
        {
          if (!["owner","admin"].includes(ctx.workspace.role)) throw new Error("Настраивать автоматизацию может только руководитель");
          const enabled = body.enabled === true;
          const { error } = await ctx.admin.from("automation_rules").update({ enabled, updated_at: new Date().toISOString() })
            .eq("id", String(body.rule_id || ""))
            .eq("workspace_id", ctx.workspace.workspace_id);
          if (error) throw error;
          return json({ ok: true });
        }
      case "delete-automation-rule":
        {
          if (!["owner","admin"].includes(ctx.workspace.role)) throw new Error("Настраивать автоматизацию может только руководитель");
          const { error } = await ctx.admin.from("automation_rules").delete()
            .eq("id", String(body.rule_id || ""))
            .eq("workspace_id", ctx.workspace.workspace_id);
          if (error) throw error;
          return json({ ok: true });
        }
      case "list-media":
        {
          const { data: files, error } = await ctx.admin.storage.from("media").list(ctx.workspace.workspace_id, {
            limit: 300,
            sortBy: { column: "created_at", order: "desc" },
          });
          if (error) throw error;
          const media = await Promise.all((files ?? []).map(async (file: any) => {
            if (!file?.name || file.name === ".emptyFolderPlaceholder") return null;
            const path = ctx.workspace.workspace_id + "/" + file.name;
            const { data } = await ctx.admin.storage.from("media").createSignedUrl(path, 3600);
            return {
              name: file.name,
              path,
              signed_url: data?.signedUrl ?? null,
              created_at: file.created_at ?? null,
              updated_at: file.updated_at ?? null,
              metadata: file.metadata ?? null,
            };
          }));
          return json({ ok: true, media: media.filter(Boolean) });
        }
      case "delete-media":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const rawPath = String(body.path || "");
          const prefix = ctx.workspace.workspace_id + "/";
          if (!rawPath.startsWith(prefix)) throw new Error("Недопустимый путь к медиа");
          const { data: posts, error: postsError } = await ctx.admin.from("posts")
            .select("id,media")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .limit(5000);
          if (postsError) throw postsError;
          const used = (posts ?? []).some((post:any) =>
            Array.isArray(post.media) && post.media.some((item:any)=>item?.path === rawPath)
          );
          if (used) throw new Error("Файл используется в публикации и не может быть удалён из медиатеки");

          const { error } = await ctx.admin.storage.from("media").remove([rawPath]);
          if (error) throw error;
          return json({ ok: true });
        }
      case "list-notifications":
        {
          const { data, error } = await ctx.admin.from("notifications")
            .select("id,type,title,body,read_at,created_at")
            .eq("user_id", ctx.user.id)
            .order("created_at", { ascending: false })
            .limit(100);
          if (error) throw error;
          return json({ ok: true, notifications: data ?? [] });
        }
      case "mark-notification-read":
        {
          const id = String(body.notification_id || "");
          const { error } = await ctx.admin.from("notifications")
            .update({ read_at: new Date().toISOString() })
            .eq("id", id)
            .eq("user_id", ctx.user.id);
          if (error) throw error;
          return json({ ok: true });
        }
      case "content-insights":
        {
          const { data: posts, error: postsError } = await ctx.admin.from("posts")
            .select("id,body,status,created_at,scheduled_at,post_targets(status,metrics,published_at)")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .order("created_at", { ascending: false })
            .limit(500);
          if (postsError) throw postsError;

          const stop = new Set([
            "это","как","для","что","так","или","при","из","на","по","и","в","во","с","со","у","к","о","об","а","но","не","да","мы","вы","они","он","она","я","ты","за","до","от","же","ли","уже","еще","ещё","также","можно","если","будет","быть","был","была","были","их","его","ее","ее","тот","эта","этот","эти","все","всё","про","когда","где","кто","для","над","под","без","через"
          ]);
          const freq: Record<string,{term:string;count:number;views:number;posts:number}> = {};
          const weekday: Record<number,{weekday:number;posts:number;views:number}> = {};

          for (const post of posts ?? []) {
            const text = String(post.body ?? "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-zа-яё0-9\s-]/gi, " ");
            const words = text.split(/\s+/).map((word:string)=>word.replace(/^-+|-+$/g,"")).filter((word:string)=>word.length>=4&&!stop.has(word)&&!/^\d+$/.test(word));
            const targets = Array.isArray(post.post_targets) ? post.post_targets : [];
            const postViews = targets.reduce((sum:number,target:any)=>sum+Number(target.metrics?.views??0),0);
            for (const word of new Set(words)) {
              freq[word] ||= {term:word,count:0,views:0,posts:0};
              freq[word].count++;
              freq[word].views += postViews;
              freq[word].posts++;
            }
            const publishedTarget = targets.find((target:any)=>target.status==="published" && target.published_at);
            const dateValue = publishedTarget?.published_at || post.scheduled_at || post.created_at;
            if (dateValue) {
              const day = new Date(dateValue).getDay();
              weekday[day] ||= {weekday:day,posts:0,views:0};
              weekday[day].posts++;
              weekday[day].views += postViews;
            }
          }

          const weekdayNames = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
          const topics = Object.values(freq).sort((a:any,b:any)=>b.count-a.count).slice(0,30).map(item=>({
            ...item,
            avg_views: item.posts>0?Math.round(item.views/item.posts):0,
          }));
          const bestTopics = [...topics].sort((a:any,b:any)=>b.avg_views-a.avg_views).slice(0,10);
          const weekdays = Object.values(weekday).sort((a:any,b:any)=>b.views/Math.max(1,b.posts)-a.views/Math.max(1,a.posts)).map(item=>({
            label: weekdayNames[item.weekday],
            posts:item.posts,
            avg_views:item.posts?Math.round(item.views/item.posts):0,
          }));

          return json({ok:true,posts_analyzed:(posts??[]).length,topics,best_topics:bestTopics,weekdays});
        }
      case "list-competitors":
        {
          const { data, error } = await ctx.admin.from("competitors")
            .select("id,platform,name,external_ref,url,notes,active,created_at,updated_at,competitor_snapshots(id,followers,posts_7d,avg_views,avg_engagement,last_post_at,collected_at)")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .order("created_at", { ascending: false });
          if (error) throw error;
          return json({ ok: true, competitors: data ?? [] });
        }
      case "create-competitor":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const platform = String(body.platform || "");
          const name = String(body.name || "").trim();
          const externalRef = String(body.external_ref || "").trim();
          if (!["telegram","vk","max","ok"].includes(platform)) throw new Error("Неподдерживаемая площадка");
          if (!name || !externalRef) throw new Error("Название и идентификатор конкурента обязательны");
          const { data, error } = await ctx.admin.from("competitors").insert({
            workspace_id: ctx.workspace.workspace_id,
            platform,
            name,
            external_ref: externalRef,
            url: typeof body.url === "string" ? body.url.trim() || null : null,
            notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
          }).select("id").single();
          if (error) throw error;
          return json({ ok: true, competitor_id: data.id });
        }
      case "delete-competitor":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const { error } = await ctx.admin.from("competitors").delete()
            .eq("id", String(body.competitor_id || ""))
            .eq("workspace_id", ctx.workspace.workspace_id);
          if (error) throw error;
          return json({ ok: true });
        }
      case "refresh-competitor":
        {
          const { data: competitor, error } = await ctx.admin.from("competitors")
            .select("id,platform,name,external_ref,url,notes,active")
            .eq("id", String(body.competitor_id || ""))
            .eq("workspace_id", ctx.workspace.workspace_id)
            .maybeSingle();
          if (error) throw error;
          if (!competitor) throw new Error("Конкурент не найден");
          const snapshot = await fetchCompetitorSnapshot(ctx, competitor);
          const { error: insertError } = await ctx.admin.from("competitor_snapshots").insert({
            competitor_id: competitor.id,
            followers: snapshot.followers,
            posts_7d: snapshot.posts_7d,
            avg_views: snapshot.avg_views,
            avg_engagement: snapshot.avg_engagement,
            last_post_at: snapshot.last_post_at,
            metadata: snapshot.metadata,
          });
          if (insertError) throw insertError;
          return json({ ok: true, snapshot });
        }
      case "ai-generate":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const workspaceLimit = await ctx.admin.rpc("consume_api_rate_limit", {
            p_key: "ai-workspace:" + ctx.workspace.workspace_id,
            p_limit: 200,
            p_window_seconds: 86400,
          });
          if (workspaceLimit.error) throw workspaceLimit.error;
          const quota = Array.isArray(workspaceLimit.data) ? workspaceLimit.data[0] : workspaceLimit.data;
          if (quota?.allowed !== true) {
            const resetAt = quota?.reset_at ? new Date(quota.reset_at).toISOString() : new Date(Date.now() + 86400000).toISOString();
            const retryAfter = Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000));
            return json({ ok: false, error: "Дневная квота AI для рабочего пространства исчерпана.", retry_at: resetAt }, 429, { "Retry-After": String(retryAfter) });
          }
          const text = typeof body.text === "string" ? body.text.trim() : "";
          const mode = typeof body.mode === "string" ? body.mode : "improve";
          const platform = typeof body.platform === "string" ? body.platform : undefined;
          if (!text) throw new Error("Введите исходный текст");
          if (text.length > 12000) throw new Error("Исходный текст слишком длинный");
          const generated = await aiGenerate(text, mode, platform);
          return json({ ok: true, text: generated, mode, platform: platform ?? null });
        }
      case "import-posts":
        {
          if (!canEdit(ctx.workspace.role)) throw new Error("Недостаточно прав");
          const rows = Array.isArray(body.rows) ? body.rows.slice(0, 100) : [];
          if (!rows.length) throw new Error("CSV не содержит строк");
          const { data: accounts, error: accountsError } = await ctx.admin.from("social_accounts")
            .select("id,platform,status")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .eq("status", "connected");
          if (accountsError) throw accountsError;

          const platformAliases: Record<string,string> = {
            telegram:"telegram", tg:"telegram",
            vk:"vk", vkontakte:"vk",
            max:"max",
            ok:"ok", odnoklassniki:"ok", одноклассники:"ok",
          };
          const errors: string[] = [];
          const created: string[] = [];

          for (let index = 0; index < rows.length; index++) {
            const row = rows[index] ?? {};
            const text = typeof row.text === "string" ? row.text.trim() : "";
            if (!text) { errors.push("Строка " + (index + 2) + ": нет текста"); continue; }

            const platformsRaw = typeof row.platforms === "string" ? row.platforms.trim() : "";
            const requested = platformsRaw && platformsRaw.toLowerCase() !== "all"
              ? platformsRaw.split(/[|;,]+/).map((item:string)=>platformAliases[item.trim().toLowerCase()] ?? item.trim().toLowerCase()).filter(Boolean)
              : [];
            const selectedAccounts = requested.length
              ? (accounts ?? []).filter((account:any)=>requested.includes(account.platform))
              : (accounts ?? []);

            if (!selectedAccounts.length) {
              errors.push("Строка " + (index + 2) + ": нет подключённых аккаунтов для указанных площадок");
              continue;
            }

            let scheduledAt: string | null = null;
            if (typeof row.date === "string" && row.date.trim()) {
              const time = typeof row.time === "string" && row.time.trim() ? row.time.trim() : "12:00";
              try {
                scheduledAt = zonedLocalDateTimeToUtc(row.date.trim(), time, ctx.workspace.workspace_timezone);
              } catch {
                errors.push("Строка " + (index + 2) + ": дата/время некорректны");
                continue;
              }
              if (new Date(scheduledAt).getTime() <= Date.now()) {
                errors.push("Строка " + (index + 2) + ": дата/время уже прошли по часовому поясу рабочего пространства");
                continue;
              }
            }

            const targetPublicationTypes: Record<string,string> = {};
            const targetAccountIds = selectedAccounts.map((account:any) => {
              targetPublicationTypes[account.id] = "feed";
              return account.id;
            });
            try {
              const postId = await savePost(ctx, {
                text,
                media: [],
                status: scheduledAt ? "scheduled" : "draft",
                scheduled_at: scheduledAt,
                target_account_ids: targetAccountIds,
                target_publication_types: targetPublicationTypes,
              });
              created.push(postId);
            } catch (error) {
              errors.push("Строка " + (index + 2) + ": " + sanitizeExternalError(error));
              continue;
            }
          }

          return json({ ok: true, created, errors: errors.slice(0, 50) });
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
            await deleteStoredMedia(ctx.admin, post.media, ctx.workspace.workspace_id);
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
            const targetAccountIds = (post.post_targets ?? []).map((target:any) => target.social_account_id);
            const targetPublicationTypes: Record<string,string> = {};
            for (const target of post.post_targets ?? []) {
              targetPublicationTypes[target.social_account_id] = "feed";
            }
            const postId = await savePost(ctx, {
              text: post.body ?? "",
              media: post.media ?? [],
              status: "draft",
              scheduled_at: null,
              target_account_ids: targetAccountIds,
              target_publication_types: targetPublicationTypes,
            });
            created.push(postId);
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
          const postId = String(body.post_id || "");
          if (!postId) throw new Error("Не указана публикация");

          const { data: requestId, error: requestError } = await ctx.admin.rpc("request_post_approval", {
            p_post_id: postId,
            p_workspace_id: ctx.workspace.workspace_id,
            p_user_id: ctx.user.id,
          });
          if (requestError) throw requestError;

          await createWorkspaceNotifications(
            ctx,
            [ctx.user.id],
            "Публикация отправлена на согласование",
            "Запрос на согласование создан.",
            "approval_requested",
          );
          return json({ ok: true, approval_id: requestId });
        }
      case "review-approval":
        {
          const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : "";
          if (!decision) throw new Error("Некорректное решение");
          const postId = String(body.post_id || "");
          if (!postId) throw new Error("Не указана публикация");
          const comment = typeof body.comment === "string" && body.comment.trim() ? body.comment.trim() : null;

          const { data, error } = await ctx.admin.rpc("review_post_approval", {
            p_post_id: postId,
            p_workspace_id: ctx.workspace.workspace_id,
            p_reviewer_id: ctx.user.id,
            p_decision: decision,
            p_comment: comment,
          });
          if (error) throw error;

          const row = Array.isArray(data) ? data[0] : data;
          if (row?.requested_by) {
            await createWorkspaceNotifications(
              ctx,
              [row.requested_by],
              decision === "approved" ? "Публикация согласована" : "Публикация отклонена",
              comment || "Статус публикации изменён.",
              "approval_reviewed",
            );
          }

          await runAutomations(
            ctx,
            "approval_reviewed",
            decision === "approved" ? "Публикация согласована" : "Публикация отклонена",
            "Согласование завершено.",
            "approval_reviewed",
          );
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
          const { data: queued, error: queueError } = await ctx.admin.rpc("enqueue_metrics_jobs", {
            p_workspace_id: ctx.workspace.workspace_id,
            p_limit: 1000,
            p_force: true,
          });
          if (queueError) throw queueError;
          await ctx.admin.from("stats_cache").delete().eq("workspace_id", ctx.workspace.workspace_id);
          return json({ ok: true, queued: Number(queued ?? 0), message: "Обновление метрик поставлено в очередь" });
        }
      case "stats":
        {
          const from = body.from ? new Date(body.from).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
          const to = body.to ? new Date(body.to).toISOString() : new Date().toISOString();
          const rangeMs = Math.max(1, new Date(to).getTime() - new Date(from).getTime());
          const previousFrom = new Date(new Date(from).getTime() - rangeMs);
          const previousTo = new Date(from);
          const cacheKey = "stats:" + from + ":" + to;
          const { data: cachedRow, error: cacheError } = await ctx.admin.from("stats_cache")
            .select("payload,expires_at")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .eq("cache_key", cacheKey)
            .maybeSingle();
          if (cacheError) throw cacheError;
          if (cachedRow?.payload && new Date(cachedRow.expires_at).getTime() > Date.now()) {
            return json({ ...(cachedRow.payload as Record<string, unknown>), cached: true });
          }

          const { data: posts, error: postsError } = await ctx.admin.from("posts")
            .select("id,status,scheduled_at,created_at")
            .eq("workspace_id", ctx.workspace.workspace_id)
            .or("created_at.gte." + previousFrom.toISOString() + ",scheduled_at.gte." + previousFrom.toISOString())
            .or("created_at.lte." + to + ",scheduled_at.lte." + to)
            .limit(5000);
          if (postsError) throw postsError;

          const rangePostIds = (posts ?? []).map((p:any)=>p.id);
          let targets: any[] = [];
          if (rangePostIds.length) {
            const { data: targetRows, error: targetsError } = await ctx.admin.from("post_targets")
              .select("id,platform,social_account_id,status,published_at,metrics,post_id,social_accounts(display_name,username)")
              .in("post_id", rangePostIds);
            if (targetsError) throw targetsError;
            targets = targetRows ?? [];
          }

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
            clicks: 0,
          });

          const byPlatform: Record<string, any> = {};
          const byFormat: Record<string, any> = {};
          const daily: Record<string, any> = {};

          for (const t of scopedTargets) {
            byPlatform[t.platform] ||= { platform: t.platform, ...emptyMetrics() };
            const platform = byPlatform[t.platform];

            const format = String(t.publication_type || "feed");
            const formatKey = t.platform + ":" + format;
            byFormat[formatKey] ||= { platform: t.platform, format, published: 0, views: 0, likes: 0, comments: 0, reposts: 0 };
            const f = byFormat[formatKey];
            if (t.status === "published") {
              platform.published++;
              f.published++;
            }
            if (t.status === "failed") platform.failed++;
            const m = t.metrics ?? {};
            platform.views += Number(m.views ?? 0);
            platform.likes += Number(m.likes ?? 0);
            platform.comments += Number(m.comments ?? 0);
            platform.reposts += Number(m.reposts ?? 0);
            platform.clicks += Number(m.clicks ?? 0);
            f.views += Number(m.views ?? 0);
            f.likes += Number(m.likes ?? 0);
            f.comments += Number(m.comments ?? 0);
            f.reposts += Number(m.reposts ?? 0);

            if (t.status === "published" && t.published_at) {
              const day = String(t.published_at).slice(0, 10);
              daily[day] ||= { date: day, published: 0, views: 0, likes: 0, comments: 0, reposts: 0, clicks: 0 };
              daily[day].published++;
              daily[day].views += Number(m.views ?? 0);
              daily[day].likes += Number(m.likes ?? 0);
              daily[day].comments += Number(m.comments ?? 0);
              daily[day].reposts += Number(m.reposts ?? 0);
              daily[day].clicks += Number(m.clicks ?? 0);
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
            acc.clicks += item.clicks;
            acc.publishedTargets += item.published;
            acc.failedTargets += item.failed;
            return acc;
          }, { views: 0, likes: 0, comments: 0, reposts: 0, clicks: 0, publishedTargets: 0, failedTargets: 0 });

          const engagement = totals.likes + totals.comments + totals.reposts;
          const ctr = totals.views > 0 ? Number(((totals.clicks / totals.views) * 100).toFixed(2)) : 0;
          const activeDays = Math.max(1, Math.ceil(rangeMs / 86400000));

          const previousPostIds = new Set(
            (posts ?? [])
              .filter((p: any) => {
                const d = new Date(p.scheduled_at || p.created_at).getTime();
                return d >= previousFrom.getTime() && d < previousTo.getTime();
              })
              .map((p: any) => p.id)
          );
          const previousTargets = (targets ?? []).filter((t: any) => previousPostIds.has(t.post_id));
          const previousPublished = previousTargets.filter((t: any) => t.status === "published").length;
          const previousFailed = previousTargets.filter((t: any) => t.status === "failed").length;
          const previousViews = previousTargets.reduce((sum: number, t: any) => sum + Number(t.metrics?.views ?? 0), 0);
          const previousLikes = previousTargets.reduce((sum: number, t: any) => sum + Number(t.metrics?.likes ?? 0), 0);
          const previousComments = previousTargets.reduce((sum: number, t: any) => sum + Number(t.metrics?.comments ?? 0), 0);
          const previousReposts = previousTargets.reduce((sum: number, t: any) => sum + Number(t.metrics?.reposts ?? 0), 0);
          const previousClicks = previousTargets.reduce((sum: number, t: any) => sum + Number(t.metrics?.clicks ?? 0), 0);
          const pctChange = (current: number, previous: number) => previous === 0 ? (current > 0 ? 100 : 0) : Number((((current - previous) / previous) * 100).toFixed(1));

          const topPostMap: Record<string, any> = {};
          for (const target of scopedTargets) {
            if (target.status !== "published") continue;
            const metric = target.metrics ?? {};
            const score = Number(metric.views ?? 0) + Number(metric.likes ?? 0) + Number(metric.comments ?? 0) * 3 + Number(metric.reposts ?? 0) * 4;
            topPostMap[target.post_id] ||= { post_id: target.post_id, views: 0, likes: 0, comments: 0, reposts: 0, clicks: 0, score: 0 };
            const item = topPostMap[target.post_id];
            item.views += Number(metric.views ?? 0);
            item.likes += Number(metric.likes ?? 0);
            item.comments += Number(metric.comments ?? 0);
            item.reposts += Number(metric.reposts ?? 0);
            item.clicks += Number(metric.clicks ?? 0);
            item.score += score;
          }
          const postMap = new Map((posts ?? []).map((p: any) => [p.id, p]));
          const topPosts = Object.values(topPostMap)
            .sort((a: any, b: any) => b.score - a.score)
            .slice(0, 10)
            .map((item: any) => {
              const post = postMap.get(item.post_id) as any;
              const body = String(post?.body ?? "").replace(/\s+/g, " ").trim();
              return { ...item, preview: body.length > 140 ? body.slice(0, 140) + "…" : body || "Без текста" };
            });

          const accountMap: Record<string, any> = {};
          for (const target of scopedTargets) {
            const accountId = String(target.social_account_id || "");
            if (!accountId) continue;
            accountMap[accountId] ||= {
              account_id: accountId,
              platform: target.platform,
              name: target.social_accounts?.display_name || target.social_accounts?.username || target.platform,
              published: 0,
              failed: 0,
              views: 0,
              likes: 0,
              comments: 0,
              reposts: 0,
            };
            const account = accountMap[accountId];
            if (target.status === "published") account.published++;
            if (target.status === "failed") account.failed++;
            account.views += Number(target.metrics?.views ?? 0);
            account.likes += Number(target.metrics?.likes ?? 0);
            account.comments += Number(target.metrics?.comments ?? 0);
            account.reposts += Number(target.metrics?.reposts ?? 0);
          }
          const byAccount = Object.values(accountMap).map((item: any) => ({
            ...item,
            engagement: item.likes + item.comments + item.reposts,
            engagement_rate: item.views > 0 ? Number((((item.likes + item.comments + item.reposts) / item.views) * 100).toFixed(2)) : 0,
            avg_views: item.published > 0 ? Math.round(item.views / item.published) : 0,
            success_rate: item.published + item.failed > 0 ? Number(((item.published / (item.published + item.failed)) * 100).toFixed(1)) : 0,
          })).sort((a: any, b: any) => b.avg_views - a.avg_views).map((item: any, index: number) => ({ ...item, rank: index + 1 }));

          const hourMap: Record<number, { hour: number; published: number; views: number; engagement: number }> = {};
          for (const target of scopedTargets) {
            if (target.status !== "published" || !target.published_at) continue;
            const hour = new Date(target.published_at).getUTCHours();
            hourMap[hour] ||= { hour, published: 0, views: 0, engagement: 0 };
            hourMap[hour].published++;
            hourMap[hour].views += Number(target.metrics?.views ?? 0);
            hourMap[hour].engagement += Number(target.metrics?.likes ?? 0) + Number(target.metrics?.comments ?? 0) + Number(target.metrics?.reposts ?? 0);
          }
          const bestHours = Object.values(hourMap).sort((a: any, b: any) => {
            const ar = a.published ? a.views / a.published : 0;
            const br = b.published ? b.views / b.published : 0;
            return br - ar;
          }).slice(0, 5);

          const formatRows = Object.values(byFormat).map((item: any) => ({
            ...item,
            engagement: Number(item.likes || 0) + Number(item.comments || 0) + Number(item.reposts || 0),
          }));

          const payload = {
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
              clicks: totals.clicks,
              ctr,
              engagement,
              engagement_rate: totals.views > 0 ? Number(((engagement / totals.views) * 100).toFixed(2)) : 0,
              avg_views_per_post: totals.publishedTargets > 0 ? Math.round(totals.views / totals.publishedTargets) : 0,
              avg_engagement_per_post: totals.publishedTargets > 0 ? Number((engagement / totals.publishedTargets).toFixed(2)) : 0,
              success_rate: totals.publishedTargets + totals.failedTargets > 0
                ? Number(((totals.publishedTargets / (totals.publishedTargets + totals.failedTargets)) * 100).toFixed(1))
                : 0,
              publications_per_day: Number((scopedPosts.length / activeDays).toFixed(2)),
              reels: formatRows.filter((x:any) => x.format === "reel").reduce((n:number,x:any)=>n+Number(x.published||0),0),
              clips: formatRows.filter((x:any) => x.format === "clip").reduce((n:number,x:any)=>n+Number(x.published||0),0),
              comparison: {
                posts: pctChange(scopedPosts.length, previousPostIds.size),
                published: pctChange(scopedTargets.filter((t: any) => t.status === "published").length, previousPublished),
                views: pctChange(totals.views, previousViews),
                likes: pctChange(totals.likes, previousLikes),
                comments: pctChange(totals.comments, previousComments),
                reposts: pctChange(totals.reposts, previousReposts),
                clicks: pctChange(totals.clicks, previousClicks),
              },
            },
            by_platform: Object.values(byPlatform),
            by_format: formatRows,
            daily: Object.values(daily).sort((a: any, b: any) => a.date.localeCompare(b.date)),
            top_posts: topPosts,
            best_hours: bestHours,
            by_account: byAccount,
          };
          await ctx.admin.from("stats_cache").upsert({
            workspace_id: ctx.workspace.workspace_id,
            cache_key: cacheKey,
            payload,
            expires_at: new Date(Date.now() + 30000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: "workspace_id,cache_key" });
          return json(payload);
        }
      case "scheduler-health":
        {
          await requirePlatformAdmin(ctx);
          const { data, error } = await ctx.admin.rpc("scheduler_health");
          if (error) throw error;
          return json({ ok: true, ...(data ?? {}) });
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
