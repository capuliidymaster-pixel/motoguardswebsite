import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  MapPin,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  Bike,
  RefreshCw,
  Cloud,
  CloudOff,
  Plus,
  Minus,
  Satellite,
  Gauge,
  Crosshair,
  Clock,
  Ruler,
  Compass,
  Navigation,
  Bug,
  Search,
  X,
  Eye,
  EyeOff,
} from "lucide-react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ref, onValue, goOffline, goOnline } from "firebase/database";
import { rtdb } from "./firebase";
import "./Map.css";

// ======================================================================
// CONFIGURATION
// ======================================================================

const MIN_SATELLITES = 4;
const HEARTBEAT_TIMEOUT_MS = 8000;
const DEVICE_CLOCK_TOLERANCE_MS = 10000;
const DEFAULT_CENTER = [14.5995, 120.9842];

// Ang "id" dito ay dapat EXACT na pangalan ng node sa Firebase: gps/<id>
const MOTO_CONFIGS = [
  { id: "motorcycle_001", label: "MOTO 1", colorOnline: "#FFA500", colorOffline: "#6E7681" },
  { id: "motorcycle_002", label: "MOTO 2", colorOnline: "#39D2C0", colorOffline: "#6E7681" },
];

const STATUS_COLOR = {
  online: "#3FB950",
  gpsLost: "#D29922",
  stale: "#D29922",
  deviceOffline: "#F85149",
  firebaseOffline: "#F85149",
  firebaseError: "#F85149",
  waiting: "#6E7681",
};

const STATUS_LABEL = {
  online: "ONLINE",
  gpsLost: "SIGNAL LOST",
  stale: "STALE",
  deviceOffline: "DEVICE OFFLINE",
  firebaseOffline: "FIREBASE OFFLINE",
  firebaseError: "DATABASE ERROR",
  waiting: "WAITING...",
};

// ======================================================================
// MARKER ICONS
// ======================================================================

function buildMotoIcon(config, online) {
  const color = online ? config.colorOnline : config.colorOffline;
  return L.divIcon({
    className: "mg-marker",
    html: `
      <div class="mg-marker-badge">
        <div class="mg-marker-circle ${online ? "is-online" : "is-offline"}" style="--c:${color}">
          ${online ? '<span class="mg-marker-pulse"></span>' : ""}
          <span class="mg-marker-emoji">🏍️</span>
        </div>
        <span class="mg-marker-label" style="--c:${color}">${config.label}${online ? "" : " OFFLINE"}</span>
      </div>`,
    iconSize: [90, 90],
    iconAnchor: [45, 75],
  });
}

// Pin para sa resulta ng location search
const searchPinIcon = L.divIcon({
  className: "mg-search-pin",
  html: '<div class="mg-search-pin-shape"></div>',
  iconSize: [30, 36],
  iconAnchor: [15, 36],
  popupAnchor: [0, -34],
});

// ======================================================================
// HELPERS
// ======================================================================

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function getCardinalDirection(bearing) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(bearing / 22.5) % 16];
}

function formatDistance(meters) {
  if (meters == null) return "--";
  return meters < 1000 ? `${meters.toFixed(0)} m` : `${(meters / 1000).toFixed(2)} km`;
}

function formatClock(ms) {
  if (!ms) return "--:--:--";
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function asNumber(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function asBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  if (typeof v === "number") return v === 1;
  return false;
}

function hasValidCoordinates(lat, lng) {
  if (lat == null || lng == null) return false;
  if (Number.isNaN(lat) || Number.isNaN(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

function parseMotoData(raw) {
  const latitude = asNumber(raw.latitude);
  const longitude = asNumber(raw.longitude);
  return {
    latitude,
    longitude,
    altitude: asNumber(raw.altitude),
    speedKmh: asNumber(raw.speed),
    accuracy: asNumber(raw.accuracy),
    hdop: asNumber(raw.hdop),
    satellites: raw.satellites != null ? Math.round(asNumber(raw.satellites) ?? 0) : null,
    gpsFix: asBool(raw.gpsFix),
    status: raw.status != null ? String(raw.status) : "UNKNOWN",
    deviceTimestamp: asNumber(raw.deviceTimestamp),
    updatedAt: asNumber(raw.updatedAt),
    seq: asNumber(raw.seq),
    valid: hasValidCoordinates(latitude, longitude),
  };
}

const emptyTrackState = {
  data: null,
  error: null,
  lastSeq: null,
  lastUpdatedAt: null,
  lastChangeMs: 0,
  markerPos: null,
  follow: false,
};

function evaluateHealth(track, connected, dbErrorMsg, offsetMs) {
  if (dbErrorMsg || track.error) return "firebaseError";
  if (!connected) return "firebaseOffline";

  const data = track.data;
  if (!data) return "waiting";

  const silenceMs = Date.now() - track.lastChangeMs;

  // Kung may updatedAt (server timestamp) gamitin; kung wala, umasa sa silence timer lang
  const serverNow = Date.now() + offsetMs;
  const serverAge = data.updatedAt != null ? serverNow - data.updatedAt : null;

  if ((serverAge != null && serverAge > HEARTBEAT_TIMEOUT_MS) || silenceMs > HEARTBEAT_TIMEOUT_MS) {
    return "deviceOffline";
  }

  if (!data.gpsFix || data.status !== "GPS_ONLINE") {
    return "gpsLost";
  }

  const sats = data.satellites ?? 0;
  const tsDiff =
    data.deviceTimestamp == null || data.updatedAt == null
      ? null
      : Math.abs(data.updatedAt - data.deviceTimestamp);

  // tsDiff check lang kapag parehong may timestamp
  if (!data.valid || sats < MIN_SATELLITES || (tsDiff != null && tsDiff > DEVICE_CLOCK_TOLERANCE_MS)) {
    return "stale";
  }

  return "online";
}

// ======================================================================
// MapController
// ======================================================================

function MapController({ registerMap, onInteract }) {
  const map = useMap();

  useEffect(() => {
    registerMap(map);

    const invalidate = () => map.invalidateSize();

    const t1 = setTimeout(invalidate, 100);
    const t2 = setTimeout(invalidate, 500);
    const t3 = setTimeout(invalidate, 1000);

    const resizeObserver = new ResizeObserver(() => invalidate());
    resizeObserver.observe(map.getContainer());

    window.addEventListener("resize", invalidate);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      resizeObserver.disconnect();
      window.removeEventListener("resize", invalidate);
    };
  }, [map, registerMap]);

  // Kapag ni-drag o ni-click ng user ang mapa: tigil ang follow, isara ang search results
  useEffect(() => {
    map.on("dragstart", onInteract);
    map.on("click", onInteract);
    return () => {
      map.off("dragstart", onInteract);
      map.off("click", onInteract);
    };
  }, [map, onInteract]);

  return null;
}

// Pin ng search result (kusang bumubukas ang popup)
function SearchPinMarker({ pin }) {
  const markerRef = useRef(null);

  useEffect(() => {
    markerRef.current?.openPopup();
  }, [pin]);

  return (
    <Marker ref={markerRef} position={[pin.lat, pin.lng]} icon={searchPinIcon}>
      <Popup>{pin.label}</Popup>
    </Marker>
  );
}

// ======================================================================
// MAIN MAP PAGE
// ======================================================================

export default function Map({ isDarkMode = true }) {
  const navigate = useNavigate();

  const [tracks, setTracks] = useState(() =>
    Object.fromEntries(MOTO_CONFIGS.map((c) => [c.id, { ...emptyTrackState }]))
  );

  const [firebaseConnected, setFirebaseConnected] = useState(false);
  const [dbError, setDbError] = useState(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [, forceTick] = useState(0);
  const [showDebug, setShowDebug] = useState(false);

  // Panels (minimize / hide)
  const [statusOpen, setStatusOpen] = useState(true);
  const [dataOpen, setDataOpen] = useState(true);
  const [panelsHidden, setPanelsHidden] = useState(false);

  // Location search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [searchPin, setSearchPin] = useState(null);

  const mapRef = useRef(null);

  const handleBack = () => navigate("/dashboard");
  const registerMap = useCallback((map) => {
    mapRef.current = map;
  }, []);

  const clearFollow = useCallback(() => {
    setTracks((prev) => {
      if (!Object.values(prev).some((t) => t.follow)) return prev;
      const next = {};
      for (const id of Object.keys(prev)) next[id] = { ...prev[id], follow: false };
      return next;
    });
  }, []);

  const handleMapInteract = useCallback(() => {
    clearFollow();
    setShowResults(false);
  }, [clearFollow]);

  // ---- FIREBASE: connection state + server time offset ----
  useEffect(() => {
    const unsubConnected = onValue(
      ref(rtdb, ".info/connected"),
      (snap) => setFirebaseConnected(!!snap.val()),
      (err) => {
        console.error("Firebase connection error:", err);
        setDbError(err.message);
      }
    );

    const unsubOffset = onValue(ref(rtdb, ".info/serverTimeOffset"), (snap) => {
      const v = snap.val();
      if (typeof v === "number") setServerOffsetMs(v);
    });

    return () => {
      unsubConnected();
      unsubOffset();
    };
  }, []);

  // ---- FIREBASE: isang listener bawat motorcycle -> gps/<id> ----
  useEffect(() => {
    const unsubscribers = MOTO_CONFIGS.map((config) => {
      const motoRef = ref(rtdb, `gps/${config.id}`);

      return onValue(
        motoRef,
        (snapshot) => {
          const raw = snapshot.val();
          const now = Date.now();

          console.log(`[${config.id}] raw:`, raw);

          setTracks((prev) => {
            const prevTrack = prev[config.id];

            if (!raw || typeof raw !== "object") {
              return { ...prev, [config.id]: { ...prevTrack, data: null, error: null } };
            }

            const data = parseMotoData(raw);

            const isNew =
              prevTrack.data == null ||
              data.seq !== prevTrack.lastSeq ||
              data.updatedAt !== prevTrack.lastUpdatedAt ||
              data.latitude !== prevTrack.data.latitude ||
              data.longitude !== prevTrack.data.longitude;

            const nextTrack = {
              ...prevTrack,
              data,
              error: null,
              lastSeq: data.seq,
              lastUpdatedAt: data.updatedAt,
              lastChangeMs: isNew ? now : prevTrack.lastChangeMs,
              // i-set ang marker basta valid ang coordinates
              markerPos: data.valid ? { lat: data.latitude, lng: data.longitude } : prevTrack.markerPos,
            };

            return { ...prev, [config.id]: nextTrack };
          });
        },
        (error) => {
          console.error(`Firebase listener error for ${config.id}:`, error);
          setTracks((prev) => ({
            ...prev,
            [config.id]: { ...prev[config.id], error: error.message },
          }));
        }
      );
    });

    return () => unsubscribers.forEach((u) => u());
  }, []);

  // ---- Re-evaluate health every second ----
  useEffect(() => {
    const interval = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const healthByMoto = useMemo(() => {
    const result = {};
    for (const config of MOTO_CONFIGS) {
      result[config.id] = evaluateHealth(tracks[config.id], firebaseConnected, dbError, serverOffsetMs);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, firebaseConnected, dbError, serverOffsetMs, forceTickDep()]);

  function forceTickDep() {
    // pinapatakbo ulit ang useMemo bawat segundo para ma-detect ang "device offline"
    return Math.floor(Date.now() / 1000);
  }

  // ---- Distance/bearing ----
  const [moto1, moto2] = MOTO_CONFIGS;
  const pos1 = tracks[moto1.id]?.markerPos;
  const pos2 = tracks[moto2.id]?.markerPos;
  const distanceBetween = pos1 && pos2 ? calculateDistance(pos1.lat, pos1.lng, pos2.lat, pos2.lng) : null;
  const bearingBetween = pos1 && pos2 ? calculateBearing(pos1.lat, pos1.lng, pos2.lat, pos2.lng) : null;

  // ---- Follow / center controls ----
  const centerOnMoto = (id) => {
    const pos = tracks[id]?.markerPos;
    if (!pos || !mapRef.current) return;
    setTracks((prev) => {
      const next = {};
      for (const config of MOTO_CONFIGS) {
        next[config.id] = { ...prev[config.id], follow: config.id === id };
      }
      return next;
    });
    mapRef.current.setView([pos.lat, pos.lng], 17);
  };

  useEffect(() => {
    for (const config of MOTO_CONFIGS) {
      const track = tracks[config.id];
      if (track.follow && track.markerPos && mapRef.current) {
        mapRef.current.setView([track.markerPos.lat, track.markerPos.lng], mapRef.current.getZoom());
      }
    }
  }, [tracks]);

  // totoong reconnect ng Realtime Database
  const manualReconnect = () => {
    setDbError(null);
    try {
      goOffline(rtdb);
      setTimeout(() => goOnline(rtdb), 300);
    } catch (e) {
      console.error("Reconnect failed:", e);
    }
  };

  // ---- Location search ----
  const goToPlace = (lat, lng, label) => {
    clearFollow();
    setSearchPin({ id: Date.now(), lat, lng, label });
    setShowResults(false);
    mapRef.current?.flyTo([lat, lng], 16, { duration: 1.2 });
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || searching) return;

    // Direkta ng coordinates, hal. "14.5995, 120.9842"
    const coordMatch = q.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (hasValidCoordinates(lat, lng)) {
        setSearchResults([]);
        setSearchMessage("");
        goToPlace(lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
        return;
      }
    }

    setSearching(true);
    setSearchMessage("");
    setSearchResults([]);
    setShowResults(true);

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const list = await res.json();
      const results = list
        .map((item) => ({
          id: item.place_id,
          name: item.display_name,
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon),
        }))
        .filter((r) => hasValidCoordinates(r.lat, r.lng));

      if (results.length === 0) {
        setSearchMessage("No places found. Try a more specific name.");
      } else if (results.length === 1) {
        goToPlace(results[0].lat, results[0].lng, results[0].name);
      }
      setSearchResults(results);
    } catch (err) {
      console.error("Location search failed:", err);
      setSearchMessage("Search failed. Check your internet connection and try again.");
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchMessage("");
    setShowResults(false);
    setSearchPin(null);
  };

  const hasAnyLocation = Boolean(pos1 || pos2);
  const mapCenter = pos1 ? [pos1.lat, pos1.lng] : pos2 ? [pos2.lat, pos2.lng] : DEFAULT_CENTER;
  const mapZoom = hasAnyLocation ? 16 : 13;

  const hasAnyData = MOTO_CONFIGS.some((c) => tracks[c.id]?.data);

  // ====================================================================
  // RENDER
  // ====================================================================

  return (
    <div className={`mg-shell mg-fullscreen ${isDarkMode ? "mg-dark" : "mg-light"}`}>
      {/* ============ FULLSCREEN MAP ============ */}
      <div className="mg-map-container mg-map-fullscreen" aria-label="Live motorcycle map">
        {!hasAnyLocation && (
          <div className="mg-map-fallback-note">
            <MapPin size={13} />
            Walang eksaktong lokasyon pa — ipinapakita ang default na view (Manila)
          </div>
        )}
        <div className="mg-map">
          <MapContainer
            center={mapCenter}
            zoom={mapZoom}
            className="mg-leaflet-map"
            style={{ width: "100%", height: "100%" }}
            zoomControl={false}
            scrollWheelZoom={true}
          >
            <MapController registerMap={registerMap} onInteract={handleMapInteract} />
            <TileLayer
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              maxZoom={19}
            />
            {MOTO_CONFIGS.map((config) => {
              const pos = tracks[config.id]?.markerPos;
              if (!pos) return null;
              const online = healthByMoto[config.id] === "online";
              return (
                <Marker
                  key={config.id}
                  position={[pos.lat, pos.lng]}
                  icon={buildMotoIcon(config, online)}
                />
              );
            })}
            {searchPin && <SearchPinMarker key={searchPin.id} pin={searchPin} />}
          </MapContainer>
        </div>
      </div>

      {/* ============ FLOATING HEADER: back + search + status ============ */}
      <header className="mg-header mg-floating">
        <button type="button" className="mg-back-btn" onClick={handleBack} aria-label="Back to dashboard" title="Back to dashboard">
          <ChevronLeft size={22} />
        </button>

        <div className="mg-brand">
          <span className="mg-brand-eyebrow">Real-time tracking</span>
          <span className="mg-brand-text">
            LIVE <span className="mg-brand-accent">MAP</span>
          </span>
        </div>

        <div className="mg-search">
          <form className="mg-search-form" onSubmit={handleSearch} role="search">
            <Search size={16} className="mg-search-icon" aria-hidden="true" />
            <input
              type="text"
              className="mg-search-input"
              placeholder="Search place or lat, lng"
              aria-label="Search location"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setShowResults(false);
              }}
            />
            {(searchQuery || searchPin) && (
              <button type="button" className="mg-search-btn" onClick={clearSearch} aria-label="Clear search" title="Clear">
                <X size={15} />
              </button>
            )}
            <button type="submit" className="mg-search-btn mg-search-submit" disabled={searching} aria-label="Search" title="Search">
              {searching ? <RefreshCw size={15} className="mg-spin" /> : <Search size={15} />}
            </button>
          </form>

          {showResults && (searching || searchMessage || searchResults.length > 0) && (
            <div className="mg-search-results">
              {searching && <div className="mg-search-msg">Searching...</div>}
              {!searching && searchMessage && <div className="mg-search-msg">{searchMessage}</div>}
              {!searching &&
                searchResults.map((r) => {
                  const [title, ...rest] = r.name.split(", ");
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className="mg-search-item"
                      onClick={() => goToPlace(r.lat, r.lng, r.name)}
                    >
                      <MapPin size={15} />
                      <span className="mg-search-item-text">
                        <span className="mg-search-item-title">{title}</span>
                        {rest.length > 0 && <span className="mg-search-item-sub">{rest.join(", ")}</span>}
                      </span>
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        <div className={`mg-firebase-indicator ${firebaseConnected ? "is-on" : "is-off"}`}>
          {firebaseConnected ? <Cloud size={15} color="#22c55e" /> : <CloudOff size={15} color="#ef4444" />}
          <span style={{ color: firebaseConnected ? "#22c55e" : "#ef4444" }}>
            {firebaseConnected ? "Online" : "Offline"}
          </span>
        </div>
      </header>

      {/* ============ MAP CONTROLS (zoom + hide panels) ============ */}
      <div className="mg-map-controls mg-floating">
        <button className="mg-map-btn" title="Zoom in" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
          <Plus size={18} />
        </button>
        <button className="mg-map-btn" title="Zoom out" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
          <Minus size={18} />
        </button>
        <button
          className={`mg-map-btn ${panelsHidden ? "is-active" : ""}`}
          title={panelsHidden ? "Show panels" : "Hide all panels"}
          aria-label={panelsHidden ? "Show panels" : "Hide all panels"}
          aria-pressed={panelsHidden}
          onClick={() => setPanelsHidden((v) => !v)}
        >
          {panelsHidden ? <Eye size={18} /> : <EyeOff size={18} />}
        </button>
      </div>

      {/* ============ TOP STATUS PANEL (minimizable) ============ */}
      {!panelsHidden && (
        <div className={`mg-status-panel mg-floating ${statusOpen ? "" : "is-collapsed"}`}>
          <button
            type="button"
            className="mg-panel-bar"
            onClick={() => setStatusOpen((v) => !v)}
            aria-expanded={statusOpen}
            title={statusOpen ? "Minimize" : "Expand"}
          >
            <span className="mg-panel-title">Moto status</span>
            <span className="mg-panel-dots" aria-hidden="true">
              {MOTO_CONFIGS.map((config) => (
                <span
                  key={config.id}
                  className="mg-panel-dot"
                  style={{ "--s": STATUS_COLOR[healthByMoto[config.id]] ?? "#ef4444" }}
                />
              ))}
            </span>
            {statusOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {statusOpen && (
            <div className="mg-panel-body">
              {MOTO_CONFIGS.map((config) => (
                <MotoStatusRow
                  key={config.id}
                  config={config}
                  track={tracks[config.id]}
                  health={healthByMoto[config.id]}
                />
              ))}

              {distanceBetween !== null && bearingBetween !== null && (
                <div className="mg-metrics-row">
                  <div className="mg-metric">
                    <span className="mg-metric-icon">
                      <Ruler size={15} />
                    </span>
                    <span className="mg-metric-label">Moto-to-Moto</span>
                    <span className="mg-metric-value">{formatDistance(distanceBetween)}</span>
                  </div>
                  <div className="mg-metric">
                    <span className="mg-metric-icon">
                      <Compass size={15} />
                    </span>
                    <span className="mg-metric-label">Bearing</span>
                    <span className="mg-metric-value">{bearingBetween.toFixed(1)}°</span>
                  </div>
                  <div className="mg-metric">
                    <span className="mg-metric-icon">
                      <Navigation size={15} />
                    </span>
                    <span className="mg-metric-label">Direction</span>
                    <span className="mg-metric-value">{getCardinalDirection(bearingBetween)}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ============ BOTTOM-RIGHT FOLLOW BUTTONS ============ */}
      <div className="mg-fab-column mg-floating">
        {MOTO_CONFIGS.map((config) => (
          <button
            key={config.id}
            className="mg-fab"
            style={{ color: config.colorOnline, "--c": config.colorOnline }}
            title={`Center on ${config.label}`}
            aria-label={`Center on ${config.label}`}
            onClick={() => centerOnMoto(config.id)}
          >
            <Bike size={18} />
          </button>
        ))}
        {(dbError || !firebaseConnected) && (
          <button className="mg-fab mg-fab-reconnect" title="Reconnect to Firebase" aria-label="Reconnect to Firebase" onClick={manualReconnect}>
            <RefreshCw size={18} />
          </button>
        )}
      </div>

      {/* ============ BOTTOM-LEFT DATA PANEL (minimizable) ============ */}
      {hasAnyData && !panelsHidden && (
        <div className="mg-data-panel mg-floating">
          <button
            type="button"
            className="mg-data-bar"
            onClick={() => setDataOpen((v) => !v)}
            aria-expanded={dataOpen}
            title={dataOpen ? "Minimize" : "Expand"}
          >
            <Satellite size={14} />
            <span className="mg-panel-title">Telemetry</span>
            {dataOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>

          {dataOpen && (
            <div className="mg-data-cards">
              {MOTO_CONFIGS.map((config) => {
                const data = tracks[config.id]?.data;
                if (!data) return null;
                return (
                  <div key={config.id} className="mg-data-card" style={{ "--c": config.colorOnline }}>
                    <div className="mg-data-panel-heading">
                      <Bike size={14} />
                      {config.label}
                    </div>
                    <div className="mg-data-grid">
                      <DataField icon={Satellite} label="Sats" value={`${data.satellites ?? "N/A"}`} />
                      <DataField icon={Gauge} label="Speed" value={`${data.speedKmh?.toFixed(1) ?? "N/A"} km/h`} />
                      <DataField
                        icon={Crosshair}
                        label="HDOP"
                        value={`${data.hdop?.toFixed(1) ?? data.accuracy?.toFixed(1) ?? "N/A"}`}
                      />
                      <DataField icon={Clock} label="Last Fix" value={formatClock(data.deviceTimestamp)} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============ 🐛 DEBUG PANEL (tanggalin kapag okay na) ============ */}
      <div
        className={`mg-debug ${isDarkMode ? "" : "is-light"}`}
        style={{ borderColor: firebaseConnected ? "#22c55e" : "#ef4444" }}
      >
        <button type="button" className="mg-debug-toggle" onClick={() => setShowDebug(!showDebug)}>
          <Bug size={13} />
          DEBUG {showDebug ? "▼" : "▶"}
        </button>

        {showDebug && (
          <>
            <div>
              🔗 Firebase:{" "}
              <span style={{ color: firebaseConnected ? "#0f0" : "#f00" }}>
                {firebaseConnected ? "✅ ONLINE" : "❌ OFFLINE"}
              </span>
            </div>
            <div>DB Error: {dbError ? "❌ " + dbError : "✅ None"}</div>
            <div>Offset: {serverOffsetMs}ms</div>

            {MOTO_CONFIGS.map((config) => {
              const track = tracks[config.id];
              const health = healthByMoto[config.id];
              const data = track?.data;
              return (
                <div key={config.id} className="mg-debug-card">
                  <div style={{ fontWeight: "bold", color: config.colorOnline }}>{config.label}</div>
                  <div>Path: gps/{config.id}</div>
                  <div>Health: {health}</div>
                  <div>Data: {data ? "✅ YES" : "❌ NO"}</div>
                  {track?.error && <div style={{ color: "#f00" }}>Err: {track.error}</div>}
                  {data && (
                    <>
                      <div>Valid: {data.valid ? "✅" : "❌"}</div>
                      <div>GPS Fix: {data.gpsFix ? "✅" : "❌"} ({data.status})</div>
                      <div>
                        Sats: {data.satellites ?? "N/A"}{" "}
                        {data.satellites && data.satellites >= MIN_SATELLITES ? "✅" : "❌"}
                      </div>
                      <div>
                        Pos: {data.latitude?.toFixed(4)}, {data.longitude?.toFixed(4)}
                      </div>
                      <div>Marker: {track.markerPos ? "✅ SET" : "❌ NOT SET"}</div>
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// SUBCOMPONENTS
// ======================================================================

function MotoStatusRow({ config, track, health }) {
  const dotColor = STATUS_COLOR[health] ?? "#ef4444";
  const data = track.data;
  const message =
    health === "online"
      ? ""
      : health === "gpsLost"
      ? `${config.label} GPS signal not acquired`
      : health === "stale"
      ? `${config.label} data integrity check failed`
      : health === "deviceOffline"
      ? `${config.label} ESP32/WiFi not responding`
      : health === "firebaseOffline"
      ? "Firebase connection lost"
      : health === "firebaseError"
      ? track.error ?? "Database error"
      : `Waiting for ${config.label} data...`;

  return (
    <div className="mg-status-row" style={{ "--c": config.colorOnline, "--s": dotColor }}>
      <span className="mg-status-icon">
        <Bike size={18} />
      </span>
      <div className="mg-status-text">
        <div className="mg-status-line">
          <span className="mg-status-label">{config.label}</span>
          <span className="mg-pill">
            <span className="mg-status-dot" />
            {STATUS_LABEL[health]}
          </span>
        </div>
        {message && <span className="mg-status-message">{message}</span>}
        {data && data.valid && (
          <span className="mg-status-coords">
            Lat: {data.latitude.toFixed(5)}, Lon: {data.longitude.toFixed(5)}
          </span>
        )}
      </div>
      {data?.updatedAt && <span className="mg-status-time">{formatClock(data.updatedAt)}</span>}
    </div>
  );
}

function DataField({ icon: Icon, label, value }) {
  return (
    <div className="mg-data-field">
      <span className="mg-data-icon">
        <Icon size={13} />
      </span>
      <span className="mg-data-text">
        <span className="mg-data-label">{label}</span>
        <span className="mg-data-value">{value}</span>
      </span>
    </div>
  );
}