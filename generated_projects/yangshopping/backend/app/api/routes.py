from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["core"])

@router.get("/status")
def status():
    return {"status": "ready", "message": "Project is running"}

@router.get("/summary")
def summary():
    return {"summary": "Secure starter project scaffold"}
