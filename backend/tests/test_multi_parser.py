"""
multi_parser.split_to_lines — unit tests.

All tests are pure-function with no mocking, network, or DB required.

Run:
    cd backend && pytest tests/test_multi_parser.py -v
"""
from __future__ import annotations

import pytest

from app.services.multi_parser import MAX_AND_WORDS, split_to_lines


# ── Primary separators ────────────────────────────────────────────────────────

def test_newline_splits():
    assert split_to_lines("2 eggs\n1 cup rice\nbanana") == ["2 eggs", "1 cup rice", "banana"]


def test_comma_splits():
    assert split_to_lines("2 eggs, 1 cup rice, banana") == ["2 eggs", "1 cup rice", "banana"]


def test_semicolon_splits():
    assert split_to_lines("6 oz chicken; 1 tbsp olive oil; 1 cup rice") == [
        "6 oz chicken", "1 tbsp olive oil", "1 cup rice"
    ]


def test_and_splits_simple_list():
    assert split_to_lines("eggs and toast and coffee") == ["eggs", "toast", "coffee"]


def test_single_item_unchanged():
    assert split_to_lines("banana") == ["banana"]


# ── Whitespace and empty parts ─────────────────────────────────────────────────

def test_leading_trailing_whitespace_stripped():
    assert split_to_lines("  2 eggs  ,  banana  ") == ["2 eggs", "banana"]


def test_empty_comma_segments_discarded():
    assert split_to_lines("eggs,, banana") == ["eggs", "banana"]


def test_blank_lines_discarded():
    assert split_to_lines("eggs\n\nbanana") == ["eggs", "banana"]


def test_whitespace_only_segments_discarded():
    assert split_to_lines("eggs,   , banana") == ["eggs", "banana"]


def test_empty_string_returns_empty():
    assert split_to_lines("") == []


def test_only_whitespace_returns_empty():
    assert split_to_lines("   \n  \n  ") == []


# ── "and" splitting behaviour ─────────────────────────────────────────────────

def test_and_splits_two_short_items():
    assert split_to_lines("eggs and toast") == ["eggs", "toast"]


def test_and_in_comma_segment():
    # "2 eggs" is a comma-segment on its own; "toast and coffee" is another
    assert split_to_lines("2 eggs, toast and coffee") == ["2 eggs", "toast", "coffee"]


def test_and_not_split_when_part_too_long():
    # "a very rich chocolate torte" is 5 words — right at the boundary
    # "hazelnut cream filling" is 3 words — fine on its own
    # But let's construct a case where one part exceeds MAX_AND_WORDS
    long_part = " ".join(["word"] * (MAX_AND_WORDS + 1))  # 6 words
    raw = f"eggs and {long_part}"
    result = split_to_lines(raw)
    assert result == [raw.strip()]   # not split — preserved as one item


def test_and_boundary_exactly_max_words_does_split():
    # Both parts are exactly MAX_AND_WORDS words → should split
    part = " ".join(["word"] * MAX_AND_WORDS)  # 5 words
    raw = f"{part} and {part}"
    result = split_to_lines(raw)
    assert result == [part, part]


def test_and_preserves_quantity_phrases():
    # "1 cup rice" (3 words) and "2 tbsp soy sauce" (4 words) — both ≤ 5 → split
    result = split_to_lines("1 cup rice and 2 tbsp soy sauce")
    assert result == ["1 cup rice", "2 tbsp soy sauce"]


# ── Mixed separators ───────────────────────────────────────────────────────────

def test_newline_and_comma_mixed():
    result = split_to_lines("2 eggs, toast\noatmeal; banana")
    assert result == ["2 eggs", "toast", "oatmeal", "banana"]


def test_all_three_primary_separators():
    result = split_to_lines("eggs\nrice; chicken, banana")
    assert result == ["eggs", "rice", "chicken", "banana"]


def test_and_within_newline_segment():
    result = split_to_lines("eggs and toast\nbanana")
    assert result == ["eggs", "toast", "banana"]


def test_semicolon_takes_priority_over_and():
    # semicolons split first; "and" only applies within the resulting segments
    result = split_to_lines("eggs and toast; banana and coffee")
    assert result == ["eggs", "toast", "banana", "coffee"]


# ── Real-world examples from the spec ─────────────────────────────────────────

def test_spec_example_comma():
    assert split_to_lines("2 eggs, 1 cup rice, banana") == ["2 eggs", "1 cup rice", "banana"]


def test_spec_example_semicolon():
    assert split_to_lines("6 oz chicken; 1 tbsp olive oil; 1 cup rice") == [
        "6 oz chicken", "1 tbsp olive oil", "1 cup rice"
    ]


def test_spec_example_and():
    assert split_to_lines("eggs and toast and coffee") == ["eggs", "toast", "coffee"]
