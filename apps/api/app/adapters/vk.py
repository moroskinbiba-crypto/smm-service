"""VK adapter placeholder. Implement official API integration here."""
from dataclasses import dataclass

@dataclass
class VkAdapter:
    name: str = "vk"

    async def publish(self, *, text: str, media: list[str] | None = None, target_id: str | None = None, publish_at: int | None = None):
        raise NotImplementedError("vk integration is not configured")
