# Архитектура MVP

## Поток публикации
User -> Web -> API -> PostgreSQL
                         |
                         +-> scheduled_posts
                                 |
                                 v
                              worker
                       +---------+----------+
                       |         |          |
                    Telegram    VK       MAX / OK

## Принцип
Каждая площадка реализуется как отдельный adapter с единой функцией publish().
Сервис хранит собственный статус: draft / scheduled / publishing / published / failed.

## Безопасность
- Не хранить пароли социальных сетей.
- OAuth/access tokens хранить только в зашифрованном виде.
- Секреты только в environment variables / secret storage.
- У каждого пользователя изолированные connected accounts и posts.
