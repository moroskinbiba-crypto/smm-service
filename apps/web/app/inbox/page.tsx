'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Thread = {
  id: string;
  platform: string;
  external_thread_id: string;
  thread_type: 'message' | 'comment';
  subject: string | null;
  participant_name: string | null;
  participant_external_id: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  status: string;
  social_accounts?: { display_name: string | null; username: string | null; external_id: string } | null;
};

type Message = {
  id: number;
  external_message_id: string;
  direction: 'inbound' | 'outbound';
  message_type: 'message' | 'comment';
  author_name: string | null;
  author_external_id: string | null;
  body: string;
  sent_at: string | null;
  read_at: string | null;
  metadata: Record<string, unknown>;
};

const names: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  ok: 'Одноклассники',
};

const icons: Record<string, string> = {
  telegram: '✈️',
  vk: 'VK',
  max: 'M',
  ok: 'OK',
};

function formatDate(value: string | null) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function InboxPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<{ thread: Thread; messages: Message[] } | null>(null);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [platform, setPlatform] = useState('all');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');

  async function loadThreads() {
    const result = await appRequest<{ threads: Thread[] }>('list-inbox');
    setThreads(result.threads ?? []);
    if (selectedId && !(result.threads ?? []).some(thread => thread.id === selectedId)) {
      setSelectedId('');
      setSelected(null);
    }
  }

  async function sync() {
    setSyncing(true);
    setMessage('');
    try {
      const result = await appRequest<{ scanned: number; inserted: number; errors: string[] }>('sync-inbox');
      if (result.errors?.length) setMessage(result.errors.slice(0, 2).join(' · '));
      await loadThreads();
      if (selectedId) await openThread(selectedId, false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось обновить входящие');
    } finally {
      setSyncing(false);
    }
  }

  async function openThread(id: string, markRead = true) {
    setSelectedId(id);
    try {
      const result = await appRequest<{ thread: Thread; messages: Message[] }>('get-inbox-thread', { thread_id: id });
      setSelected(result);
      if (markRead && result.thread.unread_count > 0) {
        await appRequest('mark-inbox-read', { thread_id: id });
        setThreads(value => value.map(thread => thread.id === id ? { ...thread, unread_count: 0 } : thread));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось открыть диалог');
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !text.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      await appRequest('send-inbox-message', { thread_id: selectedId, text });
      setText('');
      await openThread(selectedId, false);
      await loadThreads();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось отправить ответ');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void sync();
    const timer = window.setInterval(() => {
      void sync().catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);

  const filteredThreads = useMemo(() => {
    return threads.filter(thread =>
      (filter === 'all' || thread.unread_count > 0) &&
      (platform === 'all' || thread.platform === platform),
    );
  }, [threads, filter, platform]);

  const unread = threads.reduce((sum, thread) => sum + thread.unread_count, 0);

  return (
    <AppShell active="inbox">
      <section className="page-section inbox-page">
        <div className="page-heading">
          <div>
            <div className="eyebrow">КОММЕНТАРИИ</div>
            <h1>Комментарии</h1>
            <p>Комментарии и ответы из подключённых социальных сетей в одном окне.</p>
          </div>
          <button className="secondary" disabled={syncing} onClick={() => void sync()}>{syncing ? 'Обновляем…' : '↻ Обновить'}</button>
        </div>

        <div className="inbox-filters card">
          <div className="inbox-filter-group">
            <button className={filter === 'all' ? 'secondary active-period' : 'secondary'} onClick={() => setFilter('all')}>Все</button>
            <button className={filter === 'unread' ? 'secondary active-period' : 'secondary'} onClick={() => setFilter('unread')}>{'Непрочитанные' + (unread ? ' (' + unread + ')' : '')}</button>
          </div>
          <div className="inbox-filter-group">
            <button className={platform === 'all' ? 'secondary active-period' : 'secondary'} onClick={() => setPlatform('all')}>Все площадки</button>
            {['telegram','vk','max','ok'].map(item => (
              <button key={item} className={platform === item ? 'secondary active-period' : 'secondary'} onClick={() => setPlatform(item)}>{icons[item]} {names[item]}</button>
            ))}
          </div>
        </div>

        <div className="inbox-layout">
          <section className="card inbox-thread-list">
            <div className="card-head"><h2>Диалоги</h2><span>{filteredThreads.length}</span></div>
            <div className="inbox-thread-items">
              {filteredThreads.map(thread => (
                <button
                  key={thread.id}
                  className={selectedId === thread.id ? 'inbox-thread active' : 'inbox-thread'}
                  onClick={() => void openThread(thread.id)}
                >
                  <div className="inbox-thread-icon">{icons[thread.platform] ?? '◎'}</div>
                  <div className="inbox-thread-main">
                    <div className="inbox-thread-top">
                      <strong>{thread.participant_name || thread.subject || names[thread.platform] || thread.platform}</strong>
                      <small>{formatDate(thread.last_message_at)}</small>
                    </div>
                    <div className="inbox-thread-meta">{names[thread.platform] ?? thread.platform} · {thread.thread_type === 'comment' ? 'Комментарий' : 'Сообщение'}</div>
                    <div className="inbox-thread-preview">{thread.last_message_preview || 'Без текста'}</div>
                  </div>
                  {thread.unread_count > 0 && <span className="inbox-unread">{thread.unread_count}</span>}
                </button>
              ))}
              {!filteredThreads.length && <div className="empty small-empty">Входящих сообщений пока нет.<br />Нажмите «Обновить» после общения с подписчиком.</div>}
            </div>
          </section>

          <section className="card inbox-conversation">
            {!selected ? (
              <div className="inbox-empty-state">
                <div className="coming-icon">💬</div>
                <h2>Выберите диалог</h2>
                <p>Здесь появится переписка и комментарии выбранного пользователя.</p>
              </div>
            ) : (
              <>
                <div className="inbox-conversation-head">
                  <div>
                    <div className="eyebrow">{icons[selected.thread.platform]} {names[selected.thread.platform] ?? selected.thread.platform}</div>
                    <h2>{selected.thread.participant_name || selected.thread.subject || 'Диалог'}</h2>
                    <span>{selected.thread.thread_type === 'comment' ? 'Комментарий к публикации' : 'Входящее сообщение'}</span>
                  </div>
                  <button className="secondary" onClick={() => void openThread(selected.thread.id, false)}>Обновить</button>
                </div>
                <div className="inbox-messages">
                  {selected.messages.map(message => (
                    <div key={message.id} className={message.direction === 'outbound' ? 'inbox-message outbound' : 'inbox-message'}>
                      <div className="inbox-message-author">{message.author_name || (message.direction === 'outbound' ? 'Вы' : 'Пользователь')}</div>
                      <div className="inbox-message-body">{message.body}</div>
                      <div className="inbox-message-time">{formatDate(message.sent_at)}</div>
                    </div>
                  ))}
                  {!selected.messages.length && <div className="empty small-empty">Сообщений нет.</div>}
                </div>
                <form className="inbox-composer" onSubmit={send}>
                  <textarea value={text} onChange={event => setText(event.target.value)} placeholder="Напишите ответ…" rows={4} />
                  <div className="inbox-composer-actions">
                    {message && <div className="auth-message">{message}</div>}
                    <button className="primary inbox-send" disabled={busy || !text.trim()}>{busy ? 'Отправляем…' : 'Ответить'}</button>
                  </div>
                </form>
              </>
            )}
          </section>
        </div>

        {message && !selected && <div className="auth-message">{message}</div>}
      </section>
    </AppShell>
  );
}
