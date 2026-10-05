from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="SMM Service API", version="0.1.0")

class Health(BaseModel):
    status: str
    service: str

@app.get("/health", response_model=Health)
def health():
    return Health(status="ok", service="smm-api")

@app.get("/api/v1/networks")
def networks():
    return {
        "networks": [
            {"id":"telegram","name":"Telegram","status":"planned"},
            {"id":"vk","name":"VK","status":"planned"},
            {"id":"max","name":"MAX","status":"planned"},
            {"id":"ok","name":"Одноклассники","status":"planned"},
            {"id":"instagram","name":"Instagram","status":"later"},
        ]
    }
