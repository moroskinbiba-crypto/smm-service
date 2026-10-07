'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type ApprovalPost = {
  id: string;
  body: string;
  media: Array<{ signed_url?: string | null }>;
  status: string;
  scheduled_at: string | null;
  created_at: string;
  approval_status: string;
  approval_comment: string | null;
  post_targets: Array<{ platform: string; status: string; social_accounts?: { display_name: string | null; username: string | null } | null }>;
};

const names: Record<string,string> = { telegram:'Telegram', vk:'VK', max:'MAX', ok:'Одноклассники' };

function preview(text: string) {
  const value=text.replace(/\s+/g,' ').trim();
  return value.length>180?value.slice(0,180)+'…':value||'Без текста';
}

export default function ApprovalsPage() {
  const [posts,setPosts]=useState<ApprovalPost[]>([]);
  const [role,setRole]=useState('');
  const [message,setMessage]=useState('');
  const [enabled,setEnabled]=useState(true);
  const [busy,setBusy]=useState('');

  async function load() {
    try {
      const result=await appRequest<{posts:ApprovalPost[];role:string}>('list-approval-queue');
      setPosts(result.posts??[]);
      setRole(result.role||'');
    } catch(error) {
      setMessage(error instanceof Error?error.message:'Не удалось загрузить согласования');
    }
  }

  async function review(postId:string,decision:'approved'|'rejected') {
    const comment=window.prompt(decision==='approved'?'Комментарий (необязательно):':'Причина отклонения (необязательно):','')??'';
    setBusy(postId);
    setMessage('');
    try {
      await appRequest('review-approval',{post_id:postId,decision,comment});
      await load();
    } catch(error) {
      setMessage(error instanceof Error?error.message:'Не удалось обработать согласование');
    } finally {
      setBusy('');
    }
  }

  useEffect(()=>{void load()},[]);

  return (
    <AppShell active="approvals">
      <section className="page-section approvals-page">
        <div className="page-heading">
          <div>
            <div className="eyebrow">МОДЕРАЦИЯ</div>
            <h1>Согласование</h1>
            <p>Проверяйте публикации команды перед выпуском.</p>
          </div>
          <button className="secondary" onClick={()=>void load()}>Обновить</button>
        </div>

        {!enabled && <section className="card coming-card"><div className="coming-icon">⏸</div><h2>Согласование выключено</h2><p>Руководитель может включить режим в разделе «Команда».</p></section>}

        {!['owner','admin','approver'].includes(role) && (
          <section className="card coming-card">
            <div className="coming-icon">🔒</div>
            <h2>Нет прав на согласование</h2>
            <p>Ваша роль — «{role || 'не определена'}». Запросы видны руководителям и согласующим.</p>
          </section>
        )}

        {enabled && ['owner','admin','approver'].includes(role) && (
          <section className="approval-list">
            {posts.map(post=>(
              <article className="card approval-card" key={post.id}>
                <div className="approval-card-head">
                  <div>
                    <div className="eyebrow">ОЖИДАЕТ СОГЛАСОВАНИЯ</div>
                    <h2>{preview(post.body)}</h2>
                    <span>{post.scheduled_at ? new Date(post.scheduled_at).toLocaleString('ru-RU') : 'Без времени'} · {post.post_targets.map(t=>names[t.platform]||t.platform).join(' · ')}</span>
                  </div>
                  <div className="approval-actions">
                    <button className="primary approval-button" disabled={busy===post.id} onClick={()=>void review(post.id,'approved')}>{busy===post.id?'Сохраняем…':'Одобрить'}</button>
                    <button className="secondary danger-button approval-button" disabled={busy===post.id} onClick={()=>void review(post.id,'rejected')}>Отклонить</button>
                  </div>
                </div>
                <div className="approval-targets">
                  {post.post_targets.map((target,index)=><span key={index} className="approval-target">{names[target.platform]||target.platform} · {target.social_accounts?.display_name||target.social_accounts?.username||''}</span>)}
                </div>
                {post.media?.[0]?.signed_url&&<img className="approval-image" src={post.media[0].signed_url} alt="" />}
              </article>
            ))}
            {!posts.length && <section className="card"><div className="empty small-empty">Нет публикаций, ожидающих согласования.</div></section>}
          </section>
        )}

        {message && <div className="auth-message">{message}</div>}
      </section>
    </AppShell>
  );
}
