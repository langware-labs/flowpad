"""FastAPI backend.

Run with: .venv/bin/uvicorn main:app --reload --port 8080

In development the Next.js frontend proxies /api/* here (next.config.ts
rewrite), so browser code calls relative /api/... paths on port 3000.
Interactive docs: http://localhost:8080/docs
"""

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Web App API", version="0.1.0")

# CORS for direct (non-proxied) calls from the dev frontend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    status: str
    service: str


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health check — also used by the landing-page status board."""
    return HealthResponse(status="ok", service="fastapi")


class EchoRequest(BaseModel):
    text: str


@app.post("/api/echo")
async def echo(req: EchoRequest) -> dict:
    """Example endpoint — replace with real Python-powered routes."""
    return {"echo": req.text}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
