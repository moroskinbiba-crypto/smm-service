# Архитектура SMM Service

## Production
- Vercel: Next.js web app.
- Supabase Auth: регистрация, вход, сессии.
- Supabase PostgreSQL: workspaces, accounts, posts, targets, logs.
- Supabase Storage: приватная медиатека.
- Supabase Edge Functions: серверные операции и scheduler.
- pg_cron + pg_net: периодический запуск scheduler раз в минуту.
- Supabase Vault: секреты и ключ шифрования токенов.

## Поток публикации

User
  -> Next.js
  -> Supabase Auth / Postgres / Storage
  -> scheduled post
  -> pg_cron
  -> publish-scheduled Edge Function
  -> platform adapter
  -> Telegram / VK / MAX / Одноклассники

## Безопасность
- Пользовательские данные изолированы workspace-based RLS.
- API tokens соцсетей не хранятся в открытом виде в social_accounts.
- Токены шифруются server-side через Vault key + pgcrypto.
- Таблица social_account_secrets закрыта RLS.
- Внутренние SECURITY DEFINER функции недоступны anon/authenticated.
- Scheduler использует отдельный cron token.
- Media bucket приватный.
- Instagram заложен как отдельная интеграция второго этапа.

## Важное состояние
Scheduler существует и запускается раз в минуту, но disabled=true до подключения реальных social adapters. Это предотвращает ложное выставление задач в publishing.
