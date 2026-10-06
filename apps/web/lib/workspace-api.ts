'use client';

import { createClient } from './supabase/client';

export async function workspaceRequest<T = unknown>(action: string, payload: Record<string, unknown> = {}) {
  const supabase = createClient();
  const workspaceId = typeof window !== 'undefined' ? window.localStorage.getItem('smm-workspace-id') || '' : '';
  const { data, error } = await supabase.functions.invoke('workspace', {
    body: { action, ...payload },
    headers: workspaceId ? { 'x-workspace-id': workspaceId } : undefined,
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error || 'Не удалось выполнить действие');
  return data as T;
}
