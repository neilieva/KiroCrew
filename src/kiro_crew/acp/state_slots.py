"""Exclusive state directories for hosts whose on-disk state must not be shared.

Some hosts keep SQLite databases that tolerate only one live process at a time.
``codex app-server`` is one: every app-server on a host opens the same
``$CODEX_HOME/*.sqlite`` files, so a Codex Desktop daemon plus two Crew runtimes
fail new sessions with ``database is locked``.

A slot is a numbered directory under a root the harness names, held by an
exclusive advisory lock on a file inside it for as long as one runtime owns it.
The lowest free slot wins, so a restarted runtime reuses a directory whose
databases are already built instead of paying a fresh backfill each spawn. The
lock is released by closing its file, so a crashed gateway frees its slots with
no cleanup step.
"""

from __future__ import annotations

import contextlib
import logging
import os
from pathlib import Path

from kiro_crew import platform_compat

logger = logging.getLogger(__name__)

__all__ = ["MAX_STATE_SLOTS", "StateSlot", "acquire_state_slot"]

#: More live runtimes than this on one root means something leaks runtimes; the
#: caller falls back to the host's shared default rather than grow without bound.
MAX_STATE_SLOTS = 64

_LOCK_NAME = ".kirocrew-slot.lock"


class StateSlot:
    """One held slot: its directory, and the lock that keeps it exclusive."""

    def __init__(self, root: Path, path: Path, stack: contextlib.ExitStack) -> None:
        self.root = root
        self.path = path
        self._stack = stack

    def release(self) -> None:
        """Drop the lock. Safe to call twice."""
        self._stack.close()


def acquire_state_slot(root: Path) -> StateSlot:
    """Take the lowest free slot under *root*. Blocking IO: call off-loop.

    Raises ``OSError`` when the root cannot be created or every slot is held.
    """
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    for index in range(MAX_STATE_SLOTS):
        path = root / f"slot-{index}"
        path.mkdir(exist_ok=True, mode=0o700)
        stack = contextlib.ExitStack()
        try:
            fd = os.open(path / _LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o600)
            stack.callback(os.close, fd)
            stack.enter_context(platform_compat.file_lock(fd, exclusive=True, wait=False))
        except BlockingIOError:
            stack.close()
            continue
        except BaseException:
            stack.close()
            raise
        return StateSlot(root, path, stack)
    raise OSError(f"all {MAX_STATE_SLOTS} state slots under {root} are held")
