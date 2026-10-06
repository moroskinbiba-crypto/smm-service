# Manual setup for social integrations

This repository already contains the application-side flows. The remaining manual work is provider registration and Edge Function secrets.

## Supabase Edge Function secrets

Project:
https://lzogiorclfpmibqmzugg.supabase.co

Add these secrets to the Supabase Edge Functions environment:

### Telegram
- `TELEGRAM_SERVICE_BOT_TOKEN` — token of the SMM service bot from @BotFather.
- `TELEGRAM_SERVICE_BOT_USERNAME` — username of that bot without or with @.
- `TELEGRAM_WEBHOOK_SECRET` — long random secret used by Telegram webhook.

Telegram webhook:
`https://lzogiorclfpmibqmzugg.supabase.co/functions/v1/telegram-webhook`

The app registers the webhook automatically when a user starts the Telegram service-bot connection flow.

### MAX
- `MAX_CONNECT_BOT_TOKEN` — token of the service MAX bot.
- `MAX_CONNECT_BOT_USERNAME` — service bot username.
- `MAX_WEBHOOK_SECRET` — webhook secret.

MAX webhook:
`https://lzogiorclfpmibqmzugg.supabase.co/functions/v1/max-webhook`

The application registers the MAX webhook automatically from the “Через добавление бота в канал” flow.

### VK OAuth
- `VK_APP_ID`
- `VK_APP_SECRET`
- `VK_REDIRECT_URI`

Set `VK_REDIRECT_URI` to the production web app callback:
`https://YOUR-DOMAIN/oauth/callback`

Register exactly the same callback in the VK application settings.

### Meta / Instagram OAuth
- `META_APP_ID`
- `META_APP_SECRET`
- `META_REDIRECT_URI`

Set `META_REDIRECT_URI` to:
`https://YOUR-DOMAIN/oauth/callback`

The Instagram account must be professional (Business or Creator), and the required permissions must be enabled in the Meta app.

### AI
- `OPENAI_API_KEY`
- optional: `OPENAI_MODEL`

## Telegram service bot

1. Open @BotFather.
2. Create the SMM service bot.
3. Save the bot token.
4. Turn on Business Mode for the bot because the same service bot is used for Telegram Business connections.
5. Put the token and username into the Supabase secrets above.
6. In the SMM service, choose Telegram → “Через бота SMM-сервиса”.

### Telegram channel connection

The user presses “Получить код подключения”, adds the service bot to the target channel as an administrator with permission to publish, then posts:

`/connect CODE`

The webhook receives the channel post and creates the Telegram account automatically.

### Telegram Business / Stories connection

1. The user starts the SMM connection flow and opens the generated Telegram deep link.
2. The user presses Start in the service bot.
3. The user opens Telegram Business → Chatbots.
4. The user connects the service bot to the Business account.
5. The user grants the bot “manage stories” permission.
6. Telegram sends a BusinessConnection update; the webhook saves the connection ID and the account becomes available for Stories.

No manual `business_connection_id` copy/paste should be needed.

## MAX service bot

1. Create the service bot in MAX.
2. Save its token and username.
3. Put them into Supabase secrets.
4. The user selects MAX → “Через добавление бота в канал”.
5. The service generates a one-time code.
6. Add the service bot to the channel as an administrator.
7. Post `/connect CODE` in the channel.
8. The MAX webhook receives the event and connects the channel automatically.

## Instagram

1. Create/configure the Meta app.
2. Add Instagram/Facebook products required for the chosen API flow.
3. Configure the exact `/oauth/callback` redirect URL.
4. Enable the required permissions.
5. Make sure the Instagram profile is professional and linked to a Facebook Page for the Facebook Login flow.
6. Put Meta app ID/secret/redirect URI into Supabase Edge Function secrets.
7. In the app choose Instagram → “Войти через Meta и выбрать Instagram”.

The app then shows the available professional Instagram accounts and lets the user select one.

## What the user should not have to enter manually

- Telegram `business_connection_id`
- MAX `chat_id` when using the service-bot connection flow
- VK community ID when using OAuth
- Instagram user ID when using Meta OAuth

Those values are collected by the provider flow and stored by the backend.
