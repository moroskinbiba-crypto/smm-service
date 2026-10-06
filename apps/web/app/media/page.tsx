'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Media={name:string;path:string;signed_url:string|null;created_at:string|null};

export default function MediaPage(){
  const [items,setItems]=useState<Media[]>([]);
  const [message,setMessage]=useState('');
  async function load(){const r=await appRequest<{media:Media[]}>('list-media');setItems(r.media??[])}
  useEffect(()=>{void load().catch(e=>setMessage(e instanceof Error?e.message:'Не удалось загрузить медиатеку'))},[]);
  async function remove(path:string){
    if(!window.confirm('Удалить этот файл?'))return;
    try{await appRequest('delete-media',{path});await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось удалить файл')}
  }
  return <AppShell active="media">
    <section className="page-section media-library-page">
      <div className="page-heading"><div><div className="eyebrow">МЕДИАТЕКА</div><h1>Медиа</h1><p>Все изображения рабочего пространства в одном месте.</p></div><button className="secondary" onClick={()=>void load()}>Обновить</button></div>
      <section className="card"><div className="card-head"><h2>Файлы</h2><span>{items.length}</span></div>
        <div className="media-library-grid">
          {items.map(item=><article className="media-library-item" key={item.path}>
            <div className="media-library-preview">{item.signed_url?<img src={item.signed_url} alt="" />:<span>🖼️</span>}</div>
            <div className="media-library-info"><strong>{item.name}</strong><small>{item.created_at?new Date(item.created_at).toLocaleString('ru-RU'):''}</small></div>
            <button className="secondary danger-button" onClick={()=>void remove(item.path)}>Удалить</button>
          </article>)}
          {!items.length&&<div className="empty small-empty">Медиатека пока пуста.</div>}
        </div>
      </section>
      {message&&<div className="auth-message">{message}</div>}
    </section>
  </AppShell>;
}
