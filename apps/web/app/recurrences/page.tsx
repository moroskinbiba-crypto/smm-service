'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Post={id:string;body:string;status:string};
type Recurrence={id:string;source_post_id:string;interval_days:number;next_run_at:string;end_at:string|null;max_runs:number|null;run_count:number;active:boolean;posts?:Post};

function preview(text:string){const x=text.replace(/\s+/g,' ').trim();return x.length>90?x.slice(0,90)+'…':x||'Без текста'}

export default function RecurrencesPage(){
  const [posts,setPosts]=useState<Post[]>([]);
  const [items,setItems]=useState<Recurrence[]>([]);
  const [postId,setPostId]=useState('');
  const [interval,setIntervalDays]=useState('7');
  const [nextRun,setNextRun]=useState('');
  const [maxRuns,setMaxRuns]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);

  async function load(){
    const [p,r]=await Promise.all([
      appRequest<{posts:Post[]}>('list-posts',{from:new Date(Date.now()-30*86400000).toISOString(),to:new Date(Date.now()+365*86400000).toISOString()}),
      appRequest<{recurrences:Recurrence[]}>('list-recurrences')
    ]);
    setPosts(p.posts??[]);
    setItems(r.recurrences??[]);
    if(!postId && p.posts?.length)setPostId(p.posts[0].id);
  }
  useEffect(()=>{void load().catch(e=>setMessage(e instanceof Error?e.message:'Не удалось загрузить повторы'))},[]);

  async function create(){
    if(!postId)return;
    setBusy(true);setMessage('');
    try{
      const date=nextRun||new Date(Date.now()+86400000).toISOString();
      await appRequest('create-recurrence',{post_id:postId,interval_days:Number(interval),next_run_at:date,max_runs:maxRuns||null});
      setMessage('Повтор создан.');
      await load();
    }catch(e){setMessage(e instanceof Error?e.message:'Не удалось создать повтор')}finally{setBusy(false)}
  }

  async function stop(id:string){
    try{await appRequest('cancel-recurrence',{recurrence_id:id});await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось остановить повтор')}
  }

  return <AppShell active="recurrences">
    <section className="page-section recurrences-page">
      <div className="page-heading"><div><div className="eyebrow">АВТОПОВТОР</div><h1>Повторные публикации</h1><p>Автоматически создавайте новые публикации из уже готового контента.</p></div></div>
      <section className="card recurrence-create">
        <div className="card-head"><h2>Создать повтор</h2><span>Планировщик создаст новую публикацию</span></div>
        <div className="recurrence-form">
          <label>Исходная публикация
            <select value={postId} onChange={e=>setPostId(e.target.value)}>{posts.map(post=><option key={post.id} value={post.id}>{preview(post.body)}</option>)}</select>
          </label>
          <label>Интервал, дней<input type="number" min="1" max="365" value={interval} onChange={e=>setIntervalDays(e.target.value)}/></label>
          <label>Следующий запуск<input type="datetime-local" value={nextRun} onChange={e=>setNextRun(e.target.value)}/></label>
          <label>Количество повторов<input type="number" min="1" max="1000" placeholder="Без ограничений" value={maxRuns} onChange={e=>setMaxRuns(e.target.value)}/></label>
        </div>
        <button className="primary recurrence-create-button" disabled={busy||!postId} onClick={()=>void create()}>{busy?'Создаём…':'Создать повтор'}</button>
      </section>

      <section className="card">
        <div className="card-head"><h2>Активные повторы</h2><span>{items.filter(x=>x.active).length}</span></div>
        <div className="recurrence-list">
          {items.map(item=><div className="recurrence-row" key={item.id}>
            <div><strong>{preview(item.posts?.body||'Публикация')}</strong><span>{'Каждые ' + item.interval_days + ' дн. · следующий запуск ' + new Date(item.next_run_at).toLocaleString('ru-RU') + ' · выполнено ' + item.run_count + (item.max_runs ? ' из ' + item.max_runs : '')}</span></div>
            {item.active?<button className="secondary danger-button" onClick={()=>void stop(item.id)}>Остановить</button>:<span className="admin-status suspended">Остановлен</span>}
          </div>)}
          {!items.length&&<div className="empty small-empty">Повторов пока нет.</div>}
        </div>
      </section>
      {message&&<div className="auth-message">{message}</div>}
    </section>
  </AppShell>;
}
