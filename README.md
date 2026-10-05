# SMM Service

Онлайн-платформа автопостинга в Telegram, VK, MAX и Одноклассники. Instagram закладывается как следующий адаптер.

## Текущая архитектура
- Web: Next.js + TypeScript на Vercel
- Auth/DB/Storage/Edge Functions: Supabase
- Scheduler: Supabase pg_cron + pg_net
- Секреты токенов соцсетей: отдельная серверная таблица + шифрование через pgcrypto и ключ в Supabase Vault
- Рабочие пространства: workspace + members, чтобы позже добавить команды и роли

## Основные сущности
- profiles
- workspaces
- workspace_members
- social_accounts
- social_account_secrets
- posts
- post_targets
- publication_logs

## Статусы
Пост: draft / scheduled / publishing / partially_published / published / failed / canceled.

Цель публикации: pending / publishing / published / failed / waiting / canceled.

## Безопасность
- Клиенты не получают таблицу секретов соцсетей.
- Внутренние SECURITY DEFINER функции закрыты для anon/authenticated и предназначены для service_role.
- RLS изолирует рабочие пространства.
- Медиа хранится в приватном Storage bucket media.
- Scheduler защищён отдельным внутренним ключом.

## MVP
1. Регистрация и вход
2. Рабочее пространство
3. Подключение Telegram, VK, MAX и ОК
4. Создание и планирование публикаций
5. Очередь, retry и история
6. Светлая/тёмная тема

AI-функции пока не включены.