import { AppShell } from '../components/app-shell';

export default function StatsPage() {
  return (
    <AppShell active="stats">
      <section className="page-section">
        <div className="page-heading"><div><div className="eyebrow">АНАЛИТИКА</div><h1>Статистика</h1><p>Публикации, просмотры, реакции и другие SMM-метрики по площадкам.</p></div></div>
        <div className="stats-placeholder">
          <section className="card metric-card"><span>Публикации</span><strong>—</strong><small>за выбранный период</small></section>
          <section className="card metric-card"><span>Просмотры</span><strong>—</strong><small>все соцсети</small></section>
          <section className="card metric-card"><span>Вовлечённость</span><strong>—</strong><small>лайки, комментарии, репосты</small></section>
        </div>
      </section>
    </AppShell>
  );
}
