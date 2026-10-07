'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { createClient } from '../../lib/supabase/client';
import { workspaceRequest } from '../../lib/workspace-api';
import { appRequest } from '../../lib/app-api';

type Workspace = { workspace_id: string; workspace_name: string; workspace_timezone: string; role: string; workspace_kind?: 'personal'|'team'; max_members?: number; member_count?: number };
type WorkspaceOption = Workspace;

export function AppShell({ active, children }: { active: 'plan' | 'accounts' | 'stats' | 'inbox' | 'approvals' | 'recurrences' | 'competitors' | 'content' | 'notifications' | 'automation' | 'media' | 'admin'; children: ReactNode }) {
  const pathname = usePathname();
  const supabase = createClient();
  const [theme, setTheme] = useState<'light'|'dark'>('light');
  const [workspace, setWorkspace] = useState<Workspace|null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

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

  async function signOut() {
    await supabase.auth.signOut();
    window.location.assign('/auth');
  }

  if (!authReady) return <main className={theme==='dark'?'shell dark':'shell'}><div className="page-loading"><span className="loading-spinner"/>Загружаем рабочее пространство…</div></main>;

  return <main className={theme==='dark'?'shell dark':'shell'}>
    <header className="topbar app-topbar">
      <div className="brand"><span className="brand-mark">T</span><span>TGRMLposting</span></div>
      <nav className="main-nav" aria-label="Основная навигация">
        <Link className={active==='plan'?'nav-link active':'nav-link'} href="/">План публикаций</Link>
        <Link className={active==='accounts'?'nav-link active':'nav-link'} href="/accounts">Аккаунты</Link>
        <Link className={active==='stats'?'nav-link active':'nav-link'} href="/stats">Статистика</Link>
        <Link className={active==='inbox'?'nav-link active':'nav-link'} href="/inbox">Входящие</Link>
        <Link className={active==='approvals'?'nav-link active':'nav-link'} href="/approvals">Согласование</Link>
        <Link className={active==='recurrences'?'nav-link active':'nav-link'} href="/recurrences">Повторы</Link>
        <Link className={active==='competitors'?'nav-link active':'nav-link'} href="/competitors">Конкуренты</Link>
        <Link className={active==='content'?'nav-link active':'nav-link'} href="/content">Контент</Link>
        <Link className={active==='notifications'?'nav-link active':'nav-link'} href="/notifications">Уведомления</Link>
        <Link className={active==='automation'?'nav-link active':'nav-link'} href="/automation">Автоматизация</Link>
        <Link className={active==='media'?'nav-link active':'nav-link'} href="/media">Медиа</Link>
        {isAdmin && <Link className={active==='admin'?'nav-link active nav-link-admin':'nav-link nav-link-admin'} href="/admin">Админ</Link>}
      </nav>
      <div className="top-actions">
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
    <a className="floating-contact" href="https://t.me/truegromle" target="_blank" rel="noreferrer" aria-label="Связаться в Telegram" title="Связаться в Telegram">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21.7 3.5 18.4 20c-.25 1.2-.9 1.5-1.8.95l-5-3.7-2.4 2.3c-.27.27-.5.5-1.03.5l.36-5.1 9.28-8.38c.4-.36-.09-.56-.62-.2L5.7 13.06.8 11.53c-1.07-.34-1.1-1.08.22-1.58L20.2 2.82c.86-.31 1.61.2 1.5.68Z" />
      </svg>
    </a>
  </main>;
}
