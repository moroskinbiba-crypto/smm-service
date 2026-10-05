"""Instagram adapter placeholder. Implement official API integration later."""
from dataclasses import dataclass

@dataclass
class InstagramAdapter:
    name: str = "instagram"

    async def publish(self, *, text: str, media: list[str] | None = None, target_id: str | None = None, publish_at: int | None = None):
        raise NotImplementedError("instagram integration is not configured")
