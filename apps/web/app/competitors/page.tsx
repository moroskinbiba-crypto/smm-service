'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Competitor = {
  id:string; platform:string; name:string; external_ref:string; url:string|null;
  competitor_snapshots?: Array<{followers:number|null;posts_7d:number|null;avg_views:number|null;avg_engagement:number|null;collected_at:string}>
};

const labels:Record<string,string>={telegram:'Telegram',vk:'VK',max:'MAX',ok:'Одноклассники'};

export default function CompetitorsPage(){
  const [items,setItems]=useState<Competitor[]>([]);
  const [platform,setPlatform]=useState('vk');
  const [name,setName]=useState('');
  const [ref,setRef]=useState('');
  const [url,setUrl]=useState('');
  const [busy,setBusy]=useState('');
  const [message,setMessage]=useState('');

  async function load(){const r=await appRequest<{competitors:Competitor[]}>('list-competitors');setItems(r.competitors??[]);}
  useEffect(()=>{void load().catch(e=>setMessage(e instanceof Error?e.message:'Не удалось загрузить конкурентов'))},[]);

  async function add(){setBusy('add');try{await appRequest('create-competitor',{platform,name,external_ref:ref,url});setName('');setRef('');setUrl('');await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось добавить конкурента')}finally{setBusy('')}}
  async function refresh(id:string){setBusy(id);try{await appRequest('refresh-competitor',{competitor_id:id});await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось обновить конкурента')}finally{setBusy('')}}
  async function remove(id:string){if(!window.confirm('Удалить конкурента?'))return;try{await appRequest('delete-competitor',{competitor_id:id});await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось удалить конкурента')}}

  return <AppShell active="competitors">
    <section className="page-section competitors-page">
      <div className="page-heading"><div><div className="eyebrow">РАЗВЕДКА</div><h1>Конкуренты</h1><p>Следите за публичными показателями конкурентов.</p></div></div>
      <section className="card competitor-create">
        <div className="card-head"><h2>Добавить конкурента</h2><span>Автообновление доступно для VK и Telegram при наличии нужного доступа</span></div>
        <div className="competitor-form">
          <label>Площадка<select value={platform} onChange={e=>setPlatform(e.target.value)}>{Object.entries(labels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
          <label>Название<input value={name} onChange={e=>setName(e.target.value)} placeholder="Название конкурента"/></label>
          <label>Идентификатор<input value={ref} onChange={e=>setRef(e.target.value)} placeholder="ID или username"/></label>
          <label>URL<input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://…"/></label>
        </div>
        <button className="primary" disabled={busy==='add'} onClick={()=>void add()}>{busy==='add'?'Добавляем…':'Добавить'}</button>
      </section>
      <section className="competitor-list">
        {items.map(item=>{const s=item.competitor_snapshots?.slice(-1)[0];return <article className="card competitor-card" key={item.id}>
          <div className="competitor-card-head"><div><div className="eyebrow">{labels[item.platform]||item.platform}</div><h2>{item.name}</h2><span>{item.external_ref}{item.url?' · '+item.url:''}</span></div><div className="competitor-card-actions"><button className="secondary" disabled={busy===item.id} onClick={()=>void refresh(item.id)}>{busy===item.id?'Обновляем…':'Обновить'}</button><button className="secondary danger-button" onClick={()=>void remove(item.id)}>Удалить</button></div></div>
          <div className="competitor-metrics"><div><span>Подписчики</span><strong>{s?.followers==null?'—':Number(s.followers).toLocaleString('ru-RU')}</strong></div><div><span>Постов за 7 дней</span><strong>{s?.posts_7d==null?'—':s.posts_7d}</strong></div><div><span>Средние просмотры</span><strong>{s?.avg_views==null?'—':Math.round(Number(s.avg_views)).toLocaleString('ru-RU')}</strong></div><div><span>Средняя вовлечённость</span><strong>{s?.avg_engagement==null?'—':Number(s.avg_engagement).toLocaleString('ru-RU',{maximumFractionDigits:1})}</strong></div></div>
          {s?.collected_at&&<small className="competitor-updated">Обновлено {new Date(s.collected_at).toLocaleString('ru-RU')}</small>}
        </article>})}
        {!items.length&&<section className="card"><div className="empty small-empty">Список конкурентов пока пуст.</div></section>}
      </section>
      {message&&<div className="auth-message">{message}</div>}
    </section>
  </AppShell>;
}
