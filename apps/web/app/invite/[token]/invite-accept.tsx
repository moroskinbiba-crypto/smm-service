'use client';

import { useState } from 'react';
import { workspaceRequest } from '../../../lib/workspace-api';

export default function InviteAccept({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [accepted, setAccepted] = useState(false);

  async function accept() {
    setBusy(true); setMessage('');
    try {
      const result = await workspaceRequest<{ workspace?: unknown }>('accept-invite', { token });
      if (result.workspace) {
        setAccepted(true);
        window.setTimeout(() => window.location.assign('/'), 600);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось принять приглашение');
    } finally {
      setBusy(false);
    }
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
