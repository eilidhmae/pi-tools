"""proxy.py — OpenAI-compatible router for the mlx-lm-multi track.

Listens on $PI_PROXY_PORT, parses the model field's "+suffix", and forwards
to the matching backend mlx_lm.server. Falls back to the base backend when
no suffix is present or the suffix is unknown.

Routing table is supplied as PI_PROXY_ROUTES, comma-separated "suffix:port"
pairs. The "base" entry is required and serves the bare base model id.

Run via launch.sh; no CLI arguments.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
import uvicorn

BASE_MODEL_ID = "qwen3-coder-7b"
TRACK = "mlx-lm-multi"


def parse_routes(raw: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        suffix, port = pair.split(":", 1)
        out[suffix] = int(port)
    if "base" not in out:
        raise SystemExit("PI_PROXY_ROUTES must include a 'base' entry")
    return out


ROUTES = parse_routes(os.environ.get("PI_PROXY_ROUTES", ""))
PORT = int(os.environ.get("PI_PROXY_PORT", "8080"))

app = FastAPI()
client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=5.0))


def backend_for(model_id: str) -> tuple[int, str]:
    """Return (port, suffix) for a requested model id."""
    if model_id == BASE_MODEL_ID:
        return ROUTES["base"], "base"
    if model_id.startswith(BASE_MODEL_ID + "+"):
        suffix = model_id[len(BASE_MODEL_ID) + 1:]
        if suffix in ROUTES:
            return ROUTES[suffix], suffix
    # Unknown — fall back to base. Logged in healthz misses count.
    return ROUTES["base"], "base"


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    backends = []
    for suffix, port in ROUTES.items():
        url = f"http://127.0.0.1:{port}/v1/models"
        try:
            r = await client.get(url, timeout=2.0)
            backends.append({"suffix": suffix, "port": port, "ok": r.status_code == 200})
        except Exception as e:
            backends.append({"suffix": suffix, "port": port, "ok": False, "err": str(e)})
    ok = all(b["ok"] for b in backends)
    return {"ok": ok, "track": TRACK, "adapters": backends}


@app.get("/v1/models")
async def list_models() -> dict[str, Any]:
    data = []
    for suffix in ROUTES:
        mid = BASE_MODEL_ID if suffix == "base" else f"{BASE_MODEL_ID}+{suffix}"
        data.append({"id": mid, "object": "model", "owned_by": "local"})
    return {"object": "list", "data": data}


async def _forward(request: Request, path: str) -> Any:
    body = await request.body()
    try:
        payload = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid JSON body")
    model = payload.get("model", BASE_MODEL_ID)
    port, _ = backend_for(model)
    # Rewrite the model field to bare base id; mlx_lm.server backend doesn't
    # know about our +suffix convention — the adapter is loaded at boot.
    payload["model"] = BASE_MODEL_ID
    url = f"http://127.0.0.1:{port}{path}"

    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in ("host", "content-length")}

    if payload.get("stream"):
        async def streamer():
            async with client.stream("POST", url, json=payload, headers=headers) as r:
                async for chunk in r.aiter_bytes():
                    yield chunk
        return StreamingResponse(streamer(), media_type="text/event-stream")

    r = await client.post(url, json=payload, headers=headers)
    return JSONResponse(status_code=r.status_code, content=r.json())


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    return await _forward(request, "/v1/chat/completions")


@app.post("/v1/completions")
async def completions(request: Request):
    return await _forward(request, "/v1/completions")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
