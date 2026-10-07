'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { createClient } from '../../lib/supabase/client';
import { workspaceRequest } from '../../lib/workspace-api';
import { appRequest } from '../../lib/app-api';

type Workspace = { workspace_id: string; workspace_name: string; workspace_timezone: string; role: string; workspace_kind?: 'personal'|'team'; max_members?: number; member_count?: number; approvals_enabled?: boolean };
type WorkspaceOption = Workspace;

export function AppShell({ active, children }: { active: 'plan' | 'accounts' | 'stats' | 'inbox' | 'approvals' | 'team' | 'admin' | 'recurrences' | 'competitors' | 'content' | 'notifications' | 'automation' | 'media'; children: ReactNode }) {
  const pathname = usePathname();
  const supabase = createClient();
  const [theme, setTheme] = useState<'light'|'dark'>('light');
  const [workspace, setWorkspace] = useState<Workspace|null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commentsUnread, setCommentsUnread] = useState(0);
  const [notificationsUnread, setNotificationsUnread] = useState(0);
  const [approvalsPending, setApprovalsPending] = useState(0);

  useEffect(() => {
    const saved = window.localStorage.getItem('smm-theme');
    if (saved === 'dark') setTheme('dark');
    let cancelled = false;

    async function initialize() {
      try {
        const { data: authData } = await supabase.auth.getUser();
        if (!authData.user) {
          window.location.assign('/auth');
          return;
        }

        await workspaceRequest<{workspace?: Workspace}>('bootstrap');
        const listResult = await workspaceRequest<{workspaces: WorkspaceOption[]}>('list-workspaces');
        const available = listResult.workspaces ?? [];
        let preferred = window.localStorage.getItem('smm-workspace-id') || '';
        if (!available.some(item => item.workspace_id === preferred)) {
          preferred = available[0]?.workspace_id || '';
          if (preferred) window.localStorage.setItem('smm-workspace-id', preferred);
        }
        if (!cancelled) setWorkspaces(available);

        const result = await workspaceRequest<{workspace?: Workspace}>('get-workspace');
        if (!cancelled && result.workspace) setWorkspace(result.workspace);
        try {
          const adminResult = await appRequest<{is_admin: boolean}>('admin-check');
          if (!cancelled) setIsAdmin(adminResult.is_admin === true);
        } catch {
          if (!cancelled) setIsAdmin(false);
        }
      } catch {
        // Keep the shell usable; protected API calls will surface real errors.
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    }

    void initialize();
    return () => { cancelled = true; };
  }, [supabase]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!authReady || !workspace) return;
    void loadNavBadges();
    void syncInboxInBackground();
    const timer = window.setInterval(() => { void syncInboxInBackground(); }, 60000);
    return () => window.clearInterval(timer);
  }, [authReady, workspace?.workspace_id, workspace?.role]);

  async function loadNavBadges() {
    try {
      const result = await appRequest<{comments_unread:number;notifications_unread:number;approvals_pending:number}>('nav-badges');
      setCommentsUnread(Number(result.comments_unread ?? 0));
      setNotificationsUnread(Number(result.notifications_unread ?? 0));
      setApprovalsPending(Number(result.approvals_pending ?? 0));
    } catch {}
  }

  async function syncInboxInBackground() {
    if (!workspace || workspace.role === 'viewer') return;
    try { await appRequest('sync-inbox'); } catch {}
    await loadNavBadges();
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.assign('/auth');
  }

  if (!authReady) return <main className={theme==='dark'?'shell dark':'shell'}><div className="page-loading"><span className="loading-spinner"/>Загружаем рабочее пространство…</div></main>;

  return <main className={theme==='dark'?'shell dark':'shell'}>
    <header className="topbar app-topbar">
      <div className="mobile-header-left">
        <button type="button" className="mobile-menu-toggle" aria-label={mobileNavOpen ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(value => !value)}>
          <span /><span /><span />
        </button>
        <div className="brand"><span className="brand-mark">T</span><span>TGRMLposting</span></div>
      </div>
      <nav className={mobileNavOpen ? 'main-nav mobile-open' : 'main-nav'} aria-label="Основная навигация">
        <Link className={active==='plan'?'nav-link active':'nav-link'} href="/">План публикаций</Link>
        <Link className={active==='accounts'?'nav-link active':'nav-link'} href="/accounts">Аккаунты</Link>
        <Link className={active==='stats'?'nav-link active':'nav-link'} href="/stats">Аналитика</Link>
        <Link className={active==='inbox'?'nav-link active':'nav-link'} href="/inbox">Комментарии{commentsUnread>0&&<span className="nav-badge">{commentsUnread>99?'99+':commentsUnread}</span>}</Link>
        {workspace?.approvals_enabled===true&&<Link className={active==='approvals'?'nav-link active':'nav-link'} href="/approvals">Согласование{approvalsPending>0&&<span className="nav-badge">{approvalsPending>99?'99+':approvalsPending}</span>}</Link>}
        <Link className={active==='team'?'nav-link active':'nav-link'} href="/team">Команда</Link>
        {isAdmin && <Link className={active==='admin'?'nav-link active nav-link-admin':'nav-link nav-link-admin'} href="/admin">Пользователи</Link>}
      </nav>
      {mobileNavOpen && <button type="button" className="mobile-nav-backdrop" aria-label="Закрыть меню" onClick={() => setMobileNavOpen(false)} />}
      <div className="top-actions">
        <Link className="notification-bell" href="/stats#notifications-banner" aria-label="Уведомления">
          <span aria-hidden="true">🔔</span>
          {notificationsUnread>0&&<span className="notification-badge">{notificationsUnread>99?'99+':notificationsUnread}</span>}
        </Link>
        <select
          className="workspace-switcher"
          value={workspace?.workspace_id || ''}
          onChange={event => {
            const next = event.target.value;
            if (!next) return;
            window.localStorage.setItem('smm-workspace-id', next);
            window.location.reload();
          }}
          aria-label="Выбор профиля"
        >
          {workspaces.map(item => (
            <option key={item.workspace_id} value={item.workspace_id}>
              {item.workspace_kind === 'personal' ? 'Личный · ' : 'Команда · '}{item.workspace_name}
            </option>
          ))}
        </select>
        <Link className="workspace-chip" href="/team"><span className="workspace-dot"/>{workspace?.workspace_name??'Рабочее пространство'}</Link>
        <button className="theme" onClick={()=>{const next=theme==='light'?'dark':'light';setTheme(next);window.localStorage.setItem('smm-theme',next)}}>{theme==='light'?'☾':'☀'} Тема</button>
        <button className="profile-button" onClick={signOut}>Выйти</button>
      </div>
    </header>
    <div key={pathname} className="app-page-transition">{children}</div>
    <a className="floating-author" href="https://t.me/truegromle" target="_blank" rel="noreferrer" aria-label="Связаться с автором @truegromle" title="Связаться с автором @truegromle">
      <span className="floating-author-avatar">TG</span>
      <span className="floating-author-label">@truegromle</span>
    </a>
  </main>;
}
