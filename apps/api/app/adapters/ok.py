"""Odnoklassniki adapter placeholder. Implement official API integration here."""
from dataclasses import dataclass

@dataclass
class OkAdapter:
    name: str = "ok"

    async def publish(self, *, text: str, media: list[str] | None = None, target_id: str | None = None, publish_at: int | None = None):
        raise NotImplementedError("ok integration is not configured")
