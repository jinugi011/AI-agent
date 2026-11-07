from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["core"])

@router.get("/status")
def status():
    return {"status": "ready"}
