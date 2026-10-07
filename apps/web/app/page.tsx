'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from './components/app-shell';
import { appRequest, type ApiPost, type SocialAccount, uploadMedia } from '../lib/app-api';

type AccountGroup={id:string;name:string;description:string|null;account_ids:string[]};
type PublishedMedia={name:string;path:string;signed_url:string|null;created_at:string|null};
const meta: Record<string, {name:string; icon:string}> = {
  telegram:{name:'Telegram',icon:'➤'}, vk:{name:'VK',icon:'vk'},
  max:{name:'MAX',icon:'M'}, ok:{name:'Одноклассники',icon:'OK'},
  instagram:{name:'Instagram',icon:'◎'}
};
const logoClass=(platform:string)=>'social-card-logo social-card-logo-'+platform;
const emojis = ['😀','😂','😍','🔥','👍','❤️','🎉','✨','📌','📣','🚀','💡','👏','😊','🥳','🤝','✅','❗'];
const pad=(n:number)=>String(n).padStart(2,'0');
const label=(s:string)=>({draft:'Черновик',scheduled:'Запланировано',publishing:'Публикуется',published:'Опубликовано',partially_published:'Частично',failed:'Ошибка',canceled:'Отменено'} as Record<string,string>)[s] ?? s;
function range(d:Date){return {from:new Date(d.getFullYear(),d.getMonth()-1,1).toISOString(),to:new Date(d.getFullYear(),d.getMonth()+2,0,23,59,59).toISOString()};}
function preview(p:ApiPost){const x=p.body.replace(/\s+/g,' ').trim();return x.length>20?x.slice(0,20)+'…':x||'Без текста';}

function parseCsv(input:string){
  const rows:string[][]=[]; let row:string[]=[]; let cell=''; let quoted=false;
  for(let i=0;i<input.length;i++){
    const ch=input[i];
    const next=input[i+1];
    if(ch==='"' && quoted && next==='"'){cell+='"';i++;continue}
    if(ch==='"'){quoted=!quoted;continue}
    if(!quoted && ch===','){row.push(cell);cell='';continue}
    if(!quoted && (ch==='\n'||ch==='\r')){
      if(ch==='\r'&&next==='\n')i++;
      row.push(cell);cell='';
      if(row.some(value=>value.trim()!==''))rows.push(row);
      row=[];continue;
    }
    cell+=ch;
  }
  if(cell!==''||row.length){row.push(cell);if(row.some(value=>value.trim()!==''))rows.push(row)}
  return rows;
}

function Editor(props:{post:ApiPost|null;accounts:SocialAccount[];groups:AccountGroup[];workspaceId:string;workspaceRole:string;approvalsEnabled:boolean;onClose:()=>void;onSaved:()=>Promise<void>}){
  const {post,accounts,groups,workspaceId,workspaceRole,approvalsEnabled,onClose,onSaved}=props;
  const base=post?.scheduled_at?new Date(post.scheduled_at):new Date(Date.now()+3600000);
  const [text,setText]=useState(post?.body??'');
  const [selected,setSelected]=useState<string[]>(post?.post_targets.map(t=>t.social_account_id)??accounts.filter(a=>a.status==='connected').map(a=>a.id));
  const [selectedGroupId,setSelectedGroupId]=useState('');
  const [publicationTypes,setPublicationTypes]=useState<Record<string,'feed'|'reel'|'story'|'clip'>>(
    Object.fromEntries((post?.post_targets??[]).map(t=>[t.social_account_id,(t.publication_type as 'feed'|'reel'|'story'|'clip'|undefined)||'feed']))
  );
  const [date,setDate]=useState(String(base.getFullYear())+'-'+pad(base.getMonth()+1)+'-'+pad(base.getDate()));
  const [time,setTime]=useState(pad(base.getHours())+':'+pad(base.getMinutes()));
  const [media,setMedia]=useState(post?.media??[]);
  const [busy,setBusy]=useState(false); const [msg,setMsg]=useState(''); const [showEmoji,setShowEmoji]=useState(false);
  const [showAI,setShowAI]=useState(false); const [aiMode,setAiMode]=useState('improve'); const [aiBusy,setAiBusy]=useState(false);
  const [showUTM,setShowUTM]=useState(false);
  const [publishedMedia,setPublishedMedia]=useState<PublishedMedia[]>([]);
  const [selectedPublishedMedia,setSelectedPublishedMedia]=useState<string[]>([]);
  const [publishedMediaBusy,setPublishedMediaBusy]=useState(false); const [utmSource,setUtmSource]=useState(''); const [utmMedium,setUtmMedium]=useState('social'); const [utmCampaign,setUtmCampaign]=useState(''); const [utmContent,setUtmContent]=useState('');
  function applyGroup(groupId:string){
    setSelectedGroupId(groupId);
    const group=groups.find(g=>g.id===groupId);
    if(!group)return;
    const available=new Set(accounts.filter(a=>a.status==='connected').map(a=>a.id));
    setSelected(group.account_ids.filter(id=>available.has(id)));
  }
  async function files(fs:FileList|File[]){setBusy(true);setMsg('');try{const incoming=Array.from(fs);if(media.length+incoming.length>10)throw new Error('В одной публикации можно добавить не более 10 медиафайлов');const next: Awaited<ReturnType<typeof uploadMedia>>[]=[];for(const f of incoming)next.push(await uploadMedia(workspaceId,f));setMedia(v=>[...v,...next]);}catch(e){setMsg(e instanceof Error?e.message:'Не удалось загрузить файл')}finally{setBusy(false)}}
  function wrap(a:string,b=a){const el=document.querySelector<HTMLTextAreaElement>('#post-text');if(!el)return;const s=el.selectionStart,e=el.selectionEnd;if(s===e)return;setText(text.slice(0,s)+a+text.slice(s,e)+b+text.slice(e));requestAnimationFrame(()=>{el.focus();el.setSelectionRange(s+a.length,e+a.length)})}
  async function save(kind:'draft'|'schedule'|'publish'){if(!selected.length){setMsg('Выберите хотя бы один аккаунт.');return}if(!text.trim()&&!media.length){setMsg('Добавьте текст или медиафайл.');return}setBusy(true);setMsg('');try{const x=await appRequest<{post_id:string}>('save-post',{post_id:post?.id,text,media,scheduled_at:kind==='draft'?null:new Date(date+'T'+time).toISOString(),target_account_ids:selected,target_publication_types:publicationTypes});if(kind==='publish'){const result=await appRequest<{status:string;results?:Array<{ok:boolean;error?:string}>}>('publish-now',{post_id:x.post_id});if(result.status!=='published'){await onSaved();const errors=(result.results??[]).filter(r=>!r.ok).map(r=>r.error).filter(Boolean);setMsg('Публикация завершена со статусом «'+label(result.status)+'». '+(errors.length?errors.join(' · '):'Проверьте статусы площадок.'));return;}}await onSaved();onClose()}catch(e){setMsg(e instanceof Error?e.message:'Не удалось сохранить')}finally{setBusy(false)}}
  useEffect(() => {
    void appRequest<{media:PublishedMedia[]}>('list-media').then(result => setPublishedMedia(result.media ?? [])).catch(() => undefined);
  }, []);

  async function deleteSelectedPublishedMedia() {
    if (!selectedPublishedMedia.length) return;
    if (!window.confirm('Удалить выбранные медиа? Файлы, которые используются в публикациях, сервис не удалит.')) return;
    setPublishedMediaBusy(true);
    setMsg('');
    const failed:string[]=[];
    for (const path of selectedPublishedMedia) {
      try { await appRequest('delete-media',{path}); }
      catch (e) { failed.push(e instanceof Error ? e.message : 'Не удалось удалить файл'); }
    }
    try {
      const result=await appRequest<{media:PublishedMedia[]}>('list-media');
      setPublishedMedia(result.media ?? []);
    } catch {}
    setSelectedPublishedMedia([]);
    if (failed.length) setMsg(failed.join(' · '));
    setPublishedMediaBusy(false);
  }

  function applyUTM(){
    const el=document.querySelector<HTMLTextAreaElement>('#post-text');
    const source=el?.value??text;
    let url='';
    let start=0;
    let end=0;
    if(el){
      start=el.selectionStart;end=el.selectionEnd;
      const selectedText=source.slice(start,end).trim();
      if(selectedText) url=selectedText;
    }
    if(!url){
      const entered=window.prompt('URL для UTM','https://');
      if(!entered)return;
      url=entered;
    }
    try{
      const u=new URL(url);
      if(utmSource)u.searchParams.set('utm_source',utmSource);
      if(utmMedium)u.searchParams.set('utm_medium',utmMedium);
      if(utmCampaign)u.searchParams.set('utm_campaign',utmCampaign);
      if(utmContent)u.searchParams.set('utm_content',utmContent);
      const next=u.toString();
      if(el&&start!==end){
        setText(source.slice(0,start)+next+source.slice(end));
      }else{
        setText(v=>v+(v.trim()?'\n':'')+next);
      }
      setShowUTM(false);
    }catch{setMsg('Введите корректный URL')}
  }

  async function runAI(){
    const source=text.trim();
    if(!source){setMsg('Добавьте текст, чтобы AI мог его обработать.');return;}
    setAiBusy(true);setMsg('');
    try{
      const platformName=selected.length===1?accounts.find(a=>a.id===selected[0])?.platform:undefined;
      const result=await appRequest<{text:string}>('ai-generate',{text:source,mode:aiMode,platform:platformName});
      setText(result.text);
      setShowAI(false);
    }catch(e){setMsg(e instanceof Error?e.message:'AI не смог обработать текст')}finally{setAiBusy(false)}
  }
  async function requestApproval(){
    if(!post?.id){setMsg('Сначала сохраните публикацию.');return;}
    setBusy(true);setMsg('');
    try{await appRequest('request-approval',{post_id:post.id});await onSaved();setMsg('Публикация отправлена на согласование.');}
    catch(e){setMsg(e instanceof Error?e.message:'Не удалось отправить на согласование')}finally{setBusy(false)}
  }
  async function reviewApproval(decision:'approved'|'rejected'){
    if(!post?.id)return;
    const prompt=decision==='rejected'?'Причина отклонения (необязательно):':'Комментарий (необязательно):';
    const comment=window.prompt(prompt,'')??'';
    setBusy(true);setMsg('');
    try{await appRequest('review-approval',{post_id:post.id,decision,comment});await onSaved();setMsg(decision==='approved'?'Публикация согласована.':'Публикация отклонена.');}
    catch(e){setMsg(e instanceof Error?e.message:'Не удалось обработать согласование')}finally{setBusy(false)}
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="post-editor-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><div><div className="eyebrow">РЕДАКТОР ПУБЛИКАЦИИ</div><h2>{post?'Изменить публикацию':'Новая публикация'}</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
    <div className="editor-grid"><section>
      <div className="editor-toolbar"><button onClick={()=>wrap('**')}>B</button><button onClick={()=>wrap('*')}>I</button><button onClick={()=>wrap(String.fromCharCode(96))}>&lt;&gt;</button><button onClick={()=>{const el=document.querySelector<HTMLTextAreaElement>('#post-text');if(!el)return;const s=el.selectionStart,e=el.selectionEnd;if(s===e)return;const url=window.prompt('Ссылка', 'https://');if(!url)return;setText(text.slice(0,s)+'['+text.slice(s,e)+']('+url+')'+text.slice(e))}}>🔗</button><button onClick={()=>setShowEmoji(v=>!v)}>😊</button><button className="ai-toolbar-button" onClick={()=>setShowAI(v=>!v)}>✨ AI</button><button onClick={()=>setShowUTM(v=>!v)}>UTM</button></div>
      {showUTM&&<div className="ai-popover utm-popover"><strong>UTM-метки</strong><input value={utmSource} onChange={e=>setUtmSource(e.target.value)} placeholder="utm_source"/><input value={utmMedium} onChange={e=>setUtmMedium(e.target.value)} placeholder="utm_medium"/><input value={utmCampaign} onChange={e=>setUtmCampaign(e.target.value)} placeholder="utm_campaign"/><input value={utmContent} onChange={e=>setUtmContent(e.target.value)} placeholder="utm_content"/><button className="primary" onClick={applyUTM}>Добавить метки</button></div>}{showAI&&<div className="ai-popover"><strong>AI-помощник</strong><select value={aiMode} onChange={e=>setAiMode(e.target.value)}><option value="improve">Улучшить текст</option><option value="shorten">Сократить</option><option value="sales">Сделать продающим</option><option value="headline">5 вариантов заголовка</option><option value="variants">3 варианта поста</option><option value="adapt">Адаптировать под площадку</option></select><button className="primary" disabled={aiBusy} onClick={()=>void runAI()}>{aiBusy?'Генерируем…':'Применить AI'}</button></div>}{showEmoji&&<div className="emoji-popover">{emojis.map(x=><button key={x} onClick={()=>{setText(v=>v+x);setShowEmoji(false)}}>{x}</button>)}</div>}
      <textarea id="post-text" className="post-editor-textarea" value={text} onChange={e=>setText(e.target.value)} placeholder="Текст публикации…" />
      <div className="upload-area" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void files(e.dataTransfer.files)}}><input id="post-file" hidden type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,video/x-matroska" multiple onChange={e=>{if(e.target.files)void files(e.target.files)}}/><label htmlFor="post-file"><strong>Добавить фото или видео</strong><span>до 10 файлов, видео до 50 МБ</span></label></div>
      {!!media.length&&<div className="media-list">{media.map((m,i)=><div className="media-item" key={m.path} draggable onDragStart={e=>e.dataTransfer.setData('text/plain',String(i))} onDragOver={e=>e.preventDefault()} onDrop={e=>{const from=Number(e.dataTransfer.getData('text/plain'));if(Number.isNaN(from)||from===i)return;const n=[...media];const [x]=n.splice(from,1);n.splice(i,0,x);setMedia(n.map((q,j)=>({...q,order:j})))}}><div className="media-thumb">{m.signed_url?(m.type?.startsWith('video/')?<video src={m.signed_url} muted playsInline />:<img src={m.signed_url} alt=""/>):m.type?.startsWith('video/')?'🎬':'🖼️'}</div><div className="media-info"><strong>{m.name}</strong><span>Перетащите или используйте стрелки для изменения порядка</span></div><div className="media-actions"><button className="secondary" disabled={i===0} onClick={()=>{if(i===0)return;const n=[...media];[n[i-1],n[i]]=[n[i],n[i-1]];setMedia(n.map((q,j)=>({...q,order:j})))}}>↑</button><button className="secondary" disabled={i===media.length-1} onClick={()=>{if(i>=media.length-1)return;const n=[...media];[n[i],n[i+1]]=[n[i+1],n[i]];setMedia(n.map((q,j)=>({...q,order:j})))}}>↓</button><button className="secondary" onClick={()=>setMedia(v=>v.filter((_,j)=>j!==i))}>Удалить</button></div></div>)}</div>}
    </section>
    <aside className="editor-aside"><div className="editor-block"><h3>Площадки</h3>
      {!!groups.length&&<><select className="editor-group-select" value={selectedGroupId} onChange={e=>applyGroup(e.target.value)}><option value="">Выбрать группу аккаунтов…</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name} · {g.account_ids.length}</option>)}</select>{selectedGroupId&&<div className="group-selection-note">Группа выбрана. Снимите галочку/нажмите на аккаунт ниже, чтобы исключить отдельные аккаунты из этой публикации.</div>}</>}
      <div className="account-select-list">{accounts.map(a=><div key={a.id} className={selected.includes(a.id)?'account-target-row selected':'account-target-row'}>
  <button onClick={()=>a.status==='connected'&&setSelected(v=>v.includes(a.id)?v.filter(x=>x!==a.id):[...v,a.id])} className="account-select" disabled={a.status!=='connected'}>
    <span className={'network-icon network-logo network-logo-'+a.platform}>{meta[a.platform]?.icon??'•'}</span><span><strong>{a.display_name||a.username||a.external_id}</strong><small>{meta[a.platform]?.name??a.platform}</small></span><span className={a.status==='connected'?'account-state ok':'account-state'}>{a.status==='connected'?'✓':'!'}</span>
  </button>
  {selected.includes(a.id)&&<select className="publication-type-select" value={publicationTypes[a.id]||'feed'} onChange={e=>setPublicationTypes(v=>({...v,[a.id]:e.target.value as any}))}>
    <option value="feed">Пост</option>
    {a.platform==='instagram'&&String(a.metadata?.account_type||'').toUpperCase()==='BUSINESS'&&<option value="story">Сторис</option>}
    {a.platform==='instagram'&&<option value="reel">Reels</option>}
    {a.platform==='vk'&&<option value="clip">Клип</option>}
  </select>}
</div>)}</div>{post?.post_targets?.some(t=>t.last_error)&&<div className="target-errors">{post.post_targets.filter(t=>t.last_error).map(t=><div key={t.id}><strong>{meta[t.platform]?.name??t.platform}:</strong> {t.last_error}</div>)}</div>}{!accounts.length&&<div className="empty small-empty">Подключите аккаунт.</div>}</div>
      <div className="editor-block"><h3>Планирование</h3><div className="schedule-form"><label>Дата<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>Время<input type="time" value={time} onChange={e=>setTime(e.target.value)}/></label></div></div>
      {msg&&<div className="auth-message">{msg}</div>}</aside></div>
    <section className="published-media-section card">
      <div className="card-head"><div><h3>Опубликованные медиа</h3><span>{publishedMedia.length} файлов</span></div><button className="secondary danger-button" disabled={publishedMediaBusy||!selectedPublishedMedia.length} onClick={()=>void deleteSelectedPublishedMedia()}>Удалить выбранные</button></div>
      <div className="published-media-grid">
        {publishedMedia.map(item=><label className={selectedPublishedMedia.includes(item.path)?'published-media-item selected':'published-media-item'} key={item.path}>
          <input type="checkbox" checked={selectedPublishedMedia.includes(item.path)} onChange={event=>setSelectedPublishedMedia(v=>event.target.checked?[...v,item.path]:v.filter(path=>path!==item.path))} />
          <div className="published-media-preview">{item.signed_url?<img src={item.signed_url} alt="" />:<span>🖼️</span>}</div>
          <span className="published-media-name">{item.name}</span>
          <small>{item.created_at?new Date(item.created_at).toLocaleDateString('ru-RU'):''}</small>
        </label>)}
        {!publishedMedia.length&&<div className="empty small-empty">Опубликованных медиа пока нет.</div>}
      </div>
    </section>
    <div className="modal-actions"><div className="modal-actions-left">{approvalsEnabled&&post?.id&&(!post.approval_status || post.approval_status==='not_required' || post.approval_status==='rejected')&&workspaceRole!=='viewer'&&<button className="secondary" disabled={busy} onClick={()=>void requestApproval()}>Отправить на согласование</button>}{approvalsEnabled&&post?.approval_status==='pending'&&<span className="approval-badge approval-pending">Ожидает согласования</span>}{post?.approval_status==='pending'&&['owner','admin','approver'].includes(workspaceRole)&&<><button className="secondary" disabled={busy} onClick={()=>void reviewApproval('approved')}>Одобрить</button><button className="secondary danger-button" disabled={busy} onClick={()=>void reviewApproval('rejected')}>Отклонить</button></>}{post?.status==='scheduled'&&<button className="secondary danger-button" disabled={busy} onClick={async()=>{setBusy(true);setMsg('');try{await appRequest('cancel-post',{post_id:post.id});await onSaved();onClose()}catch(e){setMsg(e instanceof Error?e.message:'Не удалось отменить')}finally{setBusy(false)}}}>Отменить публикацию</button>}<button className="secondary" disabled={busy} onClick={()=>void save('draft')}>Сохранить черновик</button></div><div className="modal-actions-right"><button className="secondary" disabled={busy} onClick={()=>void save('schedule')}>{busy?'Сохраняем…':'Запланировать'}</button><button className="primary modal-primary" disabled={busy} onClick={()=>void save('publish')}>{busy?'Отправляем…':'Опубликовать сейчас'}</button></div></div>
  </div></div>
}

export default function Home(){
  const [workspaceId,setWorkspaceId]=useState(''); const [workspaceName,setWorkspaceName]=useState('Рабочее пространство'); const [workspaceRole,setWorkspaceRole]=useState('owner'); const [workspaceApprovalEnabled,setWorkspaceApprovalEnabled]=useState(false); const [accounts,setAccounts]=useState<SocialAccount[]>([]); const [groups,setGroups]=useState<AccountGroup[]>([]); const [selectedIds,setSelectedIds]=useState<string[]>([]); const [bulkBusy,setBulkBusy]=useState(false); const [importBusy,setImportBusy]=useState(false); const [posts,setPosts]=useState<ApiPost[]>([]); const [cursor,setCursor]=useState(new Date()); const [view,setView]=useState<'month'|'week'|'day'>('month'); const [editor,setEditor]=useState<ApiPost|null|undefined>(undefined); const [msg,setMsg]=useState('');
  async function load(){const [a,g,p]=await Promise.all([
    appRequest<{accounts:SocialAccount[]}>('list-accounts'),
    appRequest<{groups:AccountGroup[]}>('list-account-groups'),
    appRequest<{posts:ApiPost[];workspace:{workspace_id:string;workspace_name:string;role:string}}>('list-posts',range(cursor))
  ]);setWorkspaceId(p.workspace.workspace_id);setWorkspaceName(p.workspace.workspace_name);setWorkspaceRole(p.workspace.role||'viewer');setWorkspaceApprovalEnabled(p.workspace.approvals_enabled===true);setAccounts(a.accounts??[]);setGroups(g.groups??[]);setPosts(p.posts??[])}
  useEffect(()=>{void load().catch(e=>setMsg(e instanceof Error?e.message:'Не удалось загрузить план'))},[cursor.toISOString().slice(0,7)]);
  const days=useMemo(()=>{if(view==='month'){const f=new Date(cursor.getFullYear(),cursor.getMonth(),1);const off=(f.getDay()+6)%7;const l=new Date(cursor.getFullYear(),cursor.getMonth()+1,0).getDate();const total=Math.ceil((off+l)/7)*7;return Array.from({length:total},(_,i)=>new Date(cursor.getFullYear(),cursor.getMonth(),i-off+1))}const f=new Date(cursor);const monday=new Date(f);monday.setDate(f.getDate()-((f.getDay()+6)%7));if(view==='week')return Array.from({length:7},(_,i)=>new Date(monday.getFullYear(),monday.getMonth(),monday.getDate()+i));return [new Date(cursor)]},[cursor,view]);
  const byDay=useMemo(()=>{const m=new Map<string,ApiPost[]>();for(const p of posts){const d=p.scheduled_at||(p.status==='published'?p.created_at:null);if(!d)continue;const k=new Date(d).toISOString().slice(0,10);m.set(k,[...(m.get(k)??[]),p])}return m},[posts]);
  async function bulk(action:'delete'|'clone'|'shift') {
    if(!selectedIds.length)return;
    if(action==='delete' && !window.confirm('Удалить выбранные публикации?'))return;
    setBulkBusy(true);setMsg('');
    try{
      if(action==='delete') await appRequest('bulk-delete-posts',{post_ids:selectedIds});
      if(action==='clone') await appRequest('bulk-clone-posts',{post_ids:selectedIds});
      if(action==='shift'){
        const raw=window.prompt('На сколько минут перенести? Например 60 или -30','60');
        if(raw===null)return;
        const delta=Number(raw);
        if(!Number.isFinite(delta))throw new Error('Введите число минут');
        await appRequest('bulk-reschedule-posts',{post_ids:selectedIds,delta_minutes:delta});
      }
      setSelectedIds([]);
      await load();
    }catch(e){setMsg(e instanceof Error?e.message:'Массовая операция не выполнена')}finally{setBulkBusy(false)}
  }
  async function importCsv(file:File){
    setImportBusy(true);setMsg('');
    try{
      const text=await file.text();
      const rows=parseCsv(text);
      if(rows.length<2)throw new Error('CSV должен содержать заголовок и хотя бы одну строку');
      const headers=rows[0].map(h=>h.trim().toLowerCase());
      const indexOf=(name:string)=>headers.indexOf(name);
      const textIndex=indexOf('text');
      if(textIndex<0)throw new Error('В CSV обязателен столбец text');
      const dateIndex=indexOf('date');
      const timeIndex=indexOf('time');
      const platformsIndex=indexOf('platforms');
      const payload=rows.slice(1).map(row=>({
        text:row[textIndex]??'',
        date:dateIndex>=0?row[dateIndex]??'':'',
        time:timeIndex>=0?row[timeIndex]??'':'',
        platforms:platformsIndex>=0?row[platformsIndex]??'':'all',
      }));
      const result=await appRequest<{created:string[];errors:string[]}>('import-posts',{rows:payload});
      setMsg('Импортировано: '+result.created.length+(result.errors?.length?' · ошибок: '+result.errors.length:''));
      await load();
    }catch(e){setMsg(e instanceof Error?e.message:'Не удалось импортировать CSV')}finally{setImportBusy(false)}
  }

  async function remove(id:string){try{await appRequest('delete-post',{post_id:id});await load()}catch(e){setMsg(e instanceof Error?e.message:'Не удалось удалить')}}
  function startDrag(postId:string,e:React.DragEvent){e.dataTransfer.setData('text/plain',postId);e.dataTransfer.effectAllowed='move'}
  async function dropOnDay(day:Date,e:React.DragEvent){
    e.preventDefault();
    const postId=e.dataTransfer.getData('text/plain');
    const post=posts.find(item=>item.id===postId);
    if(!post)return;
    const base=post.scheduled_at?new Date(post.scheduled_at):new Date();
    const next=new Date(day.getFullYear(),day.getMonth(),day.getDate(),base.getHours(),base.getMinutes());
    if(next.getTime()<=Date.now()){setMsg('Нельзя перенести публикацию в прошлое.');return}
    try{await appRequest('reschedule-post',{post_id:post.id,scheduled_at:next.toISOString()});await load()}catch(e){setMsg(e instanceof Error?e.message:'Не удалось перенести публикацию')}
  }
  return <AppShell active="plan"><section className="page-section"><div className="page-heading"><div><div className="eyebrow">ПЛАН ПУБЛИКАЦИЙ</div><h1>{workspaceName}</h1><p>Календарь, редактор, медиа и планирование публикаций.</p></div><div className="plan-heading-actions"><input id="csv-import" type="file" accept=".csv,text/csv" hidden onChange={e=>{const file=e.target.files?.[0];if(file)void importCsv(file);e.currentTarget.value=''}}/><label className="secondary" htmlFor="csv-import">{importBusy?'Импортируем…':'Импорт CSV'}</label><button className="plus-button" onClick={()=>setEditor(null)}>＋</button></div></div>
    <section className="card calendar-preview"><div className="calendar-toolbar"><div className="calendar-nav"><button className="secondary" onClick={()=>setCursor(view==='day'?new Date(cursor.getFullYear(),cursor.getMonth(),cursor.getDate()-1):view==='week'?new Date(cursor.getFullYear(),cursor.getMonth(),cursor.getDate()-7):new Date(cursor.getFullYear(),cursor.getMonth()-1,1))}>←</button><strong>{view==='day'?cursor.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'}):cursor.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})}</strong><button className="secondary" onClick={()=>setCursor(view==='day'?new Date(cursor.getFullYear(),cursor.getMonth(),cursor.getDate()+1):view==='week'?new Date(cursor.getFullYear(),cursor.getMonth(),cursor.getDate()+7):new Date(cursor.getFullYear(),cursor.getMonth()+1,1))}>→</button><button className="secondary" onClick={()=>setCursor(new Date())}>Сегодня</button><button className={view==='month'?'secondary active-period':'secondary'} onClick={()=>setView('month')}>Месяц</button><button className={view==='week'?'secondary active-period':'secondary'} onClick={()=>setView('week')}>Неделя</button><button className={view==='day'?'secondary active-period':'secondary'} onClick={()=>setView('day')}>День</button></div><span>{posts.length} публикаций</span></div>
      <div className={"calendar-grid calendar-view-"+view}>{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d=><div className="calendar-weekday" key={d}>{d}</div>)}{days.map(d=>{const k=d.toISOString().slice(0,10);const ev=byDay.get(k)??[];return <div key={k} className={(view==='month'&&d.getMonth()!==cursor.getMonth())?'calendar-cell muted-day':'calendar-cell'} onDragOver={e=>e.preventDefault()} onDrop={e=>void dropOnDay(d,e)}><span>{d.getDate()}</span>{ev.slice(0,3).map(p=><button key={p.id} draggable onDragStart={e=>startDrag(p.id,e)} className="calendar-post" onClick={()=>setEditor(p)}>{p.media[0]?.signed_url&&<img src={p.media[0].signed_url} alt=""/>}<div className="calendar-post-logos">{p.post_targets.map(t=><span key={t.id} className={logoClass(t.platform)}>{meta[t.platform]?.icon??'•'}</span>)}</div><strong>{preview(p)}</strong></button>)}{ev.length>3&&<small className="more-posts">+ ещё {ev.length-3}</small>}</div>})}</div>
    </section>
    <section className="card plan-list-card"><div className="card-head"><h2>Ближайшие публикации</h2><span>{posts.length}</span></div>
      {!!selectedIds.length&&<div className="bulk-toolbar"><strong>Выбрано: {selectedIds.length}</strong><div className="bulk-actions"><button className="secondary" disabled={bulkBusy} onClick={()=>void bulk('clone')}>Дублировать</button><button className="secondary" disabled={bulkBusy} onClick={()=>void bulk('shift')}>Перенести</button><button className="secondary danger-button" disabled={bulkBusy} onClick={()=>void bulk('delete')}>Удалить</button></div></div>}
      <div className="plan-list">{posts.slice(0,15).map(p=><div className="plan-row" key={p.id}><input className="plan-select" type="checkbox" checked={selectedIds.includes(p.id)} onChange={e=>setSelectedIds(v=>e.target.checked?[...v,p.id]:v.filter(id=>id!==p.id))}/><div className="plan-date">{p.scheduled_at?new Date(p.scheduled_at).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'Без даты'}</div><div className="plan-content"><div className="post-target-logos">{p.post_targets.map(t=><span key={t.id} className={logoClass(t.platform)}>{meta[t.platform]?.icon??'•'}</span>)}</div><strong>{preview(p)}</strong></div><button className="secondary" onClick={()=>setEditor(p)}>Открыть</button><button className="secondary danger-button" onClick={()=>void remove(p.id)}>Удалить</button></div>)}{!posts.length&&<div className="empty small-empty">Пока нет публикаций. Нажмите «+».</div>}</div></section>{msg&&<div className="auth-message">{msg}</div>}</section>{editor!==undefined&&<Editor post={editor} accounts={accounts} groups={groups} workspaceId={workspaceId} workspaceRole={workspaceRole} approvalsEnabled={workspaceApprovalEnabled} onClose={()=>setEditor(undefined)} onSaved={load}/>}</AppShell>
}
