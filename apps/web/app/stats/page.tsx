'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '../components/app-shell';
import { appRequest } from '../../lib/app-api';

type Summary = {
  posts: number;
  published: number;
  scheduled: number;
  failed: number;
  views: number;
  likes: number;
  comments: number;
  reposts: number;
  clicks: number;
  ctr: number;
  engagement: number;
  engagement_rate: number;
  avg_views_per_post: number;
  avg_engagement_per_post: number;
  success_rate: number;
  publications_per_day: number;
  reels: number;
  clips: number;
};

type Format = { platform:string; format:string; published:number; views:number; likes:number; comments:number; reposts:number };
type Platform = {
  platform: string;
  published: number;
  failed: number;
  views: number;
  likes: number;
  comments: number;
  reposts: number;
  clicks: number;
  engagement: number;
  engagement_rate: number;
  avg_views: number;
  avg_engagement: number;
  success_rate: number;
};

type Daily = {
  date: string;
  published: number;
  views: number;
  likes: number;
  comments: number;
  reposts: number;
  clicks: number;
  engagement: number;
};

const platformNames: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  ok: 'Одноклассники',
  instagram: 'Instagram',
};

function number(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function percent(value: number) {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%';
}

type Comparison = { posts:number; published:number; views:number; likes:number; comments:number; reposts:number; clicks:number };
type TopPost = { post_id:string; preview:string; views:number; likes:number; comments:number; reposts:number; clicks:number; score:number };
type BestHour = { hour:number; published:number; views:number; engagement:number };
type BenchmarkAccount = { account_id:string; platform:string; name:string; published:number; failed:number; views:number; likes:number; comments:number; reposts:number; engagement:number; engagement_rate:number; avg_views:number; success_rate:number; rank:number };
type Topic = { term:string; count:number; avg_views:number; views:number; posts:number };
type Weekday = { label:string; posts:number; avg_views:number };
type Notification = { id:string; type:string; title:string; body:string; read_at:string|null; created_at:string };

export default function StatsPage() {
  const [period, setPeriod] = useState<'7' | '30' | '90' | 'custom'>('30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [formats, setFormats] = useState<Format[]>([]);
  const [daily, setDaily] = useState<Daily[]>([]);
  const [comparison, setComparison] = useState<Comparison|null>(null);
  const [topPosts, setTopPosts] = useState<TopPost[]>([]);
  const [bestHours, setBestHours] = useState<BestHour[]>([]);
  const [benchmarkAccounts, setBenchmarkAccounts] = useState<BenchmarkAccount[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [bestTopics, setBestTopics] = useState<Topic[]>([]);
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [analyzed, setAnalyzed] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [telegramLink, setTelegramLink] = useState<{start_url:string;bot_username:string;expires_at:string}|null>(null);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    const end = period === 'custom' && customTo ? new Date(customTo + 'T23:59:59') : new Date();
    const start = period === 'custom' && customFrom ? new Date(customFrom + 'T00:00:00') : new Date(Date.now() - Number(period === 'custom' ? 30 : period) * 86400000);
    if (start.getTime() > end.getTime()) {
      throw new Error('Начало периода не может быть позже конца');
    }
    const r = await appRequest<{ summary: Summary; by_platform: Platform[]; by_format: Format[]; daily: Daily[]; comparison: Comparison; top_posts: TopPost[]; best_hours: BestHour[]; by_account: BenchmarkAccount[] }>(
      'stats',
      { from: start.toISOString(), to: end.toISOString() },
    );
    setSummary(r.summary);
    setPlatforms(r.by_platform ?? []);
    setFormats(r.by_format ?? []);
    setDaily(r.daily ?? []);
    setComparison(r.comparison ?? null);
    setTopPosts(r.top_posts ?? []);
    setBestHours(r.best_hours ?? []);
    setBenchmarkAccounts(r.by_account ?? []);
  }

  useEffect(() => {
    void load().catch(e => setMsg(e instanceof Error ? e.message : 'Не удалось загрузить статистику'));
  }, [period, customFrom, customTo]);

  useEffect(() => {
    void Promise.all([
      appRequest<{posts_analyzed:number;topics:Topic[];best_topics:Topic[];weekdays:Weekday[]}>('content-insights'),
      appRequest<{notifications:Notification[]}>('list-notifications'),
    ]).then(([content, notices]) => {
      setAnalyzed(content.posts_analyzed ?? 0);
      setTopics(content.topics ?? []);
      setBestTopics(content.best_topics ?? []);
      setWeekdays(content.weekdays ?? []);
      setNotifications(notices.notifications ?? []);
    }).catch(e => setMsg(e instanceof Error ? e.message : 'Не удалось загрузить аналитику'));
  }, []);

  async function refreshMetrics() {
    setRefreshing(true);
    setMsg('');
    try {
      const r = await appRequest<{ queued: number; message?: string }>('refresh-metrics');
      setMsg((r.message || 'Обновление метрик поставлено в очередь') + ' · задач: ' + r.queued);
      window.setTimeout(() => {
        void load().catch(e => setMsg(e instanceof Error ? e.message : 'Не удалось обновить статистику'));
      }, 2000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Не удалось обновить метрики');
    } finally {
      setRefreshing(false);
    }
  }

  async function markNotification(id:string) {
    try {
      await appRequest('mark-notification-read',{notification_id:id});
      setNotifications(items => items.map(item => item.id===id ? {...item,read_at:new Date().toISOString()} : item));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Не удалось отметить уведомление');
    }
  }

  async function connectTelegramNotifications() {
    setTelegramBusy(true);
    setMsg('');
    try {
      const result = await appRequest<{start_url:string;bot_username:string;expires_at:string}>('telegram-notifications-start');
      setTelegramLink(result);
      window.open(result.start_url,'_blank','noopener,noreferrer');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Не удалось подключить Telegram-уведомления');
    } finally {
      setTelegramBusy(false);
    }
  }

  const cards = summary ? [
    ['Публикации', number(summary.posts), 'за выбранный период'],
    ['Опубликовано', number(summary.published), 'успешных публикаций'],
    ['Запланировано', number(summary.scheduled), 'сейчас в очереди'],
    ['Ошибки', number(summary.failed), 'публикаций с ошибкой'],
    ['Просмотры (Views)', number(summary.views), 'суммарные просмотры'],
    ['Лайки (Likes)', number(summary.likes), 'реакции'],
    ['Комментарии (Comments)', number(summary.comments), 'комментарии'],
    ['Репосты (Shares)', number(summary.reposts), 'репосты'],
    ['Клики (Clicks)', number(summary.clicks), 'клики по доступным метрикам'],
    ['CTR (Click-Through Rate)', percent(summary.ctr), 'клики / просмотры'],
    ['Engagement', number(summary.engagement), 'лайки + комментарии + репосты'],
    ['ER (Engagement Rate)', percent(summary.engagement_rate), 'вовлечённость / просмотры — формула без изменений'],
    ['Average Views', number(summary.avg_views_per_post), 'среднее число просмотров на опубликованный target'],
    ['Success Rate', percent(summary.success_rate), 'успешные / успешные + ошибки'],
    ['Reels', number(summary.reels), 'опубликовано'],
    ['VK Клипы', number(summary.clips), 'опубликовано'],
  ] : [];

  const maxDailyViews = useMemo(
    () => Math.max(1, ...daily.map(day => day.views)),
    [daily],
  );

  return (
    <AppShell active="stats">
      <section className="page-section">
        <div className="page-heading">
          <div>
            <div className="eyebrow">АНАЛИТИКА</div>
            <h1>Аналитика</h1>
            <p>Единая аналитика публикаций, контента, площадок и уведомлений.</p>
          </div>
          <div className="period-switch">
            {([['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['custom', 'Свой период']] as const).map(([id, name]) => (
              <button
                key={id}
                className={period === id ? 'secondary active-period' : 'secondary'}
                onClick={() => setPeriod(id)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        {period === 'custom' && <div className="stats-custom-period card">
          <label>С <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)} /></label>
          <label>По <input type="date" value={customTo} onChange={e=>setCustomTo(e.target.value)} /></label>
        </div>}

        <div className="stats-grid">
          {cards.map(card => (
            <section className="card metric-card" key={card[0]}>
              <span>{card[0]}</span>
              <strong>{card[1]}</strong>
              <small>{card[2]}</small>
            </section>
          ))}
        </div>

        <section className="card">
          <div className="card-head"><h2>Форматы</h2><span>Reels и VK Клипы учитываются отдельно</span></div>
          <div className="format-stats">{formats.map(item=><div className="format-stat" key={item.platform+item.format}><strong>{item.platform === 'vk' ? 'VK' : item.platform === 'instagram' ? 'Instagram' : item.platform}</strong><span>{item.format === 'clip' ? 'Клипы' : item.format === 'reel' ? 'Reels' : item.format === 'story' ? 'Stories' : 'Посты'}</span><b>{number(item.published)}</b></div>)}{!formats.length&&<div className="empty small-empty">Данных по форматам пока нет.</div>}</div>
        </section>

        <section className="card stats-chart-card">
          <div className="card-head">
            <h2>Динамика просмотров</h2>
            <span>по дате публикации</span>
          </div>
          {daily.length ? (
            <div className="stats-bars">
              {daily.map(day => (
                <div className="stats-bar-item" key={day.date} title={day.date}>
                  <div className="stats-bar-value">{number(day.views)}</div>
                  <div className="stats-bar-track">
                    <div className="stats-bar-fill" style={{ height: Math.max(4, (day.views / maxDailyViews) * 100) + '%' }} />
                  </div>
                  <small>{day.date.slice(5)}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty small-empty">После первой публикации здесь появится динамика.</div>
          )}
        </section>

        <section className="card stats-platform-card">
          <div className="card-head">
            <h2>Сравнение площадок</h2>
            <span>актуальные собранные метрики</span>
          </div>
          <div className="stats-table stats-table-wide">
            <div className="stats-row stats-head">
              <span>Площадка</span>
              <span>Posts</span>
              <span>Views</span>
              <span>Likes</span>
              <span>Comments</span>
              <span>Shares</span>
              <span>ER</span>
              <span>Success Rate</span>
            </div>
            {platforms.map(p => (
              <div className="stats-row" key={p.platform}>
                <span><strong>{platformNames[p.platform] ?? p.platform}</strong></span>
                <span>{number(p.published)}</span>
                <span>{number(p.views)}</span>
                <span>{number(p.likes)}</span>
                <span>{number(p.comments)}</span>
                <span>{number(p.reposts)}</span>
                <span>{percent(p.engagement_rate)}</span>
                <span>{percent(p.success_rate)}</span>
              </div>
            ))}
            {!platforms.length && (
              <div className="empty small-empty">Пока нет данных. После первой публикации статистика появится здесь.</div>
            )}
          </div>
        </section>

        <section className="stats-two-column">
          <section className="card">
            <div className="card-head">
              <h2>Средние показатели</h2>
              <span>на опубликованный target</span>
            </div>
            <div className="stats-detail-list">
              <div><span>Просмотров на публикацию</span><strong>{number(summary?.avg_views_per_post ?? 0)}</strong></div>
              <div><span>Вовлечённости на публикацию</span><strong>{number(summary?.avg_engagement_per_post ?? 0)}</strong></div>
              <div><span>Публикаций в день</span><strong>{(summary?.publications_per_day ?? 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</strong></div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Вовлечённость</h2>
              <span>суммарно за период</span>
            </div>
            <div className="stats-detail-list">
              <div><span>Лайки</span><strong>{number(summary?.likes ?? 0)}</strong></div>
              <div><span>Комментарии</span><strong>{number(summary?.comments ?? 0)}</strong></div>
              <div><span>Репосты</span><strong>{number(summary?.reposts ?? 0)}</strong></div>
              <div><span>Всего действий</span><strong>{number(summary?.engagement ?? 0)}</strong></div>
            </div>
          </section>
        </section>

        <section className="card stats-top-posts">
          <div className="card-head"><h2>Лучшие публикации</h2><span>выше benchmark: сначала сильнейший контент</span></div>
          <div className="stats-top-list">
            {topPosts.map((post,index)=><div className="stats-top-row" key={post.post_id}>
              <span className="stats-rank">{index+1}</span>
              <div><strong>{post.preview}</strong><small>{number(post.views)} просмотров · {number(post.likes)} лайков · {number(post.comments)} комментариев · {number(post.reposts)} репостов</small></div>
              <strong>{number(post.score)}</strong>
            </div>)}
            {!topPosts.length&&<div className="empty small-empty">Недостаточно публикаций для рейтинга.</div>}
          </div>
        </section>

        <section className="card stats-benchmark">
          <div className="card-head"><h2>Benchmark внутри команды</h2><span>сравнение подключённых аккаунтов</span></div>
          <div className="stats-table stats-table-wide">
            <div className="stats-row stats-head"><span>Аккаунт</span><span>Площадка</span><span>Posts</span><span>Средние просмотры</span><span>ER (Engagement Rate)</span><span>Success Rate</span><span>Место</span></div>
            {benchmarkAccounts.map(account=><div className="stats-row" key={account.account_id}><span><strong>{account.name}</strong></span><span>{platformNames[account.platform] ?? account.platform}</span><span>{number(account.published)}</span><span>{number(account.avg_views)}</span><span>{percent(account.engagement_rate)}</span><span>{percent(account.success_rate)}</span><span>#{account.rank}</span></div>)}
            {!benchmarkAccounts.length&&<div className="empty small-empty">Нужно несколько подключённых аккаунтов и публикаций для benchmark.</div>}
          </div>
        </section>

        <section className="stats-two-column">
          <section className="card"><div className="card-head"><h2>Частые темы</h2><span>{analyzed} публикаций</span></div><div className="topic-cloud">{topics.slice(0,20).map((topic,i)=><span key={topic.term} style={{fontSize:Math.max(12,20-i*0.35)}}>{topic.term} <small>{topic.count}</small></span>)}</div></section>
          <section className="card"><div className="card-head"><h2>Лучшие темы</h2><span>по средним просмотрам</span></div><div className="stats-detail-list">{bestTopics.slice(0,10).map(topic=><div key={topic.term}><span>{topic.term} · {topic.posts} постов</span><strong>{number(topic.avg_views)}</strong></div>)}{!bestTopics.length&&<div className="empty small-empty">Недостаточно данных.</div>}</div></section>
        </section>

        <section className="card"><div className="card-head"><h2>Лучшие дни недели</h2><span>по средним просмотрам</span></div><div className="stats-detail-list">{weekdays.slice(0,7).map(day=><div key={day.label}><span>{day.label} · {day.posts} публикаций</span><strong>{number(day.avg_views)}</strong></div>)}{!weekdays.length&&<div className="empty small-empty">Недостаточно данных.</div>}</div></section>

        <div className="stats-actions">
          <button className="secondary" onClick={() => window.print()}>Печать / PDF</button>
          <button className="secondary" onClick={() => {
            const rows = [['Период','Публикации','Опубликовано','Просмотры','Лайки','Комментарии','Репосты','Клики','ER','CTR'],[period,summary?.posts??0,summary?.published??0,summary?.views??0,summary?.likes??0,summary?.comments??0,summary?.reposts??0,summary?.clicks??0,summary?.engagement_rate??0,summary?.ctr??0]];
            const csv = rows.map(row=>row.map(value=>String(value).replace(/"/g,'""')).map(value=>'"'+value+'"').join(',')).join('\n');
            const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
            const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='smm-report.csv'; a.click(); URL.revokeObjectURL(url);
          }}>Экспорт CSV</button>
          <button className="secondary" disabled={refreshing} onClick={() => void refreshMetrics()}>
            {refreshing ? 'Обновляем…' : 'Обновить метрики площадок'}
          </button>
        </div>

        <section className="card notifications-banner" id="notifications-banner">
          <div className="card-head">
            <div><h2>Уведомления</h2><span>{notifications.filter(item=>!item.read_at).length} непрочитанных</span></div>
            <Link className="secondary" href="#notifications-banner">Все здесь</Link>
          </div>
          <div className="notification-list">
            {notifications.slice(0,5).map(item=>
              <button className={!item.read_at?'notification-row unread':'notification-row'} key={item.id} onClick={()=>void markNotification(item.id)}>
                <div className="notification-icon">{item.type==='new_comment'?'💬':item.type==='approval_requested'?'✓':item.type==='approval_reviewed'?'⚑':'🔔'}</div>
                <div><strong>{item.title}</strong><span>{item.body}</span><small>{new Date(item.created_at).toLocaleString('ru-RU')}</small></div>
                {!item.read_at&&<span className="inbox-unread">NEW</span>}
              </button>
            )}
            {!notifications.length&&<div className="empty small-empty">Новых уведомлений нет.</div>}
          </div>
          <div className="telegram-notification-explainer"><strong>Telegram-уведомления</strong><span>Можно получать важные события, рубежи просмотров и ежедневный отчёт прямо в Telegram.</span></div>
          {!telegramLink ? (
            <button className="primary" disabled={telegramBusy} onClick={()=>void connectTelegramNotifications()}>{telegramBusy?'Готовим ссылку…':'Подключить Telegram-уведомления'}</button>
          ) : (
            <div className="telegram-notify-connect"><strong>Откройте бота @{telegramLink.bot_username.replace(/^@/,'')} и нажмите Start</strong><a className="primary telegram-start-link" href={telegramLink.start_url} target="_blank" rel="noreferrer">Открыть Telegram</a><small>Ссылка действует до {new Date(telegramLink.expires_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</small></div>
          )}
        </section>

        {msg && <div className="auth-message">{msg}</div>}
      </section>
    </AppShell>
  );
}
