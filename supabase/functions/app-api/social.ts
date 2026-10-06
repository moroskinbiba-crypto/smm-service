import md5 from "npm:md5@2.3.0";

export type Platform = "telegram" | "vk" | "max" | "ok";
export type Secret = { access_token: string | null; refresh_token?: string | null; client_secret?: string | null };
export type MediaItem = { path: string; name?: string; type?: string; size?: number; order?: number; signed_url?: string };

async function jsonResponse(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  let body: any = null;
  const textBody = await response.text();
  try { body = textBody ? JSON.parse(textBody) : {}; } catch { body = { raw: textBody }; }
  if (!response.ok || body?.ok === false || body?.error || body?.error_code) {
    throw new Error(body?.description || body?.error_msg || body?.error?.error_msg || body?.error_message || body?.error || body?.message || `HTTP ${response.status}`);
  }
  return body;
}

async function fetchBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось загрузить медиа: HTTP ${response.status}`);
  return response.blob();
}

async function uploadMultipart(url: string, form: FormData) {
  const response = await fetch(url, { method: "POST", body: form });
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!response.ok || body?.error || body?.error_code) {
    throw new Error(body?.error?.error_msg || body?.error_msg || body?.error_message || body?.message || `HTTP ${response.status}`);
  }
  return body;
}

export async function telegramHealth(secret: Secret, externalId?: string) {
  if (!secret.access_token) throw new Error("Telegram token не указан");
  const me = await jsonResponse(`https://api.telegram.org/bot${secret.access_token}/getMe`);
  if (externalId) await jsonResponse(`https://api.telegram.org/bot${secret.access_token}/getChat?chat_id=${encodeURIComponent(externalId)}`);
  return { display_name: me.result?.first_name || me.result?.username || "Telegram Bot", username: me.result?.username ? `@${me.result.username}` : null };
}

export async function telegramPublish(secret: Secret, chatId: string, body: string, media: MediaItem[]) {
  if (!secret.access_token) throw new Error("Telegram token не указан");
  if (!chatId) throw new Error("Не указан chat_id Telegram");
  const base = `https://api.telegram.org/bot${secret.access_token}`;
  if (!media.length) {
    const result = await jsonResponse(`${base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body || " " }),
    });
    return String(result.result?.message_id ?? result.result?.date ?? Date.now());
  }
  if (media.length > 10) throw new Error("В одной публикации можно добавить не более 10 фото");
  if (media.length === 1) {
    const item = media[0];
    if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
    const result = await jsonResponse(`${base}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: item.signed_url, caption: body || undefined }),
    });
    return String(result.result?.message_id ?? Date.now());
  }
  const items = media.map((item, index) => {
    if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
    return {
      type: "photo",
      media: item.signed_url,
      ...(index === 0 && body ? { caption: body } : {}),
    };
  });
  const result = await jsonResponse(`${base}/sendMediaGroup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, media: items }),
  });
  const first = Array.isArray(result.result) ? result.result[0] : null;
  return String(first?.message_id ?? Date.now());
}

export async function maxHealth(secret: Secret, externalId?: string) {
  if (!secret.access_token) throw new Error("MAX token не указан");
  const me = await jsonResponse("https://platform-api2.max.ru/me", { headers: { Authorization: secret.access_token } });
  if (externalId) await jsonResponse("https://platform-api2.max.ru/chats/" + encodeURIComponent(externalId), { headers: { Authorization: secret.access_token } });
  return { display_name: me.name || me.first_name || "MAX Bot", username: me.username ? `@${me.username}` : null, external_id: me.user_id ? String(me.user_id) : undefined };
}

export async function maxPublish(secret: Secret, chatId: string, body: string, media: MediaItem[]) {
  if (!secret.access_token) throw new Error("MAX token не указан");
  if (!chatId) throw new Error("Не указан chat_id MAX");
  const attachments = media.filter(m => m.signed_url).map(m => ({ type: "image", payload: { url: m.signed_url } }));
  const result = await jsonResponse(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(chatId)}`, {
    method: "POST",
    headers: { Authorization: secret.access_token, "content-type": "application/json" },
    body: JSON.stringify({ text: body || undefined, attachments: attachments.length ? attachments : undefined }),
  });
  return String(result.message?.body?.mid ?? result.message?.mid ?? Date.now());
}

async function vkUploadImages(secret: Secret, groupId: string, media: MediaItem[]) {
  if (!secret.access_token) throw new Error("VK token не указан");
  const attachments: string[] = [];
  for (const item of media.filter(m => m.signed_url)) {
    const uploadParams = new URLSearchParams({ access_token: secret.access_token, v: "5.199", group_id: groupId.replace(/^-/, "") });
    const server = await jsonResponse(`https://api.vk.com/method/photos.getWallUploadServer?${uploadParams.toString()}`);
    const uploadUrl = server.response?.upload_url;
    if (!uploadUrl) throw new Error("VK не вернул upload_url");
    const form = new FormData();
    form.append("photo", await fetchBlob(item.signed_url!), item.name || "image");
    const uploaded = await uploadMultipart(uploadUrl, form);
    if (!uploaded.server || !uploaded.photo || !uploaded.hash) throw new Error("VK вернул неполные данные загрузки");
    const saveParams = new URLSearchParams({
      access_token: secret.access_token,
      v: "5.199",
      group_id: groupId.replace(/^-/, ""),
      server: String(uploaded.server),
      photo: String(uploaded.photo),
      hash: String(uploaded.hash),
    });
    const saved = await jsonResponse(`https://api.vk.com/method/photos.saveWallPhoto?${saveParams.toString()}`);
    const itemSaved = saved.response?.[0];
    if (!itemSaved?.id || !itemSaved?.owner_id) throw new Error("VK не вернул ID сохранённой фотографии");
    attachments.push(`photo${itemSaved.owner_id}_${itemSaved.id}`);
  }
  return attachments;
}

export async function vkHealth(secret: Secret, externalId?: string) {
  if (!secret.access_token) throw new Error("VK token не указан");
  const groupId = externalId ? String(externalId).replace(/^-/, "") : "";
  const params = new URLSearchParams({ access_token: secret.access_token, v: "5.199" });
  if (groupId) params.set("group_id", groupId);
  const data = await jsonResponse(`https://api.vk.com/method/groups.getById?${params.toString()}`);
  const group = Array.isArray(data.response) ? data.response[0] : data.response?.groups?.[0];
  return { display_name: group?.name || (groupId ? `VK #${groupId}` : "VK"), username: group?.screen_name ? `@${group.screen_name}` : null };
}

export async function vkPublish(secret: Secret, ownerId: string, body: string, media: MediaItem[]) {
  if (!secret.access_token) throw new Error("VK token не указан");
  const cleanGroupId = ownerId.replace(/^-/, "");
  const attachments = media.length ? await vkUploadImages(secret, cleanGroupId, media) : [];
  const params = new URLSearchParams({
    access_token: secret.access_token,
    v: "5.199",
    owner_id: ownerId.startsWith("-") ? ownerId : `-${ownerId}`,
    message: body || " ",
  });
  if (attachments.length) params.set("attachments", attachments.join(","));
  const result = await jsonResponse(`https://api.vk.com/method/wall.post?${params.toString()}`);
  return String(result.response?.post_id ?? Date.now());
}

function okSignature(params: Record<string, string>, accessToken: string, appSecret: string) {
  const sorted = Object.entries(params).filter(([k]) => k !== "access_token").sort(([a], [b]) => a.localeCompare(b));
  const sessionSecret = md5(accessToken + appSecret);
  const query = sorted.map(([k, v]) => `${k}=${v}`).join("");
  return md5(query + sessionSecret);
}

async function okUploadPhotos(accessToken: string, appKey: string, appSecret: string, groupId: string, media: MediaItem[]) {
  const images = media.filter(m => m.signed_url);
  if (!images.length) return [];
  const sizes = images.map(m => String(m.size ?? 0)).join(",");
  const params: Record<string,string> = {
    application_key: appKey,
    format: "json",
    method: "photosV2.getUploadUrl",
    access_token: accessToken,
    gid: groupId,
    count: String(images.length),
  };
  if (sizes) params.sizes = sizes;
  params.sig = okSignature(params, accessToken, appSecret);
  const info = await jsonResponse("https://api.ok.ru/fb.do?" + new URLSearchParams(params).toString());
  if (!info.upload_url || !Array.isArray(info.photo_ids)) throw new Error("ОК не вернул upload_url/photo_ids");
  const form = new FormData();
  for (let i = 0; i < images.length; i++) {
    form.append(`pic${i + 1}`, await fetchBlob(images[i].signed_url!), images[i].name || `image-${i + 1}.jpg`);
  }
  await uploadMultipart(info.upload_url, form);
  return info.photo_ids;
}

export async function okHealth(secret: Secret, metadata: Record<string, unknown>) {
  const accessToken = secret.access_token;
  const appKey = typeof metadata.application_key === "string" ? metadata.application_key : "";
  const appSecret = secret.client_secret || "";
  if (!accessToken || !appKey || !appSecret) throw new Error("Для ОК нужны access_token, application_key и application_secret");
  const params: Record<string,string> = { application_key: appKey, format: "json", method: "users.getCurrentUser", access_token: accessToken };
  params.sig = okSignature(params, accessToken, appSecret);
  const data = await jsonResponse("https://api.ok.ru/fb.do?" + new URLSearchParams(params).toString());
  return { display_name: data.name || "Одноклассники", username: data.uid ? `id${data.uid}` : null, external_id: typeof metadata.group_id === "string" ? metadata.group_id : undefined };
}

export async function okPublish(secret: Secret, groupId: string, body: string, metadata: Record<string, unknown>, media: MediaItem[]) {
  const accessToken = secret.access_token;
  const appKey = typeof metadata.application_key === "string" ? metadata.application_key : "";
  const appSecret = secret.client_secret || "";
  if (!accessToken || !appKey || !appSecret) throw new Error("Для ОК нужны access_token, application_key и application_secret");
  const photoIds = media.length ? await okUploadPhotos(accessToken, appKey, appSecret, groupId, media) : [];
  const mediaBlocks: any[] = [];
  if (body) mediaBlocks.push({ type: "text", text: body });
  if (photoIds.length) mediaBlocks.push({ type: "photo", list: photoIds.map((id: string) => ({ id })) });
  if (!mediaBlocks.length) mediaBlocks.push({ type: "text", text: " " });

  const attachment = JSON.stringify({ media: mediaBlocks });
  const params: Record<string,string> = {
    application_key: appKey,
    format: "json",
    method: "mediatopic.post",
    access_token: accessToken,
    attachment,
    type: "GROUP_THEME",
    gid: groupId,
  };
  params.sig = okSignature(params, accessToken, appSecret);
  const data = await jsonResponse("https://api.ok.ru/fb.do?" + new URLSearchParams(params).toString());
  return String(data);
}


export async function fetchMetrics(platform: Platform, secret: Secret, externalId: string, externalPostId: string) {
  if (!externalPostId) return {};
  if (platform === "vk") {
    if (!secret.access_token) throw new Error("VK token не указан");
    const ownerId = externalId.startsWith("-") ? externalId : "-" + externalId;
    const params = new URLSearchParams({
      access_token: secret.access_token,
      v: "5.199",
      posts: ownerId + "_" + externalPostId,
    });
    const data = await jsonResponse("https://api.vk.com/method/wall.getById?" + params.toString());
    const post = data.response?.[0];
    return {
      views: Number(post?.views?.count ?? 0),
      likes: Number(post?.likes?.count ?? 0),
      comments: Number(post?.comments?.count ?? 0),
      reposts: Number(post?.reposts?.count ?? 0),
    };
  }
  if (platform === "max") {
    if (!secret.access_token) throw new Error("MAX token не указан");
    const data = await jsonResponse("https://platform-api2.max.ru/messages/" + encodeURIComponent(externalPostId), {
      headers: { Authorization: secret.access_token },
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

export async function healthcheck(platform: Platform, secret: Secret, externalId: string, metadata: Record<string, unknown>) {
  switch (platform) {
    case "telegram": return telegramHealth(secret, externalId);
    case "vk": return vkHealth(secret, externalId);
    case "max": return maxHealth(secret, externalId);
    case "ok": return okHealth(secret, metadata);
  }
}

export async function publish(platform: Platform, secret: Secret, externalId: string, body: string, media: MediaItem[], metadata: Record<string, unknown>) {
  switch (platform) {
    case "telegram": return telegramPublish(secret, externalId, body, media);
    case "vk": return vkPublish(secret, externalId, body, media);
    case "max": return maxPublish(secret, externalId, body, media);
    case "ok": return okPublish(secret, externalId, body, metadata, media);
  }
}


export type InboxItem = {
  external_thread_id: string;
  external_message_id: string;
  thread_type: "message" | "comment";
  message_type: "message" | "comment";
  author_name: string | null;
  author_external_id: string | null;
  body: string;
  parent_external_id?: string | null;
  sent_at: string;
  subject?: string | null;
  participant_name?: string | null;
  participant_external_id?: string | null;
  post_target_external_id?: string | null;
  metadata?: Record<string, unknown>;
};

export type InboxSyncResult = {
  items: InboxItem[];
  metadata_patch?: Record<string, unknown>;
};

function isoFromUnix(value: unknown) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n > 10_000_000_000 ? n : n * 1000).toISOString();
}

export async function telegramSyncInbox(secret: Secret, metadata: Record<string, unknown>): Promise<InboxSyncResult> {
  if (!secret.access_token) throw new Error("Telegram token не указан");
  const base = `https://api.telegram.org/bot${secret.access_token}`;
  const offset = Number(metadata.inbox_update_offset ?? 0);
  const params = new URLSearchParams();
  if (offset > 0) params.set("offset", String(offset));
  params.set("limit", "100");
  params.set("timeout", "1");
  params.set("allowed_updates", JSON.stringify(["message", "edited_message"]));
  const result = await jsonResponse(`${base}/getUpdates?${params.toString()}`);
  const updates = Array.isArray(result.result) ? result.result : [];
  const items: InboxItem[] = [];
  let nextOffset = offset;

  for (const update of updates) {
    const message = update?.message ?? update?.edited_message;
    nextOffset = Math.max(nextOffset, Number(update?.update_id ?? 0) + 1);
    if (!message?.message_id || !message?.chat?.id) continue;
    if (!message?.from?.id) continue;
    if (!message?.text && !message?.caption) continue;
    items.push({
      external_thread_id: String(message.chat.id),
      external_message_id: `tg:${update.update_id}:${message.message_id}`,
      thread_type: "message",
      message_type: "message",
      author_name: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || message.from.username || String(message.from.id),
      author_external_id: String(message.from.id),
      body: String(message.text ?? message.caption ?? ""),
      sent_at: isoFromUnix(message.date),
      subject: message.chat.title || message.chat.username || String(message.chat.id),
      participant_name: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || message.from.username || String(message.from.id),
      participant_external_id: String(message.from.id),
      metadata: { chat_type: message.chat.type, chat_title: message.chat.title ?? null, telegram_update_id: update.update_id, telegram_message_id: message.message_id },
    });
  }

  return { items, metadata_patch: { inbox_update_offset: nextOffset } };
}

export async function telegramSendInboxReply(secret: Secret, threadId: string, body: string) {
  if (!secret.access_token) throw new Error("Telegram token не указан");
  if (!threadId) throw new Error("Не указан chat_id Telegram");
  const base = `https://api.telegram.org/bot${secret.access_token}`;
  const result = await jsonResponse(`${base}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: threadId, text: body }),
  });
  return {
    external_message_id: `tg-out:${result.result?.message_id ?? Date.now()}`,
    sent_at: isoFromUnix(result.result?.date),
  };
}

export async function vkSyncInbox(secret: Secret, externalId: string, publishedTargets: Array<{ external_post_id: string; published_at?: string | null }>): Promise<InboxSyncResult> {
  if (!secret.access_token) throw new Error("VK token не указан");
  const ownerId = externalId.startsWith("-") ? externalId : "-" + externalId;
  const items: InboxItem[] = [];

  for (const target of publishedTargets.slice(-30)) {
    if (!target.external_post_id) continue;
    const params = new URLSearchParams({
      access_token: secret.access_token,
      v: "5.199",
      owner_id: ownerId,
      post_id: target.external_post_id,
      need_likes: "0",
      extended: "1",
      count: "100",
    });
    const data = await jsonResponse("https://api.vk.com/method/wall.getComments?" + params.toString());
    const response = data.response ?? {};
    const comments = Array.isArray(response.items) ? response.items : [];
    const profiles = Array.isArray(response.profiles) ? response.profiles : [];
    const profileMap = new Map<number, any>(profiles.map((p: any) => [Number(p.id), p]));

    for (const comment of comments) {
      if (!comment?.id || !comment?.from_id) continue;
      const profile = profileMap.get(Number(comment.from_id));
      const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || String(comment.from_id);
      items.push({
        external_thread_id: `vk:${ownerId}:${target.external_post_id}`,
        external_message_id: `vk:${ownerId}:${target.external_post_id}:${comment.id}`,
        thread_type: "comment",
        message_type: "comment",
        author_name: name,
        author_external_id: String(comment.from_id),
        body: String(comment.text ?? ""),
        parent_external_id: comment.reply_to_comment ? String(comment.reply_to_comment) : null,
        sent_at: isoFromUnix(comment.date),
        subject: `VK #${target.external_post_id}`,
        participant_name: name,
        participant_external_id: String(comment.from_id),
        post_target_external_id: target.external_post_id,
        metadata: { vk_comment_id: comment.id, vk_owner_id: Number(ownerId), vk_post_id: Number(target.external_post_id), can_reply: true },
      });
    }
  }

  return { items };
}

export async function vkSendInboxReply(secret: Secret, ownerId: string, postId: string, replyToCommentId: string | null, body: string) {
  if (!secret.access_token) throw new Error("VK token не указан");
  const params = new URLSearchParams({
    access_token: secret.access_token,
    v: "5.199",
    owner_id: ownerId.startsWith("-") ? ownerId : "-" + ownerId,
    post_id: postId,
    message: body,
  });
  if (replyToCommentId) params.set("reply_to_comment", replyToCommentId);
  const data = await jsonResponse("https://api.vk.com/method/wall.createComment?" + params.toString());
  const commentId = data.response?.comment_id ?? Date.now();
  return {
    external_message_id: `vk-out:${ownerId}:${postId}:${commentId}`,
    sent_at: new Date().toISOString(),
    external_comment_id: String(commentId),
  };
}

export async function maxSyncInbox(secret: Secret, externalId: string, publishedTargets: Array<{ external_post_id: string; published_at?: string | null }>): Promise<InboxSyncResult> {
  if (!secret.access_token) throw new Error("MAX token не указан");
  const headers = { Authorization: secret.access_token };
  const me = await jsonResponse("https://platform-api2.max.ru/me", { headers });
  const botId = String(me.user_id ?? "");
  const items: InboxItem[] = [];

  if (externalId) {
    const data = await jsonResponse(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(externalId)}`, { headers });
    const messages = Array.isArray(data.messages) ? data.messages : Array.isArray(data) ? data : [];
    for (const message of messages.slice(-100)) {
      const senderId = String(message?.sender?.user_id ?? "");
      if (!message?.body?.text && !message?.body?.attachments) continue;
      if (senderId && senderId === botId) continue;
      const text = String(message?.body?.text ?? "");
      if (!text) continue;
      const author = message?.sender?.name || message?.sender?.username || senderId || "Пользователь";
      items.push({
        external_thread_id: String(externalId),
        external_message_id: `max:${message.id ?? message.mid}`,
        thread_type: "message",
        message_type: "message",
        author_name: author,
        author_external_id: senderId || null,
        body: text,
        sent_at: isoFromUnix(message.timestamp),
        subject: message?.recipient?.title || String(externalId),
        participant_name: author,
        participant_external_id: senderId || null,
        metadata: { max_message_id: message.id ?? message.mid, max_chat_id: externalId },
      });
    }
  }

  for (const target of publishedTargets.slice(-20)) {
    if (!target.external_post_id) continue;
    try {
      const data = await jsonResponse(`https://platform-api2.max.ru/messages/${encodeURIComponent(target.external_post_id)}/comments`, { headers });
      const comments = Array.isArray(data.comments) ? data.comments : Array.isArray(data.messages) ? data.messages : [];
      for (const comment of comments) {
        const senderId = String(comment?.sender?.user_id ?? "");
        if (senderId && senderId === botId) continue;
        const text = String(comment?.body?.text ?? comment?.text ?? "");
        if (!text) continue;
        const author = comment?.sender?.name || comment?.sender?.username || senderId || "Пользователь";
        items.push({
          external_thread_id: `max-comment:${target.external_post_id}`,
          external_message_id: `max-comment:${comment.id ?? comment.mid}`,
          thread_type: "comment",
          message_type: "comment",
          author_name: author,
          author_external_id: senderId || null,
          body: text,
          sent_at: isoFromUnix(comment.timestamp),
          subject: `MAX ${target.external_post_id}`,
          participant_name: author,
          participant_external_id: senderId || null,
          post_target_external_id: target.external_post_id,
          metadata: { max_comment_id: comment.id ?? comment.mid, max_post_id: target.external_post_id },
        });
      }
    } catch {
      // Some MAX accounts are chats without channel comments. Keep the inbox usable.
    }
  }

  return { items };
}

export async function maxSendInboxReply(secret: Secret, threadId: string, body: string, messageType: "message" | "comment", postId?: string | null) {
  if (!secret.access_token) throw new Error("MAX token не указан");
  const headers = { Authorization: secret.access_token, "content-type": "application/json" };

  if (messageType === "comment" && postId) {
    const data = await jsonResponse(`https://platform-api2.max.ru/messages/${encodeURIComponent(postId)}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: body }),
    });
    return { external_message_id: `max-out-comment:${data.message?.id ?? data.message?.mid ?? Date.now()}`, sent_at: isoFromUnix(data.message?.timestamp), post_id: postId };
  }

  const data = await jsonResponse(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(threadId)}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: body }),
  });
  return { external_message_id: `max-out:${data.message?.body?.mid ?? data.message?.mid ?? Date.now()}`, sent_at: isoFromUnix(data.message?.timestamp) };
}

export async function okSyncInbox(secret: Secret, metadata: Record<string, unknown>): Promise<InboxSyncResult> {
  const accessToken = secret.access_token;
  const chatId = typeof metadata.inbox_chat_id === "string" ? metadata.inbox_chat_id : "";
  if (!accessToken || !chatId) return { items: [] };

  const data = await jsonResponse("https://api.ok.ru/graph/" + encodeURIComponent(chatId) + "/messages?access_token=" + encodeURIComponent(accessToken) + "&count=50");
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const items: InboxItem[] = [];
  for (const message of messages) {
    const authorId = message?.sender?.user_id ? String(message.sender.user_id) : null;
    const body = String(message?.text ?? "");
    if (!body) continue;
    const author = String(message?.sender?.name ?? authorId ?? "Пользователь");
    items.push({
      external_thread_id: chatId,
      external_message_id: `ok:${message?.mid ?? message?.message_id ?? Date.now()}`,
      thread_type: "message",
      message_type: "message",
      author_name: author,
      author_external_id: authorId,
      body,
      sent_at: isoFromUnix(message?.timestamp),
      subject: chatId,
      participant_name: author,
      participant_external_id: authorId,
      metadata: { ok_message_id: message?.mid ?? message?.message_id, ok_chat_id: chatId },
    });
  }
  return { items };
}

export async function okSendInboxReply(secret: Secret, threadId: string, body: string) {
  const accessToken = secret.access_token;
  if (!accessToken) throw new Error("ОК token не указан");
  const data = await jsonResponse("https://api.ok.ru/graph/" + encodeURIComponent(threadId) + "/messages?access_token=" + encodeURIComponent(accessToken), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: { chat_id: threadId }, message: { text: body } }),
  });
  return { external_message_id: `ok-out:${data.mid ?? data.message?.mid ?? Date.now()}`, sent_at: new Date().toISOString() };
}
