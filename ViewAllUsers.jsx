import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAuth, onAuthStateChanged, signOut } from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  onSnapshot,
} from "firebase/firestore";
import { ref, onValue } from "firebase/database";
import { rtdb } from "./firebase";
import "./Dashboard.css"; // shared shell: top bar, sidebar, banner, cards, pills
import "./Users.css"; // users-only styles

const PAGE_SIZES = [10, 20, 50];

// A device sending live GPS data is "active" if its last ping is newer than this
const LIVE_WINDOW_MS = 30 * 1000;

// A device with no live GPS data is "active" if Firestore says it reported in within this window
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// Nominatim asks for max 1 request per second
const GEOCODE_DELAY_MS = 1100;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "online", label: "Online" },
  { key: "offline", label: "Offline" },
  { key: "with", label: "With device" },
  { key: "without", label: "No device" },
];

// =========================================================
// FIELD HELPERS
// If your Firestore documents use different field names,
// adjust them here. Nothing else needs to change.
// (These match the helpers used in Dashboard.jsx.)
// =========================================================

const toDate = (value) => {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const getRegisteredAt = (u) => toDate(u.createdAt ?? u.registeredAt);
const getLastSeen = (x) => toDate(x.lastSeen ?? x.lastActive ?? x.lastOnline);
const getUserName = (u) => u.name ?? u.displayName ?? u.fullName ?? null;
const getUserPhone = (u) => u.phone ?? u.phoneNumber ?? null;

// The key of this device under gps/<key> in the Realtime Database
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

// Same rules as the dashboard. Returns "active" | "inactive" | "unlinked"
const getIotStatus = (d, g, nowMs, offsetMs) => {
  if (d.status !== "connected") return "unlinked";

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

// CSV cells starting with = + - @ can run as formulas in Excel, so neutralise them
const csvCell = (value) => {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const SORT_COLUMNS = {
  name: (r) => String(r.name ?? "").toLowerCase(),
  email: (r) => String(r.email ?? "").toLowerCase(),
  devices: (r) => r.devices.length,
  registered: (r) => r.registeredAt?.getTime() ?? 0,
};

// =========================================================
// SMALL COMPONENTS
// =========================================================

function StatusPill({ status }) {
  return (
    <span className={`dash-pill dash-pill-${status}`}>
      <span className="dash-pill-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function SortHeader({ label, column, sort, onSort }) {
  const isActive = sort.key === column;
  return (
    <th
      aria-sort={
        isActive ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className={`mgu-sort ${isActive ? "is-active" : ""}`}
        onClick={() => onSort(column)}
      >
        {label}
        <span className="mgu-sort-arrow" aria-hidden="true">
          {isActive ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

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
  calendar: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
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
  search: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
};

// =========================================================
// PAGE
// =========================================================

export default function ViewAllUsers({ isDarkMode: isDarkModeProp = true }) {
  const navigate = useNavigate();

  // Same theme storage key as the dashboard, so all pages match
  const [isDarkMode, setIsDarkMode] = useState(() => {
    try {
      const saved = localStorage.getItem("isDarkMode");
      return saved === null ? isDarkModeProp : saved === "true";
    } catch {
      return isDarkModeProp;
    }
  });

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // Auth
  const [authUser, setAuthUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(null); // null = not checked yet

  // Data (all live)
  const [users, setUsers] = useState([]);
  const [iotDevices, setIotDevices] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [usersFailed, setUsersFailed] = useState(false);
  const [devicesFailed, setDevicesFailed] = useState(false);
  const [errorHint, setErrorHint] = useState("");

  const [gps, setGps] = useState({});
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Table controls
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState({ key: "registered", dir: "desc" });
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);

  // Detail drawer
  const [selectedId, setSelectedId] = useState(null);

  // Place names (reverse geocoding, only for the open drawer)
  const [places, setPlaces] = useState({});
  const requestedPlacesRef = useRef(new Set());
  const mountedRef = useRef(true);

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

  const toggleTheme = () => {
    setIsDarkMode((value) => {
      const next = !value;
      try {
        localStorage.setItem("isDarkMode", String(next));
      } catch {
        // Ignore localStorage errors
      }
      return next;
    });
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

  // =========================================================
  // AUTH + ADMIN CHECK
  // =========================================================

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = onAuthStateChanged(getAuth(), async (currentUser) => {
      if (!currentUser) {
        if (!cancelled) navigate("/login", { replace: true });
        return;
      }

      setAuthUser(currentUser);

      let adminExists = false;
      try {
        const adminSnap = await getDoc(
          doc(getFirestore(), "admins", currentUser.uid)
        );
        adminExists = adminSnap.exists();
      } catch (error) {
        console.error("Admin check failed:", error);
      }
      if (!cancelled) setIsAdmin(adminExists);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [navigate]);

  // =========================================================
  // REAL-TIME LISTENERS
  // Firestore: users + iotDevices   Realtime DB: gps
  // They start once the admin check is done and are removed
  // automatically when you leave the page.
  // =========================================================

  useEffect(() => {
    if (!authUser || isAdmin === null) return undefined;

    const db = getFirestore();
    setUsersLoading(true);
    setDevicesLoading(true);
    setUsersFailed(false);
    setDevicesFailed(false);
    setErrorHint("");

    const unsubUsers = onSnapshot(
      collection(db, "users"),
      (snap) => {
        setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setUsersFailed(false);
        setUsersLoading(false);
      },
      (error) => {
        console.error("Failed to load users:", error);
        setUsers([]);
        setUsersFailed(true);
        setUsersLoading(false);
        if (error?.code === "permission-denied") {
          setErrorHint(
            isAdmin
              ? "Permission denied. Publish the latest Firestore rules."
              : "This account is not an admin. Add it to the 'admins' collection."
          );
        }
      }
    );

    const unsubDevices = onSnapshot(
      collection(db, "iotDevices"),
      (snap) => {
        setIotDevices(
          snap.docs.map((d) => {
            // passkeyHash is intentionally dropped, never shown or stored in state
            // eslint-disable-next-line no-unused-vars
            const { passkeyHash, ...safe } = d.data();
            return { id: d.id, ...safe };
          })
        );
        setDevicesFailed(false);
        setDevicesLoading(false);
      },
      (error) => {
        console.error("Failed to load devices:", error);
        setIotDevices([]);
        setDevicesFailed(true);
        setDevicesLoading(false);
      }
    );

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
      unsubUsers();
      unsubDevices();
      unsubGps();
      unsubOffset();
    };
  }, [authUser, isAdmin]);

  // =========================================================
  // DERIVED DATA
  // =========================================================

  // One row per user, with that user's linked devices and live status
  const rows = useMemo(() => {
    const byOwner = new Map();
    iotDevices.forEach((d) => {
      if (!d.connectedUserId) return;
      const list = byOwner.get(d.connectedUserId) ?? [];
      list.push(d);
      byOwner.set(d.connectedUserId, list);
    });

    return users.map((u) => {
      const owned = [
        ...(byOwner.get(u.id) ?? []),
        ...(u.uid && u.uid !== u.id ? byOwner.get(u.uid) ?? [] : []),
      ];

      const devices = owned.map((d) => {
        const live = gps[getGpsKey(d)];
        const status = getIotStatus(d, live, nowMs, serverOffsetMs);
        const pingMs = getPingMs(live) ?? getLastSeen(d)?.getTime() ?? null;
        return {
          device: d,
          status,
          pingMs,
          agoMs: pingMs !== null ? nowMs + serverOffsetMs - pingMs : null,
          loc: getLocation(live),
        };
      });

      let presence = "none";
      if (devices.some((x) => x.status === "active")) presence = "online";
      else if (devices.some((x) => x.status === "inactive")) presence = "offline";

      return {
        id: u.id,
        user: u,
        name: getUserName(u),
        email: u.email ?? null,
        registeredAt: getRegisteredAt(u),
        devices,
        presence,
      };
    });
  }, [users, iotDevices, gps, nowMs, serverOffsetMs]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      online: rows.filter((r) => r.presence === "online").length,
      offline: rows.filter((r) => r.presence === "offline").length,
      with: rows.filter((r) => r.devices.length > 0).length,
      without: rows.filter((r) => r.devices.length === 0).length,
    }),
    [rows]
  );

  const unassignedDevices = useMemo(() => {
    const ids = new Set(users.flatMap((u) => [u.id, u.uid].filter(Boolean)));
    return iotDevices.filter(
      (d) => !d.connectedUserId || !ids.has(d.connectedUserId)
    ).length;
  }, [users, iotDevices]);

  const joinedThisMonth = useMemo(() => {
    const now = new Date();
    return rows.filter(
      (r) =>
        r.registeredAt &&
        r.registeredAt.getFullYear() === now.getFullYear() &&
        r.registeredAt.getMonth() === now.getMonth()
    ).length;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();

    const matches = rows.filter((r) => {
      if (filter === "online" && r.presence !== "online") return false;
      if (filter === "offline" && r.presence !== "offline") return false;
      if (filter === "with" && r.devices.length === 0) return false;
      if (filter === "without" && r.devices.length > 0) return false;
      if (!q) return true;

      return (
        String(r.name ?? "").toLowerCase().includes(q) ||
        String(r.email ?? "").toLowerCase().includes(q) ||
        r.devices.some(
          (x) =>
            String(x.device.deviceId ?? x.device.id).toLowerCase().includes(q) ||
            String(x.device.name ?? "").toLowerCase().includes(q)
        )
      );
    });

    const getter = SORT_COLUMNS[sort.key] ?? SORT_COLUMNS.registered;
    const dir = sort.dir === "asc" ? 1 : -1;

    return [...matches].sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, search, filter, sort]);

  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = visibleRows.slice(startIndex, startIndex + pageSize);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  const loading = usersLoading || devicesLoading;
  const systemOk = !usersFailed && !devicesFailed;

  const display = (value, failed = usersFailed) => {
    if (loading) return "...";
    if (failed) return "—";
    return value;
  };

  const onlineUsers = rows.filter((r) => r.presence === "online").length;

  // =========================================================
  // DRAWER BEHAVIOUR
  // =========================================================

  // If the selected user is deleted elsewhere, close the drawer
  useEffect(() => {
    if (selectedId && !loading && !selected) setSelectedId(null);
  }, [selectedId, selected, loading]);

  // Escape closes the drawer, page behind it does not scroll
  useEffect(() => {
    if (!selectedId) return undefined;

    const onKey = (e) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [selectedId]);

  // Look up place names for the open user's devices (one request at a time)
  useEffect(() => {
    if (!selected) return;

    const todo = [];
    selected.devices.forEach((x) => {
      if (!x.loc) return;
      const key = placeKey(x.loc);
      if (requestedPlacesRef.current.has(key)) return;
      requestedPlacesRef.current.add(key);
      todo.push({ key, ...x.loc });
    });
    if (todo.length === 0) return;

    (async () => {
      for (const item of todo) {
        if (!mountedRef.current) return;
        let name = "";
        try {
          const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${item.lat}&lon=${item.lng}`;
          const res = await fetch(url, {
            headers: { Accept: "application/json" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          name = shortPlaceName(await res.json());
        } catch (error) {
          console.error("Place lookup failed:", error);
        }
        if (mountedRef.current) {
          setPlaces((prev) => ({ ...prev, [item.key]: name }));
        }
        await sleep(GEOCODE_DELAY_MS);
      }
    })();
  }, [selected]);

  // =========================================================
  // ACTIONS
  // =========================================================

  const handleSort = (key) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "registered" || key === "devices" ? "desc" : "asc" }
    );
    setPage(1);
  };

  const exportCsv = () => {
    const header = [
      "Name",
      "Email",
      "Registered",
      "Devices",
      "Device IDs",
      "Status",
    ];
    const lines = visibleRows.map((r) =>
      [
        r.name ?? "",
        r.email ?? "",
        r.registeredAt ? r.registeredAt.toISOString() : "",
        r.devices.length,
        r.devices.map((x) => x.device.deviceId ?? x.device.id).join(" | "),
        r.presence === "online"
          ? "Online"
          : r.presence === "offline"
          ? "Offline"
          : "No device",
      ]
        .map(csvCell)
        .join(",")
    );

    const blob = new Blob([`\uFEFF${[header.map(csvCell).join(","), ...lines].join("\r\n")}`], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `motoguard-users-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const resetControls = () => {
    setSearch("");
    setFilter("all");
    setPage(1);
  };

  const adminLabel = authUser?.email ?? authUser?.displayName ?? "";

  const goTo = (fn) => () => {
    setSidebarOpen(false);
    fn();
  };

  const navItems = [
    {
      key: "dashboard",
      icon: icons.dashboard,
      title: "Dashboard",
      onClick: () => navigate("/dashboard"),
    },
    {
      key: "users",
      icon: icons.users,
      title: "All users",
      onClick: () => {},
      active: true,
    },
    {
      key: "devices",
      icon: icons.chip,
      title: "ESP devices",
      onClick: () => navigate("/dashboard"),
    },
    {
      key: "map",
      icon: icons.map,
      title: "Live map",
      onClick: () => navigate("/map"),
    },
  ];

  const hasActiveControls = search.trim() !== "" || filter !== "all";

  return (
    <div className={`mg-shell ${isDarkMode ? "mg-dark" : "mg-light"}`}>
      {/* ---------- TOP BAR ---------- */}
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
              {loading
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
        {/* ---------- SIDEBAR ---------- */}
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
                aria-current={item.active ? "page" : undefined}
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

        {/* ---------- CONTENT ---------- */}
        <main className="mg-content">
          <section className="mg-banner">
            <div>
              <h1 className="mg-banner-title">All users</h1>
              <p className="mg-banner-sub">
                Riders, the ESP32 devices linked to them, and their live status.
              </p>
            </div>
            <span className="mg-banner-crumb">
              MotoGuard <span aria-hidden="true">›</span> Users
            </span>
          </section>

          <div className="mg-main">
            {/* Summary */}
            <section className="mg-panel mgu-summary" aria-label="User summary">
              <div className="mg-statcell">
                <span className="mg-statcell-icon mg-c-blue">{icons.users}</span>
                <div>
                  <strong className="mg-statcell-value">
                    {display(users.length)}
                  </strong>
                  <span className="mg-statcell-label">Total users</span>
                </div>
              </div>
              <div className="mg-statcell">
                <span className="mg-statcell-icon mg-c-green">
                  {icons.signal}
                </span>
                <div>
                  <strong className="mg-statcell-value dash-tone-active">
                    {display(onlineUsers, usersFailed || devicesFailed)}
                  </strong>
                  <span className="mg-statcell-label">Online now</span>
                </div>
              </div>
              <div className="mg-statcell">
                <span className="mg-statcell-icon mg-c-teal">{icons.chip}</span>
                <div>
                  <strong className="mg-statcell-value">
                    {display(counts.with, usersFailed || devicesFailed)}
                  </strong>
                  <span className="mg-statcell-label">With a device</span>
                </div>
              </div>
              <div className="mg-statcell">
                <span className="mg-statcell-icon mg-c-amber">
                  {icons.calendar}
                </span>
                <div>
                  <strong className="mg-statcell-value">
                    {display(joinedThisMonth)}
                  </strong>
                  <span className="mg-statcell-label">Joined this month</span>
                </div>
              </div>
            </section>

            {/* Users table */}
            <section className="mg-panel dash-card" aria-label="Registered users">
              <div className="dash-card-head">
                <div>
                  <h2 className="dash-card-title">
                    Registered users
                    {!loading && !usersFailed && (
                      <span className="dash-card-title-badge">
                        {users.length}
                      </span>
                    )}
                    <span className="mgu-live" title="Updates automatically">
                      <span className="mgu-live-dot" aria-hidden="true" />
                      Live
                    </span>
                  </h2>
                  <p className="dash-card-sub">
                    Search by name, email or device ID. Select a row for
                    details.
                    {!loading && !devicesFailed && unassignedDevices > 0 && (
                      <>
                        {" "}
                        {unassignedDevices}{" "}
                        {unassignedDevices === 1 ? "device is" : "devices are"}{" "}
                        not linked to a rider.
                      </>
                    )}
                  </p>
                </div>

                <button
                  type="button"
                  className="mgu-btn"
                  onClick={exportCsv}
                  disabled={loading || usersFailed || visibleRows.length === 0}
                >
                  {icons.download}
                  Export CSV
                </button>
              </div>

              {/* Toolbar */}
              <div className="mgu-toolbar">
                <label className="mgu-search">
                  {icons.search}
                  <input
                    type="search"
                    placeholder="Search name, email or device"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search users"
                  />
                </label>

                <div className="mgu-chips" role="group" aria-label="Filter users">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={`mgu-chip ${filter === f.key ? "is-active" : ""}`}
                      aria-pressed={filter === f.key}
                      onClick={() => {
                        setFilter(f.key);
                        setPage(1);
                      }}
                    >
                      {f.label}
                      <span className="mgu-chip-count">
                        {loading || usersFailed ? "–" : counts[f.key]}
                      </span>
                    </button>
                  ))}
                </div>

                <select
                  className="mgu-select"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  aria-label="Rows per page"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n} per page
                    </option>
                  ))}
                </select>
              </div>

              <div className="mgu-table-wrap">
                <table className="mgu-table">
                  <thead>
                    <tr>
                      <SortHeader
                        label="Name"
                        column="name"
                        sort={sort}
                        onSort={handleSort}
                      />
                      <SortHeader
                        label="Email"
                        column="email"
                        sort={sort}
                        onSort={handleSort}
                      />
                      <SortHeader
                        label="Devices"
                        column="devices"
                        sort={sort}
                        onSort={handleSort}
                      />
                      <th>Status</th>
                      <SortHeader
                        label="Registered"
                        column="registered"
                        sort={sort}
                        onSort={handleSort}
                      />
                      <th className="mgu-col-action">
                        <span className="mgu-visually-hidden">Details</span>
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {loading && (
                      <tr className="mgu-empty-row">
                        <td colSpan={6}>Loading users...</td>
                      </tr>
                    )}

                    {!loading && usersFailed && (
                      <tr className="mgu-empty-row">
                        <td colSpan={6}>
                          Users could not be loaded.{" "}
                          {errorHint ||
                            "Check your connection and Firestore permissions, then refresh."}
                        </td>
                      </tr>
                    )}

                    {!loading && !usersFailed && users.length === 0 && (
                      <tr className="mgu-empty-row">
                        <td colSpan={6}>No users have registered yet.</td>
                      </tr>
                    )}

                    {!loading &&
                      !usersFailed &&
                      users.length > 0 &&
                      visibleRows.length === 0 && (
                        <tr className="mgu-empty-row">
                          <td colSpan={6}>
                            No users match your search or filter.{" "}
                            {hasActiveControls && (
                              <button
                                type="button"
                                className="mgu-link"
                                onClick={resetControls}
                              >
                                Clear filters
                              </button>
                            )}
                          </td>
                        </tr>
                      )}

                    {!loading &&
                      !usersFailed &&
                      pageRows.map((r) => {
                        const label = r.name ?? r.email ?? r.id;
                        const shown = r.devices.slice(0, 2);
                        const extra = r.devices.length - shown.length;

                        return (
                          <tr
                            key={r.id}
                            className="mgu-row"
                            onClick={() => setSelectedId(r.id)}
                          >
                            <td data-label="Name" className="mgu-cell-name">
                              <div className="dash-user">
                                <span
                                  className={`dash-avatar dash-avatar-${avatarTone(
                                    label
                                  )}`}
                                  aria-hidden="true"
                                >
                                  {getInitials(r.name ?? r.email)}
                                </span>
                                <span>{r.name ?? "—"}</span>
                              </div>
                            </td>
                            <td data-label="Email" className="mgu-cell-email">
                              {r.email ?? "—"}
                            </td>
                            <td data-label="Devices">
                              {r.devices.length === 0 ? (
                                <span className="mgu-muted">None</span>
                              ) : (
                                <div className="mgu-devchips">
                                  {shown.map((x) => (
                                    <span
                                      key={x.device.id}
                                      className={`mgu-devchip mgu-devchip-${x.status}`}
                                      title={`${x.device.name ?? ""} ${
                                        x.device.deviceId ?? x.device.id
                                      } · ${STATUS_LABEL[x.status]}`}
                                    >
                                      <span
                                        className="mgu-devchip-dot"
                                        aria-hidden="true"
                                      />
                                      {x.device.deviceId ?? x.device.id}
                                    </span>
                                  ))}
                                  {extra > 0 && (
                                    <span className="mgu-devchip mgu-devchip-more">
                                      +{extra}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td data-label="Status">
                              {r.presence === "online" && (
                                <StatusPill status="active" />
                              )}
                              {r.presence === "offline" && (
                                <StatusPill status="inactive" />
                              )}
                              {r.presence === "none" && (
                                <span className="mgu-muted">No device</span>
                              )}
                            </td>
                            <td data-label="Registered">
                              {formatDate(r.registeredAt)}
                            </td>
                            <td className="mgu-col-action">
                              <button
                                type="button"
                                className="mgu-btn mgu-btn-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedId(r.id);
                                }}
                                aria-label={`View details for ${label}`}
                              >
                                View
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {!loading && !usersFailed && visibleRows.length > 0 && (
                <div className="mgu-pagination">
                  <span className="mgu-pagination-info">
                    Showing {startIndex + 1}–
                    {Math.min(startIndex + pageSize, visibleRows.length)} of{" "}
                    {visibleRows.length}{" "}
                    {visibleRows.length === 1 ? "user" : "users"}
                  </span>

                  <div className="mgu-pagination-controls">
                    <button
                      type="button"
                      className="mgu-btn mgu-btn-sm"
                      onClick={() => setPage(currentPage - 1)}
                      disabled={currentPage <= 1}
                    >
                      Previous
                    </button>
                    <span className="mgu-pagination-page">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      className="mgu-btn mgu-btn-sm"
                      onClick={() => setPage(currentPage + 1)}
                      disabled={currentPage >= totalPages}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </section>

            <footer className="mg-footer">MotoGuard · Admin</footer>
          </div>
        </main>
      </div>

      {/* ---------- USER DETAILS DRAWER ---------- */}
      {selected && (
        <>
          <button
            type="button"
            className="mgu-overlay"
            aria-label="Close details"
            onClick={() => setSelectedId(null)}
          />
          <aside
            className="mgu-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`Details for ${selected.name ?? selected.email ?? "user"}`}
          >
            <header className="mgu-drawer-head">
              <span
                className={`dash-avatar dash-avatar-lg dash-avatar-${avatarTone(
                  selected.name ?? selected.email ?? selected.id
                )}`}
                aria-hidden="true"
              >
                {getInitials(selected.name ?? selected.email)}
              </span>
              <div className="mgu-drawer-who">
                <strong>{selected.name ?? "Unnamed rider"}</strong>
                <span>{selected.email ?? "No email"}</span>
              </div>
              <button
                type="button"
                className="mgu-icon-btn"
                onClick={() => setSelectedId(null)}
                aria-label="Close details"
                autoFocus
              >
                {icons.close}
              </button>
            </header>

            <div className="mgu-drawer-body">
              <dl className="mgu-facts">
                <div>
                  <dt>Registered</dt>
                  <dd>{formatDate(selected.registeredAt)}</dd>
                </div>
                {getUserPhone(selected.user) && (
                  <div>
                    <dt>Phone</dt>
                    <dd>{getUserPhone(selected.user)}</dd>
                  </div>
                )}
                <div>
                  <dt>Status</dt>
                  <dd>
                    {selected.presence === "online" && (
                      <StatusPill status="active" />
                    )}
                    {selected.presence === "offline" && (
                      <StatusPill status="inactive" />
                    )}
                    {selected.presence === "none" && "No device linked"}
                  </dd>
                </div>
                <div>
                  <dt>User ID</dt>
                  <dd className="mgu-mono">{selected.id}</dd>
                </div>
              </dl>

              <h3 className="mgu-drawer-title">
                Linked devices
                <span className="dash-card-title-badge">
                  {selected.devices.length}
                </span>
              </h3>

              {selected.devices.length === 0 && (
                <p className="mgu-drawer-empty">
                  This rider has no ESP32 device linked yet. Devices appear here
                  as soon as they are connected.
                </p>
              )}

              <ul className="mgu-devlist">
                {selected.devices.map((x) => {
                  const place = x.loc ? places[placeKey(x.loc)] : undefined;
                  return (
                    <li key={x.device.id} className="mgu-dev">
                      <div className="mgu-dev-top">
                        <div>
                          <strong>{x.device.name ?? "Unnamed device"}</strong>
                          <span className="mgu-mono mgu-muted">
                            {x.device.deviceId ?? x.device.id}
                          </span>
                        </div>
                        <StatusPill status={x.status} />
                      </div>

                      <dl className="mgu-dev-facts">
                        <div>
                          <dt>Last ping</dt>
                          <dd>
                            {x.pingMs ? formatDateTime(new Date(x.pingMs)) : "Never"}
                            {x.agoMs !== null && (
                              <span className="mgu-muted">
                                {" "}
                                · {formatAgo(x.agoMs)}
                              </span>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Location</dt>
                          <dd>
                            {x.loc ? (
                              <>
                                {place === undefined
                                  ? "Finding place..."
                                  : place || "Place name unavailable"}
                                <span className="mgu-muted mgu-block">
                                  {x.loc.lat.toFixed(5)}, {x.loc.lng.toFixed(5)}{" "}
                                  ·{" "}
                                  <a
                                    href={`https://www.openstreetmap.org/?mlat=${x.loc.lat}&mlon=${x.loc.lng}#map=17/${x.loc.lat}/${x.loc.lng}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open map
                                  </a>
                                </span>
                              </>
                            ) : (
                              <span className="mgu-muted">No location yet</span>
                            )}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            </div>

            <footer className="mgu-drawer-foot">
              <button
                type="button"
                className="mgu-btn mgu-btn-primary"
                onClick={() => navigate("/map")}
              >
                {icons.map}
                Open live map
              </button>
            </footer>
          </aside>
        </>
      )}
    </div>
  );
}