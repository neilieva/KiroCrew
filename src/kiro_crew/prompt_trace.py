"""In-memory record of the prompt text each turn handed to the agent.

The dashboard's Context Breakdown tab shows what each turn injected by SIZE
(``ctx_blocks``: label -> characters). That answers "how much" but never
"what": a developer chasing a rule the model ignored, a block that doubled, or a
marker that landed in the wrong place needs to read the exact text the turn
put on the wire, and until this module nothing kept it. The per-turn
diagnostics in ``acp/prompt_blocks.py`` are content-free by requirement (issue
#6022), the usage shards carry sizes only, and the opt-in wire recorder
(``acp/_frame_record.py``) needs an environment variable at gateway start and
writes files a human then has to find.

So this is the third, smallest thing: a bounded ring of the newest prompts per
session, in process memory only, read back by ``GET
/api/telemetry/prompt-trace``. Three properties fix its shape:

* **Memory, never disk.** A prompt carries the user's memory, lessons and skill
  text. Nothing here is persisted, so a gateway restart forgets it and no file
  needs owner-only permissions, redaction or a review step. The wire recorder
  remains the tool for a durable capture.
* **Bounded twice.** At most :data:`MAX_TURNS_PER_SESSION` records per session,
  and at most :data:`MAX_TOTAL_CHARS` characters across all sessions; when the
  global budget is exceeded the least recently written session is dropped
  whole. A session-start prompt can run to a few hundred kilobytes and a busy
  gateway serves many sessions, so an unbounded ring would be a slow leak.
* **Restricted sessions record nothing.** The callers gate on the session's
  memory mode before calling :func:`record`, the same gate the wire recorder
  and the transcript store apply, so an incognito or temporary session leaves
  no prompt text behind even in memory.

The text recorded is the string the provider hands its transport's ``send`` —
after ``EssentialDelivery`` has substituted its receipt envelope, so it is what
``build_prompt_blocks`` wraps into the ``session/prompt`` text block(s). An
image reference in that string becomes an image block on the wire and stays a
path here; that is the one place record and wire differ.
"""

from __future__ import annotations

import collections
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final

#: Newest prompts kept per session. A developer reading the tab wants the last
#: few turns, not the session's history; the transcript store has that.
MAX_TURNS_PER_SESSION: Final = 12

#: Characters kept across ALL sessions before the least recently written
#: session is evicted whole. 48M characters is on the order of 100 MB of
#: Python string, an amount a long-running gateway can hold without anyone
#: noticing and far more than a developer reads.
MAX_TOTAL_CHARS: Final = 48_000_000


@dataclass(frozen=True)
class PromptRecord:
    """One turn's outbound prompt text, as handed to the transport."""

    ts: str
    session_key: str
    backend: str
    chars: int
    text: str

    def to_dict(self) -> dict[str, object]:
        return {
            "ts": self.ts,
            "backend": self.backend,
            "chars": self.chars,
            "text": self.text,
        }


class _Store:
    """The process-wide ring: session_key -> deque of records, LRU-ordered."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.rings: collections.OrderedDict[str, collections.deque[PromptRecord]] = (
            collections.OrderedDict()
        )
        self.total_chars = 0


_store = _Store()


def record(session_key: str, text: str, *, backend: str = "") -> None:
    """Remember *text* as the newest prompt sent on *session_key*.

    Never raises and never blocks on anything but its own short lock: this is
    called on the turn path right before the transport write, and a bookkeeping
    fault must not cost a turn. An empty *session_key* (a pooled worker not yet
    claimed by any session) is dropped: there is no tab that could read it.
    """
    if not session_key or not text:
        return
    rec = PromptRecord(
        ts=datetime.now(timezone.utc).isoformat(),
        session_key=session_key,
        backend=backend,
        chars=len(text),
        text=text,
    )
    try:
        with _store.lock:
            ring = _store.rings.get(session_key)
            if ring is None:
                ring = collections.deque(maxlen=MAX_TURNS_PER_SESSION)
                _store.rings[session_key] = ring
            else:
                _store.rings.move_to_end(session_key)
            if len(ring) == ring.maxlen:
                _store.total_chars -= ring[0].chars
            ring.append(rec)
            _store.total_chars += rec.chars
            # Evict least recently written sessions, never the one just
            # written (it is at the end): a single prompt larger than the whole
            # budget must still be readable for the session that sent it.
            while _store.total_chars > MAX_TOTAL_CHARS and len(_store.rings) > 1:
                _, oldest_ring = _store.rings.popitem(last=False)
                _store.total_chars -= sum(r.chars for r in oldest_ring)
    except Exception:  # noqa: BLE001 - bookkeeping must never reach the turn
        return


def prompts_for(session_key: str) -> list[PromptRecord]:
    """Return the recorded prompts for *session_key*, oldest first."""
    with _store.lock:
        ring = _store.rings.get(session_key)
        return list(ring) if ring else []


def forget(session_key: str) -> None:
    """Drop everything recorded for *session_key* (session closed or reset)."""
    with _store.lock:
        ring = _store.rings.pop(session_key, None)
        if ring:
            _store.total_chars -= sum(r.chars for r in ring)


def _reset_for_tests() -> None:
    with _store.lock:
        _store.rings.clear()
        _store.total_chars = 0
