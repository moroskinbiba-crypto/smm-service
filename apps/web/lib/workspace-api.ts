'use client';

import { createClient } from './supabase/client';

export async function workspaceRequest<T = unknown>(action: string, payload: Record<string, unknown> = {}) {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke('workspace', {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error || 'Не удалось выполнить действие');
  return data as T;
}
