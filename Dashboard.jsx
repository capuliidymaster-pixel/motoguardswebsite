import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
} from "firebase/firestore";
import { ref, onValue } from "firebase/database";
import { rtdb } from "./firebase";
import "./Dashboard.css";

// A device with no live GPS data is "active" if Firestore says it reported in within this window
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// A device sending live GPS data is "active" if its last ping is newer than this
const LIVE_WINDOW_MS = 30 * 1000;

// How many users to preview on the dashboard
const USER_PREVIEW_LIMIT = 3;

// Nominatim asks for max 1 request per second
const GEOCODE_DELAY_MS = 1100;

// =========================================================
// FIELD HELPERS
// If your Firestore documents use different field names,
// adjust them here. Nothing else in the file needs to change.
// =========================================================

const toDate = (value) => {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const getLastSeen = (x) => toDate(x.lastSeen ?? x.lastActive ?? x.lastOnline);

const getRegisteredAt = (u) => toDate(u.createdAt ?? u.registeredAt);

// The key of this device under gps/<key> in the Realtime Database.
// Must match the node name, e.g. "motorcycle_001".
const getGpsKey = (d) => d.deviceId ?? d.id;

const asNumber = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
};

// Accepts milliseconds or seconds, returns milliseconds
const normalizeMs = (v) => {
  const n = asNumber(v);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
};

const getPingMs = (g) => {
  if (!g || typeof g !== "object") return null;
  return normalizeMs(g.updatedAt) ?? normalizeMs(g.deviceTimestamp);
};

const getLocation = (g) => {
  if (!g || typeof g !== "object") return null;
  const lat = asNumber(g.latitude);
  const lng = asNumber(g.longitude);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
};

// Round to ~110 m so nearby pings share one place lookup
const placeKey = (loc) => `${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`;

// Status for a document from the "iotDevices" collection
// Returns "active" | "inactive" (shown as Offline) | "unlinked"
const getIotStatus = (d, g, nowMs, offsetMs) => {
  // "available" = not connected to any rider
  if (d.status !== "connected") return "unlinked";

  // Live data from the Realtime Database wins
  const pingMs = getPingMs(g);
  if (pingMs !== null) {
    return nowMs + offsetMs - pingMs <= LIVE_WINDOW_MS ? "active" : "inactive";
  }

  if (typeof d.isOnline === "boolean") {
    return d.isOnline ? "active" : "inactive";
  }

  const lastSeen = getLastSeen(d);
  if (lastSeen) {
    return nowMs - lastSeen.getTime() <= ACTIVE_WINDOW_MS
      ? "active"
      : "inactive";
  }

  // Connected to a rider, but the device has no timestamp to check
  return "active";
};

const STATUS_LABEL = {
  active: "Active",
  inactive: "Offline",
  unlinked: "Not linked",
};

const formatDate = (date) =>
  date
    ? date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";

const formatDateTime = (date) =>
  date
    ? date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Never";

const formatAgo = (ms) => {
  if (ms === null || ms === undefined) return "";
  const diff = Math.max(0, Math.round(ms / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const min = Math.floor(diff / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Up to two initials from a name or email, for avatars
const getInitials = (value) => {
  if (!value || typeof value !== "string") return "?";
  const base = value.includes("@") ? value.split("@")[0] : value;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

// Picks one of 4 avatar colours, always the same for the same text
const avatarTone = (value) => {
  const str = String(value ?? "");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) % 4;
  }
  return hash + 1;
};

// Turns a Nominatim reverse result into a short place name
const shortPlaceName = (data) => {
  const a = data?.address ?? {};
  const street = a.road ?? a.pedestrian ?? a.neighbourhood ?? null;
  const area = a.suburb ?? a.village ?? a.quarter ?? a.neighbourhood ?? null;
  const city =
    a.city ?? a.town ?? a.municipality ?? a.county ?? a.state ?? null;

  const parts = [street, area !== street ? area : null, city].filter(Boolean);
  if (parts.length > 0) return parts.join(", ");

  if (data?.display_name) {
    return data.display_name.split(", ").slice(0, 3).join(", ");
  }
  return "";
};

function StatusPill({ status }) {
  return (
    <span className={`dash-pill dash-pill-${status}`}>
      <span className="dash-pill-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

// Simple inline icons (only the ones the layout needs)
const icons = {
  dashboard: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  chip: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </svg>
  ),
  map: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  signal: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12h4l3-8 4 16 3-8h6" />
    </svg>
  ),
  offline: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 2l20 20" />
      <path d="M8.5 16.4a5 5 0 0 1 7 0" />
      <path d="M5 12.9a10 10 0 0 1 5.2-2.7" />
      <path d="M12 20h.01" />
    </svg>
  ),
  menu: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
};

export default function Dashboard({ isDarkMode: isDarkModeProp = true }) {
  const navigate = useNavigate();
  const espSectionRef = useRef(null);

  const [isDarkMode, setIsDarkMode] = useState(() => {
    try {
      const saved = localStorage.getItem("isDarkMode");
      return saved === null ? isDarkModeProp : saved === "true";
    } catch {
      return isDarkModeProp;
    }
  });

  // Mobile / tablet sidebar drawer
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auth
  const [authUser, setAuthUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(null); // null = not checked yet

  // Data
  const [users, setUsers] = useState([]);
  const [iotDevices, setIotDevices] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [usersFailed, setUsersFailed] = useState(false);
  const [devicesFailed, setDevicesFailed] = useState(false);
  const [errorHint, setErrorHint] = useState("");

  // Live GPS data from the Realtime Database: { motorcycle_001: {...}, ... }
  const [gps, setGps] = useState({});
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Place names from reverse geocoding: { "14.600,120.984": "Street, Area, City" }
  const [places, setPlaces] = useState({});
  const requestedPlacesRef = useRef(new Set());
  const placeQueueRef = useRef([]);
  const placeWorkerRunningRef = useRef(false);
  const mountedRef = useRef(true);

  const [loggingOut, setLoggingOut] = useState(false);

  const toggleTheme = () => {
    setIsDarkMode((value) => {
      const nextValue = !value;

      try {
        localStorage.setItem("isDarkMode", String(nextValue));
      } catch {
        // Ignore localStorage errors
      }

      return nextValue;
    });
  };

  const scrollToDevices = () => {
    espSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleLogout = async () => {
    setLoggingOut(true);

    try {
      await signOut(getAuth());
      navigate("/login", { replace: true });
    } catch (error) {
      console.error("Logout failed:", error);
      setLoggingOut(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Re-evaluate "active / offline" and "x seconds ago" every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);

  // =========================================================
  // LOAD DATA (only after Firebase Auth is ready)
  // =========================================================

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = onAuthStateChanged(getAuth(), async (currentUser) => {
      if (!currentUser) {
        if (!cancelled) navigate("/login", { replace: true });
        return;
      }

      setAuthUser(currentUser);
      setLoadingData(true);
      setUsersFailed(false);
      setDevicesFailed(false);
      setErrorHint("");

      const db = getFirestore();

      // Is this account listed in the "admins" collection?
      let adminExists = false;
      try {
        const adminSnap = await getDoc(doc(db, "admins", currentUser.uid));
        adminExists = adminSnap.exists();
      } catch (error) {
        console.error("Admin check failed:", error);
      }
      if (cancelled) return;
      setIsAdmin(adminExists);

      // Users and devices load separately, so one failing
      // does not hide the other.
      const [usersResult, devicesResult] = await Promise.allSettled([
        getDocs(collection(db, "users")),
        getDocs(collection(db, "iotDevices")),
      ]);
      if (cancelled) return;

      if (usersResult.status === "fulfilled") {
        setUsers(
          usersResult.value.docs.map((d) => ({ id: d.id, ...d.data() }))
        );
      } else {
        console.error("Failed to load users:", usersResult.reason);
        setUsers([]);
        setUsersFailed(true);

        if (usersResult.reason?.code === "permission-denied") {
          setErrorHint(
            adminExists
              ? "Permission denied. Publish the latest Firestore rules."
              : "This account is not an admin. Add it to the 'admins' collection."
          );
        }
      }

      if (devicesResult.status === "fulfilled") {
        setIotDevices(
          devicesResult.value.docs.map((d) => {
            // passkeyHash is intentionally dropped, never shown or stored in state
            const { passkeyHash, ...safe } = d.data();
            return { id: d.id, ...safe };
          })
        );
      } else {
        console.error("Failed to load devices:", devicesResult.reason);
        setIotDevices([]);
        setDevicesFailed(true);
      }

      setLoadingData(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [navigate]);

  // =========================================================
  // LIVE GPS DATA (Realtime Database: gps/<deviceId>)
  // =========================================================

  useEffect(() => {
    if (!authUser) return undefined;

    const unsubGps = onValue(
      ref(rtdb, "gps"),
      (snapshot) => {
        const value = snapshot.val();
        setGps(value && typeof value === "object" ? value : {});
      },
      (error) => {
        console.error("Failed to read live GPS data:", error);
        setGps({});
      }
    );

    const unsubOffset = onValue(ref(rtdb, ".info/serverTimeOffset"), (snap) => {
      const v = snap.val();
      if (typeof v === "number") setServerOffsetMs(v);
    });

    return () => {
      unsubGps();
      unsubOffset();
    };
  }, [authUser]);

  // =========================================================
  // PLACE NAMES (reverse geocoding, one request at a time)
  // =========================================================

  const runPlaceWorker = useCallback(async () => {
    if (placeWorkerRunningRef.current) return;
    placeWorkerRunningRef.current = true;

    while (placeQueueRef.current.length > 0 && mountedRef.current) {
      const { key, lat, lng } = placeQueueRef.current.shift();
      let name = "";

      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${lat}&lon=${lng}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        name = shortPlaceName(await res.json());
      } catch (error) {
        console.error("Place lookup failed:", error);
      }

      if (mountedRef.current) {
        setPlaces((prev) => ({ ...prev, [key]: name }));
      }
      await sleep(GEOCODE_DELAY_MS);
    }

    placeWorkerRunningRef.current = false;
  }, []);

  useEffect(() => {
    iotDevices.forEach((d) => {
      const loc = getLocation(gps[getGpsKey(d)]);
      if (!loc) return;

      const key = placeKey(loc);
      if (requestedPlacesRef.current.has(key)) return;

      requestedPlacesRef.current.add(key);
      placeQueueRef.current.push({ key, lat: loc.lat, lng: loc.lng });
    });

    if (placeQueueRef.current.length > 0) runPlaceWorker();
  }, [gps, iotDevices, runPlaceWorker]);

  // =========================================================
  // DERIVED DATA
  // =========================================================

  // userId -> user (used to show the owner of each device)
  const userById = useMemo(() => {
    const map = new Map();
    users.forEach((u) => map.set(u.id, u));
    return map;
  }, [users]);

  const stats = useMemo(() => {
    const statuses = iotDevices.map((d) =>
      getIotStatus(d, gps[getGpsKey(d)], nowMs, serverOffsetMs)
    );
    const active = statuses.filter((s) => s === "active").length;
    const offline = statuses.filter((s) => s === "inactive").length;
    const unlinked = statuses.filter((s) => s === "unlinked").length;

    return { registered: iotDevices.length, active, offline, unlinked };
  }, [iotDevices, gps, nowMs, serverOffsetMs]);

  const previewUsers = useMemo(
    () => users.slice(0, USER_PREVIEW_LIMIT),
    [users]
  );

  const display = (value, failed) => {
    if (loadingData) return "...";
    if (failed) return "—";
    return value ?? "—";
  };

  const systemOk = !usersFailed && !devicesFailed;

  const pct = (n) =>
    stats.registered > 0 ? `${(n / stats.registered) * 100}%` : "0%";

  const pctLabel = (n) =>
    stats.registered > 0 ? `${Math.round((n / stats.registered) * 100)}%` : "0%";

  const goTo = (fn) => () => {
    setSidebarOpen(false);
    fn();
  };

  // Sidebar navigation (same targets as the old quick actions)
  const navItems = [
    {
      key: "dashboard",
      icon: icons.dashboard,
      title: "Dashboard",
      onClick: scrollToTop,
      active: true,
    },
    {
      key: "users",
      icon: icons.users,
      title: "All users",
      onClick: () => navigate("/users"),
    },
    {
      key: "devices",
      icon: icons.chip,
      title: "ESP devices",
      onClick: scrollToDevices,
    },
    {
      key: "map",
      icon: icons.map,
      title: "Live map",
      onClick: () => navigate("/map"),
    },
  ];

  const adminLabel = authUser?.email ?? authUser?.displayName ?? "";

  return (
    <div className={`mg-shell ${isDarkMode ? "mg-dark" : "mg-light"}`}>
      {/* =================================================
          TOP BAR
          ================================================= */}

      <header className="mg-topbar">
        <div className="mg-topbar-left">
          <button
            type="button"
            className="mg-topbar-btn mg-menu-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="Toggle navigation"
            aria-expanded={sidebarOpen}
          >
            {icons.menu}
          </button>

          <div className="mg-brand">
            <span className="mg-brand-mark">{icons.shield}</span>
            <span className="mg-brand-text">
              Moto<span className="mg-brand-accent">Guard</span>
            </span>
          </div>
        </div>

        <div className="mg-topbar-right">
          <span
            className={`mg-system ${systemOk ? "" : "mg-system-error"}`}
            role="status"
          >
            <span className="mg-system-dot" aria-hidden="true" />
            <span className="mg-system-text">
              {loadingData
                ? "Checking system"
                : systemOk
                ? "System operational"
                : "System error"}
            </span>
          </span>

          <button
            type="button"
            className="mg-topbar-btn"
            onClick={toggleTheme}
            aria-label={
              isDarkMode ? "Switch to light mode" : "Switch to dark mode"
            }
            title={isDarkMode ? "Light mode" : "Dark mode"}
          >
            {isDarkMode ? icons.sun : icons.moon}
          </button>

          {adminLabel && (
            <span className="mg-admin" title={adminLabel}>
              <span className="mg-admin-avatar">{getInitials(adminLabel)}</span>
              <span className="mg-admin-text">{adminLabel}</span>
            </span>
          )}
        </div>
      </header>

      <div className="mg-body">
        {/* =================================================
            SIDEBAR
            ================================================= */}

        <aside className={`mg-side ${sidebarOpen ? "is-open" : ""}`}>
          <div className="mg-side-profile">
            <span
              className={`dash-avatar dash-avatar-lg dash-avatar-${avatarTone(
                adminLabel
              )}`}
              aria-hidden="true"
            >
              {getInitials(adminLabel)}
            </span>
            <div className="mg-side-profile-text">
              <strong title={adminLabel}>{adminLabel || "Administrator"}</strong>
              <span>{isAdmin ? "Administrator" : "Signed in"}</span>
            </div>
          </div>

          <nav className="mg-side-nav" aria-label="Main navigation">
            <span className="mg-side-label">Navigation</span>
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`mg-side-link ${item.active ? "is-active" : ""}`}
                onClick={goTo(item.onClick)}
              >
                <span className="mg-side-icon">{item.icon}</span>
                {item.title}
              </button>
            ))}
          </nav>

          <button
            type="button"
            className="mg-side-logout"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {icons.logout}
            {loggingOut ? "Logging out..." : "Log out"}
          </button>
        </aside>

        {sidebarOpen && (
          <button
            type="button"
            className="mg-scrim"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* =================================================
            MAIN CONTENT
            ================================================= */}

        <main className="mg-content">
          <section className="mg-banner">
            <div>
              <h1 className="mg-banner-title">Dashboard</h1>
              <p className="mg-banner-sub">
                Monitor riders and tracking devices across your fleet.
              </p>
            </div>
            <span className="mg-banner-crumb">
              MotoGuard <span aria-hidden="true">›</span> Dashboard
            </span>
          </section>

          <div className="mg-main">
            {/* ---------- STATS ---------- */}
            <section className="mg-stats" aria-label="System overview">
              <div className="mg-panel mg-statgrid">
                <div className="mg-statcell">
                  <span className="mg-statcell-icon mg-c-blue">
                    {icons.users}
                  </span>
                  <div>
                    <strong className="mg-statcell-value">
                      {display(users.length, usersFailed)}
                    </strong>
                    <span className="mg-statcell-label">Total users</span>
                  </div>
                </div>

                <div className="mg-statcell">
                  <span className="mg-statcell-icon mg-c-teal">
                    {icons.chip}
                  </span>
                  <div>
                    <strong className="mg-statcell-value">
                      {display(stats.registered, devicesFailed)}
                    </strong>
                    <span className="mg-statcell-label">ESP devices</span>
                  </div>
                </div>

                <div className="mg-statcell">
                  <span className="mg-statcell-icon mg-c-green">
                    {icons.signal}
                  </span>
                  <div>
                    <strong className="mg-statcell-value dash-tone-active">
                      {display(stats.active, devicesFailed)}
                    </strong>
                    <span className="mg-statcell-label">Active devices</span>
                  </div>
                </div>

                <div className="mg-statcell">
                  <span className="mg-statcell-icon mg-c-amber">
                    {icons.offline}
                  </span>
                  <div>
                    <strong className="mg-statcell-value dash-tone-inactive">
                      {display(stats.offline, devicesFailed)}
                    </strong>
                    <span className="mg-statcell-label">Offline devices</span>
                  </div>
                </div>
              </div>

              <div className="mg-tile mg-tile-green">
                <strong className="mg-tile-value">
                  {loadingData || devicesFailed
                    ? display(null, devicesFailed)
                    : pctLabel(stats.active)}
                </strong>
                <span className="mg-tile-label">Fleet online rate</span>
                <span className="mg-tile-note">Devices reporting live</span>
              </div>

              <div className="mg-tile mg-tile-blue">
                <strong className="mg-tile-value">
                  {display(stats.unlinked, devicesFailed)}
                </strong>
                <span className="mg-tile-label">Not linked</span>
                <span className="mg-tile-note">Not assigned to a rider</span>
              </div>
            </section>

            {/* ---------- USERS + FLEET ---------- */}
            <div className="mg-row">
              <section className="mg-panel dash-card" aria-label="Users">
                <div className="dash-card-head">
                  <div>
                    <h2 className="dash-card-title">
                      Users
                      {!loadingData && !usersFailed && (
                        <span className="dash-card-title-badge">
                          {users.length}
                        </span>
                      )}
                    </h2>
                    <p className="dash-card-sub">
                      Most recent registered riders.
                    </p>
                  </div>
                </div>

                <div className="dash-table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Registered</th>
                      </tr>
                    </thead>

                    <tbody>
                      {loadingData && (
                        <tr className="dash-empty-row">
                          <td colSpan={3}>Loading users...</td>
                        </tr>
                      )}

                      {!loadingData && usersFailed && (
                        <tr className="dash-empty-row">
                          <td colSpan={3}>
                            Users could not be loaded.{" "}
                            {errorHint ||
                              "Check your connection and Firestore permissions, then refresh."}
                          </td>
                        </tr>
                      )}

                      {!loadingData &&
                        !usersFailed &&
                        previewUsers.length === 0 && (
                          <tr className="dash-empty-row">
                            <td colSpan={3}>No users have registered yet.</td>
                          </tr>
                        )}

                      {!loadingData &&
                        !usersFailed &&
                        previewUsers.map((u) => (
                          <tr key={u.id}>
                            <td data-label="Name" className="dash-cell-strong">
                              <div className="dash-user">
                                <span
                                  className={`dash-avatar dash-avatar-${avatarTone(
                                    u.name ?? u.email ?? u.id
                                  )}`}
                                  aria-hidden="true"
                                >
                                  {getInitials(u.name ?? u.email)}
                                </span>
                                <span>{u.name ?? "—"}</span>
                              </div>
                            </td>
                            <td data-label="Email">{u.email ?? "—"}</td>
                            <td data-label="Registered">
                              {formatDate(getRegisteredAt(u))}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                {!loadingData && !usersFailed && users.length > 0 && (
                  <div className="dash-card-foot-row">
                    <span className="dash-card-foot-text">
                      Showing {previewUsers.length} of {users.length}{" "}
                      {users.length === 1 ? "user" : "users"}
                    </span>

                    <button
                      type="button"
                      className="dash-see-more"
                      onClick={() => navigate("/users")}
                    >
                      See more
                    </button>
                  </div>
                )}
              </section>

              <section
                className="mg-panel dash-card mg-fleet"
                aria-label="Fleet status"
              >
                <div className="dash-card-head">
                  <div>
                    <h2 className="dash-card-title">Fleet status</h2>
                    <p className="dash-card-sub">
                      Share of registered devices by connection.
                    </p>
                  </div>
                </div>

                <div className="mg-fleet-body">
                  {[
                    ["Active", stats.active, "active"],
                    ["Offline", stats.offline, "inactive"],
                    ["Not linked", stats.unlinked, "unlinked"],
                  ].map(([label, count, tone]) => (
                    <div className="mg-meter" key={tone}>
                      <div className="mg-meter-top">
                        <span>{label}</span>
                        <strong>
                          {loadingData || devicesFailed
                            ? display(null, devicesFailed)
                            : `${count} · ${pctLabel(count)}`}
                        </strong>
                      </div>
                      <div className="mg-meter-track">
                        <span
                          className={`mg-meter-fill mg-meter-${tone}`}
                          style={{
                            width:
                              loadingData || devicesFailed ? "0%" : pct(count),
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {/* ---------- ESP DEVICES ---------- */}
            <section
              className="mg-panel dash-card"
              aria-label="Registered ESP devices"
              ref={espSectionRef}
            >
              <div className="dash-card-head">
                <div>
                  <h2 className="dash-card-title">
                    Registered ESP devices
                    {!loadingData && !devicesFailed && (
                      <span className="dash-card-title-badge">
                        {iotDevices.length}
                      </span>
                    )}
                  </h2>
                  <p className="dash-card-sub">
                    Devices in the system, the rider each one is linked to, and
                    where it last reported from.
                  </p>
                </div>

                <button
                  type="button"
                  className="dash-btn dash-btn-primary"
                  onClick={() => navigate("/map")}
                >
                  Open live map
                </button>
              </div>

              <div className="dash-table-wrap">
                <table className="dash-table dash-table-wide">
                  <thead>
                    <tr>
                      <th>Device ID</th>
                      <th>Name</th>
                      <th>Owner</th>
                      <th>Connection</th>
                      <th>Last ping</th>
                      <th>Last location</th>
                    </tr>
                  </thead>

                  <tbody>
                    {loadingData && (
                      <tr className="dash-empty-row">
                        <td colSpan={6}>Loading devices...</td>
                      </tr>
                    )}

                    {!loadingData && devicesFailed && (
                      <tr className="dash-empty-row">
                        <td colSpan={6}>Devices could not be loaded.</td>
                      </tr>
                    )}

                    {!loadingData &&
                      !devicesFailed &&
                      iotDevices.length === 0 && (
                        <tr className="dash-empty-row">
                          <td colSpan={6}>No ESP devices are registered yet.</td>
                        </tr>
                      )}

                    {!loadingData &&
                      !devicesFailed &&
                      iotDevices.map((d) => {
                        const owner = d.connectedUserId
                          ? userById.get(d.connectedUserId)
                          : null;

                        const live = gps[getGpsKey(d)];
                        const status = getIotStatus(
                          d,
                          live,
                          nowMs,
                          serverOffsetMs
                        );

                        // Last ping: live GPS ping first, Firestore lastSeen as fallback
                        const pingMs =
                          getPingMs(live) ?? getLastSeen(d)?.getTime() ?? null;
                        const pingDate = pingMs ? new Date(pingMs) : null;
                        const agoMs =
                          pingMs !== null
                            ? nowMs + serverOffsetMs - pingMs
                            : null;

                        // Last known location
                        const loc = getLocation(live);
                        const place = loc ? places[placeKey(loc)] : undefined;

                        return (
                          <tr key={d.id}>
                            <td
                              data-label="Device ID"
                              className="dash-cell-mono"
                            >
                              <span className="dash-device-id">
                                {d.deviceId ?? d.id}
                              </span>
                            </td>
                            <td data-label="Name" className="dash-cell-strong">
                              {d.name ?? "—"}
                            </td>
                            <td data-label="Owner">
                              {owner
                                ? owner.name ?? owner.email ?? "—"
                                : d.connectedUserId
                                ? "Unknown rider"
                                : "—"}
                            </td>
                            <td data-label="Connection">
                              <StatusPill status={status} />
                            </td>
                            <td data-label="Last ping">
                              <div className="dash-cell-stack">
                                <span>{formatDateTime(pingDate)}</span>
                                {agoMs !== null && (
                                  <span className="dash-cell-muted">
                                    {formatAgo(agoMs)}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td data-label="Last location">
                              {loc ? (
                                <div className="dash-cell-stack">
                                  <span>
                                    {place === undefined
                                      ? "Finding place..."
                                      : place || "Place name unavailable"}
                                  </span>
                                  <span className="dash-cell-muted">
                                    {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}{" "}
                                    ·{" "}
                                    <a
                                      href={`https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}`}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Open map
                                    </a>
                                  </span>
                                </div>
                              ) : (
                                <span className="dash-cell-muted">
                                  No location yet
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {!loadingData && !devicesFailed && iotDevices.length > 0 && (
                <p className="dash-card-foot">
                  {iotDevices.length}{" "}
                  {iotDevices.length === 1 ? "device" : "devices"} registered
                </p>
              )}
            </section>

            <footer className="mg-footer">MotoGuard · Admin</footer>
          </div>
        </main>
      </div>
    </div>
  );
}
