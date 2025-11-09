"""
Local Nova ACT bridge for NeuroNudge.

Exposes a minimal FastAPI surface that the extension can call without
shipping credentials. Replace the TODO blocks with real Nova SDK calls
once NOVA_ACT_API_KEY is available in the environment.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Annotated

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("nova_bridge")

app = FastAPI(
    title="Nova ACT Local Bridge",
    version="0.1.0",
    description="Local shim that forwards focus rituals to Nova ACT without exposing credentials.",
)

class BreakRitualRequest(BaseModel):
    seconds: Annotated[int, Field(ge=30, le=900)] = 90
    kind: Annotated[str, Field(max_length=64)] = "breathing"
    mute_slack: bool = True


class ReentryRequest(BaseModel):
    url: Annotated[str, Field(min_length=1, max_length=2048, description="Last focused document URL")]
    note: str = ""
    selector_hint: str = "textarea, [contenteditable=true]"


@app.post("/break-ritual")
async def trigger_break_ritual(payload: BreakRitualRequest) -> dict:
    """
    Kick off a short reset ritual. The real implementation should call the Nova ACT SDK.
    """
    if not os.getenv("NOVA_ACT_API_KEY"):
        logger.warning("NOVA_ACT_API_KEY not set; break ritual will run in dry-run mode.")

    logger.info(
        "Triggering Nova break ritual: kind=%s seconds=%s mute_slack=%s",
        payload.kind,
        payload.seconds,
        payload.mute_slack,
    )

    # TODO: Replace with Nova ACT SDK call (non-blocking).
    await asyncio.sleep(min(2, max(0.1, payload.seconds / 60)))

    return {"status": "ok"}


@app.post("/reentry")
async def trigger_reentry(payload: ReentryRequest) -> dict:
    """
    Cue the re-entry automation once the reset finishes.
    """
    if not payload.url:
        raise HTTPException(status_code=400, detail="Missing url.")

    if not os.getenv("NOVA_ACT_API_KEY"):
        logger.warning("NOVA_ACT_API_KEY not set; reentry will run in dry-run mode.")

    logger.info(
        "Triggering Nova reentry: url=%s selector_hint=%s note_len=%d",
        payload.url,
        payload.selector_hint,
        len(payload.note or ""),
    )

    # TODO: Send payload to Nova ACT SDK (non-blocking).
    await asyncio.sleep(0.1)

    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("tools.nova_bridge:app", host="127.0.0.1", port=5057, reload=False)
