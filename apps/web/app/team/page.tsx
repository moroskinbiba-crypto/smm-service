'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { workspaceRequest } from '../../lib/workspace-api';

type Member = { user_id: string; display_name: string | null; role: string; created_at: string };
type Invite = { invite_id: string; expires_at: string; used_at: string | null; created_at: string; role: string };
type Workspace = { workspace_id: string; workspace_name: string; workspace_timezone: string; role: string };

function roleLabel(role: string) {
  return ({owner:'Владелец',admin:'Администратор',editor:'Редактор',publisher:'Публикатор',approver:'Согласующий',viewer:'Наблюдатель'} as Record<string,string>)[role] ?? role;
}

export default function TeamPage() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [createdLink, setCreatedLink] = useState('');
  const [message, setMessage] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');

  async function load() {
    try {
      const [workspaceResult, membersResult] = await Promise.all([
        workspaceRequest<{ workspace?: Workspace }>('get-workspace'),
        workspaceRequest<{ members: Member[] }>('members'),
      ]);
      if (workspaceResult.workspace) setWorkspace(workspaceResult.workspace);
      setMembers(membersResult.members ?? []);

      if (workspaceResult.workspace?.role === 'owner' || workspaceResult.workspace?.role === 'admin') {
        const invitesResult = await workspaceRequest<{ invites: Invite[] }>('list-invites');
        setInvites(invitesResult.invites ?? []);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить команду');
    }
  }

  useEffect(() => { void load(); }, []);

  const canInvite = workspace?.role === 'owner' || workspace?.role === 'admin';

  async function createInvite() {
    setBusy(true); setMessage(''); setCreatedLink('');
    try {
      const result = await workspaceRequest<{ invite?: { token?: string } }>('create-invite', { expires_in_hours: 168, role: inviteRole });
      if (result.invite?.token) {
        setCreatedLink(window.location.origin + '/invite/' + result.invite.token);
        await load();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось создать приглашение');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!createdLink) return;
    await navigator.clipboard.writeText(createdLink);
    setMessage('Ссылка скопирована.');
  }

  async function revokeInvite(inviteId: string) {
    try {
      await workspaceRequest('revoke-invite', { invite_id: inviteId });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось отозвать ссылку');
    }
  }

  async function updateRole(userId: string, role: string) {
    setBusy(true); setMessage('');
    try {
      await workspaceRequest('set-member-role', { user_id: userId, role });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось изменить роль');
    } finally {
      setBusy(false);
    }
  }

  const activeInvites = useMemo(() => invites.filter(item => !item.used_at && new Date(item.expires_at) > new Date()), [invites]);

  return (
    <AppShell active="plan">
      <section className="page-section team-page">
        <div className="page-heading">
          <div><div className="eyebrow">КОМАНДА</div><h1>{workspace?.workspace_name ?? 'Рабочее пространство'}</h1><p>Управление участниками и приглашениями.</p></div>
          <span className="status"><span className="dot" />{roleLabel(workspace?.role ?? 'owner')}</span>
        </div>
        <div className="team-grid">
          <section className="card">
            <div className="card-head"><h2>Участники</h2><span>{members.length}</span></div>
            <div className="member-list">
              {members.map(member => <div className="member-row" key={member.user_id}>
  <div className="member-avatar">{(member.display_name ?? 'П').slice(0, 1).toUpperCase()}</div>
  <div className="member-main"><strong>{member.display_name ?? 'Пользователь'}</strong><span>{roleLabel(member.role)}</span></div>
  {canInvite && member.role !== 'owner' && <select className="member-role-select" value={member.role} disabled={busy} onChange={event => void updateRole(member.user_id, event.target.value)}>
    <option value="admin">Администратор</option>
    <option value="editor">Редактор</option>
    <option value="publisher">Публикатор</option>
    <option value="approver">Согласующий</option>
    <option value="viewer">Наблюдатель</option>
  </select>}
</div>)}
              {!members.length && <div className="empty small-empty">Участников пока нет.</div>}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Приглашение</h2><span>7 дней</span></div>
            <p className="section-copy">Создайте одноразовую ссылку для сотрудника. Роль приглашённого — «Сотрудник».</p>
            {canInvite ? <>
              <button className="primary" disabled={busy} onClick={createInvite}>{busy ? 'Создаём…' : '＋ Создать инвайт-ссылку'}</button>
              {createdLink && <div className="invite-result"><div className="invite-label">Ссылка готова</div><div className="invite-row"><input readOnly value={createdLink} /><button className="secondary" onClick={copyLink}>Копировать</button></div><small>После первого использования ссылка перестанет работать.</small></div>}
              {message && <div className="auth-message">{message}</div>}
            </> : <div className="auth-message">Создавать приглашения может только руководитель.</div>}
          </section>
        </div>
        {canInvite && <section className="card"><div className="card-head"><h2>Активные приглашения</h2><span>{activeInvites.length}</span></div><div className="invite-list">{activeInvites.map(invite => <div className="invite-item" key={invite.invite_id}><div><strong>Сотрудник</strong><span>до {new Date(invite.expires_at).toLocaleString('ru-RU')}</span></div><button className="secondary danger-button" onClick={() => revokeInvite(invite.invite_id)}>Отозвать</button></div>)}{!activeInvites.length && <div className="empty small-empty">Активных приглашений нет.</div>}</div></section>}
      </section>
    </AppShell>
  );
}
