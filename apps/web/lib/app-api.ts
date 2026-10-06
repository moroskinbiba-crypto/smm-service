'use client';

import { createClient } from './supabase/client';

export type ApiPost = {
  id: string;
  body: string;
  media: Array<{ path: string; name?: string; type?: string; size?: number; order?: number; signed_url?: string | null }>;
  status: string;
  scheduled_at: string | null;
  created_at: string;
  post_targets: Array<{
    id: string;
    social_account_id: string;
    platform: string;
    status: string;
    last_error: string | null;
    published_at: string | null;
    metrics: Record<string, number>;
    external_post_id: string | null;
    social_accounts?: { display_name: string | null; username: string | null; status: string };
  }>;
};

export type SocialAccount = {
  id: string;
  platform: 'telegram' | 'vk' | 'max' | 'ok' | 'instagram';
  external_id: string;
  display_name: string | null;
  username: string | null;
  token_expires_at: string | null;
  status: 'pending' | 'connected' | 'expired' | 'error' | 'disabled';
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function appRequest<T = unknown>(action: string, payload: Record<string, unknown> = {}) {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke('app-api', {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error || 'Не удалось выполнить действие');
  return data as T;
}

export async function uploadMedia(workspaceId: string, file: File) {
  const supabase = createClient();
  if (!/^image\/(jpeg|png|webp|gif|avif)|video\/(mp4|webm|quicktime)$/.test(file.type)) {
    throw new Error('Поддерживаются JPG, PNG, WebP, GIF, AVIF, MP4, WebM и MOV');
  }
  if (file.size > 50 * 1024 * 1024) {
    throw new Error('Размер файла не должен превышать 50 МБ');
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9а-яА-Я._-]+/g, '_');
  const path = `${workspaceId}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from('media').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return { path, name: file.name, type: file.type, size: file.size };
}
