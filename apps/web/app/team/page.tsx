'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { workspaceRequest } from '../../lib/workspace-api';
import { appRequest } from '../../lib/app-api';
import { createClient } from '../../lib/supabase/client';

type Member = { user_id: string; display_name: string | null; role: string; created_at: string; invited_by: string | null; suspended_at: string | null; suspended_reason: string | null };
type Invite = { invite_id: string; expires_at: string; used_at: string | null; created_at: string; role: string };
type Workspace = { workspace_id: string; workspace_name: string; workspace_timezone: string; role: string; workspace_kind?: 'personal'|'team'; max_members?: number; member_count?: number };

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
  const [currentUserId, setCurrentUserId] = useState('');
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [limit, setLimit] = useState('');
  const [limitBusy, setLimitBusy] = useState(false);
  const supabase = createClient();

  async function load() {
    try {
      const [workspaceResult, membersResult] = await Promise.all([
        workspaceRequest<{ workspace?: Workspace }>('get-workspace'),
        workspaceRequest<{ members: Member[] }>('members'),
      ]);
      if (workspaceResult.workspace) {
        setWorkspace(workspaceResult.workspace);
        setLimit(String(workspaceResult.workspace.max_members ?? ''));
      }
      setMembers(membersResult.members ?? []);
      try {
        const adminResult = await appRequest<{is_admin:boolean}>('admin-check');
        setIsPlatformAdmin(adminResult.is_admin === true);
      } catch { setIsPlatformAdmin(false); }

      if (workspaceResult.workspace?.role === 'owner' || workspaceResult.workspace?.role === 'admin') {
        const invitesResult = await workspaceRequest<{ invites: Invite[] }>('list-invites');
        setInvites(invitesResult.invites ?? []);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить команду');
    }
  }

  useEffect(() => { void load(); void supabase.auth.getUser().then(({data})=>setCurrentUserId(data.user?.id??'')); }, [supabase]);

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

  async function removeMember(member: Member){
    if(!window.confirm('Удалить '+(member.display_name||'пользователя')+' из команды? Личный профиль и личные данные пользователя останутся.')) return;
    setBusy(true);setMessage('');
    try{await workspaceRequest('remove-member',{user_id:member.user_id});await load();}
    catch(e){setMessage(e instanceof Error?e.message:'Не удалось удалить участника')}
    finally{setBusy(false)}
  }

  async function saveLimit(){
    if(!workspace || !isPlatformAdmin) return;
    const value=Number(limit);
    if(!Number.isInteger(value)||value<1||value>10000){setMessage('Количество участников должно быть от 1 до 10000.');return;}
    setLimitBusy(true);setMessage('');
    try{
      const result=await appRequest<{max_members:number}>('admin-set-workspace-limit',{workspace_id:workspace.workspace_id,max_members:value});
      setWorkspace(prev=>prev?{...prev,max_members:result.max_members,workspace_kind:result.max_members>1?'team':prev.workspace_kind}:prev);
      setMessage('Лимит команды сохранён.');
    }catch(e){setMessage(e instanceof Error?e.message:'Не удалось сохранить лимит')}
    finally{setLimitBusy(false)}
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
          {workspace?.workspace_kind === 'personal' && canInvite && <section className="card"><div className="auth-message">Это личный профиль. Создание первой команды через приглашение автоматически создаст отдельный личный профиль и превратит текущий профиль в командный.</div></section>}
          {isPlatformAdmin && workspace && <section className="card">
            <div className="card-head"><h2>Лимит команды</h2><span>{workspace.member_count ?? members.length} / {workspace.max_members ?? '—'}</span></div>
            <p className="section-copy">Этот параметр доступен только вам как платформенному администратору. Он задаёт максимальное число участников команды.</p>
            <div className="workspace-limit-row">
              <input className="workspace-limit-input" type="number" min="1" max="10000" value={limit} onChange={e=>setLimit(e.target.value)} />
              <button className="primary" disabled={limitBusy} onClick={()=>void saveLimit()}>{limitBusy?'Сохраняем…':'Сохранить'}</button>
            </div>
          </section>}
          <section className="card">
            <div className="card-head"><h2>Участники</h2><span>{members.length}{workspace?.max_members ? ' / ' + workspace.max_members : ''}</span></div>
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
  {canInvite && member.role !== 'owner' && <button className="secondary danger-button" disabled={busy} onClick={()=>void removeMember(member)}>Удалить из команды</button>}
</div>)}
              {!members.length && <div className="empty small-empty">Участников пока нет.</div>}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Приглашение</h2><span>7 дней</span></div>
            <p className="section-copy">Создайте одноразовую ссылку и сразу назначьте роль участника.</p>
            {canInvite ? <>
              <label className="invite-role-label">Роль приглашённого
                <select className="invite-role-select" value={inviteRole} onChange={event => setInviteRole(event.target.value)}>
                  <option value="editor">Редактор</option>
                  <option value="publisher">Публикатор</option>
                  <option value="approver">Согласующий</option>
                  <option value="viewer">Наблюдатель</option>
                  {workspace?.role === 'owner' && <option value="admin">Администратор</option>}
                </select>
              </label>
              <button className="primary" disabled={busy} onClick={createInvite}>{busy ? 'Создаём…' : '＋ Создать инвайт-ссылку'}</button>
              {createdLink && <div className="invite-result"><div className="invite-label">Ссылка готова</div><div className="invite-row"><input readOnly value={createdLink} /><button className="secondary" onClick={copyLink}>Копировать</button></div><small>После первого использования ссылка перестанет работать.</small></div>}
              {message && <div className="auth-message">{message}</div>}
            </> : <div className="auth-message">Создавать приглашения может только руководитель.</div>}
          </section>
        </div>
        {canInvite && <section className="card"><div className="card-head"><h2>Активные приглашения</h2><span>{activeInvites.length}</span></div><div className="invite-list">{activeInvites.map(invite => <div className="invite-item" key={invite.invite_id}><div><strong>{roleLabel(invite.role)}</strong><span>до {new Date(invite.expires_at).toLocaleString('ru-RU')}</span></div><button className="secondary danger-button" onClick={() => revokeInvite(invite.invite_id)}>Отозвать</button></div>)}{!activeInvites.length && <div className="empty small-empty">Активных приглашений нет.</div>}</div></section>}
      </section>
    </AppShell>
  );
}
