'use client';

import { useState } from 'react';
import { createClient } from '../../../lib/supabase/client';

export default function InviteAccept({ token }: { token: string }) {
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [accepted, setAccepted] = useState(false);

  async function accept() {
    setBusy(true);
    setMessage('');
    const { data, error } = await supabase.rpc('accept_workspace_invite', { p_token: token });
    if (error) {
      setMessage(error.message);
      setBusy(false);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      setAccepted(true);
      window.setTimeout(() => window.location.assign('/'), 600);
    }
    setBusy(false);
  }

  return (
    <section className="auth-card invite-card">
      <div className="brand"><span className="brand-mark">S</span><span>SMM Service</span></div>
      <div className="eyebrow">ПРИГЛАШЕНИЕ</div>
      <h1>{accepted ? 'Готово' : 'Войти в команду'}</h1>
      <p className="auth-subtitle">{accepted ? 'Вы добавлены в рабочее пространство. Перенаправляем в кабинет…' : 'Вас пригласили работать с публикациями в SMM Service.'}</p>
      {!accepted && <button className="primary" disabled={busy} onClick={accept}>{busy ? 'Проверяем…' : 'Принять приглашение'}</button>}
      {message && <div className="auth-message">{message}</div>}
    </section>
  );
}
