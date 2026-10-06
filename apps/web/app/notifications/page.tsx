'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Notification={id:string;type:string;title:string;body:string;read_at:string|null;created_at:string};

export default function NotificationsPage(){
  const [items,setItems]=useState<Notification[]>([]);
  const [message,setMessage]=useState('');
  async function load(){const r=await appRequest<{notifications:Notification[]}>('list-notifications');setItems(r.notifications??[])}
  async function mark(id:string){try{await appRequest('mark-notification-read',{notification_id:id});setItems(v=>v.map(x=>x.id===id?{...x,read_at:new Date().toISOString()}:x))}catch(e){setMessage(e instanceof Error?e.message:'Не удалось отметить уведомление')}}
  useEffect(()=>{void load().catch(e=>setMessage(e instanceof Error?e.message:'Не удалось загрузить уведомления'))},[]);
  const unread=items.filter(x=>!x.read_at).length;
  return <AppShell active="notifications">
    <section className="page-section notifications-page">
      <div className="page-heading"><div><div className="eyebrow">СИСТЕМА</div><h1>Уведомления</h1><p>Согласование, ошибки и важные события рабочего пространства.</p></div><span className="status"><span className="dot"/>{unread} непрочитанных</span></div>
      <section className="card notification-list">
        {items.map(item=><button className={!item.read_at?'notification-row unread':'notification-row'} key={item.id} onClick={()=>void mark(item.id)}>
          <div className="notification-icon">{item.type==='approval_requested'?'✓':item.type==='approval_reviewed'?'⚑':'🔔'}</div>
          <div><strong>{item.title}</strong><span>{item.body}</span><small>{new Date(item.created_at).toLocaleString('ru-RU')}</small></div>
          {!item.read_at&&<span className="inbox-unread">NEW</span>}
        </button>)}
        {!items.length&&<div className="empty small-empty">Новых уведомлений нет.</div>}
      </section>
      {message&&<div className="auth-message">{message}</div>}
    </section>
  </AppShell>;
}
