# SMM Service

Онлайн-платформа автопостинга в Telegram, VK, MAX и Одноклассники. Instagram — следующим этапом.

## Production architecture
- Web: Next.js on Vercel (production target); Netlify configuration removed from the repository
- Auth/DB/Storage/Functions: Supabase
- Scheduler: pg_cron + pg_net + Supabase Edge Function
- Secrets: Supabase Vault for encryption material; provider tokens are kept server-side
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

AI-помощник доступен прямо в редакторе публикации.

### AI-провайдеры
Поддерживается резервная цепочка провайдеров: Groq → Gemini → OpenRouter → OpenAI (необязательный платный fallback).

Базовая бесплатная конфигурация:
- `GROQ_API_KEY` — основной провайдер
- `GEMINI_API_KEY` — резерв
- `OPENROUTER_API_KEY` — дополнительный резерв

Настройки моделей и порядок можно менять через secrets Edge Function:
- `AI_PROVIDER_ORDER=groq,gemini,openrouter,openai`
- `GROQ_MODEL=openai/gpt-oss-120b`
- `GEMINI_MODEL=gemini-3.8-flash`
- `OPENROUTER_MODEL=openrouter/free`

Ключи AI хранятся только на стороне Supabase Edge Function и не должны попадать во frontend, GitHub или переменные `NEXT_PUBLIC_*`.

## Security
- Workspace-based RLS
- Private Storage
- Encrypted social tokens
- Server-only secrets
- Protected scheduler

## Current status
Предфинальное ядро собрано: календарь, редактор публикаций, медиа, рабочие пространства и приглашения, подключение и health-check аккаунтов, планирование/очередь, реальные адаптеры Telegram/VK/MAX/ОК, статистика и защищённое хранение токенов. OAuth-подключение соцсетей и часть расширенной аналитики остаются следующим этапом.
