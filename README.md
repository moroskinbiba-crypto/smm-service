# SMM Service

Онлайн-платформа автопостинга в Telegram, VK, MAX и Одноклассники. Instagram — следующим этапом.

## Production architecture
- Web: Next.js on Vercel
- Auth/DB/Storage/Functions: Supabase
- Scheduler: pg_cron + pg_net + Supabase Edge Function
- Secrets: Supabase Vault
- Social integrations: отдельные platform adapters

## MVP
1. Регистрация и вход
2. Рабочее пространство
3. Подключение соцсетей
4. Создание публикации
5. Медиа
6. Планирование
7. Очередь
8. Автопубликация
9. История и ошибки
10. Светлая/тёмная тема

AI пока не входит в MVP.

## Security
- Workspace-based RLS
- Private Storage
- Encrypted social tokens
- Server-only secrets
- Protected scheduler

## Current status
Инфраструктура и база подготовлены. Реальные API-интеграции соцсетей и полноценный фронтенд ещё в разработке.
