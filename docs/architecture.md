# Архитектура

## Контур
User
→ Next.js / Vercel
→ Supabase Auth / Postgres / Storage
→ Edge Function
→ Telegram / VK / MAX / Одноклассники

## Планировщик
pg_cron запускается раз в минуту и вызывает run_scheduler_http().
Он отправляет внутренний запрос в Edge Function publish-scheduled.

Сейчас функция выполняет безопасный heartbeat и считает отложенные цели. Она не публикует контент в соцсети до подключения реальных адаптеров.

## Данные
Workspace
├── members
├── social_accounts
├── posts
│   └── post_targets
└── media

Секреты аккаунтов вынесены в social_account_secrets. Клиентские RLS-политики не дают им доступ.

## Очередь и retry
post_targets:
- pending
- publishing
- published
- failed
- waiting
- canceled

После ошибки complete_post_target() планирует повтор с backoff до пяти попыток.

## Интеграции
Для каждой площадки будет отдельный адаптер с единой логикой:
- validate_connection()
- publish_text()
- publish_media()
- get_target_info()

Instagram — следующий этап.