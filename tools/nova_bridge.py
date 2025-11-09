"""
Local Nova ACT bridge for NeuroNudge.

When the extension detects an impending focus dip, it calls these endpoints to
kick off a short break ritual and cue re-entry afterwards. This module now
invokes the real Nova ACT SDK where available, while gracefully falling back to
dry-run behavior if the SDK or API key is missing.
"""

from __future__ import annotations

import asyncio
import logging
import os
from textwrap import dedent
from typing import Annotated, Callable, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

try:  # pragma: no cover - optional SDK import
    from nova_act import NovaAct
except ImportError:  # pragma: no cover - allow dry-run without SDK
    NovaAct = None  # type: ignore[misc]


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("nova_bridge")

app = FastAPI(
    title="Nova ACT Local Bridge",
    version="0.2.0",
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


def _nova_available() -> bool:
    if NovaAct is None:
        logger.debug("Nova ACT SDK not installed; operating in dry-run mode.")
        return False
    if not os.getenv("NOVA_ACT_API_KEY"):
        logger.debug("NOVA_ACT_API_KEY not set; operating in dry-run mode.")
        return False
    return True


async def _run_in_executor(fn: Callable[[], None]) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, fn)


def _format_seconds(seconds: int) -> str:
    minutes = seconds // 60
    remaining = seconds % 60
    if minutes and remaining:
        return f"{minutes}m {remaining}s"
    if minutes:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    return f"{seconds} second{'s' if seconds != 1 else ''}"


def _strip_note(note: str) -> str:
    """
    Sanitize multi-line notes so they embed cleanly in the Nova prompt.
    """
    note = note.strip()
    if not note:
        return ""
    return note.replace("\n", " ").strip()


def _describe_break_prompt(payload: BreakRitualRequest) -> str:
    duration = _format_seconds(payload.seconds)
    prompt = dedent(
        f"""
        You are a focus coach helping a writer in Google Docs take a short reset.
        1. Open a new tab and navigate to https://box-breathing.com/?duration={max(30, min(payload.seconds, 300))}.
        2. Start the guided breathing session immediately and let it run in the foreground.
        3. If a confirmation appears, acknowledge it.
        4. Reply in chat with: "Break timer started for {duration}."
        Keep the session active until the timer completes. Do not close the tab or switch away.
        """
    ).strip()
    if payload.mute_slack:
        prompt += (
            "\nIf Slack is open in another tab, pause Slack notifications for the next hour before starting the timer."
        )
    return prompt


def _describe_reentry_prompt(payload: ReentryRequest) -> str:
    safe_note = _strip_note(payload.note)
    base = dedent(
        f"""
        Help the user resume work after their break.
        1. Navigate to {payload.url}.
        2. Wait for the page to finish loading.
        3. Focus the best matching element for the CSS selector "{payload.selector_hint}".
        4. Place the text caret at the end of the existing content without submitting the document.
        """
    ).strip()
    if safe_note:
        base += f'\n5. Insert this note verbatim so the user remembers their next step: "{safe_note}".'
    base += "\n6. Reply in chat with: \"Ready to resume.\""
    return base


async def _invoke_nova(prompt: str, starting_page: Optional[str] = None) -> None:
    if not _nova_available():
        logger.info("Nova unavailable; skipping prompt: %s", prompt.replace("\n", " "))
        return

    def _runner() -> None:
        kwargs = {"starting_page": starting_page} if starting_page else {}
        try:
            with NovaAct(**kwargs) as nova:  # type: ignore[operator]
                nova.act(prompt)
        except Exception as exc:  # pragma: no cover - external SDK behavior
            logger.warning("Nova ACT invocation failed: %s", exc)
            raise

    await _run_in_executor(_runner)


@app.post("/break-ritual")
async def trigger_break_ritual(payload: BreakRitualRequest) -> dict:
    """
    Kick off a short reset ritual via Nova ACT (falls back to a simulated delay).
    """
    logger.info(
        "Triggering Nova break ritual: kind=%s seconds=%s mute_slack=%s",
        payload.kind,
        payload.seconds,
        payload.mute_slack,
    )

    if _nova_available():
        prompt = _describe_break_prompt(payload)
        await _invoke_nova(prompt, starting_page="https://docs.google.com/")
        return {"status": "ok", "nova": True}

    await asyncio.sleep(min(2, max(0.1, payload.seconds / 60)))
    return {"status": "ok", "nova": False, "skipped": "nova_unavailable"}


@app.post("/reentry")
async def trigger_reentry(payload: ReentryRequest) -> dict:
    """
    Cue the re-entry automation once the reset finishes.
    """
    if not payload.url:
        raise HTTPException(status_code=400, detail="Missing url.")

    logger.info(
        "Triggering Nova reentry: url=%s selector_hint=%s note_len=%d",
        payload.url,
        payload.selector_hint,
        len(payload.note or ""),
    )

    if _nova_available():
        prompt = _describe_reentry_prompt(payload)
        await _invoke_nova(prompt, starting_page=payload.url)
        return {"status": "ok", "nova": True}

    await asyncio.sleep(0.1)
    return {"status": "ok", "nova": False, "skipped": "nova_unavailable"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("tools.nova_bridge:app", host="127.0.0.1", port=5057, reload=False)
