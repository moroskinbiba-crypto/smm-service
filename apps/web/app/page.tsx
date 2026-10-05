'use client';

import { useEffect, useState } from 'react';
import { AppShell } from './components/app-shell';
import { workspaceRequest } from '../lib/workspace-api';

const networks = [
  { id: 'telegram', name: 'Telegram', icon: '✈️' },
  { id: 'vk', name: 'VK', icon: 'VK' },
  { id: 'max', name: 'MAX', icon: 'M' },
  { id: 'ok', name: 'Одноклассники', icon: 'OK' },
  { id: 'instagram', name: 'Instagram', icon: '◎', muted: true },
];

export default function Home() {
  const [selected, setSelected] = useState<string[]>(['telegram', 'vk']);
  const [workspaceName, setWorkspaceName] = useState('Рабочее пространство');

  useEffect(() => {
    void workspaceRequest<{ workspace?: { workspace_name?: string } }>('get-workspace').then(result => {
      if (result.workspace?.workspace_name) setWorkspaceName(result.workspace.workspace_name);
    }).catch(() => undefined);
  }, []);

  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);

  return (
    <AppShell active="plan">
      <section className="page-section">
        <div className="page-heading">
          <div><div className="eyebrow">ПЛАН ПУБЛИКАЦИЙ</div><h1>{workspaceName}</h1><p>Здесь будет календарь запланированных и уже опубликованных материалов.</p></div>
          <button className="plus-button" type="button">＋</button>
        </div>
        <section className="card calendar-preview">
          <div className="calendar-toolbar"><div><strong>Октябрь 2026</strong><span>Сегодня</span></div><div className="calendar-mode"><button className="secondary">Месяц</button><button className="secondary">Неделя</button></div></div>
          <div className="calendar-grid">
            {['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day => <div className="calendar-weekday" key={day}>{day}</div>)}
            {Array.from({ length: 35 }, (_, index) => <div className="calendar-cell" key={index}>{index < 31 && <span>{index + 1}</span>}{index === 5 && <div className="calendar-post mock-post">Новая публикация</div>}{index === 12 && <div className="calendar-post mock-post">Анонс мероприятия</div>}</div>)}
          </div>
        </section>
        <section className="card quick-composer">
          <div className="card-head"><h2>Быстрый просмотр редактора</h2><span>Скоро подключим сохранение</span></div>
          <textarea placeholder="Введите текст публикации…" />
          <div className="media">＋ Добавить фото или видео</div>
          <div className="targets"><h3>Площадки</h3>{networks.map(network => <button key={network.id} onClick={() => !network.muted && toggle(network.id)} className={selected.includes(network.id) ? 'network active' : 'network'} disabled={network.muted}><b>{network.icon}</b>{network.name}{network.muted && <small>позже</small>}</button>)}</div>
          <div className="schedule"><div><label>Дата</label><input type="date" /></div><div><label>Время</label><input type="time" /></div></div>
        </section>
      </section>
    </AppShell>
  );
}
