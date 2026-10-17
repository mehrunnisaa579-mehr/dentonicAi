"""
FarmAI — IoT Sensor Service
Stores and provides real field telemetry (soil moisture, temperature, humidity)
received from ESP32 hardware sensors.

Rules enforced here:
- Only real hardware readings are stored in iot_readings.json.
- Devices whose id starts with "sim_" are kept in-memory ONLY; never persisted.
- No mock / random / fallback sensor values are ever fabricated.
- If no real reading exists, callers receive None; endpoints surface "no_data".
"""

import os
import json
import time
import logging
import math
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Tunable thresholds (easy to adjust; not business logic) ──────────────────
SOIL_DRY_LIMIT = 30.0        # soil_moisture < 30  → "dry"
SOIL_WET_LIMIT = 60.0        # soil_moisture > 60  → "wet"  (30-60 → "adequate")
IOT_STALE_AFTER_SECONDS = int(os.getenv("IOT_STALE_AFTER_SECONDS", "60"))
_DEQUE_MAXLEN = 360          # per-device in-memory cap
_PERSIST_MAXLEN = 100        # per-device cap in JSON file
_FLUSH_INTERVAL_SEC = 30     # minimum seconds between file writes
_WEATHER_CACHE_TTL_SEC = 600 # 10 minutes: TTL for live weather rain cache
_WEATHER_FAIL_TTL_SEC   = 60  # 60 seconds: remember weather unavailability before retrying

# ── Storage paths ─────────────────────────────────────────────────────────────
_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_READINGS_FILE = _DATA_DIR / "iot_readings.json"

# ── In-process state ──────────────────────────────────────────────────────────
_lock = threading.Lock()
# {device_id: deque(maxlen=360)}  — holds real AND sim readings
_store: dict[str, deque] = {}
# track order of most-recently-updated real devices for "pick best" logic
_real_device_last_updated: dict[str, float] = {}

_loaded = False            # lazy-load flag
_last_flush_time = 0.0     # epoch of last successful file write

# Weather rain-data cache: {(lat2, lon2): {"rain_expected_24h": bool, "cached_at": monotonic_float}}
# Only successful live results (source != "fallback") are stored here. Never cached: failures or fallback.
_weather_cache: dict = {}

# Weather failure memory: {(lat2, lon2): monotonic_float (time of last failure)}
# When live weather fails or returns fallback, the failure timestamp is stored for
# _WEATHER_FAIL_TTL_SEC seconds so subsequent polls skip the network entirely.
# No weather values are ever stored here — only the timestamp of the failure.
_weather_fail_cache: dict = {}


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _is_sim(device_id: str) -> bool:
    return str(device_id).startswith("sim_")


def _classify_soil(soil_moisture: float) -> str:
    if soil_moisture < SOIL_DRY_LIMIT:
        return "dry"
    if soil_moisture > SOIL_WET_LIMIT:
        return "wet"
    return "adequate"


def _load_from_disk() -> None:
    """
    Load persisted readings into _store once at first use.
    A corrupt / missing file is silently ignored — never crashes startup.
    """
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not _READINGS_FILE.exists():
            return
        raw = _READINGS_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            return
        for dev_id, readings in data.items():
            if _is_sim(dev_id):
                continue          # never re-load sim data
            if not isinstance(readings, list):
                continue
            dq = deque(maxlen=_DEQUE_MAXLEN)
            for r in readings:
                dq.append(r)
            _store[dev_id] = dq
            if dq:
                _real_device_last_updated[dev_id] = dq[-1].get("received_at", 0.0)
        logger.info("[IoT Service] Loaded persisted readings from disk: %d device(s)", len(_store))
    except Exception as exc:
        logger.warning("[IoT Service] Could not load iot_readings.json (ignored): %s", exc)


def _flush_to_disk() -> None:
    """
    Persist last _PERSIST_MAXLEN real readings per device atomically.
    Sim devices are never written. Any disk error is swallowed.
    Rate-limited to once every _FLUSH_INTERVAL_SEC seconds.
    """
    global _last_flush_time
    now = time.monotonic()
    if now - _last_flush_time < _FLUSH_INTERVAL_SEC:
        return
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        payload: dict = {}
        for dev_id, dq in _store.items():
            if _is_sim(dev_id):
                continue
            payload[dev_id] = list(dq)[-_PERSIST_MAXLEN:]
        tmp_path = _READINGS_FILE.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp_path, _READINGS_FILE)
        _last_flush_time = now
    except Exception as exc:
        logger.warning("[IoT Service] Disk flush failed (ignored): %s", exc)


def _eligible_device(device_id: str | None, include_sim: bool) -> str | None:
    """
    Resolve the target device_id.
    - If device_id is given and passes the sim filter → return it.
    - If device_id is None → pick the most recently updated eligible device.
    - Returns None when nothing eligible exists.
    """
    if device_id is not None:
        if _is_sim(device_id) and not include_sim:
            return None
        return device_id if device_id in _store else None

    # Pick most-recently-updated real device (or sim device if include_sim and no real)
    candidates: list[tuple[float, str]] = []
    for dev_id, dq in _store.items():
        if _is_sim(dev_id) and not include_sim:
            continue
        if not dq:
            continue
        candidates.append((dq[-1].get("received_at", 0.0), dev_id))

    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def add_reading(device_id: str, soil: float, temp: float, hum: float) -> dict:
    """
    Store a real sensor reading.  Returns the stored record dict.
    Thread-safe; never raises.
    """
    with _lock:
        _load_from_disk()

        now_epoch = time.time()
        now_iso = datetime.fromtimestamp(now_epoch, tz=timezone.utc).isoformat()

        record = {
            "device_id": device_id,
            "soil_moisture": round(float(soil), 2),
            "temperature": round(float(temp), 2),
            "humidity": round(float(hum), 2),
            "received_at": now_epoch,
            "received_iso": now_iso,
        }

        if device_id not in _store:
            _store[device_id] = deque(maxlen=_DEQUE_MAXLEN)
        _store[device_id].append(record)

        if not _is_sim(device_id):
            _real_device_last_updated[device_id] = now_epoch
            _flush_to_disk()

        return record


def get_latest(device_id: str | None = None, include_sim: bool = False) -> dict | None:
    """
    Return the most recent reading for the resolved device, or None.
    """
    with _lock:
        _load_from_disk()
        target = _eligible_device(device_id, include_sim)
        if target is None:
            return None
        dq = _store.get(target)
        if not dq:
            return None
        return dict(dq[-1])


def get_history(
    device_id: str | None = None,
    limit: int = 60,
    include_sim: bool = False,
) -> tuple[str | None, list[dict]]:
    """
    Return (resolved_device_id, list_of_readings[-limit:]).
    """
    with _lock:
        _load_from_disk()
        target = _eligible_device(device_id, include_sim)
        if target is None:
            return None, []
        dq = _store.get(target, deque())
        readings = list(dq)[-limit:]
        return target, readings


def get_status(include_sim: bool = False) -> list[dict]:
    """
    Return a status record for every eligible device.
    """
    with _lock:
        _load_from_disk()
        now = time.time()
        result = []
        for dev_id, dq in _store.items():
            if _is_sim(dev_id) and not include_sim:
                continue
            if not dq:
                continue
            last = dq[-1]
            age = now - last.get("received_at", now)
            result.append({
                "device_id": dev_id,
                "online": age <= IOT_STALE_AFTER_SECONDS,
                "seconds_since_last": int(age),
            })
        return result


def list_devices(include_sim: bool = False) -> list[str]:
    """Return all known device IDs passing the sim filter."""
    with _lock:
        _load_from_disk()
        return [
            dev_id for dev_id in _store
            if not (_is_sim(dev_id) and not include_sim)
        ]


# ─────────────────────────────────────────────────────────────────────────────
# Compatibility shims  (keep callers working without editing them)
# ─────────────────────────────────────────────────────────────────────────────

def get_latest_reading(device_id: str = "field_1") -> dict | None:
    """
    Compatibility alias for the old public API.

    Returns the most recent real sensor reading for ``device_id``, or
    ``None`` when no reading has been received yet.

    This is a thin wrapper over :func:`get_latest` using the same real-data
    store.  It never returns mock or default values; callers that receive
    ``None`` must treat it as "no sensor data available".

    Parameters
    ----------
    device_id : str
        Device identifier (default ``'field_1'``).

    Returns
    -------
    dict | None
        Latest reading dict with keys
        ``device_id, soil_moisture, temperature, humidity,
        received_at, received_iso``
        — or ``None`` if no real reading exists yet.
    """
    return get_latest(device_id=device_id, include_sim=False)


class _LatestReadingsProxy:
    """
    Dict-like proxy over ``_store`` that exposes the *latest* reading per
    device — used only by legacy test code (``test_iot_verification.py``)
    that imported the old ``_LATEST_READINGS`` dict directly.

    Supported operations: ``get``, ``clear``, ``__contains__``,
    ``__getitem__``, ``__len__``, ``__repr__``.
    """

    def _snapshot(self) -> dict:
        """Return {device_id: latest_reading_dict} for all non-empty devices."""
        result = {}
        for dev_id, dq in _store.items():
            if dq:
                result[dev_id] = dict(dq[-1])
        return result

    def get(self, device_id: str, default=None):
        dq = _store.get(device_id)
        if not dq:
            return default
        return dict(dq[-1])

    def clear(self) -> None:
        """Clear all in-process state (mirrors old _LATEST_READINGS.clear())."""
        with _lock:
            _store.clear()
            _real_device_last_updated.clear()

    def __contains__(self, device_id: str) -> bool:
        dq = _store.get(device_id)
        return bool(dq)

    def __getitem__(self, device_id: str) -> dict:
        dq = _store.get(device_id)
        if not dq:
            raise KeyError(device_id)
        return dict(dq[-1])

    def __len__(self) -> int:
        return sum(1 for dq in _store.values() if dq)

    def __repr__(self) -> str:  # pragma: no cover
        return f"_LatestReadingsProxy({self._snapshot()!r})"


# Singleton proxy — importable as ``from services.iot_service import _LATEST_READINGS``
_LATEST_READINGS = _LatestReadingsProxy()


# ─────────────────────────────────────────────────────────────────────────────
# Irrigation advice
# ─────────────────────────────────────────────────────────────────────────────

def build_irrigation_advice(
    reading: dict,
    latitude: float | None = None,
    longitude: float | None = None,
) -> dict:
    """
    Derive irrigation advice from the sensor reading and (optionally) live weather.

    Returns:
        {
            "level": "water_now" | "ok" | "hold",
            "text_ur": <Urdu advice string>,
            "rain_check": True | False | None
        }

    Rules:
    - Calls get_live_weather() only when lat/lon are both provided.
    - Any exception from weather is silently caught → sensor-only advice.
    - Never fabricates sensor values; uses only what is in `reading`.
    - Never raises.
    """
    soil = reading.get("soil_moisture", 50.0)
    temp = reading.get("temperature", 25.0)
    soil_status = _classify_soil(soil)

    rain_expected_24h: bool | None = None
    rain_check: bool | None = None

    # ── Attempt live weather (TTL-cached per rounded lat/lon) ──────────────────
    if latitude is not None and longitude is not None:
        cache_key = (round(float(latitude), 2), round(float(longitude), 2))
        now_mono = time.monotonic()
        cached_entry = None
        skip_due_to_failure = False

        # Fast path: check success cache and failure memory under one lock read
        with _lock:
            _entry = _weather_cache.get(cache_key)
            if _entry is not None and (now_mono - _entry["cached_at"]) < _WEATHER_CACHE_TTL_SEC:
                cached_entry = _entry
            elif cache_key in _weather_fail_cache:
                fail_age = now_mono - _weather_fail_cache[cache_key]
                if fail_age < _WEATHER_FAIL_TTL_SEC:
                    # Within failure window — skip network, return sensor-only advice
                    skip_due_to_failure = True
                    logger.debug(
                        "[IoT Service] Weather fail-memory hit for key %s (%.0fs ago, TTL %ds)",
                        cache_key, fail_age, _WEATHER_FAIL_TTL_SEC,
                    )

        if cached_entry is not None:
            # Success cache hit — use stored rain result; no network call needed
            rain_expected_24h = cached_entry["rain_expected_24h"]
            rain_check = rain_expected_24h
            logger.debug("[IoT Service] Weather cache hit for key %s", cache_key)
        elif skip_due_to_failure:
            # Failure memory active — sensor-only advice, no network call
            rain_check = None
            rain_expected_24h = None
        else:
            # Cache miss / failure window expired — fetch live outside the lock
            try:
                from services.weather_service import get_live_weather  # lazy import, read-only
                wx = get_live_weather(float(latitude), float(longitude))
                if isinstance(wx, dict) and wx.get("source") not in (None, "fallback"):
                    rain_expected_24h = bool(wx.get("rain_expected_24h", False))
                    rain_check = rain_expected_24h
                    # Store ONLY successful live results — never cache fallback or errors
                    # Also clear any lingering failure entry for this key
                    with _lock:
                        _weather_cache[cache_key] = {
                            "rain_expected_24h": rain_expected_24h,
                            "cached_at": now_mono,
                        }
                        _weather_fail_cache.pop(cache_key, None)  # clear failure memory
                    logger.debug("[IoT Service] Weather cache stored for key %s", cache_key)
                elif isinstance(wx, dict) and wx.get("source") == "fallback":
                    # Fallback values are not reliable — record failure, sensor-only advice
                    with _lock:
                        _weather_fail_cache[cache_key] = now_mono
                    rain_check = None
                    rain_expected_24h = None
            except Exception as exc:
                logger.warning("[IoT Service] Weather lookup failed (sensor-only advice): %s", exc)
                with _lock:
                    _weather_fail_cache[cache_key] = now_mono
                rain_expected_24h = None
                rain_check = None

    # ── Build advice ─────────────────────────────────────────────────────────
    hot = temp > 38.0
    hot_suffix = "  گرمی زیادہ ہے، صبح سویرے یا شام کے وقت پانی دیں۔" if hot else ""

    if soil_status == "dry":
        if rain_expected_24h is True:
            level = "hold"
            text_ur = "زمین خشک ہے مگر بارش متوقع ہے، بارش کا انتظار کریں۔"
        else:
            level = "water_now"
            text_ur = "زمین خشک ہے، فصل کو پانی دیں۔" + hot_suffix

    elif soil_status == "adequate":
        level = "ok"
        text_ur = "زمین میں نمی مناسب ہے، ابھی پانی کی ضرورت نہیں۔"

    else:  # wet
        level = "hold"
        text_ur = "زمین میں نمی زیادہ ہے، پانی نہ دیں۔"

    return {
        "level": level,
        "text_ur": text_ur,
        "rain_check": rain_check,
    }
