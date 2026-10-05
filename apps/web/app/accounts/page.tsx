import Link from 'next/link';
import { AppShell } from '../components/app-shell';

export default function AccountsPage() {
  return (
    <AppShell active="accounts">
      <section className="page-section">
        <div className="page-heading"><div><div className="eyebrow">СОЦИАЛЬНЫЕ СЕТИ</div><h1>Доступные аккаунты</h1><p>Здесь появятся подключённые Telegram, VK, MAX и Одноклассники.</p></div></div>
        <div className="card coming-card"><div className="coming-icon">＋</div><h2>Подключение аккаунтов</h2><p>Следующим этапом добавим авторизацию социальных сетей и автоматическую проверку их состояния.</p><Link href="/team" className="secondary">Настроить команду</Link></div>
      </section>
    </AppShell>
  );
}
