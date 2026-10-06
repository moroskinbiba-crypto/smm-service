'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { createClient } from '../../lib/supabase/client';
import { workspaceRequest } from '../../lib/workspace-api';
import { appRequest } from '../../lib/app-api';

type Workspace = { workspace_id: string; workspace_name: string; workspace_timezone: string; role: string };

export function AppShell({ active, children }: { active: 'plan' | 'accounts' | 'stats' | 'inbox' | 'approvals' | 'admin'; children: ReactNode }) {
  const supabase = createClient();
  const [theme, setTheme] = useState<'light'|'dark'>('light');
  const [workspace, setWorkspace] = useState<Workspace|null>(null);
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

        const result = await workspaceRequest<{workspace?: Workspace}>('bootstrap');
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
      <div className="brand"><span className="brand-mark">S</span><span>SMM Service</span></div>
      <nav className="main-nav" aria-label="Основная навигация">
        <Link className={active==='plan'?'nav-link active':'nav-link'} href="/">План публикаций</Link>
        <Link className={active==='accounts'?'nav-link active':'nav-link'} href="/accounts">Аккаунты</Link>
        <Link className={active==='stats'?'nav-link active':'nav-link'} href="/stats">Статистика</Link>
        <Link className={active==='inbox'?'nav-link active':'nav-link'} href="/inbox">Входящие</Link>
        <Link className={active==='approvals'?'nav-link active':'nav-link'} href="/approvals">Согласование</Link>
        {isAdmin && <Link className={active==='admin'?'nav-link active nav-link-admin':'nav-link nav-link-admin'} href="/admin">Админ</Link>}
      </nav>
      <div className="top-actions"><Link className="workspace-chip" href="/team"><span className="workspace-dot"/>{workspace?.workspace_name??'Команда'}</Link><button className="theme" onClick={()=>{const next=theme==='light'?'dark':'light';setTheme(next);window.localStorage.setItem('smm-theme',next)}}>{theme==='light'?'☾':'☀'} Тема</button><button className="profile-button" onClick={signOut}>Выйти</button></div>
    </header>
    {children}
  </main>;
}
