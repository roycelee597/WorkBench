from pathlib import Path
from types import SimpleNamespace

import pytest

from cs2_engine import disk_space
from cs2_engine.record_task import RecordError

_OUTPUT = Path("output")
_WORK = Path("work")
_NATIVE = Path("native")
_SIZE = (1920, 1080)


def _budgets(
    monkeypatch, durations, *, keep_raw=False, shared=False, native=False, native_on_work=False
):
    seen = {}
    volumes = {_OUTPUT: (1, "D:", _OUTPUT), _WORK: (2, "E:", _WORK), _NATIVE: (3, "F:", _NATIVE)}
    if shared:
        volumes[_WORK] = (1, "D:", _WORK)
    if native_on_work:
        key, label, _ = volumes[_WORK]
        volumes[_NATIVE] = (key, label, _NATIVE)
    monkeypatch.setattr(disk_space, "_find_volume", volumes.__getitem__)

    def track(label, _existing, needed):
        assert label not in seen
        seen[label] = needed
        return None

    monkeypatch.setattr(disk_space, "_shortage", track)
    disk_space.check_recording_space(
        _OUTPUT,
        _WORK,
        durations,
        capture_size=_SIZE,
        demo_bytes=100_000_000,
        keep_raw=keep_raw,
        native_dir=_NATIVE if native else None,
    )
    return seen


def test_raw_reservation_accounts_for_resolution_and_measured_speed():
    # Budget the recording above the measured 373.43 MB/s, with a smaller 4:3 image.
    full = disk_space.raw_bytes(10, _SIZE)
    stretched = disk_space.raw_bytes(10, (1440, 1080))
    assert 4_980_000_000 < full < 5_100_000_000
    assert 0.74 < stretched / full < 0.76


def test_default_budget_reuses_one_raw_slot_and_kept_raw_budget_sums_clips(monkeypatch):
    default_one = _budgets(monkeypatch, [10])
    default_many = _budgets(monkeypatch, [10, 10, 10])
    keep = _budgets(monkeypatch, [10, 10, 10], keep_raw=True)

    assert default_one["D:"] < default_many["D:"] == keep["D:"]
    assert default_one["E:"] == default_many["E:"]
    assert keep["E:"] > default_many["E:"] + 2 * disk_space.raw_bytes(10, _SIZE)


def test_large_compilation_temporaries_are_accounted_for(monkeypatch):
    short = _budgets(monkeypatch, [1])
    long = _budgets(monkeypatch, [1] * 100)

    assert short["D:"] < long["D:"]
    assert 2_000_000_000 < long["E:"] < 2_100_000_000


def test_output_budget_uses_eight_megabytes_per_second_for_clips_and_compilations(monkeypatch):
    budgets = _budgets(monkeypatch, [10, 20])

    assert budgets["D:"] == 2 * 30 * 8_000_000 + 1024**2 + 2 * 2048 + 256 * 1024**2


def test_shared_physical_volume_adds_both_requirements_once(monkeypatch):
    separate = _budgets(monkeypatch, [10])
    shared = _budgets(monkeypatch, [10], shared=True)

    assert list(shared) == ["D:"]
    assert max(separate.values()) < shared["D:"] <= sum(separate.values())


def test_startmovie_accounts_for_install_drive_and_restored_raw(monkeypatch):
    regular = _budgets(monkeypatch, [5, 10])
    regular_kept = _budgets(monkeypatch, [5, 10], keep_raw=True)
    native = _budgets(monkeypatch, [5, 10], native=True)
    kept = _budgets(monkeypatch, [5, 10], native=True, keep_raw=True)

    assert native["E:"] == regular["E:"]
    largest = disk_space.raw_bytes(10, _SIZE)
    assert native["F:"] == kept["F:"] > largest
    assert kept["E:"] > 2 * largest + disk_space.raw_bytes(5, _SIZE)
    assert kept["E:"] > regular_kept["E:"]


@pytest.mark.parametrize("keep_raw", [False, True])
def test_startmovie_install_and_profile_on_same_volume_reserve_one_live_raw_peak(
    monkeypatch, keep_raw
):
    distinct = _budgets(monkeypatch, [5, 10], native=True, keep_raw=keep_raw)
    shared = _budgets(monkeypatch, [5, 10], native=True, native_on_work=True, keep_raw=keep_raw)

    assert shared == {name: bytes_ for name, bytes_ in distinct.items() if name != "F:"}


def test_insufficient_space_reports_each_affected_volume(monkeypatch):
    volumes = {_OUTPUT: (1, "D:", _OUTPUT), _WORK: (2, "E:", _WORK)}
    monkeypatch.setattr(disk_space, "_find_volume", volumes.__getitem__)
    monkeypatch.setattr(
        disk_space,
        "disk_usage",
        lambda path: SimpleNamespace(free={_OUTPUT: 10_000_000, _WORK: 50_000_000}[path]),
    )

    with pytest.raises(RecordError) as exc:
        disk_space.check_recording_space(_OUTPUT, _WORK, [10], capture_size=_SIZE, demo_bytes=0)

    assert exc.value.code == "OUTPUT_WRITE_FAILED"
    assert "D: 需要约 0.43 GB，可用 0.01 GB，还差 0.42 GB" in str(exc.value)
    assert "E: 需要约" in str(exc.value) and "可用 0.05 GB，还差" in str(exc.value)


def test_uncreated_path_uses_existing_parent(tmp_path, monkeypatch):
    measured = []

    def usage(path):
        measured.append(path)
        return SimpleNamespace(free=100)

    monkeypatch.setattr(disk_space, "disk_usage", usage)
    proposed = tmp_path / "not-created" / "children"
    disk_space.require_free_space(proposed, 100)

    assert measured == [tmp_path.resolve()]
    assert not proposed.exists()
