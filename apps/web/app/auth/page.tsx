'use client';

import { FormEvent, useState } from 'react';
import { createClient } from '../../lib/supabase/client';

export default function AuthPage() {
  const supabase = createClient();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  function getNext() {
    const next = new URLSearchParams(window.location.search).get('next');
    return next && next.startsWith('/') ? next : '/';
  }

  async function sendPasswordReset() {
    setRecoveryBusy(true);
    setMessage('');

    const redirectTo = window.location.origin + '/auth/callback?next=' + encodeURIComponent('/auth/reset');
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

    setRecoveryBusy(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage('Если аккаунт с таким email существует, мы отправили письмо со ссылкой для восстановления пароля.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const next = getNext();

    const result = mode === 'login'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + '/auth/callback?next=' + encodeURIComponent(next) },
        });

    setBusy(false);

    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    if (mode === 'signup') {
      setMessage('Регистрация создана. Проверьте почту, чтобы подтвердить email.');
      return;
    }

    window.location.assign(next);
  }

  return (
    <main className="shell">
      <section className="auth-card">
        <div className="brand"><span className="brand-mark">S</span><span>SMM Service</span></div>
        <div className="eyebrow">АККАУНТ</div>
        <h1>{mode === 'login' ? 'Вход' : 'Регистрация'}</h1>
        <p className="auth-subtitle">Единый кабинет для управления публикациями.</p>

        <form onSubmit={submit} className="auth-form">
          <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" /></label>
          <label>Пароль<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
          <button className="primary" disabled={busy}>{busy ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
        </form>

        {message && <div className="auth-message">{message}</div>}

        {mode === 'login' && (
          <button type="button" className="auth-switch" disabled={recoveryBusy || !email} onClick={sendPasswordReset}>
            {recoveryBusy ? 'Отправляем…' : 'Забыли пароль? Восстановить'}
          </button>
        )}

        <button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage(''); }}>
          {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
        </button>
      </section>
    </main>
  );
}
