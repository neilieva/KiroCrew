"""The in-memory prompt ring and the ``prompt-trace`` endpoint that reads it.

Three contracts, each pinned here because a slip is invisible at runtime:

* the ring is BOUNDED per session and across sessions, and eviction never
  removes the session that just wrote (a single oversized prompt must still be
  readable for the turn that sent it);
* a provider records exactly what it hands its transport — the text AFTER the
  receipt substitution ``EssentialDelivery`` performs — and only for a
  persistent session;
* the endpoint is dashboard-only and returns the backend's own block spans, so
  the developer view can never disagree with the size breakdown about a
  boundary.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from kiro_crew import prompt_trace
from kiro_crew.context_blocks import USER_LABEL, block_spans, split_blocks
from kiro_crew.dashboard.handlers import telemetry as h
from kiro_crew.essential_delivery import EssentialDelivery


@pytest.fixture(autouse=True)
def _fresh_ring():
    prompt_trace._reset_for_tests()
    yield
    prompt_trace._reset_for_tests()


# ── the ring ─────────────────────────────────────────────────────────────────


def test_records_are_returned_oldest_first_and_carry_the_text():
    prompt_trace.record("chat-1", "first", backend="kas")
    prompt_trace.record("chat-1", "second", backend="kas")
    recs = prompt_trace.prompts_for("chat-1")
    assert [r.text for r in recs] == ["first", "second"]
    assert recs[0].chars == 5 and recs[0].backend == "kas"
    assert recs[0].ts <= recs[1].ts


def test_each_session_keeps_only_its_newest_turns():
    for i in range(prompt_trace.MAX_TURNS_PER_SESSION + 3):
        prompt_trace.record("chat-1", f"turn {i}")
    texts = [r.text for r in prompt_trace.prompts_for("chat-1")]
    assert len(texts) == prompt_trace.MAX_TURNS_PER_SESSION
    assert texts[0] == "turn 3" and texts[-1] == f"turn {prompt_trace.MAX_TURNS_PER_SESSION + 2}"


def test_empty_key_or_text_records_nothing():
    prompt_trace.record("", "orphan pooled worker")
    prompt_trace.record("chat-1", "")
    assert prompt_trace.prompts_for("") == []
    assert prompt_trace.prompts_for("chat-1") == []


def test_the_global_budget_evicts_the_least_recently_written_session(monkeypatch):
    monkeypatch.setattr(prompt_trace, "MAX_TOTAL_CHARS", 100)
    prompt_trace.record("old", "a" * 60)
    prompt_trace.record("new", "b" * 60)
    assert prompt_trace.prompts_for("old") == [], "the older session should have been evicted"
    assert len(prompt_trace.prompts_for("new")) == 1
    # A prompt larger than the whole budget is still readable for its own session.
    prompt_trace.record("huge", "c" * 500)
    assert len(prompt_trace.prompts_for("huge")) == 1
    assert prompt_trace._store.total_chars == 500


def test_forget_drops_a_session_and_its_bytes():
    prompt_trace.record("chat-1", "x" * 10)
    prompt_trace.record("chat-2", "y" * 5)
    prompt_trace.forget("chat-1")
    assert prompt_trace.prompts_for("chat-1") == []
    assert prompt_trace._store.total_chars == 5


# ── what a provider records ──────────────────────────────────────────────────


class _Event:
    def __init__(self, kind: str, **fields: Any) -> None:
        self.kind = kind
        self.text = fields.get("text", "")
        self.control_notice = False
        self.stop_reason = fields.get("stop_reason", "")
        self.synthetic_completion = False
        self.refusal = False


@pytest.mark.asyncio
async def test_essential_delivery_reports_the_text_it_actually_sends():
    """``on_send`` sees the FINAL message — the same string ``send`` receives."""
    sent: list[str] = []
    seen: list[str] = []

    async def send(message: str):
        sent.append(message)
        yield _Event("text", text="ok")

    delivery = EssentialDelivery()
    async for _ in delivery.stream("hello", send, lambda: ("inc",), on_send=seen.append):
        pass
    assert seen == sent == ["hello"]


# ── the endpoint ─────────────────────────────────────────────────────────────


def _mk(query: str = "", *, app: str = "") -> web.Request:
    request = make_mocked_request("GET", "/api/telemetry/prompt-trace" + query)
    if app:
        request["app"] = app
    return request


def _body(response: web.StreamResponse) -> Any:
    assert isinstance(response, web.Response)
    return json.loads(response.body or b"{}")


@pytest.mark.asyncio
async def test_prompt_trace_400_without_a_slot():
    response = await h.api_prompt_trace(_mk("?slot=%20"))
    assert response.status == 400
    assert _body(response)["code"] == "slot_required"


@pytest.mark.asyncio
async def test_prompt_trace_refuses_an_app_caller_indistinguishably(monkeypatch):
    audited: list[dict[str, Any]] = []
    monkeypatch.setattr(
        h._sel_mod,
        "sel",
        lambda: SimpleNamespace(log_api_access=lambda **kw: audited.append(kw)),
    )
    prompt_trace.record("chat-1", "secret memory text")
    response = await h.api_prompt_trace(_mk("?slot=chat-1", app="some-app"))
    assert response.status == 404
    assert _body(response) == {"error": "not found", "code": "not_found"}
    assert audited and audited[0]["operation"] == "prompt_trace"
    assert audited[0]["outcome"] == "denied"


@pytest.mark.asyncio
async def test_prompt_trace_returns_text_and_the_backends_own_spans():
    text = (
        "[CRITICAL RULES -- always follow these]\nrule\n[END CRITICAL RULES]\n\n"
        "[CURRENT USER REQUEST -- respond to this]\nhello there\n\n(If presenting choices, end with x.)"
    )
    prompt_trace.record("chat-1", text, backend="kas")
    payload = _body(await h.api_prompt_trace(_mk("?slot=chat-1")))
    assert payload["slot"] == "chat-1"
    assert payload["max_turns"] == prompt_trace.MAX_TURNS_PER_SESSION
    (turn,) = payload["turns"]
    assert turn["text"] == text and turn["chars"] == len(text) and turn["backend"] == "kas"
    spans = [(s["start"], s["end"], s["label"]) for s in turn["spans"]]
    assert spans == block_spans(text)
    # Contiguous and covering: the view can colour every character exactly once.
    assert spans[0][0] == 0 and spans[-1][1] == len(text)
    assert all(a[1] == b[0] for a, b in zip(spans, spans[1:]))


@pytest.mark.asyncio
async def test_prompt_trace_is_empty_for_a_session_that_recorded_nothing():
    payload = _body(await h.api_prompt_trace(_mk("?slot=never")))
    assert payload["turns"] == []


# ── block_spans vs split_blocks ──────────────────────────────────────────────

_PROMPT = (
    "[CRITICAL RULES -- always follow these]\nrules here\n[END CRITICAL RULES]\n\n"
    "[Learned corrections -- retained rules]\n- one\n- two\n[End of learned corrections]\n\n"
    "stray text nobody marked\n"
    "[PROJECT] Active project directory: /w\n\n"
    "[CURRENT USER REQUEST -- respond to this]\nwhat is this\n\n(If presenting choices, end with x.)"
)


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"user_chars": len("what is this")},
        {"user_span": (_PROMPT.index("what is this"), _PROMPT.index("what is this") + 12)},
    ],
)
def test_block_spans_sum_to_split_blocks_and_cover_the_prompt(kwargs):
    spans = block_spans(_PROMPT, **kwargs)
    assert spans[0][0] == 0 and spans[-1][1] == len(_PROMPT)
    assert all(a[1] == b[0] for a, b in zip(spans, spans[1:]))
    sums: dict[str, int] = {}
    for start, end, label in spans:
        sums[label] = sums.get(label, 0) + (end - start)
    assert sums == split_blocks(_PROMPT, **kwargs)


def test_block_spans_place_the_users_text_where_it_sits():
    start = _PROMPT.index("what is this")
    spans = block_spans(_PROMPT, user_span=(start, start + 12))
    user = [s for s in spans if s[2] == USER_LABEL]
    assert user == [(start, start + 12, USER_LABEL)]
    assert _PROMPT[start : start + 12] == "what is this"


def test_block_spans_of_an_empty_prompt_are_empty():
    assert block_spans("") == []
