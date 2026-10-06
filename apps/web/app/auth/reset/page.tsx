'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '../../../lib/supabase/client';

export default function ResetPasswordPage() {
  const supabase = createClient();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setReady(Boolean(data.session));
      if (!data.session) {
        setMessage('Ссылка для восстановления недействительна или истекла. Запросите новую.');
      }
    });

    return () => {
      active = false;
    };
  }, [supabase]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (password.length < 6) {
      setMessage('Пароль должен содержать минимум 6 символов.');
      return;
    }

    if (password !== confirmation) {
      setMessage('Пароли не совпадают.');
      return;
    }

    setBusy(true);
    setMessage('');

    const { error } = await supabase.auth.updateUser({ password });

    setBusy(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage('Пароль успешно изменён. Сейчас перенаправим вас в кабинет.');
    window.setTimeout(() => router.replace('/'), 900);
  }

  return (
    <main className="shell">
      <section className="auth-card">
        <div className="brand"><span className="brand-mark">S</span><span>SMM Service</span></div>
        <div className="eyebrow">ВОССТАНОВЛЕНИЕ</div>
        <h1>Новый пароль</h1>
        <p className="auth-subtitle">Введите новый пароль для вашего аккаунта.</p>

        <form onSubmit={submit} className="auth-form">
          <label>
            Новый пароль
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              disabled={!ready || busy}
            />
          </label>

          <label>
            Повторите пароль
            <input
              type="password"
              value={confirmation}
              onChange={e => setConfirmation(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              disabled={!ready || busy}
            />
          </label>

          <button className="primary" disabled={!ready || busy}>
            {busy ? 'Сохраняем…' : 'Изменить пароль'}
          </button>
        </form>

        {message && <div className="auth-message">{message}</div>}

        <button type="button" className="auth-switch" onClick={() => router.replace('/auth')}>
          Вернуться ко входу
        </button>
      </section>
    </main>
  );
}
