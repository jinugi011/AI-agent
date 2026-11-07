from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Secure API")

class CreateOrderRequest(BaseModel):
    user_id: str
    item_id: str
    quantity: int

@app.post("/orders")
def create_order(payload: CreateOrderRequest):
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="quantity must be positive")
    return {"status": "created", "user_id": payload.user_id, "item_id": payload.item_id}
