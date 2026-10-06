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
  let firstId: string | null = null;
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (!item.signed_url) throw new Error("У медиафайла отсутствует ссылка");
    const result = await jsonResponse(`${base}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: item.signed_url, caption: i === 0 ? body : undefined }),
    });
    if (!firstId) firstId = String(result.result?.message_id ?? Date.now());
  }
  return firstId ?? String(Date.now());
}

export async function maxHealth(secret: Secret) {
  if (!secret.access_token) throw new Error("MAX token не указан");
  const me = await jsonResponse("https://platform-api2.max.ru/me", { headers: { Authorization: secret.access_token } });
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

export async function healthcheck(platform: Platform, secret: Secret, externalId: string, metadata: Record<string, unknown>) {
  switch (platform) {
    case "telegram": return telegramHealth(secret, externalId);
    case "vk": return vkHealth(secret, externalId);
    case "max": return maxHealth(secret);
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
