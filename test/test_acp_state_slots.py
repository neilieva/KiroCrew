"""Private SQLite slots for codex runtimes.

Every ``codex app-server`` on a host opened the same ``$CODEX_HOME/*.sqlite``
files, so a Codex Desktop daemon plus Crew runtimes failed new sessions with
``database is locked``. Each Crew codex runtime now holds its own slot and points
``CODEX_SQLITE_HOME`` at it.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path

import pytest

from kiro_crew.acp.harness.codex import sqlite_slot_root
from kiro_crew.acp.runtime import AcpRuntime
from kiro_crew.acp.state_slots import MAX_STATE_SLOTS, acquire_state_slot


def test_concurrent_holders_get_distinct_slots_and_a_freed_slot_is_reused(tmp_path: Path) -> None:
    first = acquire_state_slot(tmp_path)
    second = acquire_state_slot(tmp_path)
    assert first.path != second.path
    assert {first.path.name, second.path.name} == {"slot-0", "slot-1"}

    first.release()
    first.release()  # a second release is harmless
    again = acquire_state_slot(tmp_path)
    # Lowest free slot wins, so a restarted runtime keeps its built databases.
    assert again.path == tmp_path / "slot-0"
    second.release()
    again.release()


def test_every_slot_held_raises_oserror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kiro_crew.acp.state_slots.MAX_STATE_SLOTS", 2)
    held = [acquire_state_slot(tmp_path), acquire_state_slot(tmp_path)]
    with pytest.raises(OSError, match="state slots"):
        acquire_state_slot(tmp_path)
    for slot in held:
        slot.release()
    assert MAX_STATE_SLOTS == 64


def test_slot_root_follows_the_operators_codex_locations(tmp_path: Path) -> None:
    home = tmp_path / "home"
    assert sqlite_slot_root({}, home) == home / ".codex" / "kirocrew-sqlite"
    assert sqlite_slot_root({"CODEX_HOME": "/c"}, home) == Path("/c/kirocrew-sqlite")
    both = {"CODEX_HOME": "/c", "CODEX_SQLITE_HOME": "/s"}
    assert sqlite_slot_root(both, home) == Path("/s/kirocrew-sqlite")


def _bare_runtime() -> AcpRuntime:
    # The binder reads only its own slot field, so no process is needed.
    return object.__new__(AcpRuntime)


def test_runtime_binds_one_slot_and_keeps_it_across_respawns(tmp_path: Path) -> None:
    one, two = _bare_runtime(), _bare_runtime()
    request = ("CODEX_SQLITE_HOME", str(tmp_path))
    env_one: dict[str, str] = {}
    env_two: dict[str, str] = {}
    one._bind_state_slot(env_one, request)
    two._bind_state_slot(env_two, request)
    assert env_one["CODEX_SQLITE_HOME"] != env_two["CODEX_SQLITE_HOME"]

    respawn: dict[str, str] = {}
    one._bind_state_slot(respawn, request)
    assert respawn == env_one

    one._release_state_slot()
    three = _bare_runtime()
    env_three: dict[str, str] = {}
    three._bind_state_slot(env_three, request)
    assert env_three == env_one
    two._release_state_slot()
    three._release_state_slot()


def test_runtime_without_a_request_leaves_env_alone(tmp_path: Path) -> None:
    env = {"CODEX_SQLITE_HOME": "operator"}
    _bare_runtime()._bind_state_slot(env, None)
    assert env == {"CODEX_SQLITE_HOME": "operator"}


def test_unusable_root_falls_back_to_the_shared_default_with_a_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("")
    env: dict[str, str] = {}
    with caplog.at_level(logging.WARNING, logger="kiro_crew.acp.runtime"):
        _bare_runtime()._bind_state_slot(env, ("CODEX_SQLITE_HOME", str(blocker / "root")))
    assert "CODEX_SQLITE_HOME" not in env
    assert "no private CODEX_SQLITE_HOME" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("confirmed_dead", [True, False])
async def test_kill_frees_the_slot_only_once_the_tree_is_confirmed_dead(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, confirmed_dead: bool
) -> None:
    import kiro_crew.acp.runtime as runtime_mod

    runtime = AcpRuntime(work_dir=tmp_path / "workspace")
    runtime._bind_state_slot({}, ("CODEX_SQLITE_HOME", str(tmp_path / "slots")))
    held = runtime._state_slot
    assert held is not None

    async def fake_kill_inner(self, *, expected=False, reason=""):
        # A survivor (an unsignalled root or a retained descendant) leaves the
        # flag False, and it still has the slot's databases open.
        self._process_tree_confirmed_dead = confirmed_dead

    monkeypatch.setattr(runtime_mod, "authorize_runtime_kill", lambda *a, **k: True)
    monkeypatch.setattr(AcpRuntime, "_kill_inner", fake_kill_inner)
    await runtime.kill(expected=True, reason="test")

    if confirmed_dead:
        assert runtime._state_slot is None
        assert acquire_state_slot(tmp_path / "slots").path == held.path
    else:
        assert runtime._state_slot is held
        assert acquire_state_slot(tmp_path / "slots").path != held.path


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_at", ["before_process_creation", "process_creation"])
async def test_a_spawn_that_never_creates_a_process_frees_its_slot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fail_at: str
) -> None:
    import kiro_crew.acp.runtime as runtime_mod
    from kiro_crew.acp.harness.base import SpawnPlan

    monkeypatch.setenv("KIROCREW_NATIVE_SKILL_PROJECTION", "0")
    slots = tmp_path / "slots"
    seen: dict[str, str] = {}

    class _StopSpawn(Exception):
        pass

    async def plan(self):
        return SpawnPlan(argv=["/bin/true"], private_state_dir=("CODEX_SQLITE_HOME", str(slots)))

    async def stop_spawn(*args, **kwargs):
        seen.update(kwargs["env"])
        raise _StopSpawn()

    async def unbound(work_dir):
        return work_dir, None

    monkeypatch.setattr(AcpRuntime, "_resolve_spawn_plan", plan)
    monkeypatch.setattr(runtime_mod, "wrap_argv", lambda argv, mode, **k: (list(argv), None))
    monkeypatch.setattr(runtime_mod, "cgroup_scope_argv", lambda argv: list(argv))
    monkeypatch.setattr(
        runtime_mod, "assert_voice_runtime_outside_agent_workspace", lambda *a: None
    )
    monkeypatch.setattr(runtime_mod, "bind_voice_safe_agent_workspace_async", unbound)
    monkeypatch.setattr(runtime_mod, "create_subprocess_limited", stop_spawn)
    if fail_at == "before_process_creation":
        # An await after the slot is taken but before the subprocess call.
        def stop_early(env):
            seen.update(env)
            raise _StopSpawn()

        monkeypatch.setattr(runtime_mod, "inject_xdist_auto_cap", stop_early)

    runtime = AcpRuntime(work_dir=tmp_path / "workspace")
    with pytest.raises(_StopSpawn):
        await runtime.spawn()

    assert seen["CODEX_SQLITE_HOME"] == str(slots / "slot-0")
    assert runtime._state_slot is None
    assert acquire_state_slot(slots).path == slots / "slot-0"


@pytest.mark.asyncio
async def test_a_spawn_cancelled_while_taking_its_slot_still_frees_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import kiro_crew.acp.runtime as runtime_mod
    from kiro_crew.acp.harness.base import SpawnPlan

    monkeypatch.setenv("KIROCREW_NATIVE_SKILL_PROJECTION", "0")
    slots = tmp_path / "slots"
    in_thread = threading.Event()
    may_finish = threading.Event()
    finished = threading.Event()
    real_acquire = runtime_mod.acquire_state_slot

    def slow_acquire(root):
        # The worker thread is mid-acquire when the loop cancels spawn; the
        # lock it takes after that must not outlive the runtime.
        in_thread.set()
        assert may_finish.wait(timeout=10)
        try:
            return real_acquire(root)
        finally:
            finished.set()

    async def plan(self):
        return SpawnPlan(argv=["/bin/true"], private_state_dir=("CODEX_SQLITE_HOME", str(slots)))

    async def unbound(work_dir):
        return work_dir, None

    monkeypatch.setattr(AcpRuntime, "_resolve_spawn_plan", plan)
    monkeypatch.setattr(runtime_mod, "wrap_argv", lambda argv, mode, **k: (list(argv), None))
    monkeypatch.setattr(runtime_mod, "cgroup_scope_argv", lambda argv: list(argv))
    monkeypatch.setattr(
        runtime_mod, "assert_voice_runtime_outside_agent_workspace", lambda *a: None
    )
    monkeypatch.setattr(runtime_mod, "bind_voice_safe_agent_workspace_async", unbound)
    monkeypatch.setattr(runtime_mod, "acquire_state_slot", slow_acquire)

    runtime = AcpRuntime(work_dir=tmp_path / "workspace")
    spawning = asyncio.ensure_future(runtime.spawn())
    await asyncio.to_thread(in_thread.wait, 10)
    spawning.cancel()
    await asyncio.sleep(0)
    may_finish.set()
    with pytest.raises(asyncio.CancelledError):
        await spawning
    await asyncio.to_thread(finished.wait, 10)

    assert runtime._state_slot is None
    assert acquire_state_slot(slots).path == slots / "slot-0"
