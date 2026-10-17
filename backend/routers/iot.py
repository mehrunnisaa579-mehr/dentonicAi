"""
FarmAI — IoT Router
Endpoints for ESP32 sensor telemetry ingestion, status, and history.

POST /iot/reading    — ingest a real sensor reading
GET  /iot/latest     — latest reading with irrigation advice
GET  /iot/history    — reading history for a device
GET  /iot/status     — online/offline status of all devices

Sim isolation:
  Any device_id starting with "sim_" is hidden from GET endpoints
  unless ?include_sim=true is passed.

Real-data guarantee:
  No mock, random, or fallback sensor values are ever returned.
  If no real reading exists → 200 {"status":"no_data",...}.
"""

import logging
import math
import time

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from services import iot_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/iot", tags=["iot"])


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic model — validation per firmware contract
# ─────────────────────────────────────────────────────────────────────────────

class IoTReading(BaseModel):
    device_id: str = Field(default="field_1", min_length=1, max_length=32)
    soil_moisture: float = Field(..., ge=0.0, le=100.0)
    temperature: float = Field(..., ge=-10.0, le=60.0)
    humidity: float = Field(..., ge=0.0, le=100.0)

    @field_validator("device_id", mode="before")
    @classmethod
    def strip_device_id(cls, v):
        return str(v).strip()

    @field_validator("soil_moisture", "temperature", "humidity", mode="before")
    @classmethod
    def reject_nan_inf(cls, v):
        fv = float(v)
        if math.isnan(fv) or math.isinf(fv):
            raise ValueError("NaN and Inf are not allowed")
        return fv


# ─────────────────────────────────────────────────────────────────────────────
# POST /iot/reading
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/reading")
def post_sensor_reading(payload: IoTReading):
    """
    Ingest live telemetry from ESP32 hardware.
    Returns a tiny 200 response so the firmware can confirm receipt.
    """
    try:
        record = iot_service.add_reading(
            device_id=payload.device_id,
            soil=payload.soil_moisture,
            temp=payload.temperature,
            hum=payload.humidity,
        )
        logger.info(
            "[IoT] Reading stored — device=%s soil=%.1f temp=%.1f hum=%.1f",
            record["device_id"], record["soil_moisture"],
            record["temperature"], record["humidity"],
        )
        return {
            "status": "ok",
            "device_id": record["device_id"],
            "received_at": record["received_iso"],
        }
    except Exception as exc:
        logger.error("[IoT] Unexpected error in POST /iot/reading: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "Internal error storing reading"},
        )


# ─────────────────────────────────────────────────────────────────────────────
# GET /iot/latest
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/latest")
def get_latest_reading(
    device_id: str = Query(default=None),
    latitude: float = Query(default=None),
    longitude: float = Query(default=None),
    include_sim: bool = Query(default=False),
):
    """
    Return the most recent sensor reading with irrigation advice.
    If no eligible data exists → {"status":"no_data"} (HTTP 200, never 404/500).
    Numeric fields are NEVER returned when status is "no_data".
    """
    try:
        reading = iot_service.get_latest(device_id=device_id, include_sim=include_sim)

        if reading is None:
            return {
                "status": "no_data",
                "message_ur": "ابھی تک سینسر سے کوئی ڈیٹا نہیں آیا۔",
            }

        now = time.time()
        age = now - reading.get("received_at", now)
        online = age <= iot_service.IOT_STALE_AFTER_SECONDS
        soil_status = iot_service._classify_soil(reading["soil_moisture"])

        advice = iot_service.build_irrigation_advice(
            reading=reading,
            latitude=latitude,
            longitude=longitude,
        )

        return {
            "status": "ok",
            "online": online,
            "device_id": reading["device_id"],
            "soil_moisture": reading["soil_moisture"],
            "temperature": reading["temperature"],
            "humidity": reading["humidity"],
            "soil_status": soil_status,
            "seconds_since_last": int(age),
            "received_iso": reading["received_iso"],
            "irrigation_advice": advice,
        }

    except Exception as exc:
        logger.error("[IoT] Unexpected error in GET /iot/latest: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "Internal error fetching latest reading"},
        )


# ─────────────────────────────────────────────────────────────────────────────
# GET /iot/history
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/history")
def get_reading_history(
    device_id: str = Query(default=None),
    limit: int = Query(default=60, ge=1, le=360),
    include_sim: bool = Query(default=False),
):
    """
    Return the reading history for a device (up to 360 entries).
    """
    try:
        resolved_id, readings = iot_service.get_history(
            device_id=device_id,
            limit=limit,
            include_sim=include_sim,
        )
        if resolved_id is None:
            return {
                "status": "no_data",
                "message_ur": "ابھی تک سینسر سے کوئی ڈیٹا نہیں آیا۔",
            }
        return {
            "status": "ok",
            "device_id": resolved_id,
            "count": len(readings),
            "readings": readings,
        }
    except Exception as exc:
        logger.error("[IoT] Unexpected error in GET /iot/history: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "Internal error fetching history"},
        )


# ─────────────────────────────────────────────────────────────────────────────
# GET /iot/status
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/status")
def get_devices_status(
    include_sim: bool = Query(default=False),
):
    """
    Return online/offline status for all known devices.
    """
    try:
        devices = iot_service.get_status(include_sim=include_sim)
        return {
            "status": "ok",
            "devices": devices,
        }
    except Exception as exc:
        logger.error("[IoT] Unexpected error in GET /iot/status: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "Internal error fetching status"},
        )
