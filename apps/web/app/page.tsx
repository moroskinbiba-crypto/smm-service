'use client';
import { useState } from 'react';

const networks = [
  { id: 'telegram', name: 'Telegram', icon: '✈️' },
  { id: 'vk', name: 'VK', icon: 'VK' },
  { id: 'max', name: 'MAX', icon: 'M' },
  { id: 'ok', name: 'Одноклассники', icon: 'OK' },
  { id: 'instagram', name: 'Instagram', icon: '◎', muted: true },
];

export default function Home() {
  const [theme, setTheme] = useState<'light'|'dark'>('light');
  const [selected, setSelected] = useState<string[]>(['telegram', 'vk']);

  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  return <main className={theme === 'dark' ? 'shell dark' : 'shell'}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">S</span><span>SMM Service</span></div>
      <button className="theme" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '☾' : '☀'} Тема</button>
    </header>
    <section className="hero">
      <div><div className="eyebrow">MVP</div><h1>Публикуй один раз.<br/>Рассылай везде.</h1><p>Единая очередь публикаций для Telegram, VK, MAX и Одноклассников.</p></div>
      <div className="status"><span className="dot"/>Сервис готов к подключению</div>
    </section>
    <section className="grid">
      <div className="card composer">
        <div className="card-head"><h2>Новая публикация</h2><span>Черновик</span></div>
        <textarea placeholder="Напишите текст публикации..." />
        <div className="media">＋ Добавить фото или видео</div>
        <div className="targets"><h3>Площадки</h3>{networks.map(n => <button key={n.id} onClick={() => !n.muted && toggle(n.id)} className={selected.includes(n.id) ? 'network active' : 'network'} disabled={n.muted}><b>{n.icon}</b>{n.name}{n.muted && <small>позже</small>}</button>)}</div>
        <div className="schedule"><div><label>Дата</label><input type="date" /></div><div><label>Время</label><input type="time" /></div></div>
        <button className="primary">Запланировать публикацию</button>
      </div>
      <aside className="card queue"><div className="card-head"><h2>Очередь</h2><span>Сегодня</span></div><div className="empty">Пока нет запланированных публикаций.<br/><span>Создайте первую — она появится здесь.</span></div></aside>
    </section>
  </main>;
}
