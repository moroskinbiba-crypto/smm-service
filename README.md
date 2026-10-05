# SMM Service MVP

Платформа автопостинга в Telegram, VK, MAX и Одноклассники. Instagram заложен как следующий адаптер.

## Стек
- Web: Next.js + TypeScript
- API/worker: FastAPI + Python
- DB/Auth/Storage: Supabase (PostgreSQL)
- Deployment: Vercel (web) + Render (API/worker)
- Queue: Redis/Render Key Value

## Первый этап
1. Регистрация и вход
2. Подключение социальных аккаунтов
3. Создание публикации
4. Выбор нескольких площадок
5. Планирование даты и времени
6. Очередь публикаций
7. Автоматическая публикация
8. История, статусы и ошибки
9. Переключение светлой/тёмной темы

AI в MVP пока не включён.

## Архитектура
Каждая соцсеть реализуется отдельным adapter с единым интерфейсом publish().
Секреты и токены не хранятся в коде.

## Deployment
- Vercel — веб-приложение
- Render — FastAPI API + background worker
- Supabase — PostgreSQL, Auth, Storage
