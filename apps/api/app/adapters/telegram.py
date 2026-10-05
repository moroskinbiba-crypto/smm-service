"""Telegram adapter placeholder. Implement official Bot API integration here."""
from dataclasses import dataclass

@dataclass
class TelegramAdapter:
    name: str = "telegram"

    async def publish(self, *, text: str, media: list[str] | None = None, target_id: str | None = None, publish_at: int | None = None):
        raise NotImplementedError("telegram integration is not configured")
