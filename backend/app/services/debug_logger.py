"""
Lume Food Engine — Debug Logger

Optional structured logging for the food search pipeline.
All output is suppressed by default and can be enabled by setting:

    LUME_DEBUG=1   (or "true" / "yes")

in the environment before starting the server, e.g.:

    LUME_DEBUG=1 uvicorn app.main:app --reload

What gets logged
────────────────
[ROUTE]   — chosen QueryClass + parsed query metadata
[USDA]    — top USDA candidate descriptions and their scores
[OFF]     — Open Food Facts candidates and their scores before ranking
[REJECT]  — when a candidate or entire source is rejected and why
[RESULT]  — final nutrition result returned to the caller

All log lines are emitted at DEBUG level under the "lume.food" logger so
they can also be captured by any structured logging setup that routes that
logger to a file or aggregator.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

# ---------------------------------------------------------------------------
# Toggle — a single env var enables all debug output
# ---------------------------------------------------------------------------
_DEBUG_ENABLED: bool = os.getenv("LUME_DEBUG", "").strip().lower() in ("1", "true", "yes")

_log = logging.getLogger("lume.food")

# Auto-configure a console handler when debug mode is on and no handler is
# already registered (avoids duplicate lines if the caller has a root handler).
if _DEBUG_ENABLED and not _log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("%(asctime)s  [%(levelname)s]  %(name)s — %(message)s",
                          datefmt="%H:%M:%S")
    )
    _log.addHandler(_handler)
    _log.setLevel(logging.DEBUG)
    _log.propagate = False   # don't double-emit via the root logger


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _j(obj: Any) -> str:
    """Compact JSON serialisation that never raises."""
    try:
        return json.dumps(obj, default=str, ensure_ascii=False)
    except Exception:
        return repr(obj)


# ---------------------------------------------------------------------------
# Public logging functions
# ---------------------------------------------------------------------------

def log_routing(raw_query: str, query_class: str, parsed_meta: dict) -> None:
    """
    Log the chosen QueryClass and key parsed fields for the incoming query.

    Call this once per request in the router, right after classification.
    `parsed_meta` should contain lightweight primitives (no large objects).
    """
    if not _DEBUG_ENABLED:
        return
    _log.debug("[ROUTE]  query=%r  class=%s  parsed=%s", raw_query, query_class, _j(parsed_meta))


def log_usda_candidates(query: str, scored_candidates: list[dict]) -> None:
    """
    Log the top USDA candidates and their computed scores.

    `scored_candidates` should be a list of dicts with at least:
      description, dataType, _score
    Only the first 5 are printed.
    """
    if not _DEBUG_ENABLED:
        return
    top = [
        {
            "desc":  c.get("description", "")[:60],
            "type":  c.get("dataType", ""),
            "score": c.get("_score", "?"),
        }
        for c in scored_candidates[:5]
    ]
    _log.debug("[USDA]   query=%r  top=%s", query, _j(top))


def log_off_candidates(
    query: str,
    candidates: list[tuple[str, str | None, int]],
) -> None:
    """
    Log Open Food Facts candidates with their relevance scores.

    Each entry in `candidates` should be (product_name, brand_or_None, score).
    Only the first 5 are printed.
    """
    if not _DEBUG_ENABLED:
        return
    top = [
        {"name": name[:50], "brand": brand, "score": score}
        for name, brand, score in candidates[:5]
    ]
    _log.debug("[OFF]    query=%r  candidates=%s", query, _j(top))


def log_rejection(query: str, reason: str, details: dict | None = None) -> None:
    """
    Log that a candidate or source was rejected, and the reason.

    Examples:
      reason="usda_score_below_threshold", details={"score": 12, "threshold": 30}
      reason="off_no_candidates"
      reason="meal_calorie_floor", details={"keyword": "smoothie", "calories": 89, "floor": 150}
    """
    if not _DEBUG_ENABLED:
        return
    _log.debug("[REJECT] query=%r  reason=%s  details=%s", query, reason, _j(details or {}))


def log_result(
    query: str,
    source_type: str,
    confidence: float,
    calories: float,
    name: str = "",
) -> None:
    """
    Log the final nutrition result returned to the caller.

    Call this at the end of route_food_query, after all source selection
    and confidence assignment is done.
    """
    if not _DEBUG_ENABLED:
        return
    _log.debug(
        "[RESULT] query=%r  source=%s  conf=%.2f  cal=%.0f  name=%r",
        query, source_type, confidence, calories, name,
    )
