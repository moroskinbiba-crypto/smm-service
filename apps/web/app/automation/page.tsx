'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Rule={id:string;name:string;trigger_type:string;action_type:string;enabled:boolean;created_at:string};

const triggerLabels:Record<string,string>={
  publication_success:'Публикация успешно вышла',
  publication_failure:'Публикация завершилась ошибкой',
  approval_requested:'Пост отправлен на согласование',
  approval_reviewed:'Согласование обработано',
};

export default function AutomationPage(){
  const [rules,setRules]=useState<Rule[]>([]);
  const [name,setName]=useState('');
  const [trigger,setTrigger]=useState('publication_failure');
  const [message,setMessage]=useState('');

  async function load(){const r=await appRequest<{rules:Rule[]}>('list-automation-rules');setRules(r.rules??[])}
  useEffect(()=>{void load().catch(e=>setMessage(e instanceof Error?e.message:'Не удалось загрузить автоматизацию'))},[]);

  async function add(){
    try{await appRequest('create-automation-rule',{name:name||triggerLabels[trigger],trigger_type:trigger,action_type:'notify_team'});setName('');await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось создать правило')}
  }
  async function toggle(rule:Rule){try{await appRequest('toggle-automation-rule',{rule_id:rule.id,enabled:!rule.enabled});await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось изменить правило')}}
  async function remove(id:string){if(!window.confirm('Удалить правило?'))return;try{await appRequest('delete-automation-rule',{rule_id:id});await load()}catch(e){setMessage(e instanceof Error?e.message:'Не удалось удалить правило')}}

  return <AppShell active="automation">
    <section className="page-section automation-page">
      <div className="page-heading"><div><div className="eyebrow">АВТОМАТИЗАЦИЯ</div><h1>Правила</h1><p>Автоматические реакции сервиса на публикации и согласования.</p></div></div>
      <section className="card automation-create">
        <div className="card-head"><h2>Новое правило</h2><span>Действие сейчас — уведомить команду</span></div>
        <div className="automation-form"><label>Название<input value={name} onChange={e=>setName(e.target.value)} placeholder="Например: сообщать об ошибках"/></label><label>Событие<select value={trigger} onChange={e=>setTrigger(e.target.value)}>{Object.entries(triggerLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label></div>
        <button className="primary" onClick={()=>void add()}>Создать правило</button>
      </section>
      <section className="card"><div className="card-head"><h2>Правила команды</h2><span>{rules.length}</span></div><div className="automation-list">
        {rules.map(rule=><div className="automation-row" key={rule.id}><div><strong>{rule.name}</strong><span>Если: {triggerLabels[rule.trigger_type]||rule.trigger_type} → уведомить команду</span></div><button className={rule.enabled?'secondary':'secondary active-period'} onClick={()=>void toggle(rule)}>{rule.enabled?'Включено':'Выключено'}</button><button className="secondary danger-button" onClick={()=>void remove(rule.id)}>Удалить</button></div>)}
        {!rules.length&&<div className="empty small-empty">Автоматических правил пока нет.</div>}
      </div></section>
      {message&&<div className="auth-message">{message}</div>}
    </section>
  </AppShell>;
}
