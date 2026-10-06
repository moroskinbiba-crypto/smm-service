'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Topic={term:string;count:number;avg_views:number;views:number;posts:number};
type Weekday={label:string;posts:number;avg_views:number};

export default function ContentPage(){
  const [topics,setTopics]=useState<Topic[]>([]);
  const [best,setBest]=useState<Topic[]>([]);
  const [weekdays,setWeekdays]=useState<Weekday[]>([]);
  const [analyzed,setAnalyzed]=useState(0);
  const [message,setMessage]=useState('');

  async function load(){
    try{
      const r=await appRequest<{posts_analyzed:number;topics:Topic[];best_topics:Topic[];weekdays:Weekday[]}>('content-insights');
      setAnalyzed(r.posts_analyzed||0);setTopics(r.topics||[]);setBest(r.best_topics||[]);setWeekdays(r.weekdays||[]);
    }catch(e){setMessage(e instanceof Error?e.message:'Не удалось собрать контент-аналитику')}
  }
  useEffect(()=>{void load()},[]);

  return <AppShell active="content">
    <section className="page-section content-page">
      <div className="page-heading"><div><div className="eyebrow">КОНТЕНТ</div><h1>Контент-аналитика</h1><p>Темы и слова, которые чаще всего встречаются в ваших публикациях и получают больше просмотров.</p></div><button className="secondary" onClick={()=>void load()}>Обновить</button></div>
      <div className="stats-grid">
        <section className="card metric-card"><span>Проанализировано</span><strong>{analyzed}</strong><small>публикаций</small></section>
        <section className="card metric-card"><span>Основных тем</span><strong>{topics.length}</strong><small>ключевых слов</small></section>
        <section className="card metric-card"><span>Лучший день</span><strong>{weekdays[0]?.label||'—'}</strong><small>по средним просмотрам</small></section>
      </div>
      <section className="stats-two-column">
        <section className="card"><div className="card-head"><h2>Частые темы</h2><span>по количеству публикаций</span></div><div className="topic-cloud">{topics.slice(0,20).map((topic,i)=><span key={topic.term} style={{fontSize:Math.max(12,20-i*0.35)}}>{topic.term} <small>{topic.count}</small></span>)}</div></section>
        <section className="card"><div className="card-head"><h2>Лучшие темы</h2><span>по средним просмотрам</span></div><div className="stats-detail-list">{best.slice(0,10).map(topic=><div key={topic.term}><span>{topic.term} · {topic.posts} постов</span><strong>{topic.avg_views.toLocaleString('ru-RU')}</strong></div>)}</div></section>
      </section>
      <section className="card"><div className="card-head"><h2>Лучшие дни недели</h2><span>по средним просмотрам</span></div><div className="stats-detail-list">{weekdays.slice(0,7).map(day=><div key={day.label}><span>{day.label} · {day.posts} публикаций</span><strong>{day.avg_views.toLocaleString('ru-RU')}</strong></div>)}</div></section>
      {message&&<div className="auth-message">{message}</div>}
    </section>
  </AppShell>;
}
