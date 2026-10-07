'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../components/app-shell';
import { appRequest, type SocialAccount } from '../../lib/app-api';

type Platform='telegram'|'vk'|'max'|'ok'|'instagram';

const meta: Record<Platform,{name:string;icon:string;help:string}> = {
  telegram:{name:'Telegram',icon:'➤',help:'Подключите Telegram-канал для обычных публикаций. Личные уведомления подключаются отдельно через Telegram-бота.'},
  vk:{name:'VK',icon:'vk',help:'Удобнее войти через VK OAuth и выбрать нужное сообщество прямо в сервисе.'},
  max:{name:'MAX',icon:'M',help:'Два способа: токен вашего бота или подключение через служебного бота, добавленного в канал.'},
  ok:{name:'Одноклассники',icon:'OK',help:'OAuth access token + application key/secret + ID группы.'},
  instagram:{name:'Instagram',icon:'◎',help:'Подключаются профессиональные Instagram-аккаунты через Meta и можно выбрать нужный аккаунт.'},
};

type VkCandidate={id:string;name:string;screen_name:string|null;photo_100:string|null};
type MetaCandidate={page_id:string;page_name:string;page_access_token:string;instagram_id:string;instagram_username:string|null;instagram_name:string|null;profile_picture_url:string|null;account_type:string|null};
type AccountGroup={id:string;name:string;description:string|null;account_ids:string[]};

export default function AccountsPage(){
  const [accounts,setAccounts]=useState<SocialAccount[]>([]);
  const [platform,setPlatform]=useState<Platform>('telegram');
  const [maxMode,setMaxMode]=useState<'token'|'service_bot'>('token');
  const [telegramMode,setTelegramMode]=useState<'own_bot'|'service_bot'>('own_bot');
  const [token,setToken]=useState('');
  const [externalId,setExternalId]=useState('');
  const [name,setName]=useState('');
  const [appKey,setAppKey]=useState('');
  const [appSecret,setAppSecret]=useState('');
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState('');
  const [oauthLoading,setOauthLoading]=useState('');
  const [vkCandidates,setVkCandidates]=useState<VkCandidate[]>([]);
  const [vkToken,setVkToken]=useState('');
  const [metaCandidates,setMetaCandidates]=useState<MetaCandidate[]>([]);
  const [oauthProvider,setOauthProvider]=useState<'vk'|'meta'|null>(null);
  const [maxConnect,setMaxConnect]=useState<{code:string;expires_at:string;bot_username:string;instructions:string}|null>(null);
  const [telegramConnect,setTelegramConnect]=useState<{mode:'channel';code:string;expires_at:string;bot_username:string;instructions:string}|null>(null);
  const [groups,setGroups]=useState<AccountGroup[]>([]);
  const [groupName,setGroupName]=useState('');
  const [groupDescription,setGroupDescription]=useState('');
  const [groupAccountIds,setGroupAccountIds]=useState<string[]>([]);
  const [editingGroupId,setEditingGroupId]=useState<string|null>(null);
  const [groupBusy,setGroupBusy]=useState(false);

  async function load(){
    const [accountsResult,groupsResult]=await Promise.all([
      appRequest<{accounts:SocialAccount[]}>('list-accounts'),
      appRequest<{groups:AccountGroup[]}>('list-account-groups'),
    ]);
    setAccounts(accountsResult.accounts??[]);
    setGroups(groupsResult.groups??[]);
    return accountsResult.accounts??[];
  }
  async function refreshHealth(list:SocialAccount[]){const targets=list.filter(a=>a.status==='connected');if(!targets.length)return;const checked=await Promise.all(targets.map(a=>appRequest<{account:SocialAccount}>('check-account',{account_id:a.id}).then(x=>x.account).catch(()=>a)));setAccounts(v=>v.map(a=>checked.find(x=>x.id===a.id)??a))}
  useEffect(()=>{
    let cancelled=false;
    void load().then(list=>{if(!cancelled)void refreshHealth(list)}).catch(e=>setMsg(e instanceof Error?e.message:'Не удалось загрузить аккаунты'));
    const timer=window.setInterval(()=>{void load().then(list=>refreshHealth(list)).catch(()=>undefined)},5*60*1000);
    return()=>{cancelled=true;window.clearInterval(timer)};
  },[]);

  useEffect(()=>{
    function onMessage(event:MessageEvent){
      if(event.origin!==window.location.origin||event.data?.type!=='smm-oauth-callback')return;
      const p=event.data.payload||{};
      if(p.error){setMsg(p.error_description||p.error);return}
      void (async()=>{
        try{
          if(p.provider==='vk'){
            const result=await appRequest<{access_token:string;groups:VkCandidate[]}>('oauth-vk-complete',{code:p.code,state:p.state});
            setVkToken(result.access_token);
            setVkCandidates(result.groups||[]);
            setOauthProvider('vk');
          }else if(p.provider==='meta'){
            const result=await appRequest<{accounts:MetaCandidate[]}>('oauth-meta-complete',{code:p.code,state:p.state});
            setMetaCandidates(result.accounts||[]);
            setOauthProvider('meta');
          }
        }catch(e){setMsg(e instanceof Error?e.message:'OAuth авторизация не завершилась')}
      })();
    }
    window.addEventListener('message',onMessage);
    return()=>window.removeEventListener('message',onMessage);
  },[]);

  async function openOAuth(provider:'vk'|'meta'){
    setOauthLoading(provider);setMsg('');
    try{
      const action=provider==='vk'?'oauth-vk-start':'oauth-meta-start';
      const r=await appRequest<{url:string}>(action);
      const popup=window.open(r.url,'smm-oauth','width=620,height=760,resizable=yes,scrollbars=yes');
      if(!popup) throw new Error('Браузер заблокировал popup. Разрешите всплывающие окна для сервиса.');
    }catch(e){setMsg(e instanceof Error?e.message:'Не удалось открыть OAuth')}finally{setOauthLoading('')}
  }

  async function connectManual(){
    setBusy(true);setMsg('');
    try{
      const metadata:any={};
      if(platform==='ok'){metadata.application_key=appKey;metadata.group_id=externalId}
      const r=await appRequest<{account:SocialAccount}>('connect-account',{
        platform,
        access_token:token,
        external_id:externalId,
        display_name:name||undefined,
        client_secret:platform==='ok'?appSecret:undefined,
        metadata,
      });
      setAccounts(v=>[...v,r.account]);
      setToken('');setExternalId('');setName('');setAppKey('');setAppSecret('');
    }catch(e){setMsg(e instanceof Error?e.message:'Не удалось подключить')}finally{setBusy(false)}
  }

  async function connectVk(group:VkCandidate){
    setBusy(true);setMsg('');
    try{
      const r=await appRequest<{account:SocialAccount}>('oauth-connect-vk',{
        access_token:vkToken,
        group_id:group.id,
        group_name:group.name,
        group_screen_name:group.screen_name,
      });
      setAccounts(v=>[...v,r.account]);setOauthProvider(null);setVkCandidates([]);setVkToken('');
    }catch(e){setMsg(e instanceof Error?e.message:'Не удалось подключить сообщество VK')}finally{setBusy(false)}
  }

  async function connectInstagram(item:MetaCandidate){
    setBusy(true);setMsg('');
    try{
      const r=await appRequest<{account:SocialAccount}>('oauth-connect-meta',{
        page_access_token:item.page_access_token,
        instagram_id:item.instagram_id,
        page_id:item.page_id,
        page_name:item.page_name,
        instagram_username:item.instagram_username,
        instagram_name:item.instagram_name,
        account_type:item.account_type,
      });
      setAccounts(v=>[...v,r.account]);setOauthProvider(null);setMetaCandidates([]);
    }catch(e){setMsg(e instanceof Error?e.message:'Не удалось подключить Instagram')}finally{setBusy(false)}
  }

  async function startTelegramServiceBot(mode:'channel'){
    setBusy(true);setMsg('');
    try{
      const r=await appRequest<{mode:'channel';code:string;expires_at:string;bot_username:string;instructions:string}>('telegram-service-start',{mode});
      setTelegramConnect(r);
      const started=Date.now();
      const modeStartedAt=new Date().toISOString();
      const timer=window.setInterval(async()=>{
        if(Date.now()-started>120000){window.clearInterval(timer);return}
        try{
          const list=await load();
          const matched=list.find((account:any) =>
            account.platform === 'telegram' &&
            account.status === 'connected' &&
            account.metadata?.connection_method === 'service_bot' &&
            !account.metadata?.business_connection_id
          );
          if (matched && new Date(matched.updated_at).getTime() >= new Date(modeStartedAt).getTime()) {
            window.clearInterval(timer);
            setTelegramConnect(null);
            setMsg('✅ Telegram-канал подключён.');
          } else if (Date.now()-started>120000) {
            window.clearInterval(timer);
          }
        }catch{}
      },4000);
    }catch(e){setMsg(e instanceof Error?e.message:'Не удалось запустить подключение Telegram')}finally{setBusy(false)}
  }

  async function startMaxServiceBot(){
    setBusy(true);setMsg('');
    try{
      const r=await appRequest<{code:string;expires_at:string;bot_username:string;instructions:string}>('max-service-start');
      setMaxConnect(r);
    }catch(e){setMsg(e instanceof Error?e.message:'Не удалось запустить подключение MAX')}finally{setBusy(false)}
  }

  async function check(id:string){try{const r=await appRequest<{account:SocialAccount}>('check-account',{account_id:id});setAccounts(v=>v.map(a=>a.id===id?r.account:a))}catch(e){setMsg(e instanceof Error?e.message:'Проверка не удалась')}}
  async function disconnect(id:string){if(!confirm('Отключить этот аккаунт?'))return;try{await appRequest('disconnect-account',{account_id:id});setAccounts(v=>v.filter(a=>a.id!==id))}catch(e){setMsg(e instanceof Error?e.message:'Не удалось отключить')}}

  return <AppShell active="accounts">
    <section className="page-section">
      <div className="page-heading">
        <div><div className="eyebrow">СОЦИАЛЬНЫЕ СЕТИ</div><h1>Доступные аккаунты</h1><p>Подключайте площадки через токен или удобную авторизацию с выбором сообщества / аккаунта.</p></div>
      </div>

      <div className="account-page-grid">
        <section className="card">
          <div className="card-head"><h2>Подключённые аккаунты</h2><span>{accounts.length}</span></div>
          <div className="connected-list">
            {accounts.map(a=><div className="connected-account" key={a.id}>
              <div className={'connected-icon network-logo network-logo-'+a.platform}>{meta[a.platform as Platform]?.icon??'•'}</div>
              <div className="connected-main"><strong>{a.display_name||a.username||a.external_id}</strong><span>{meta[a.platform as Platform]?.name??a.platform} · {a.external_id}</span></div>
              <span className={a.status==='connected'?'account-status connected':'account-status error'}>{a.status==='connected'?'Работает':'Ошибка'}</span>
              <button className="secondary" onClick={()=>void check(a.id)}>Проверить</button>
              <button className="secondary danger-button" onClick={()=>void disconnect(a.id)}>Отключить</button>
            </div>)}
            {!accounts.length&&<div className="empty small-empty">Пока нет подключённых аккаунтов.</div>}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Группы аккаунтов</h2><span>{groups.length}</span></div>
          <p className="section-copy">Создайте группы заранее: например «Основные», «Все соцсети», «Региональные». В публикации группа сразу подставит все входящие аккаунты, а отдельные аккаунты можно снять вручную.</p>
          <div className="account-group-form">
            <input value={groupName} onChange={e=>setGroupName(e.target.value)} placeholder="Название группы"/>
            <input value={groupDescription} onChange={e=>setGroupDescription(e.target.value)} placeholder="Описание (необязательно)"/>
            <div className="account-group-checks">
              {accounts.filter(a=>a.status==='connected').map(a=><label className="account-group-check" key={a.id}>
                <input type="checkbox" checked={groupAccountIds.includes(a.id)} onChange={e=>setGroupAccountIds(v=>e.target.checked?[...v,a.id]:v.filter(id=>id!==a.id))}/>
                <span><strong>{a.display_name||a.username||a.external_id}</strong><small>{meta[a.platform as Platform]?.name??a.platform}</small></span>
              </label>)}
              {!accounts.some(a=>a.status==='connected')&&<div className="empty small-empty">Сначала подключите хотя бы один аккаунт.</div>}
            </div>
            <div className="modal-actions-left">
              <button className="primary" disabled={groupBusy||!groupName.trim()} onClick={async()=>{
                setGroupBusy(true);setMsg('');
                try{
                  await appRequest(editingGroupId?'update-account-group':'create-account-group',{
                    ...(editingGroupId?{group_id:editingGroupId}:{}),
                    name:groupName,
                    description:groupDescription,
                    account_ids:groupAccountIds,
                  });
                  setGroupName('');setGroupDescription('');setGroupAccountIds([]);setEditingGroupId(null);
                  await load();
                }catch(e){setMsg(e instanceof Error?e.message:'Не удалось сохранить группу')}
                finally{setGroupBusy(false)}
              }}>{groupBusy?'Сохраняем…':editingGroupId?'Сохранить группу':'Создать группу'}</button>
              {editingGroupId&&<button className="secondary" onClick={()=>{setEditingGroupId(null);setGroupName('');setGroupDescription('');setGroupAccountIds([])}}>Отмена</button>}
            </div>
          </div>
          <div className="account-group-list">
            {groups.map(g=><div className="account-group-card" key={g.id}>
              <div className="card-head"><div><h3>{g.name}</h3><small>{g.description||'Без описания'}</small></div><span>{g.account_ids.length}</span></div>
              <div className="account-group-members">
                {g.account_ids.map(id=>{const a=accounts.find(x=>x.id===id);return a?<span className="account-group-member" key={id}>{meta[a.platform as Platform]?.icon??'•'} {a.display_name||a.username||a.external_id}</span>:null})}
                {!g.account_ids.length&&<small>Группа пустая</small>}
              </div>
              <div className="modal-actions-left">
                <button className="secondary" onClick={()=>{setEditingGroupId(g.id);setGroupName(g.name);setGroupDescription(g.description||'');setGroupAccountIds(g.account_ids)}}>Изменить</button>
                <button className="secondary danger-button" onClick={async()=>{if(!confirm('Удалить группу «'+g.name+'»?'))return;try{await appRequest('delete-account-group',{group_id:g.id});await load()}catch(e){setMsg(e instanceof Error?e.message:'Не удалось удалить группу')}}}>Удалить</button>
              </div>
            </div>)}
            {!groups.length&&<div className="empty small-empty">Групп пока нет. Создайте первую выше.</div>}
          </div>
        </section>

        <section className="card connect-card">
          <div className="card-head"><h2>Добавить аккаунт</h2><span>секреты хранятся зашифрованно</span></div>
          <div className="platform-tabs">{Object.entries(meta).map(([id,v])=><button key={id} className={platform===id?'platform-tab active':'platform-tab'} onClick={()=>setPlatform(id as Platform)}><b className={'network-logo network-logo-'+id}>{v.icon}</b>{v.name}</button>)}</div>

          {platform==='vk'&&<div className="oauth-panel">
            <div className="oauth-panel-title">Удобное подключение VK</div>
            <p>Войдите через VK и выберите сообщество, которым вы управляете. Токен копировать не нужно.</p>
            <button className="primary" disabled={oauthLoading==='vk'} onClick={()=>void openOAuth('vk')}>{oauthLoading==='vk'?'Открываем VK…':'Войти через VK и выбрать сообщество'}</button>
          </div>}

          {platform==='instagram'&&<div className="oauth-panel">
            <div className="oauth-panel-title">Подключение через Meta</div>
            <p>Откроется окно входа Meta. После входа выберите нужный профессиональный Instagram-аккаунт.</p>
            <button className="primary" disabled={oauthLoading==='meta'} onClick={()=>void openOAuth('meta')}>{oauthLoading==='meta'?'Открываем Meta…':'Войти через Meta и выбрать Instagram'}</button>
          </div>}

          {platform==='telegram'&&<div className="max-connect-choice">
            <div className="connection-method-heading"><strong>Способ подключения Telegram</strong><small>Выберите один из двух вариантов</small></div>
            <div className="max-method-tabs">
              <button className={telegramMode==='own_bot'?'max-method active':'max-method'} onClick={()=>setTelegramMode('own_bot')}><strong>1. Ваш Telegram-бот</strong><small>Вы создаёте и даёте сервису токен. Максимум контроля.</small></button>
              <button className={telegramMode==='service_bot'?'max-method active':'max-method'} onClick={()=>setTelegramMode('service_bot')}><strong>2. Бот SMM-сервиса</strong><small>Без копирования токена — подключение через одноразовый код.</small></button>
            </div>
          </div>}
          {platform==='telegram'&&telegramMode==='service_bot'&&<div className="max-service-form">
            <div className="connect-method-badge">Бот TGRMLposting</div>
            <p className="section-copy">Самый простой способ подключить Telegram-канал. Токен создавать не нужно.</p>
            <div className="telegram-feature-card">
              <strong>Telegram-канал</strong>
              <small>Посты публикуются прямо в выбранный канал от имени канала.</small>
            </div>
            <ol className="max-steps">
              <li>Нажмите «Получить код подключения».</li>
              <li>Добавьте нашего бота в нужный канал как администратора с правом публикации сообщений.</li>
              <li>Отправьте в канале сообщение <b>/connect КОД</b>.</li>
              <li>Канал автоматически появится в списке аккаунтов.</li>
            </ol>
            <button className="primary" disabled={busy} onClick={()=>void startTelegramServiceBot('channel')}>{busy?'Готовим…':'Получить код подключения'}</button>
            {telegramConnect?.mode==='channel'&&<div className="max-connect-code">
              <strong>Код: {telegramConnect.code}</strong>
              <span>Бот: @{telegramConnect.bot_username.replace(/^@/,'')} · до {new Date(telegramConnect.expires_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span>
              <code>/connect {telegramConnect.code}</code>
              <small>{telegramConnect.instructions}</small>
            </div>}
            <div className="telegram-story-notice">
              <strong>Stories от имени канала</strong>
              <span>Эта функция подключается отдельно: Telegram разрешает публикацию Stories канала через пользовательский API-доступ, а не через обычный Bot API. Поэтому мы не выдаём здесь ложную кнопку «Business».</span>
              <small>Обычные публикации канала уже подключаются этим способом.</small>
            </div>
          </div>}          {platform==='max'&&<div className="max-connect-choice">
            <div className="connection-method-heading"><strong>Способ подключения MAX</strong><small>Выберите один из двух вариантов</small></div>
            <div className="max-method-tabs">
              <button className={maxMode==='token'?'max-method active':'max-method'} onClick={()=>setMaxMode('token')}><strong>1. Токен вашего MAX-бота</strong><small>Вы создаёте бота и вводите его токен.</small></button>
              <button className={maxMode==='service_bot'?'max-method active':'max-method'} onClick={()=>setMaxMode('service_bot')}><strong>2. Бот SMM-сервиса</strong><small>Добавляете нашего бота в канал и вводите только одноразовый код.</small></button>
            </div>
          </div>}

          {platform!=='vk'&&platform!=='instagram'&&platform!=='telegram'&&!(platform==='max'&&maxMode==='service_bot')&&<>
            <p className="section-copy">{meta[platform].help}</p>
            <label>Токен доступа<input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="Вставьте токен"/></label>
            <label>{platform==='max'?'Chat ID':'ID группы'}<input value={externalId} onChange={e=>setExternalId(e.target.value)} placeholder="Например, 123456789"/></label>

            {platform==='ok'&&<><label>Application key<input value={appKey} onChange={e=>setAppKey(e.target.value)}/></label><label>Application secret<input type="password" value={appSecret} onChange={e=>setAppSecret(e.target.value)}/></label></>}
            <label>Название в сервисе<input value={name} onChange={e=>setName(e.target.value)} placeholder={meta[platform].name}/></label>
            <details className="connect-faq" open>
              <summary>FAQ: как подключить {meta[platform].name}</summary>
              <div className="connect-faq-body">
                {platform==='ok'&&<><p>Используйте OAuth access token, application key/secret и ID группы.</p><a href="https://apiok.ru/" target="_blank" rel="noreferrer">Официальная документация OK →</a></>}
                {platform==='max'&&<><p>Создайте MAX business-бота, получите токен и добавьте бота администратором в канал.</p><a href="https://dev.max.ru/docs-api" target="_blank" rel="noreferrer">Официальная документация MAX →</a></>}
              </div>
            </details>
            <button className="primary" disabled={busy||!token||!externalId} onClick={()=>void connectManual()}>{busy?'Проверяем и подключаем…':'Подключить аккаунт'}</button>
          </>}

          {platform==='telegram'&&telegramMode==='own_bot'&&<>
            <p className="section-copy">Ваш бот остаётся вашим: вы даёте его токен, а сервис публикует от имени этого бота.</p>
            <label>Токен доступа<input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="123456:ABC..."/></label>
            <label>Chat ID / @username<input value={externalId} onChange={e=>setExternalId(e.target.value)} placeholder="@my_channel или -100123..."/></label>
            <label>Название в сервисе<input value={name} onChange={e=>setName(e.target.value)} placeholder="Telegram"/></label>
            <details className="connect-faq" open>
              <summary>Как подключить</summary>
              <div className="connect-faq-body">
                <p><strong>1.</strong> Создайте бота через @BotFather.</p>
                <p><strong>2.</strong> Добавьте его в канал как администратора и дайте право публикации.</p>
                <p><strong>3.</strong> Укажите токен и @username / chat_id канала.</p>
                <p><strong>Stories:</strong> для Stories используйте вариант «Через бота SMM-сервиса → Telegram Business» ниже.</p>
              </div>
            </details>
            <button className="primary" disabled={busy||!token||!externalId} onClick={()=>void connectManual()}>{busy?'Проверяем и подключаем…':'Подключить Telegram'}</button>
          </>}
          {platform==='max'&&maxMode==='service_bot'&&<div className="max-service-form">
            <div className="connect-method-badge">Вариант 2 · Бот SMM-сервиса</div>
            <p className="section-copy">Добавьте служебного MAX-бота в канал как администратора. Затем отправьте в канале команду с одноразовым кодом — сервис сам увидит channel ID и подключит канал.</p>
            <ol className="max-steps"><li>Нажмите «Получить код подключения».</li><li>Добавьте служебного бота <b>{maxConnect?.bot_username ? '@'+maxConnect.bot_username.replace(/^@/,'') : 'служебного бота'}</b> в канал и назначьте ему права администратора.</li><li>Отправьте в канале сообщение <b>/connect КОД</b>.</li><li>Через несколько секунд канал появится в списке аккаунтов.</li></ol>
            <button className="primary" disabled={busy} onClick={()=>void startMaxServiceBot()}>{busy?'Готовим…':'Получить код подключения'}</button>
            {maxConnect&&<div className="max-connect-code"><strong>Код: {maxConnect.code}</strong><span>Действует до {new Date(maxConnect.expires_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span><code>/connect {maxConnect.code}</code><small>{maxConnect.instructions}</small></div>}
            <div className="connect-faq-body"><p>Этот способ требует один раз настроить служебного MAX-бота и Webhook на стороне сервиса. Пользовательский токен не вводится.</p></div>
          </div>}

          {(platform==='vk'||platform==='instagram')&&<details className="connect-faq" open><summary>Как работает вход</summary><div className="connect-faq-body"><p>Сначала открывается отдельное окно авторизации. После входа сервис получает только нужные разрешения, показывает список доступных сообществ/аккаунтов и сохраняет выбранный.</p></div></details>}

          {platform==='instagram'&&<div className="manual-fallback">
            <details className="connect-faq"><summary>Нужен ручной способ? Подключить токен вручную</summary>
              <div className="connect-faq-body">
                <label>Instagram access token<input type="password" value={token} onChange={e=>setToken(e.target.value)}/></label>
                <label>Instagram User ID<input value={externalId} onChange={e=>setExternalId(e.target.value)}/></label>
                <button className="secondary" disabled={!token||!externalId||busy} onClick={()=>void connectManual()}>Подключить вручную</button>
              </div>
            </details>
          </div>}

          {msg&&<div className="auth-message">{msg}</div>}
        </section>
      </div>

      {(oauthProvider==='vk'||oauthProvider==='meta')&&<div className="modal-backdrop" onMouseDown={()=>setOauthProvider(null)}>
        <div className="oauth-select-modal" onMouseDown={e=>e.stopPropagation()}>
          <div className="modal-head"><div><div className="eyebrow">{oauthProvider==='vk'?'VK':'INSTAGRAM'}</div><h2>{oauthProvider==='vk'?'Выберите сообщество':'Выберите Instagram-аккаунт'}</h2></div><button className="icon-button" onClick={()=>setOauthProvider(null)}>×</button></div>
          <div className="oauth-candidate-list">
            {oauthProvider==='vk'&&vkCandidates.map(group=><button key={group.id} className="oauth-candidate" disabled={busy} onClick={()=>void connectVk(group)}><span>{group.photo_100?<img src={group.photo_100} alt=""/>:<b>VK</b>}</span><span><strong>{group.name}</strong><small>{group.screen_name?'@'+group.screen_name:'ID '+group.id}</small></span></button>)}
            {oauthProvider==='meta'&&metaCandidates.map(item=><button key={item.instagram_id} className="oauth-candidate" disabled={busy} onClick={()=>void connectInstagram(item)}><span>{item.profile_picture_url?<img src={item.profile_picture_url} alt=""/>:<b>◎</b>}</span><span><strong>{item.instagram_name||item.instagram_username||'Instagram'}</strong><small>@{item.instagram_username||item.instagram_id}</small></span></button>)}
            {oauthProvider==='vk'&&!vkCandidates.length&&<div className="empty small-empty">VK не вернул доступных сообществ.</div>}
            {oauthProvider==='meta'&&!metaCandidates.length&&<div className="empty small-empty">Meta не нашла привязанный профессиональный Instagram.</div>}
          </div>
        </div>
      </div>}
    </section>
  </AppShell>
}