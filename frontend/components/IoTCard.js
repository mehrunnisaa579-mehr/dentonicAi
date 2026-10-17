/**
 * IoTCard — کھیت سینسر (Field Sensor) screen component.
 *
 * Displays ONLY real sensor data returned by the backend from the ESP32.
 * Forbidden: placeholder values, Math.random, hardcoded readings, hardcoded device_id,
 * include_sim, or any numeric display when a field is null/undefined.
 *
 * Props:
 *   latitude  {number|null} — from App.js userCoords
 *   longitude {number|null} — from App.js userCoords
 *   embedded  {boolean}     — default false. When true renders as a plain View
 *                             section (no ScrollView) suitable for nesting inside
 *                             another scroll container (e.g. WeatherCard).
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  AppState,
  RefreshControl,
} from 'react-native';
import { fetchIoTLatest } from '../services/iotApi';

// ── Tunable UI constants (no sensor values here) ──────────────────────────────
const POLL_INTERVAL_MS = 10000; // 10 seconds

// Raise this slightly (e.g. to 3 or 4) if your sensor reads a little above 0
// in open air before being pushed into soil. Never set it above ~10.
const SOIL_NOT_IN_GROUND_MAX = 2; // soil_moisture <= this (%) → sensor is out of the soil

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format seconds_since_last into a human-readable Urdu age string.
 * Returns null if seconds is not a valid positive number.
 */
function formatAge(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)} سیکنڈ پہلے`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} منٹ پہلے`;
  return `${Math.round(seconds / 3600)} گھنٹے پہلے`;
}

/**
 * Format a numeric sensor value to one decimal place.
 * Returns null if value is null/undefined/NaN/Inf — caller must show a dash.
 */
function fmtVal(v) {
  if (v == null || !isFinite(v)) return null;
  return Number(v).toFixed(1);
}

/**
 * Returns true ONLY when soilValue is a finite number AND is at or below
 * SOIL_NOT_IN_GROUND_MAX. Returns false for null/undefined/NaN/strings so we
 * never guess on missing data.
 */
function isSoilOutOfGround(soilValue) {
  if (soilValue == null) return false;
  if (typeof soilValue !== 'number' || !isFinite(soilValue)) return false;
  return soilValue <= SOIL_NOT_IN_GROUND_MAX;
}

// ── Sub-components ────────────────────────────────────────────────────────────

/** A single metric tile (نمی / درجہ حرارت). */
function MetricTile({ icon, label, value, unit, dimmed }) {
  const displayValue = value != null ? `${value}${unit}` : null;
  return (
    <View style={[styles.metricTile, dimmed && styles.dimmed]}>
      <Text style={styles.metricIcon}>{icon}</Text>
      <Text style={[styles.metricValue, displayValue == null && styles.noValueDash]}>
        {displayValue != null ? displayValue : '—'}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

/** Soil status chip: dry / adequate / wet. */
function SoilChip({ soilStatus }) {
  if (!soilStatus) return null;
  const config = {
    dry:      { label: '🔴 خشک',      bg: '#fef2f2', border: '#fca5a5', text: '#b91c1c' },
    adequate: { label: '🟢 مناسب',    bg: '#f0f9f2', border: '#86efac', text: '#15803d' },
    wet:      { label: '🔵 زیادہ نمی', bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8' },
  }[soilStatus];
  if (!config) return null;
  return (
    <View style={[styles.soilChip, { backgroundColor: config.bg, borderColor: config.border }]}>
      <Text style={[styles.soilChipText, { color: config.text }]}>{config.label}</Text>
    </View>
  );
}

/**
 * Advice box — only shows when text_ur is present from the API.
 * label: optional string override for the card title.
 *        Defaults to "آبپاشی کا مشورہ" (standalone mode).
 *        Pass "زمین کا مشورہ (سینسر)" for embedded mode.
 */
function AdviceBox({ advice, dimmed, label }) {
  if (!advice || !advice.text_ur) return null;

  const levelConfig = {
    water_now: { bg: '#fff7ed', border: '#fdba74', icon: '💧', titleColor: '#c2410c' },
    ok:        { bg: '#f0f9f2', border: '#86efac', icon: '✅', titleColor: '#15803d' },
    hold:      { bg: '#eff6ff', border: '#93c5fd', icon: '⏸️', titleColor: '#1d4ed8' },
  }[advice.level] || { bg: '#f7f7f5', border: '#e8e8e5', icon: 'ℹ️', titleColor: '#555' };

  return (
    <View style={[
      styles.adviceBox,
      { backgroundColor: levelConfig.bg, borderColor: levelConfig.border },
      dimmed && styles.dimmed,
    ]}>
      <View style={styles.adviceHeader}>
        <Text style={styles.adviceIcon}>{levelConfig.icon}</Text>
        <Text style={[styles.adviceTitle, { color: levelConfig.titleColor }]}>
          {label || 'آبپاشی کا مشورہ'}
        </Text>
      </View>
      <Text style={styles.adviceText}>{advice.text_ur}</Text>
      {advice.rain_check === true && (
        <View style={styles.rainNote}>
          <Text style={styles.rainNoteText}>🌧️ بارش کا امکان</Text>
        </View>
      )}
      {/* rain_check === null → show nothing (per spec) */}
    </View>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function IoTCard({ latitude, longitude, embedded = false }) {
  const [data, setData]             = useState(null);  // last API response
  const [lastGood, setLastGood]     = useState(null);  // last "ok" — kept on error
  const [refreshing, setRefreshing] = useState(false);

  const mountedRef   = useRef(true);
  const inFlightRef  = useRef(false);
  const intervalRef  = useRef(null);
  const appStateRef  = useRef(AppState.currentState);

  // ── Core fetch ─────────────────────────────────────────────────────────────
  const doFetch = useCallback(async () => {
    if (inFlightRef.current || !mountedRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await fetchIoTLatest(latitude, longitude);
      if (!mountedRef.current) return;
      setData(result);
      if (result?.status === 'ok') {
        setLastGood(result);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [latitude, longitude]);

  // ── Pull-to-refresh ────────────────────────────────────────────────────────
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await doFetch();
    if (mountedRef.current) setRefreshing(false);
  }, [doFetch]);

  // ── Polling + AppState lifecycle ───────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;

    doFetch();
    intervalRef.current = setInterval(doFetch, POLL_INTERVAL_MS);

    const subscription = AppState.addEventListener('change', (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && prev !== 'active') {
        doFetch();
        if (!intervalRef.current) {
          intervalRef.current = setInterval(doFetch, POLL_INTERVAL_MS);
        }
      } else if (nextState === 'background' || nextState === 'inactive') {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    });

    return () => {
      mountedRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      subscription.remove();
    };
  }, [doFetch]);

  // ── Shared display state ───────────────────────────────────────────────────
  const status = data?.status ?? null;

  // ════════════════════════════════════════════════════════════════════════════
  // EMBEDDED MODE — plain <View>, no ScrollView, no RefreshControl, no flex:1.
  // All lifecycle safety (polling, AppState, overlap guard, mountedRef) is
  // identical to standalone mode — only the JSX container changes.
  // ════════════════════════════════════════════════════════════════════════════
  if (embedded) {
    // Section divider + compact heading
    const SectionHeader = () => (
      <View style={styles.embSectionHeader}>
        <View style={styles.embDivider} />
        <Text style={styles.embSectionTitle}>🌱 کھیت کی حالت (سینسر)</Text>
      </View>
    );

    // ── no_data / null ───────────────────────────────────────────────────────
    if (status === 'no_data' || status === null) {
      return (
        <View style={styles.embContainer}>
          <SectionHeader />
          <View style={styles.statusBadge}>
            <View style={[styles.dot, { backgroundColor: '#9ca3af' }]} />
            <Text style={[styles.statusText, { color: '#6b7280' }]}>ابھی تک ڈیٹا نہیں</Text>
          </View>
          <View style={styles.embNoDataBox}>
            <Text style={styles.noDataIcon}>📵</Text>
            <Text style={styles.noDataText}>
              {data?.message_ur || 'سینسر سے ابھی تک کوئی ریڈنگ نہیں آئی۔'}
            </Text>
            <Text style={styles.noDataHint}>ESP32 آن کریں اور انٹرنیٹ سے جوڑیں</Text>
          </View>
          <RefreshButton onPress={onRefresh} />
        </View>
      );
    }

    // ── error state ──────────────────────────────────────────────────────────
    if (status === 'error') {
      return (
        <View style={styles.embContainer}>
          <SectionHeader />
          <View style={styles.statusBadge}>
            <View style={[styles.dot, { backgroundColor: '#f97316' }]} />
            <Text style={[styles.statusText, { color: '#c2410c' }]}>کنکشن میں مسئلہ</Text>
          </View>
          {lastGood ? (
            <LastGoodReadings data={lastGood} embedded />
          ) : (
            <View style={styles.embNoDataBox}>
              <Text style={styles.noDataIcon}>⚠️</Text>
              <Text style={styles.noDataText}>بیک اینڈ سے کنکشن نہیں ہو سکا۔</Text>
            </View>
          )}
          <RefreshButton onPress={onRefresh} />
        </View>
      );
    }

    // ── ok state (online or stale) ───────────────────────────────────────────
    const online     = data.online === true;
    const dimmed     = !online;
    const soilOutEMB = isSoilOutOfGround(data.soil_moisture);
    const soil       = soilOutEMB ? null : fmtVal(data.soil_moisture);
    const temp       = fmtVal(data.temperature);
    const hum        = fmtVal(data.humidity);
    const age        = formatAge(data.seconds_since_last);

    return (
      <View style={styles.embContainer}>
        <SectionHeader />

        {/* Status badge */}
        <View style={styles.statusBadge}>
          <View style={[styles.dot, { backgroundColor: online ? '#22c55e' : '#ef4444' }]} />
          <Text style={[styles.statusText, { color: online ? '#15803d' : '#b91c1c' }]}>
            {online ? 'سینسر آن لائن' : 'سینسر آف لائن'}
          </Text>
          {age != null && <Text style={styles.ageText}>{age}</Text>}
        </View>

        {/* Offline warning */}
        {!online && (
          <View style={styles.offlineWarning}>
            <Text style={styles.offlineWarningText}>
              ⚠️ یہ آخری مل کہ ریڈنگ ہے — سینسر سے تازہ ڈیٹا نہیں آ رہا
            </Text>
          </View>
        )}

        {/* Sensor-not-in-soil warning — shown whenever soil_moisture <= SOIL_NOT_IN_GROUND_MAX */}
        {soilOutEMB && (
          <View style={styles.soilOutWarning}>
            <Text style={styles.offlineWarningText}>
              ⚠️ سینسر مٹی میں نہیں ہے۔ براہ کرم سینسر کو مٹی میں لگائیں۔
            </Text>
          </View>
        )}

        {/* Three metric tiles — soil tile shows "—" with caption when sensor is out */}
        <View style={styles.metricsRow}>
          <View style={[styles.metricTile, dimmed && styles.dimmed]}>
            <Text style={styles.metricIcon}>🌱</Text>
            <Text style={[styles.metricValue, soilOutEMB ? styles.noValueDash : null]}>
              {soilOutEMB ? '—' : (soil != null ? `${soil}%` : '—')}
            </Text>
            <Text style={styles.metricLabel}>
              {soilOutEMB ? 'مٹی میں نہیں' : 'زمین کی نمی'}
            </Text>
          </View>
          <MetricTile icon="🌡️" label="درجہ حرارت" value={temp} unit="°C" dimmed={dimmed} />
          <MetricTile icon="💧" label="ہوا میں نمی" value={hum} unit="%" dimmed={dimmed} />
        </View>

        {/* Soil chip — hidden when sensor is out of soil (reading is invalid) */}
        {!soilOutEMB && (
          <View style={[styles.chipRow, dimmed && styles.dimmed]}>
            <Text style={styles.chipRowLabel}>مٹی کی حالت:</Text>
            <SoilChip soilStatus={data.soil_status} />
          </View>
        )}

        {/* Sensor irrigation advice — hidden when sensor is out of soil */}
        {!soilOutEMB && (
          <AdviceBox
            advice={data.irrigation_advice}
            dimmed={dimmed}
            label="زمین کا مشورہ (سینسر)"
          />
        )}

        {/* Device info */}
        {data.device_id != null && (
          <Text style={[styles.deviceInfo, dimmed && styles.dimmed]}>
            🔌 ڈیوائس: {data.device_id}
            {data.received_iso
              ? `  •  ${new Date(data.received_iso).toLocaleTimeString('ur-PK')}`
              : ''}
          </Text>
        )}

        <RefreshButton onPress={onRefresh} />
      </View>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STANDALONE MODE (embedded === false) — original behaviour, 100% unchanged.
  // ════════════════════════════════════════════════════════════════════════════

  // "no_data" — clean state, no numbers
  if (status === 'no_data' || status === null) {
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1a7a2e" />}
      >
        <Text style={styles.heading}>📡 کھیت سینسر</Text>
        <Text style={styles.subtitle}>ESP32 سینسر سے لائیو ڈیٹا</Text>

        <View style={styles.statusBadge}>
          <View style={[styles.dot, { backgroundColor: '#9ca3af' }]} />
          <Text style={[styles.statusText, { color: '#6b7280' }]}>ابھی تک ڈیٹا نہیں</Text>
        </View>

        <View style={styles.noDataBox}>
          <Text style={styles.noDataIcon}>📵</Text>
          <Text style={styles.noDataText}>
            {data?.message_ur || 'سینسر سے ابھی تک کوئی ریڈنگ نہیں آئی۔'}
          </Text>
          <Text style={styles.noDataHint}>
            ESP32 آن کریں اور انٹرنیٹ سے جوڑیں
          </Text>
        </View>

        <RefreshButton onPress={onRefresh} />
      </ScrollView>
    );
  }

  // "error" state — show last good reading dimmed if available
  if (status === 'error') {
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1a7a2e" />}
      >
        <Text style={styles.heading}>📡 کھیت سینسر</Text>
        <Text style={styles.subtitle}>ESP32 سینسر سے لائیو ڈیٹا</Text>

        <View style={styles.statusBadge}>
          <View style={[styles.dot, { backgroundColor: '#f97316' }]} />
          <Text style={[styles.statusText, { color: '#c2410c' }]}>کنکشن میں مسئلہ</Text>
        </View>

        {lastGood ? (
          <LastGoodReadings data={lastGood} />
        ) : (
          <View style={styles.noDataBox}>
            <Text style={styles.noDataIcon}>⚠️</Text>
            <Text style={styles.noDataText}>بیک اینڈ سے کنکشن نہیں ہو سکا۔</Text>
          </View>
        )}

        <RefreshButton onPress={onRefresh} />
      </ScrollView>
    );
  }

  // "ok" state — online=true or online=false (stale)
  const online  = data.online === true;
  const dimmed  = !online;
  const soilOut = isSoilOutOfGround(data.soil_moisture);
  const soil    = soilOut ? null : fmtVal(data.soil_moisture);
  const temp    = fmtVal(data.temperature);
  const hum     = fmtVal(data.humidity);
  const age     = formatAge(data.seconds_since_last);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1a7a2e" />}
    >
      <Text style={styles.heading}>📡 کھیت سینسر</Text>
      <Text style={styles.subtitle}>ESP32 سینسر سے لائیو ڈیٹا</Text>

      {/* Status badge */}
      <View style={styles.statusBadge}>
        <View style={[styles.dot, { backgroundColor: online ? '#22c55e' : '#ef4444' }]} />
        <Text style={[styles.statusText, { color: online ? '#15803d' : '#b91c1c' }]}>
          {online ? 'سینسر آن لائن' : 'سینسر آف لائن'}
        </Text>
        {age != null && (
          <Text style={styles.ageText}>{age}</Text>
        )}
      </View>

      {/* Offline warning */}
      {!online && (
        <View style={styles.offlineWarning}>
          <Text style={styles.offlineWarningText}>
            ⚠️ یہ آخری مل کہ ریڈنگ ہے — سینسر سے تازہ ڈیٹا نہیں آ رہا
          </Text>
        </View>
      )}

      {/* Sensor-not-in-soil warning — shown whenever soil_moisture <= SOIL_NOT_IN_GROUND_MAX */}
      {soilOut && (
        <View style={styles.soilOutWarning}>
          <Text style={styles.offlineWarningText}>
            ⚠️ سینسر مٹی میں نہیں ہے۔ براہ کرم سینسر کو مٹی میں لگائیں۔
          </Text>
        </View>
      )}

      {/* Three metric tiles — soil tile shows "—" with caption when sensor is out */}
      <View style={styles.metricsRow}>
        <View style={[styles.metricTile, dimmed && styles.dimmed]}>
          <Text style={styles.metricIcon}>🌱</Text>
          <Text style={[styles.metricValue, soilOut ? styles.noValueDash : null]}>
            {soilOut ? '—' : (soil != null ? `${soil}%` : '—')}
          </Text>
          <Text style={styles.metricLabel}>
            {soilOut ? 'مٹی میں نہیں' : 'زمین کی نمی'}
          </Text>
        </View>
        <MetricTile icon="🌡️" label="درجہ حرارت" value={temp} unit="°C" dimmed={dimmed} />
        <MetricTile icon="💧" label="ہوا میں نمی" value={hum} unit="%" dimmed={dimmed} />
      </View>

      {/* Soil status chip — hidden when sensor is out of soil (reading is invalid) */}
      {!soilOut && (
        <View style={[styles.chipRow, dimmed && styles.dimmed]}>
          <Text style={styles.chipRowLabel}>مٹی کی حالت:</Text>
          <SoilChip soilStatus={data.soil_status} />
        </View>
      )}

      {/* Irrigation advice — hidden when sensor is out of soil */}
      {!soilOut && <AdviceBox advice={data.irrigation_advice} dimmed={dimmed} />}

      {/* Device info */}
      {data.device_id != null && (
        <Text style={[styles.deviceInfo, dimmed && styles.dimmed]}>
          🔌 ڈیوائس: {data.device_id}
          {data.received_iso ? `  •  ${new Date(data.received_iso).toLocaleTimeString('ur-PK')}` : ''}
        </Text>
      )}

      <RefreshButton onPress={onRefresh} />
    </ScrollView>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

/** Shows the last successfully fetched real reading, dimmed, labelled as old. */
function LastGoodReadings({ data, embedded }) {
  const soil = fmtVal(data.soil_moisture);
  const temp = fmtVal(data.temperature);
  const hum  = fmtVal(data.humidity);
  const age  = formatAge(data.seconds_since_last);

  return (
    <View>
      <View style={styles.offlineWarning}>
        <Text style={styles.offlineWarningText}>
          ⚠️ آخری مل کہ ریڈنگ دکھائی جا رہی ہے{age ? ` — ${age}` : ''}
        </Text>
      </View>
      <View style={[styles.metricsRow, styles.dimmed]}>
        <MetricTile icon="🌱" label="زمین کی نمی" value={soil} unit="%" dimmed />
        <MetricTile icon="🌡️" label="درجہ حرارت" value={temp} unit="°C" dimmed />
        <MetricTile icon="💧" label="ہوا میں نمی" value={hum} unit="%" dimmed />
      </View>
      <View style={[styles.chipRow, styles.dimmed]}>
        <Text style={styles.chipRowLabel}>مٹی کی حالت:</Text>
        <SoilChip soilStatus={data.soil_status} />
      </View>
      <AdviceBox
        advice={data.irrigation_advice}
        dimmed
        label={embedded ? 'زمین کا مشورہ (سینسر)' : undefined}
      />
    </View>
  );
}

function RefreshButton({ onPress }) {
  return (
    <TouchableOpacity style={styles.refreshBtn} onPress={onPress} activeOpacity={0.75}>
      <Text style={styles.refreshBtnText}>🔄 تازہ کریں</Text>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Standalone (full-screen) ──
  scroll: {
    flex: 1,
    backgroundColor: '#f2f0ec',
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  heading: {
    fontSize: 24,
    fontWeight: '800',
    color: '#1a7a2e',
    textAlign: 'right',
    writingDirection: 'rtl',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'right',
    writingDirection: 'rtl',
    marginBottom: 20,
  },

  // ── Embedded section ──
  embContainer: {
    paddingBottom: 8,
  },
  embSectionHeader: {
    marginTop: 8,
    marginBottom: 14,
  },
  embDivider: {
    height: 1,
    backgroundColor: '#e8e8e5',
    marginBottom: 14,
  },
  embSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a7a2e',
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  embNoDataBox: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },

  // ── Status badge ──
  statusBadge: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'right',
    writingDirection: 'rtl',
    flex: 1,
  },
  ageText: {
    fontSize: 12,
    color: '#9ca3af',
    textAlign: 'left',
  },

  // ── Offline warning ──
  offlineWarning: {
    backgroundColor: '#fef3c7',
    borderColor: '#fcd34d',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  offlineWarningText: {
    fontSize: 13,
    color: '#92400e',
    textAlign: 'right',
    writingDirection: 'rtl',
    lineHeight: 20,
    flexWrap: 'wrap',
  },

  // ── Metric tiles ──
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  metricTile: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 6,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  metricIcon: {
    fontSize: 24,
    marginBottom: 8,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1a7a2e',
    marginBottom: 4,
    textAlign: 'center',
  },
  noValueDash: {
    color: '#9ca3af',
    fontWeight: '400',
    fontSize: 18,
  },
  metricLabel: {
    fontSize: 11,
    color: '#888',
    textAlign: 'center',
    writingDirection: 'rtl',
  },

  // ── Soil chip ──
  chipRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    marginBottom: 14,
    gap: 10,
  },
  chipRowLabel: {
    fontSize: 14,
    color: '#555',
    fontWeight: '600',
    writingDirection: 'rtl',
  },
  soilChip: {
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  soilChipText: {
    fontSize: 13,
    fontWeight: '700',
  },

  // ── Advice box ──
  adviceBox: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 14,
  },
  adviceHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  adviceIcon: {
    fontSize: 22,
  },
  adviceTitle: {
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'right',
    writingDirection: 'rtl',
    flex: 1,
  },
  adviceText: {
    fontSize: 14,
    color: '#444',
    textAlign: 'right',
    writingDirection: 'rtl',
    lineHeight: 22,
    flexWrap: 'wrap',
  },
  rainNote: {
    marginTop: 8,
    backgroundColor: '#e0f2fe',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-end',
  },
  rainNoteText: {
    fontSize: 12,
    color: '#0369a1',
    fontWeight: '600',
  },

  // ── No-data / error box ──
  noDataBox: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 30,
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  noDataIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  noDataText: {
    fontSize: 16,
    color: '#555',
    textAlign: 'center',
    writingDirection: 'rtl',
    lineHeight: 24,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  noDataHint: {
    fontSize: 13,
    color: '#9ca3af',
    textAlign: 'center',
    writingDirection: 'rtl',
    lineHeight: 20,
  },

  // ── Device info ──
  deviceInfo: {
    fontSize: 12,
    color: '#9ca3af',
    textAlign: 'right',
    writingDirection: 'rtl',
    marginBottom: 16,
  },

  // ── Dimmed overlay for stale/error readings ──
  dimmed: {
    opacity: 0.45,
  },

  // ── Sensor-not-in-soil warning (amber, same style family as offlineWarning) ──
  soilOutWarning: {
    backgroundColor: '#fff7ed',
    borderColor: '#fb923c',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },

  // ── Refresh button ──
  refreshBtn: {
    backgroundColor: '#f0f9f2',
    borderColor: '#86efac',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginTop: 4,
  },
  refreshBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#15803d',
  },
});
