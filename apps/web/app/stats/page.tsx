'use client';

import { useEffect, useMemo, useState } from 'react';
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
};

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

export default function StatsPage() {
  const [period, setPeriod] = useState<'7' | '30' | '90' | 'custom'>('30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [daily, setDaily] = useState<Daily[]>([]);
  const [comparison, setComparison] = useState<Comparison|null>(null);
  const [topPosts, setTopPosts] = useState<TopPost[]>([]);
  const [bestHours, setBestHours] = useState<BestHour[]>([]);
  const [benchmarkAccounts, setBenchmarkAccounts] = useState<BenchmarkAccount[]>([]);
  const [msg, setMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    const end = period === 'custom' && customTo ? new Date(customTo + 'T23:59:59') : new Date();
    const start = period === 'custom' && customFrom ? new Date(customFrom + 'T00:00:00') : new Date(Date.now() - Number(period === 'custom' ? 30 : period) * 86400000);
    if (start.getTime() > end.getTime()) {
      throw new Error('Начало периода не может быть позже конца');
    }
    const r = await appRequest<{ summary: Summary; by_platform: Platform[]; daily: Daily[]; comparison: Comparison; top_posts: TopPost[]; best_hours: BestHour[]; by_account: BenchmarkAccount[] }>(
      'stats',
      { from: start.toISOString(), to: end.toISOString() },
    );
    setSummary(r.summary);
    setPlatforms(r.by_platform ?? []);
    setDaily(r.daily ?? []);
    setComparison(r.comparison ?? null);
    setTopPosts(r.top_posts ?? []);
    setBestHours(r.best_hours ?? []);
    setBenchmarkAccounts(r.by_account ?? []);
  }

  useEffect(() => {
    void load().catch(e => setMsg(e instanceof Error ? e.message : 'Не удалось загрузить статистику'));
  }, [period, customFrom, customTo]);

  async function refreshMetrics() {
    setRefreshing(true);
    setMsg('');
    try {
      const r = await appRequest<{ refreshed: number; errors: string[] }>('refresh-metrics');
      if (r.errors?.length) {
        setMsg('Обновлено: ' + r.refreshed + '. Ошибки: ' + r.errors.slice(0, 2).join(' · '));
      }
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Не удалось обновить метрики');
    } finally {
      setRefreshing(false);
    }
  }

  const cards = summary ? [
    ['Публикации', number(summary.posts), 'за выбранный период'],
    ['Опубликовано', number(summary.published), 'успешных публикаций'],
    ['Запланировано', number(summary.scheduled), 'сейчас в очереди'],
    ['Ошибки', number(summary.failed), 'публикаций с ошибкой'],
    ['Просмотры', number(summary.views), 'суммарный охват'],
    ['Лайки', number(summary.likes), 'реакции'],
    ['Комментарии', number(summary.comments), 'комментарии'],
    ['Репосты', number(summary.reposts), 'репосты'],
    ['Клики', number(summary.clicks), 'клики по доступным метрикам'],
    ['CTR', percent(summary.ctr), 'клики / просмотры'],
    ['Вовлечённость', number(summary.engagement), 'лайки + комментарии + репосты'],
    ['ER по просмотрам', percent(summary.engagement_rate), 'вовлечённость / просмотры'],
    ['Средние просмотры', number(summary.avg_views_per_post), 'на опубликованный target'],
    ['Успешность публикаций', percent(summary.success_rate), 'успешные / успешные + ошибки'],
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
            <h1>Статистика</h1>
            <p>Публикации, охват и вовлечённость по подключённым площадкам.</p>
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
              <span>Посты</span>
              <span>Просмотры</span>
              <span>Лайки</span>
              <span>Комментарии</span>
              <span>Репосты</span>
              <span>ER</span>
              <span>Успешность</span>
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

        <section className="card stats-benchmark">
          <div className="card-head"><h2>Benchmark внутри команды</h2><span>сравнение подключённых аккаунтов</span></div>
          <div className="stats-table stats-table-wide">
            <div className="stats-row stats-head"><span>Аккаунт</span><span>Площадка</span><span>Посты</span><span>Средние просмотры</span><span>ER</span><span>Успешность</span><span>Место</span></div>
            {benchmarkAccounts.map(account=><div className="stats-row" key={account.account_id}><span><strong>{account.name}</strong></span><span>{platformNames[account.platform] ?? account.platform}</span><span>{number(account.published)}</span><span>{number(account.avg_views)}</span><span>{percent(account.engagement_rate)}</span><span>{percent(account.success_rate)}</span><span>#{account.rank}</span></div>)}
            {!benchmarkAccounts.length&&<div className="empty small-empty">Нужно несколько подключённых аккаунтов и публикаций для benchmark.</div>}
          </div>
        </section>

        <section className="card stats-top-posts">
          <div className="card-head"><h2>Лучшие публикации</h2><span>по просмотрам и вовлечённости</span></div>
          <div className="stats-top-list">
            {topPosts.map((post,index)=><div className="stats-top-row" key={post.post_id}>
              <span className="stats-rank">{index+1}</span>
              <div><strong>{post.preview}</strong><small>{number(post.views)} просмотров · {number(post.likes)} лайков · {number(post.comments)} комментариев · {number(post.reposts)} репостов</small></div>
              <strong>{number(post.score)}</strong>
            </div>)}
            {!topPosts.length&&<div className="empty small-empty">Недостаточно публикаций для рейтинга.</div>}
          </div>
        </section>

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

        {msg && <div className="auth-message">{msg}</div>}
      </section>
    </AppShell>
  );
}
