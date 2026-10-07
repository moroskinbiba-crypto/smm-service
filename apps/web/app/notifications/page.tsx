'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Notification={id:string;type:string;title:string;body:string;read_at:string|null;created_at:string};

export default function NotificationsPage(){
  const [items,setItems]=useState<Notification[]>([]);
  const [message,setMessage]=useState('');
  const [telegram,setTelegram]=useState<{start_url:string;bot_username:string;expires_at:string}|null>(null);
  const [telegramBusy,setTelegramBusy]=useState(false);
  const [telegramConnected,setTelegramConnected]=useState(false);
  async function load(){const r=await appRequest<{notifications:Notification[]}>('list-notifications');setItems(r.notifications??[])}
  async function mark(id:string){try{await appRequest('mark-notification-read',{notification_id:id});setItems(v=>v.map(x=>x.id===id?{...x,read_at:new Date().toISOString()}:x))}catch(e){setMessage(e instanceof Error?e.message:'Не удалось отметить уведомление')}}
  useEffect(()=>{void load().catch(e=>setMessage(e instanceof Error?e.message:'Не удалось загрузить уведомления'))},[]);

  async function connectTelegram(){
    setTelegramBusy(true);setMessage('');
    try{
      const r=await appRequest<{start_url:string;bot_username:string;expires_at:string}>('telegram-notifications-start');
      setTelegram(r);
      setTelegramConnected(false);
      window.open(r.start_url,'_blank','noopener,noreferrer');
    }catch(e){setMessage(e instanceof Error?e.message:'Не удалось подключить Telegram-уведомления')}
    finally{setTelegramBusy(false)}
  }
  const unread=items.filter(x=>!x.read_at).length;
  return <AppShell active="notifications">
    <section className="page-section notifications-page">
      <div className="page-heading"><div><div className="eyebrow">СИСТЕМА</div><h1>Уведомления</h1><p>Согласование, ошибки и важные события рабочего пространства.</p></div><span className="status"><span className="dot"/>{unread} непрочитанных</span></div>
      <section className="card telegram-notification-card">
        <div className="card-head"><div><h2>Telegram-уведомления</h2><span>Просмотры и суточная статистика</span></div></div>
        <p className="section-copy">Это ваш личный Telegram-бот. Он не подключает каналы и не получает доступ к публикациям — он нужен только для отправки вам статистики и важных событий.</p><div className="telegram-notify-explainer"><strong>Как подключить</strong><span>1. Нажмите «Подключить уведомления».</span><span>2. Откройте бота и нажмите <b>Start</b>.</span><span>3. Вернитесь на сайт — ваш Telegram автоматически привяжется к вашему аккаунту.</span><small>После подключения бот сможет присылать рубежи просмотров и ежедневный отчёт.</small></div>
        {!telegram ? <button className="primary" disabled={telegramBusy} onClick={()=>void connectTelegram()}>{telegramBusy?'Готовим ссылку…':'Подключить Telegram-уведомления'}</button> : <div className="telegram-notify-connect"><strong>1. Нажмите Start у бота @{telegram.bot_username.replace(/^@/,'')}</strong><a className="primary telegram-start-link" href={telegram.start_url} target="_blank" rel="noreferrer">Открыть Telegram</a><small>Ссылка действует до {new Date(telegram.expires_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}. После Start этот блок больше не понадобится.</small></div>}
      </section>
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
