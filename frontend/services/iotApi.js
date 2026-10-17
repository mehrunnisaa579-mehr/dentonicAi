// FarmAI — IoT Sensor API Service
// Fetches live sensor readings from the backend (GET /iot/latest).
// Single source of truth for the backend address comes from api.js BASE_URL.
// Never throws — always returns a parsed JSON object or {status:"error"}.

import { BASE_URL } from './api';

const IOT_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Fetch the latest IoT sensor reading from the backend.
 *
 * @param {number|null} latitude  - Device latitude (from Expo Location). Pass null to omit.
 * @param {number|null} longitude - Device longitude (from Expo Location). Pass null to omit.
 * @returns {Promise<object>}     - Parsed JSON response, or {status:"error"} on any failure.
 *
 * Rules enforced here:
 *  - device_id is NOT sent; backend picks the most recent real device.
 *  - include_sim is NEVER sent; backend hides sim_ devices by default.
 *  - lat/lon appended ONLY when both are valid finite numbers.
 *  - Never throws; catches all network/timeout/parse errors.
 */
export async function fetchIoTLatest(latitude, longitude) {
  let url = `${BASE_URL}/iot/latest`;

  const hasCoords =
    latitude != null &&
    longitude != null &&
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    isFinite(latitude) &&
    isFinite(longitude);

  if (hasCoords) {
    url += `?latitude=${latitude}&longitude=${longitude}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IOT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await response.json();
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.log('[IoT API] Request timed out after', IOT_TIMEOUT_MS, 'ms');
    } else {
      console.log('[IoT API] Network error:', error.message);
    }
    return { status: 'error' };
  }
}
