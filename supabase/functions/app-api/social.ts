import md5 from "npm:md5@2.3.0";

export type Platform = "telegram" | "vk" | "max" | "ok" | "instagram";
export type Secret = { access_token: string | null; refresh_token?: string | null; client_secret?: string | null };
export type MediaItem = { path: string; name?: string; type?: string; size?: number; order?: number; signed_url?: string };
export type PublicationType = "feed" | "reel" | "story" | "clip";

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

export async function telegramHealth(secret: Secret, externalId?: string, metadata: Record<string, unknown> = {}) {
  if (!secret.access_token) throw new Error("Telegram token не указан");
  const base = `https://api.telegram.org/bot${secret.access_token}`;
  const me = await jsonResponse(`${base}/getMe`);
  const businessConnectionId = typeof metadata.business_connection_id === "string" ? metadata.business_connection_id : "";
  if (businessConnectionId) {
    const connection = await jsonResponse(`${base}/getBusinessConnection?business_connection_id=${encodeURIComponent(businessConnectionId)}`);
    if (!connection.result?.is_enabled) throw new Error("Telegram Business-подключение отключено");
    if (connection.result?.rights?.can_manage_stories !== true) {
      throw new Error("У Telegram Business-бота нет права «Управление историями»");
    }
    return {
      display_name: connection.result?.user?.first_name || connection.result?.user?.username || "Telegram Business",
      username: connection.result?.user?.username ? `@${connection.result.user.username}` : null,
      metadata_patch: { business_connection_id: connection.result.id, business_user_id: String(connection.result.user?.id ?? ""), business_user_chat_id: String(connection.result?.user_chat_id ?? "") },
    };
  }
  if (externalId) {
    const chat = await jsonResponse(`${base}/getChat?chat_id=${encodeURIComponent(externalId)}`);
    return {
      display_name: chat.result?.title || me.result?.first_name || me.result?.username || "Telegram Bot",
      username: chat.result?.username ? `@${chat.result.username}` : (me.result?.username ? `@${me.result.username}` : null),
    };
  }
  return { display_name: me.result?.first_name || me.result?.username || "Telegram Bot", username: me.result?.username ? `@${me.result.username}` : null };
}

export async function telegramPublish(secret: Secret, chatId: string, body: string, media: MediaItem[], publicationType: PublicationType = "feed", metadata: Record<string, unknown> = {}) {
  if (!secret.access_token) throw new Error("Telegram token не указан");
  if (!chatId) throw new Error("Не указан chat_id Telegram");
  const base = `https://api.telegram.org/bot${secret.access_token}`;

  const businessConnectionId = typeof metadata.business_connection_id === "string" ? metadata.business_connection_id : "";
  if (businessConnectionId && publicationType !== "story") {
    throw new Error("Этот Telegram-аккаунт подключён как Business. Для него сейчас доступен только режим «Сторис».");
  }

  if (publicationType === "story") {
    if (!businessConnectionId) {
      throw new Error("Для Telegram Stories подключите Telegram Business и разрешите боту управление историями.");
    }
    if (media.length !== 1) throw new Error("Telegram Story требует ровно один фото- или видеофайл");
    const item = media[0];
    if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
    const isVideo = item.type?.startsWith("video/");
    if (isVideo && (Number(item.size ?? 0) > 30 * 1024 * 1024)) throw new Error("Telegram Story video не должен превышать 30 МБ");
    if (!isVideo && Number(item.size ?? 0) > 10 * 1024 * 1024) throw new Error("Telegram Story фото не должно превышать 10 МБ");
    const content = isVideo
      ? { type: "video", video: "attach://story_file" }
      : { type: "photo", photo: "attach://story_file" };
    if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
    const form = new FormData();
    form.append("business_connection_id", businessConnectionId);
    form.append("content", JSON.stringify(content));
    form.append("active_period", "86400");
    if (body) form.append("caption", body);
    form.append("story_file", await fetchBlob(item.signed_url), item.name || (isVideo ? "story.mp4" : "story.jpg"));
    const result = await uploadMultipart(`${base}/postStory`, form);
    return String(result.result?.id ?? Date.now());
  }

  if (!media.length) {
    const result = await jsonResponse(`${base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body || " " }),
    });
    return String(result.result?.message_id ?? result.result?.date ?? Date.now());
  }

  if (media.length > 10) throw new Error("В одной публикации можно добавить не более 10 медиафайлов");

  if (media.length === 1) {
    const item = media[0];
    if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
    const isVideo = item.type?.startsWith("video/");
    const result = await jsonResponse(`${base}/${isVideo ? "sendVideo" : "sendPhoto"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, [isVideo ? "video" : "photo"]: item.signed_url, caption: body || undefined }),
    });
    return String(result.result?.message_id ?? Date.now());
  }

  const items = media.map((item, index) => {
    if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
    const isVideo = item.type?.startsWith("video/");
    return {
      type: isVideo ? "video" : "photo",
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

async function maxUploadAttachment(secret: Secret, item: MediaItem) {
  if (!secret.access_token) throw new Error("MAX token не указан");
  if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
  const type = item.type?.startsWith("video/") ? "video" : "image";
  const init = await jsonResponse(`https://platform-api2.max.ru/uploads?type=${type}`, {
    method: "POST",
    headers: { Authorization: secret.access_token },
  });
  if (!init.url) throw new Error("MAX не вернул URL загрузки");
  const form = new FormData();
  form.append("data", await fetchBlob(item.signed_url), item.name || (type === "video" ? "video.mp4" : "image.jpg"));
  const upload = await uploadMultipart(init.url, form);
  const token = upload?.token || init.token;
  if (!token) throw new Error("MAX не вернул токен вложения");
  return { type, payload: { token } };
}

export async function maxPublish(secret: Secret, chatId: string, body: string, media: MediaItem[], publicationType: PublicationType = "feed") {
  if (!secret.access_token) throw new Error("MAX token не указан");
  if (!chatId) throw new Error("Не указан chat_id MAX");
  if (publicationType === "story") throw new Error("Stories в MAX API для чат-ботов сейчас не поддерживаются");
  const attachments: any[] = [];
  for (const item of media.slice(0, 10)) {
    attachments.push(await maxUploadAttachment(secret, item));
  }
  if (attachments.length) await new Promise(resolve => setTimeout(resolve, 1200));
  const result = await jsonResponse(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(chatId)}`, {
    method: "POST",
    headers: { Authorization: secret.access_token, "content-type": "application/json" },
    body: JSON.stringify({ text: body || undefined, attachments: attachments.length ? attachments : undefined }),
  });
  return String(result.message?.body?.mid ?? result.message?.mid ?? Date.now());
}

async function vkUploadImages(secret: Secret, ownerId: string, media: MediaItem[], accountType: "community"|"personal") {
  if (!secret.access_token) throw new Error("VK token не указан");
  const attachments: string[] = [];
  for (const item of media.filter(m => m.signed_url)) {
    const uploadParams = new URLSearchParams({ access_token: secret.access_token, v: "5.199" });
    if (accountType === "community") uploadParams.set("group_id", ownerId.replace(/^-/, ""));
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
      server: String(uploaded.server),
      photo: String(uploaded.photo),
      hash: String(uploaded.hash),
    });
    if (accountType === "community") saveParams.set("group_id", ownerId.replace(/^-/, ""));
    else saveParams.set("user_id", ownerId);
    const saved = await jsonResponse(`https://api.vk.com/method/photos.saveWallPhoto?${saveParams.toString()}`);
    const itemSaved = saved.response?.[0];
    if (!itemSaved?.id || !itemSaved?.owner_id) throw new Error("VK не вернул ID сохранённой фотографии");
    attachments.push(`photo${itemSaved.owner_id}_${itemSaved.id}`);
  }
  return attachments;
}

export async function vkHealth(secret: Secret, externalId?: string, metadata: Record<string, unknown> = {}) {
  if (!secret.access_token) throw new Error("VK token не указан");
  const accountType = metadata.vk_account_type === "personal" || metadata.connection_method === "user_token" ? "personal" : "community";
  if (accountType === "personal") {
    const userId = String(externalId || "").trim();
    if (!userId) throw new Error("VK user ID не указан");
    const data = await jsonResponse(`https://api.vk.com/method/users.get?${new URLSearchParams({
      access_token: secret.access_token,
      v: "5.199",
      user_ids: userId,
      fields: "screen_name,photo_200",
    }).toString()}`);
    const user = Array.isArray(data.response) ? data.response[0] : null;
    if (!user?.id) throw new Error("VK не подтвердил личную страницу");
    return {
      display_name: [user.first_name, user.last_name].filter(Boolean).join(" ") || `VK #${user.id}`,
      username: user.screen_name ? `@${user.screen_name}` : null,
      metadata_patch: { vk_account_type: "personal" },
    };
  }
  const groupId = externalId ? String(externalId).replace(/^-/, "") : "";
  const params = new URLSearchParams({ access_token: secret.access_token, v: "5.199" });
  if (groupId) params.set("group_id", groupId);
  const data = await jsonResponse(`https://api.vk.com/method/groups.getById?${params.toString()}`);
  const group = Array.isArray(data.response) ? data.response[0] : data.response?.groups?.[0];
  return { display_name: group?.name || (groupId ? `VK #${groupId}` : "VK"), username: group?.screen_name ? `@${group.screen_name}` : null, metadata_patch: { vk_account_type: "community" } };
}

export async function vkRefreshToken(secret: Secret, metadata: Record<string, unknown> = {}) {
  if (!secret.refresh_token) throw new Error("VK refresh token не указан");
  const clientId = Deno.env.get("VK_ID_APP_ID") ?? "";
  const redirectUri = Deno.env.get("VK_ID_REDIRECT_URI") ?? "";
  const deviceId = typeof metadata.vk_device_id === "string" ? metadata.vk_device_id : "";
  if (!clientId || !redirectUri || !deviceId) {
    throw new Error("VK ID refresh не настроен: нужны VK_ID_APP_ID, VK_ID_REDIRECT_URI и device_id");
  }
  const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, "0")).join("");
  const query = new URLSearchParams({
    grant_type: "refresh_token",
    redirect_uri: redirectUri,
    client_id: clientId,
    device_id: deviceId,
    state,
  });
  const response = await fetch("https://id.vk.ru/oauth2/auth?" + query.toString(), {
    method: "POST",
    body: new URLSearchParams({ refresh_token: secret.refresh_token }),
  });
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok || data?.error) {
    throw new Error(data?.error_description || data?.error || "VK ID не смог обновить токен");
  }
  if (data.state && data.state !== state) throw new Error("VK ID refresh вернул некорректное состояние");
  if (!data.access_token) throw new Error("VK ID refresh не вернул access_token");
  return {
    access_token: String(data.access_token),
    refresh_token: data.refresh_token ? String(data.refresh_token) : secret.refresh_token,
    expires_in: Number(data.expires_in ?? 0),
    user_id: data.user_id ? String(data.user_id) : null,
    scope: data.scope ? String(data.scope) : null,
  };
}

async function vkUploadClip(secret: Secret, ownerId: string, body: string, item: MediaItem, accountType: "community"|"personal") {
  if (!secret.access_token) throw new Error("VK token не указан");
  if (!item.signed_url) throw new Error("У VK-клипа отсутствует ссылка на видео");
  const saveParams = new URLSearchParams({
    access_token: secret.access_token,
    v: "5.199",
    name: item.name || "Клип",
    description: body || "",
    wallpost: "0",
    is_private: "0",
    no_comments: "0",
  });
  if (accountType === "community") saveParams.set("group_id", ownerId.replace(/^-/, ""));
  const saved = await jsonResponse("https://api.vk.com/method/video.save?" + saveParams.toString());
  const response = saved.response ?? {};
  if (!response.upload_url || !response.video_id || response.owner_id === undefined) {
    throw new Error("VK не вернул URL загрузки клипа");
  }
  const form = new FormData();
  form.append("video_file", await fetchBlob(item.signed_url), item.name || "clip.mp4");
  await uploadMultipart(response.upload_url, form);
  return String(response.owner_id) + "_" + String(response.video_id);
}

export async function vkPublish(secret: Secret, ownerId: string, body: string, media: MediaItem[], publicationType: PublicationType = "feed", metadata: Record<string, unknown> = {}) {
  if (!secret.access_token) throw new Error("VK token не указан");
  if (publicationType === "story") throw new Error("VK Stories пока не подключены в этом проекте");
  const accountType = metadata.vk_account_type === "personal" || metadata.connection_method === "user_token" ? "personal" : "community";
  const owner = accountType === "community" ? `-${ownerId.replace(/^-/, "")}` : ownerId.replace(/^-/, "");
  const images = media.filter(m => !m.type?.startsWith("video/"));
  const videos = media.filter(m => m.type?.startsWith("video/"));

  if (publicationType === "clip") {
    if (videos.length !== 1 || media.length !== 1) throw new Error("VK Клип требует ровно один видеофайл");
    return vkUploadClip(secret, owner, body, videos[0], accountType);
  }

  if (videos.length) throw new Error("Для видео VK выберите формат «Клип»");
  const attachments = images.length ? await vkUploadImages(secret, owner, images, accountType) : [];
  const params = new URLSearchParams({
    access_token: secret.access_token,
    v: "5.199",
    owner_id: owner,
    message: body || " ",
  });
  if (accountType === "community") params.set("from_group", "1");
  if (attachments.length) params.set("attachments", attachments.join(","));
  const result = await jsonResponse("https://api.vk.com/method/wall.post?" + params.toString());
  return String(result.response?.post_id ?? Date.now());
}

async function instagramGraph(path: string, init: RequestInit = {}) {
  const version = Deno.env.get("META_GRAPH_VERSION") || "v25.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${path}`, init);
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.error?.error_user_msg || `Instagram API HTTP ${response.status}`);
  }
  return data;
}

export async function instagramHealth(secret: Secret, externalId?: string) {
  if (!secret.access_token) throw new Error("Instagram token не указан");
  const id = externalId || "me";
  const fields = "id,username,name,profile_picture_url,followers_count,media_count,account_type";
  const data = await instagramGraph(`${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(secret.access_token)}`);
  return { display_name: data.name || data.username || "Instagram", username: data.username ? `@${data.username}` : null, external_id: String(data.id || id), metadata_patch: { account_type: data.account_type ?? null } };
}

async function instagramCreateAndPublish(secret: Secret, igUserId: string, body: string, item: MediaItem, publicationType: PublicationType) {
  if (!secret.access_token) throw new Error("Instagram token не указан");
  if (!item.signed_url) throw new Error("Instagram требует доступный URL медиафайла");
  const isVideo = item.type?.startsWith("video/");
  const mediaParams = new URLSearchParams({
    access_token: secret.access_token,
    caption: body || "",
  });

  if (publicationType === "story") {
    if (isVideo) {
      mediaParams.set("video_url", item.signed_url);
      mediaParams.set("media_type", "STORIES");
    } else {
      mediaParams.set("image_url", item.signed_url);
      mediaParams.set("media_type", "STORIES");
    }
  } else if (isVideo) {
    mediaParams.set("video_url", item.signed_url);
    mediaParams.set("media_type", "REELS");
  } else {
    mediaParams.set("image_url", item.signed_url);
  }

  const container = await instagramGraph(`${encodeURIComponent(igUserId)}/media`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: mediaParams.toString(),
  });
  const creationId = container.id;
  if (!creationId) throw new Error("Instagram не вернул creation_id");

  if (isVideo) {
    for (let attempt = 0; attempt < 18; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const status = await instagramGraph(`${encodeURIComponent(creationId)}?fields=status_code,status&access_token=${encodeURIComponent(secret.access_token)}`);
      if (status.status_code === "FINISHED" || status.status === "FINISHED") break;
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw new Error("Instagram не смог подготовить видео");
    }
  }

  const published = await instagramGraph(`${encodeURIComponent(igUserId)}/media_publish`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `creation_id=${encodeURIComponent(creationId)}&access_token=${encodeURIComponent(secret.access_token)}`,
  });
  return String(published.id ?? creationId);
}

export async function instagramPublish(secret: Secret, igUserId: string, body: string, media: MediaItem[], publicationType: PublicationType = "feed", metadata: Record<string, unknown> = {}) {
  if (!media.length) throw new Error("Instagram требует минимум одно изображение или видео");
  if (publicationType === "story") {
    if (String(metadata.account_type || "").toUpperCase() !== "BUSINESS") {
      throw new Error("Instagram Stories доступны только для профессионального Business-аккаунта");
    }
    if (media.length !== 1) throw new Error("Instagram Story требует один файл");
  }
  if (publicationType === "reel" && !media[0]?.type?.startsWith("video/")) {
    throw new Error("Reels требует видеофайл");
  }
  if (media[0]?.type?.startsWith("video/") && publicationType === "feed") {
    throw new Error("Для видео в Instagram выберите Reels или Сторис");
  }
  if (media.length > 1) throw new Error("Instagram-карусель пока будет следующим этапом; публикуйте один файл");
  return instagramCreateAndPublish(secret, igUserId, body, media[0], publicationType);
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

export async function okPublish(secret: Secret, groupId: string, body: string, metadata: Record<string, unknown>, media: MediaItem[], publicationType: PublicationType = "feed") {
  if (publicationType !== "feed") throw new Error("ОК сейчас поддерживает публикации только в ленту");
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


export async function fetchMetrics(platform: Platform, secret: Secret, externalId: string, externalPostId: string, publicationType: PublicationType = "feed", metadata: Record<string, unknown> = {}) {
  if (!externalPostId) return {};
  if (platform === "vk") {
    if (!secret.access_token) throw new Error("VK token не указан");
    const personal = metadata.vk_account_type === "personal" || metadata.connection_method === "user_token";
    const ownerId = personal ? externalId.replace(/^-/, "") : (externalId.startsWith("-") ? externalId : "-" + externalId);
    if (publicationType === "clip") {
      const videoId = String(externalPostId).split("_").pop() || String(externalPostId);
      const data = await jsonResponse("https://api.vk.com/method/video.get?" + new URLSearchParams({
        access_token: secret.access_token,
        v: "5.199",
        videos: String(ownerId) + "_" + videoId,
        count: "1",
      }).toString());
      const video = data.response?.items?.[0] ?? data.response?.[0];
      return {
        views: Number(video?.views ?? video?.views_count ?? 0),
        likes: Number(video?.likes?.count ?? video?.likes ?? 0),
        comments: Number(video?.comments?.count ?? video?.comments ?? 0),
        reposts: Number(video?.reposts?.count ?? video?.reposts ?? 0),
      };
    }
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
  if (platform === "instagram") {
    if (!secret.access_token) throw new Error("Instagram token не указан");
    const media = await instagramGraph(`${encodeURIComponent(externalPostId)}?fields=like_count,comments_count&access_token=${encodeURIComponent(secret.access_token)}`);
    let views = 0;
    let saved = 0;
    let shares = 0;
    try {
      const insights = await instagramGraph(`${encodeURIComponent(externalPostId)}/insights?metric=impressions,reach,plays,saved,shares&access_token=${encodeURIComponent(secret.access_token)}`);
      for (const item of Array.isArray(insights.data) ? insights.data : []) {
        const value = Number(item.values?.[0]?.value ?? 0);
        if (item.name === "impressions" || item.name === "reach" || item.name === "plays") views = Math.max(views, value);
        if (item.name === "saved") saved = value;
        if (item.name === "shares") shares = value;
      }
    } catch {
      // Some media types/accounts expose fewer insight metrics.
    }
    return {
      views,
      likes: Number(media.like_count ?? 0),
      comments: Number(media.comments_count ?? 0),
      reposts: shares,
      saves: saved,
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
    case "telegram": return telegramHealth(secret, externalId, metadata);
    case "vk": return vkHealth(secret, externalId, metadata);
    case "max": return maxHealth(secret, externalId);
    case "ok": return okHealth(secret, metadata);
    case "instagram": return instagramHealth(secret, externalId);
  }
}

export async function publish(platform: Platform, secret: Secret, externalId: string, body: string, media: MediaItem[], metadata: Record<string, unknown>, publicationType: PublicationType = "feed") {
  switch (platform) {
    case "telegram": return telegramPublish(secret, externalId, body, media, publicationType, metadata);
    case "vk": return vkPublish(secret, externalId, body, media, publicationType, metadata);
    case "max": return maxPublish(secret, externalId, body, media, publicationType);
    case "ok": return okPublish(secret, externalId, body, metadata, media, publicationType);
    case "instagram": return instagramPublish(secret, externalId, body, media, publicationType, metadata);
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
  if (metadata.connection_method === "service_bot" || metadata.connection_method === "business_bot") {
    return { items: [] };
  }
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

export async function vkSyncInbox(secret: Secret, externalId: string, publishedTargets: Array<{ external_post_id: string; published_at?: string | null }>, metadata: Record<string, unknown> = {}): Promise<InboxSyncResult> {
  if (!secret.access_token) throw new Error("VK token не указан");
  const personal = metadata.vk_account_type === "personal" || metadata.connection_method === "user_token";
  const ownerId = personal ? externalId.replace(/^-/, "") : (externalId.startsWith("-") ? externalId : "-" + externalId);
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

export async function vkSendInboxReply(secret: Secret, ownerId: string, postId: string, replyToCommentId: string | null, body: string, metadata: Record<string, unknown> = {}) {
  if (!secret.access_token) throw new Error("VK token не указан");
  const personal = metadata.vk_account_type === "personal" || metadata.connection_method === "user_token";
  const params = new URLSearchParams({
    access_token: secret.access_token,
    v: "5.199",
    owner_id: personal ? ownerId.replace(/^-/, "") : (ownerId.startsWith("-") ? ownerId : "-" + ownerId),
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
