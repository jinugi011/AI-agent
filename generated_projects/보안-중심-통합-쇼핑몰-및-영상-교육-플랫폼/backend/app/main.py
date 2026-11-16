from fastapi import FastAPI

from app.api.routes import router

app = FastAPI(title="보안 중심 통합 쇼핑몰 및 영상 교육 플랫폼")
app.include_router(router)

@app.get("/health")
def health():
    return {"status": "ok", "project": "보안 중심 통합 쇼핑몰 및 영상 교육 플랫폼"}
