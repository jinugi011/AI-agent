from fastapi import FastAPI

app = FastAPI(title="Generated Project")

@app.get("/health")
def health():
    return {"status": "ok"}
