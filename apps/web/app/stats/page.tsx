'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Summary={posts:number;published:number;scheduled:number;failed:number;views:number;likes:number;comments:number;reposts:number};
type Platform={platform:string;published:number;failed:number;views:number;likes:number;comments:number;reposts:number};

export default function StatsPage(){
  const [period,setPeriod]=useState<'7'|'30'|'90'>('30'); const [summary,setSummary]=useState<Summary|null>(null); const [platforms,setPlatforms]=useState<Platform[]>([]); const [msg,setMsg]=useState('');
  async function load(){const end=new Date();const start=new Date(Date.now()-Number(period)*86400000);const r=await appRequest<{summary:Summary;by_platform:Platform[]}>('stats',{from:start.toISOString(),to:end.toISOString()});setSummary(r.summary);setPlatforms(r.by_platform??[])}
  useEffect(()=>{void load().catch(e=>setMsg(e instanceof Error?e.message:'Не удалось загрузить статистику'))},[period]);
  const cards=[['Публикации',summary?.posts??0,'за период'],['Опубликовано',summary?.published??0,'успешных'],['Запланировано',summary?.scheduled??0,'в очереди'],['Ошибки',summary?.failed??0,'требуют внимания'],['Просмотры',summary?.views??0,'получены из API'],['Лайки',summary?.likes??0,'собранные реакции']];
  return <AppShell active="stats"><section className="page-section"><div className="page-heading"><div><div className="eyebrow">АНАЛИТИКА</div><h1>Статистика</h1><p>Публикации, статусы и доступные метрики по площадкам.</p></div><div className="period-switch">{[['7','7 дней'],['30','30 дней'],['90','90 дней']].map(([id,name])=><button key={id} className={period===id?'secondary active-period':'secondary'} onClick={()=>setPeriod(id as typeof period)}>{name}</button>)}</div></div>
    <div className="stats-grid">{cards.map(c=><section className="card metric-card" key={c[0] as string}><span>{c[0]}</span><strong>{c[1]}</strong><small>{c[2]}</small></section>)}</div>
    <section className="card"><div className="card-head"><h2>По площадкам</h2><span>собирается автоматически</span></div><div className="stats-table"><div className="stats-row stats-head"><span>Площадка</span><span>Опубликовано</span><span>Ошибки</span><span>Просмотры</span><span>Лайки</span></div>{platforms.map(p=><div className="stats-row" key={p.platform}><span><strong>{({telegram:'Telegram',vk:'VK',max:'MAX',ok:'Одноклассники'} as Record<string,string>)[p.platform]??p.platform}</strong></span><span>{p.published}</span><span>{p.failed}</span><span>{p.views}</span><span>{p.likes}</span></div>)}{!platforms.length&&<div className="empty small-empty">Пока нет данных. После первой публикации статистика появится здесь.</div>}</div></section>
    {msg&&<div className="auth-message">{msg}</div>}
  </section></AppShell>
}
