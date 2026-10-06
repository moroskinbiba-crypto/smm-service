import md5 from "npm:md5@2.3.0";

export type Platform = "telegram" | "vk" | "max" | "ok";
export type Secret = { access_token: string | null; refresh_token?: string | null; client_secret?: string | null };
export type MediaItem = { path: string; name?: string; type?: string; size?: number; order?: number; signed_url?: string };

async function jsonResponse(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  let body: any = null;
  try { body = await response.json(); } catch { body = { raw: await response.text() }; }
  if (!response.ok || (body && body.ok === false)) {
    throw new Error(body?.description || body?.error_msg || body?.error || `HTTP ${response.status}`);
  }
  return body;
}

export async function telegramHealth(secret: Secret, externalId?: string) {
  if (!secret.access_token) throw new Error("Telegram token не указан");
  const me = await jsonResponse(`https://api.telegram.org/bot${secret.access_token}/getMe`);
  if (externalId) {
    await jsonResponse(`https://api.telegram.org/bot${secret.access_token}/getChat?chat_id=${encodeURIComponent(externalId)}`);
  }
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
  const me = await jsonResponse("https://platform-api2.max.ru/me", {
    headers: { Authorization: secret.access_token },
  });
  return { display_name: me.name || me.first_name || "MAX Bot", username: me.username ? `@${me.username}` : null, external_id: me.user_id ? String(me.user_id) : undefined };
}

export async function maxPublish(secret: Secret, chatId: string, body: string, media: MediaItem[]) {
  if (!secret.access_token) throw new Error("MAX token не указан");
  if (!chatId) throw new Error("Не указан chat_id MAX");
  const attachments = media.filter(m => m.signed_url).slice(0, 1).map(m => ({
    type: "image",
    payload: { url: m.signed_url },
  }));
  const result = await jsonResponse(`https://platform-api2.max.ru/messages?chat_id=${encodeURIComponent(chatId)}`, {
    method: "POST",
    headers: { Authorization: secret.access_token, "content-type": "application/json" },
    body: JSON.stringify({ text: body || undefined, attachments: attachments.length ? attachments : undefined }),
  });
  return String(result.message?.body?.mid ?? result.message?.mid ?? Date.now());
}

export async function vkHealth(secret: Secret, externalId?: string) {
  if (!secret.access_token) throw new Error("VK token не указан");
  const groupId = externalId ? String(externalId).replace(/^-/,"") : "";
  const params = new URLSearchParams({ access_token: secret.access_token, v: "5.199" });
  if (groupId) params.set("group_id", groupId);
  const data = await jsonResponse(`https://api.vk.com/method/groups.getById?${params.toString()}`);
  const group = Array.isArray(data.response) ? data.response[0] : data.response?.groups?.[0];
  return { display_name: group?.name || (groupId ? `VK #${groupId}` : "VK"), username: group?.screen_name ? `@${group.screen_name}` : null };
}

export async function vkPublish(secret: Secret, ownerId: string, body: string, media: MediaItem[]) {
  if (!secret.access_token) throw new Error("VK token не указан");
  if (media.length) throw new Error("VK: публикация фото будет подключена после настройки upload-адаптера; текстовая публикация уже готова.");
  const params = new URLSearchParams({
    access_token: secret.access_token,
    v: "5.199",
    owner_id: ownerId.startsWith("-") ? ownerId : `-${ownerId}`,
    message: body || " ",
  });
  const result = await jsonResponse(`https://api.vk.com/method/wall.post?${params.toString()}`);
  return String(result.response?.post_id ?? Date.now());
}

function okSignature(params: Record<string, string>, accessToken: string, appSecret: string) {
  const sorted = Object.entries(params).filter(([k]) => k !== "access_token").sort(([a], [b]) => a.localeCompare(b));
  const sessionSecret = md5(accessToken + appSecret);
  const query = sorted.map(([k, v]) => `${k}=${v}`).join("");
  return md5(query + sessionSecret);
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
  if (media.length) throw new Error("ОК: текстовая публикация готова; загрузку изображений подключим отдельным upload-шагом.");
  const attachment = JSON.stringify({ media: [{ type: "text", text: body || " " }] });
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
