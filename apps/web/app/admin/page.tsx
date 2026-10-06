'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type AdminUser = {
  id: string;
  email: string | null;
  display_name: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  banned_until: string | null;
  is_admin: boolean;
};

type AdminMember = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  created_at: string;
};

type AdminAccount = {
  id: string;
  user_id: string;
  email: string | null;
  platform: string;
  external_id: string;
  display_name: string | null;
  username: string | null;
  status: string;
  created_at: string;
};

type AdminTeam = {
  id: string;
  name: string;
  owner_id: string;
  owner_email: string | null;
  timezone: string;
  created_at: string;
  members: AdminMember[];
  accounts: AdminAccount[];
};

type Overview = {
  summary: { users: number; teams: number; social_accounts: number; suspended: number };
  users: AdminUser[];
  teams: AdminTeam[];
};

type SchedulerRun = {
  id: number;
  worker: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  claimed: number;
  published: number;
  failed: number;
  recovered: number;
  queued: number;
  duration_ms: number | null;
  error: string | null;
};

type QueueMetric = {
  queue_name: string;
  queue_length: number;
  oldest_msg_age_sec: number | null;
  total_messages: number;
};

type SchedulerHealth = {
  due_publications: number;
  due_metrics: number;
  checked_at: string;
  queues: QueueMetric[];
  latest_runs: SchedulerRun[];
};

const platformNames: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  ok: 'Одноклассники',
  instagram: 'Instagram',
};

function date(value: string | null) {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

function roleLabel(role: string) {
  return role === 'owner' ? 'Владелец' : role === 'admin' ? 'Администратор' : role === 'editor' ? 'Редактор' : role;
}

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busyUser, setBusyUser] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('');
  const [expandedTeams, setExpandedTeams] = useState<Record<string, boolean>>({});
  const [scheduler, setScheduler] = useState<SchedulerHealth | null>(null);

  async function load() {
    setMessage('');
    const [result, health] = await Promise.all([
      appRequest<Overview>('admin-overview'),
      appRequest<SchedulerHealth>('scheduler-health'),
    ]);
    setOverview(result);
    setScheduler(health);
  }

  useEffect(() => {
    void load().catch(error => setMessage(error instanceof Error ? error.message : 'Не удалось загрузить админ-панель'));
  }, []);

  async function setSuspended(user: AdminUser, suspended: boolean) {
    const action = suspended ? 'приостановить' : 'возобновить';
    if (!window.confirm('Точно ' + action + ' аккаунт ' + (user.email || user.id) + '?')) return;
    setBusyUser(user.id);
    setMessage('');
    try {
      await appRequest('admin-suspend-user', {
        user_id: user.id,
        suspended,
        reason: suspended ? 'Приостановлено администратором' : null,
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось изменить статус аккаунта');
    } finally {
      setBusyUser('');
    }
  }

  const filteredUsers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return overview?.users ?? [];
    return (overview?.users ?? []).filter(user =>
      [user.email, user.display_name, user.id].filter(Boolean).some(value => String(value).toLowerCase().includes(q)),
    );
  }, [overview, filter]);

  function toggleTeam(id: string) {
    setExpandedTeams(value => ({ ...value, [id]: !value[id] }));
  }

  return (
    <AppShell active="admin">
      <section className="page-section admin-page">
        <div className="page-heading">
          <div>
            <div className="eyebrow">АДМИНИСТРИРОВАНИЕ</div>
            <h1>Все пользователи</h1>
            <p>Пользователи, команды, подключённые социальные аккаунты и управление доступом.</p>
          </div>
          <button className="secondary" onClick={() => void load()}>Обновить</button>
        </div>

        {overview && (
          <div className="admin-stats">
            <section className="card metric-card"><span>Пользователи</span><strong>{overview.summary.users}</strong><small>в системе</small></section>
            <section className="card metric-card"><span>Команды</span><strong>{overview.summary.teams}</strong><small>рабочих пространств</small></section>
            <section className="card metric-card"><span>Соц. аккаунты</span><strong>{overview.summary.social_accounts}</strong><small>подключено</small></section>
            <section className="card metric-card"><span>Приостановлено</span><strong>{overview.summary.suspended}</strong><small>доступ заблокирован</small></section>
          </div>
        )}

        {scheduler && (
          <section className="card admin-scheduler-card">
            <div className="card-head">
              <div>
                <h2>Мониторинг очередей</h2>
                <span>Проверено {date(scheduler.checked_at)}</span>
              </div>
              <button className="secondary" onClick={() => void load()}>Обновить</button>
            </div>
            <div className="admin-stats">
              <section className="card metric-card"><span>Публикации к отправке</span><strong>{scheduler.due_publications}</strong><small>ожидают обработки</small></section>
              <section className="card metric-card"><span>Метрики к обновлению</span><strong>{scheduler.due_metrics}</strong><small>ожидают обработки</small></section>
              {scheduler.queues.map(queue => (
                <section className="card metric-card" key={queue.queue_name}>
                  <span>{queue.queue_name === 'publication_jobs' ? 'Очередь публикаций' : 'Очередь метрик'}</span>
                  <strong>{queue.queue_length}</strong>
                  <small>{queue.oldest_msg_age_sec == null ? 'пусто' : 'старейшая задача: ' + Math.round(queue.oldest_msg_age_sec) + ' c'}</small>
                </section>
              ))}
            </div>
            <div className="admin-mini-list">
              {scheduler.latest_runs.slice(0, 6).map(run => (
                <div className="admin-mini-row" key={run.id}>
                  <div>
                    <strong>{run.worker}</strong>
                    <span>{date(run.started_at)} · {run.duration_ms ?? 0} мс</span>
                  </div>
                  <span className={run.status === 'success' ? 'admin-status active' : 'admin-status suspended'}>
                    {run.status === 'success' ? 'OK' : 'Ошибка'} · queued {run.queued} · published {run.published} · failed {run.failed}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="card">
          <div className="card-head">
            <h2>Пользователи</h2>
            <span>{filteredUsers.length}</span>
          </div>
          <input className="admin-search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Поиск по email, имени или ID…" />
          <div className="admin-user-list">
            {filteredUsers.map(user => (
              <div className="admin-user-row" key={user.id}>
                <div className="admin-user-main">
                  <strong>{user.email ?? 'Без email'}</strong>
                  <span>{user.display_name ?? 'Без имени'} · зарегистрирован {date(user.created_at)}</span>
                  <small>Последний вход: {date(user.last_sign_in_at)}</small>
                </div>
                <span className={user.suspended_at ? 'admin-status suspended' : 'admin-status active'}>
                  {user.suspended_at ? 'Приостановлен' : 'Активен'}
                </span>
                <button
                  className={user.suspended_at ? 'secondary' : 'secondary danger-button'}
                  disabled={busyUser === user.id}
                  onClick={() => void setSuspended(user, !user.suspended_at)}
                >
                  {busyUser === user.id ? 'Сохраняем…' : user.suspended_at ? 'Возобновить' : 'Приостановить'}
                </button>
              </div>
            ))}
            {!filteredUsers.length && <div className="empty small-empty">Пользователи не найдены.</div>}
          </div>
        </section>

        <section className="admin-team-list">
          {overview?.teams.map(team => {
            const expanded = expandedTeams[team.id] ?? true;
            return (
              <section className="card admin-team-card" key={team.id}>
                <div className="card-head">
                  <div>
                    <h2>{team.name}</h2>
                    <div className="admin-team-meta">
                      Владелец: {team.owner_email ?? '—'} · {team.members.length} участников · {team.accounts.length} соц. аккаунтов · {team.timezone}
                    </div>
                  </div>
                  <button className="secondary" onClick={() => toggleTeam(team.id)}>{expanded ? 'Свернуть' : 'Развернуть'}</button>
                </div>
                {expanded && (
                  <div className="admin-team-content">
                    <div>
                      <h3>Участники</h3>
                      <div className="admin-mini-list">
                        {team.members.map(member => (
                          <div className="admin-mini-row" key={member.user_id}>
                            <div><strong>{member.email ?? member.display_name ?? member.user_id}</strong><span>{member.display_name ?? 'Без имени'}</span></div>
                            <span>{roleLabel(member.role)}</span>
                          </div>
                        ))}
                        {!team.members.length && <div className="empty small-empty">Участников нет.</div>}
                      </div>
                    </div>
                    <div>
                      <h3>Социальные аккаунты</h3>
                      <div className="admin-mini-list">
                        {team.accounts.map(account => (
                          <div className="admin-mini-row" key={account.id}>
                            <div><strong>{account.display_name ?? account.username ?? account.external_id}</strong><span>{platformNames[account.platform] ?? account.platform} · {account.email ?? '—'}</span></div>
                            <span className={account.status === 'connected' ? 'admin-status active' : 'admin-status suspended'}>{account.status}</span>
                          </div>
                        ))}
                        {!team.accounts.length && <div className="empty small-empty">Подключённых аккаунтов нет.</div>}
                      </div>
                    </div>
                  </div>
                )}
              </section>
            );
          })}
          {!overview?.teams.length && <section className="card"><div className="empty small-empty">Команд пока нет.</div></section>}
        </section>

        {message && <div className="auth-message">{message}</div>}
      </section>
    </AppShell>
  );
}
