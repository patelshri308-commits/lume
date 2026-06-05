"""
Multi-food input parser.

Converts free-form meal text into a flat list of individual food query
strings before each is sent through route_food_query.

Splitting hierarchy (applied in order, most-significant first):
  1. Newlines  — always create separate items.
  2. Semicolons — split within each newline segment.
  3. Commas    — split within each semicolon segment.
  4. " and "   — splits a segment only when ALL resulting parts are
                 short (≤ MAX_AND_WORDS words), so standalone food items
                 ("eggs and toast") split cleanly while complex ingredient
                 descriptions ("a very rich chocolate and hazelnut torte")
                 are preserved as one query.

Empty and whitespace-only parts are discarded at every level.
"""
from __future__ import annotations

# Parts with more than this many words are not " and "-split.
MAX_AND_WORDS = 5


def split_to_lines(raw: str) -> list[str]:
    """
    Split raw multi-food text into individual food query strings.

    Returns a list of non-empty, stripped strings suitable for passing
    to route_food_query one at a time.
    """
    items: list[str] = []

    for newline_seg in raw.split("\n"):
        for semi_seg in newline_seg.split(";"):
            for comma_seg in semi_seg.split(","):
                seg = comma_seg.strip()
                if not seg:
                    continue

                # Attempt " and " split only when every resulting part is short.
                and_parts = [p.strip() for p in seg.split(" and ")]
                if (
                    len(and_parts) > 1
                    and all(p for p in and_parts)
                    and all(len(p.split()) <= MAX_AND_WORDS for p in and_parts)
                ):
                    items.extend(and_parts)
                else:
                    items.append(seg)

    return [item for item in items if item]
