'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest, type SocialAccount } from '../../lib/app-api';

const meta: Record<string,{name:string;icon:string;help:string}> = {
  telegram:{name:'Telegram',icon:'✈️',help:'Bot token от BotFather + @username или chat_id канала/чата.'},
  vk:{name:'VK',icon:'VK',help:'Токен сообщества/пользователя с правом wall + ID группы без знака минус.'},
  max:{name:'MAX',icon:'M',help:'Токен бота + chat_id канала/чата.'},
  ok:{name:'Одноклассники',icon:'OK',help:'OAuth access token + application key/secret + ID группы.'},
};

export default function AccountsPage(){
  const [accounts,setAccounts]=useState<SocialAccount[]>([]);
  const [platform,setPlatform]=useState<'telegram'|'vk'|'max'|'ok'>('telegram');
  const [token,setToken]=useState(''); const [externalId,setExternalId]=useState('');
  const [name,setName]=useState(''); const [appKey,setAppKey]=useState(''); const [appSecret,setAppSecret]=useState('');
  const [busy,setBusy]=useState(false); const [msg,setMsg]=useState('');
  async function load(){const r=await appRequest<{accounts:SocialAccount[]}>('list-accounts');setAccounts(r.accounts??[]);return r.accounts??[]}
  async function refreshHealth(list:SocialAccount[]){const targets=list.filter(a=>a.status==='connected');if(!targets.length)return;const checked=await Promise.all(targets.map(a=>appRequest<{account:SocialAccount}>('check-account',{account_id:a.id}).then(x=>x.account).catch(()=>a)));setAccounts(v=>v.map(a=>checked.find(x=>x.id===a.id)??a))}
  useEffect(()=>{let cancelled=false;void load().then(list=>{if(!cancelled)void refreshHealth(list)}).catch(e=>setMsg(e instanceof Error?e.message:'Не удалось загрузить аккаунты'));const timer=window.setInterval(()=>{void load().then(list=>refreshHealth(list)).catch(()=>undefined)},5*60*1000);return()=>{cancelled=true;window.clearInterval(timer)}},[]);
  async function connect(){setBusy(true);setMsg('');try{const metadata:any={};if(platform==='ok')metadata.application_key=appKey;if(platform==='ok')metadata.group_id=externalId;const r=await appRequest<{account:SocialAccount}>('connect-account',{platform,access_token:token,external_id:externalId,display_name:name||undefined,client_secret:platform==='ok'?appSecret:undefined,metadata});setAccounts(v=>[...v,r.account]);setToken('');setExternalId('');setName('');setAppKey('');setAppSecret('')}catch(e){setMsg(e instanceof Error?e.message:'Не удалось подключить')}finally{setBusy(false)}}
  async function check(id:string){try{const r=await appRequest<{account:SocialAccount}>('check-account',{account_id:id});setAccounts(v=>v.map(a=>a.id===id?r.account:a))}catch(e){setMsg(e instanceof Error?e.message:'Проверка не удалась')}}
  async function disconnect(id:string){if(!confirm('Отключить этот аккаунт?'))return;try{await appRequest('disconnect-account',{account_id:id});setAccounts(v=>v.filter(a=>a.id!==id))}catch(e){setMsg(e instanceof Error?e.message:'Не удалось отключить')}}
  return <AppShell active="accounts"><section className="page-section"><div className="page-heading"><div><div className="eyebrow">СОЦИАЛЬНЫЕ СЕТИ</div><h1>Доступные аккаунты</h1><p>Подключайте площадки и следите за их состоянием.</p></div></div>
    <div className="account-page-grid"><section className="card"><div className="card-head"><h2>Подключённые аккаунты</h2><span>{accounts.length}</span></div><div className="connected-list">{accounts.map(a=><div className="connected-account" key={a.id}><div className="connected-icon">{meta[a.platform]?.icon??'◎'}</div><div className="connected-main"><strong>{a.display_name||a.username||a.external_id}</strong><span>{meta[a.platform]?.name??a.platform} · {a.external_id}</span>{a.last_error&&<small className="error-text">{a.last_error}</small>}</div><span className={a.status==='connected'?'account-status connected':'account-status error'}>{a.status==='connected'?'Работает':'Ошибка'}</span><button className="secondary" onClick={()=>void check(a.id)}>Проверить</button><button className="secondary danger-button" onClick={()=>void disconnect(a.id)}>Отключить</button></div>)}{!accounts.length&&<div className="empty small-empty">Пока нет подключённых аккаунтов.</div>}</div></section>
    <section className="card connect-card"><div className="card-head"><h2>Добавить аккаунт</h2><span>секреты хранятся зашифрованно</span></div><div className="platform-tabs">{Object.entries(meta).map(([id,v])=><button key={id} className={platform===id?'platform-tab active':'platform-tab'} onClick={()=>setPlatform(id as typeof platform)}><b>{v.icon}</b>{v.name}</button>)}</div><p className="section-copy">{meta[platform].help}</p>
      <label>Токен доступа<input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="Вставьте токен"/></label>
      <label>{platform==='telegram'?'Chat ID / @username':platform==='vk'?'ID группы':platform==='max'?'Chat ID':'ID группы'}<input value={externalId} onChange={e=>setExternalId(e.target.value)} placeholder={platform==='telegram'?'@my_channel':'Например, 123456789'}/></label>
      {platform==='ok'&&<><label>Application key<input value={appKey} onChange={e=>setAppKey(e.target.value)}/></label><label>Application secret<input type="password" value={appSecret} onChange={e=>setAppSecret(e.target.value)}/></label></>}
      <label>Название в сервисе <input value={name} onChange={e=>setName(e.target.value)} placeholder={meta[platform].name}/></label>
      {msg&&<div className="auth-message">{msg}</div>}
      <button className="primary" disabled={busy||!token||!externalId} onClick={()=>void connect()}>{busy?'Проверяем и подключаем…':'Подключить аккаунт'}</button>
    </section></div>
  </section></AppShell>
}
