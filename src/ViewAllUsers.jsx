
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  writeBatch,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import "./Dashboard.css";
import "./ViewAllUsers.css";

const PAGE_SIZE = 10;
const CONFIRM_WORD = "DELETE";
const WRITE_CHUNK = 400;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "with", label: "With device" },
  { key: "without", label: "No device" },
];

const toDate = (value) => {
  if (!value) return null;

  try {
    const date =
      typeof value.toDate === "function"
        ? value.toDate()
        : new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};

const getRegisteredAt = (user) =>
  toDate(user?.createdAt ?? user?.registeredAt);

const getUserName = (user) =>
  user?.name ?? user?.displayName ?? null;

const formatDate = (date) =>
  date
    ? date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";

const getInitials = (value) => {
  if (!value || typeof value !== "string") return "?";

  const base = value.includes("@") ? value.split("@")[0] : value;
  const parts = base.split(/[\s._-]+/).filter(Boolean);

  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

const avatarTone = (value) => {
  const str = String(value ?? "");
  let hash = 0;

  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) % 4;
  }

  return hash + 1;
};

const getErrorText = (error) => {
  if (error?.code === "permission-denied") {
    return "Permission denied. Check your Firestore security rules and admin permissions.";
  }

  if (error?.code === "unavailable") {
    return "Firebase is temporarily unavailable. Check your connection and try again.";
  }

  return error?.message || error?.code || "An unexpected error occurred.";
};

const backIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

const shieldIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

const trashIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </svg>
);

const searchIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

const warnIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3l10 18H2L12 3z" />
    <path d="M12 10v5M12 18h.01" />
  </svg>
);

const usersIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const chipIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </svg>
);

const calendarIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);

export default function ViewAllUsers({
  isDarkMode: isDarkModeProp = true,
}) {
  const navigate = useNavigate();

  const [isDarkMode] = useState(() => {
    try {
      const saved = localStorage.getItem("isDarkMode");
      return saved === null ? isDarkModeProp : saved === "true";
    } catch {
      return isDarkModeProp;
    }
  });

  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(null);

  const [users, setUsers] = useState([]);
  const [iotDevices, setIotDevices] = useState([]);

  const [usersLoading, setUsersLoading] = useState(true);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [usersFailed, setUsersFailed] = useState(false);
  const [devicesFailed, setDevicesFailed] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");
  const [deviceErrorMessage, setDeviceErrorMessage] = useState("");

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);

  const [target, setTarget] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [notice, setNotice] = useState(null);
  const noticeTimerRef = useRef(null);
  const dialogInputRef = useRef(null);

  const showNotice = useCallback((type, message) => {
    setNotice({ type, message });

    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }

    noticeTimerRef.current = setTimeout(() => {
      setNotice(null);
    }, 4500);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
    },
    []
  );

  // ---------------------------------------------------------
  // AUTHENTICATION
  // ---------------------------------------------------------

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (currentUser) => {
        setAuthUser(currentUser);
        setAuthReady(true);
      },
      (error) => {
        console.error("Authentication listener failed:", error);
        setAuthUser(null);
        setAuthReady(true);
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (authReady && !authUser) {
      navigate("/login", { replace: true });
    }
  }, [authReady, authUser, navigate]);

  // ---------------------------------------------------------
  // ADMIN AUTHORIZATION
  // ---------------------------------------------------------

  useEffect(() => {
    if (!authReady || !authUser) {
      setIsAdmin(null);
      return undefined;
    }

    let cancelled = false;

    setIsAdmin(null);

    const checkAdmin = async () => {
      try {
        const adminSnapshot = await getDoc(
          doc(db, "admins", authUser.uid)
        );

        if (!cancelled) {
          setIsAdmin(adminSnapshot.exists());
        }
      } catch (error) {
        console.error("Admin verification failed:", error);

        if (!cancelled) {
          setIsAdmin(false);
          setErrorMessage(getErrorText(error));
        }
      }
    };

    checkAdmin();

    return () => {
      cancelled = true;
    };
  }, [authReady, authUser]);

  // ---------------------------------------------------------
  // LIVE FIRESTORE DATA
  // ---------------------------------------------------------

  useEffect(() => {
    if (!authReady || !authUser || isAdmin !== true) {
      setUsers([]);
      setIotDevices([]);
      setUsersLoading(false);
      setDevicesLoading(false);
      return undefined;
    }

    let usersActive = true;
    let devicesActive = true;

    setUsersLoading(true);
    setDevicesLoading(true);
    setUsersFailed(false);
    setDevicesFailed(false);
    setErrorMessage("");
    setDeviceErrorMessage("");

    const unsubscribeUsers = onSnapshot(
      collection(db, "users"),
      (snapshot) => {
        if (!usersActive) return;

        setUsers(
          snapshot.docs.map((item) => ({
            ...item.data(),
            id: item.id,
          }))
        );

        setUsersFailed(false);
        setUsersLoading(false);
        setErrorMessage("");
      },
      (error) => {
        console.error("Unable to read users:", error);

        if (!usersActive) return;

        setUsers([]);
        setUsersFailed(true);
        setUsersLoading(false);
        setErrorMessage(getErrorText(error));
      }
    );

    const unsubscribeDevices = onSnapshot(
      collection(db, "iotDevices"),
      (snapshot) => {
        if (!devicesActive) return;

        setIotDevices(
          snapshot.docs.map((item) => {
            const data = item.data();
            const { passkeyHash, ...safeData } = data;

            return {
              ...safeData,
              id: item.id,
            };
          })
        );

        setDevicesFailed(false);
        setDevicesLoading(false);
        setDeviceErrorMessage("");
      },
      (error) => {
        console.error("Unable to read IoT devices:", error);

        if (!devicesActive) return;

        setIotDevices([]);
        setDevicesFailed(true);
        setDevicesLoading(false);
        setDeviceErrorMessage(getErrorText(error));
      }
    );

    return () => {
      usersActive = false;
      devicesActive = false;
      unsubscribeUsers();
      unsubscribeDevices();
    };
  }, [authReady, authUser, isAdmin]);

  // ---------------------------------------------------------
  // LINK USERS TO DEVICES
  // ---------------------------------------------------------

  const devicesByOwner = useMemo(() => {
    const map = new Map();

    for (const device of iotDevices) {
      if (!device.connectedUserId) continue;

      const current = map.get(device.connectedUserId) ?? [];
      current.push(device);
      map.set(device.connectedUserId, current);
    }

    return map;
  }, [iotDevices]);

  const getDevicesFor = useCallback(
    (user) => {
      if (!user) return [];

      const result = new Map();

      const direct = devicesByOwner.get(user.id) ?? [];

      direct.forEach((device) => result.set(device.id, device));

      if (user.uid && user.uid !== user.id) {
        const alternate = devicesByOwner.get(user.uid) ?? [];

        alternate.forEach((device) => result.set(device.id, device));
      }

      return [...result.values()];
    },
    [devicesByOwner]
  );

  const rows = useMemo(
    () =>
      users.map((user) => ({
        user,
        devices: getDevicesFor(user),
      })),
    [users, getDevicesFor]
  );

  const stats = useMemo(() => {
    const now = new Date();

    return {
      total: rows.length,
      withDevice: rows.filter((row) => row.devices.length > 0).length,
      joinedThisMonth: rows.filter((row) => {
        const date = getRegisteredAt(row.user);

        return (
          date &&
          date.getFullYear() === now.getFullYear() &&
          date.getMonth() === now.getMonth()
        );
      }).length,
    };
  }, [rows]);

  const counts = {
    all: stats.total,
    with: stats.withDevice,
    without: stats.total - stats.withDevice,
  };

  const filteredRows = useMemo(() => {
    const search = query.trim().toLowerCase();

    return rows
      .filter(({ user, devices }) => {
        if (filter === "with" && devices.length === 0) return false;
        if (filter === "without" && devices.length > 0) return false;

        if (!search) return true;

        const fields = [
          getUserName(user),
          user.email,
          ...devices.flatMap((device) => [
            device.deviceId,
            device.id,
            device.name,
          ]),
        ];

        return fields.some(
          (field) =>
            field != null &&
            String(field).toLowerCase().includes(search)
        );
      })
      .sort((a, b) => {
        const dateA = getRegisteredAt(a.user)?.getTime() ?? 0;
        const dateB = getRegisteredAt(b.user)?.getTime() ?? 0;

        return dateB - dateA;
      });
  }, [rows, query, filter]);

  useEffect(() => {
    setPage(1);
  }, [query, filter]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredRows.length / PAGE_SIZE)
  );

  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;

  const pageRows = filteredRows.slice(
    pageStart,
    pageStart + PAGE_SIZE
  );

  const loading = !authReady || isAdmin === null || usersLoading;
  const targetDevices = getDevicesFor(target);

  // ---------------------------------------------------------
  // DELETE DIALOG
  // ---------------------------------------------------------

  const resetDialog = useCallback(() => {
    setTarget(null);
    setConfirmText("");
    setDeleteError("");
  }, []);

  const closeDialog = useCallback(() => {
    if (deleting) return;
    resetDialog();
  }, [deleting, resetDialog]);

  const openDelete = (user) => {
    if (isAdmin !== true) {
      showNotice("error", "Only verified admins can delete users.");
      return;
    }

    if (user.id === authUser?.uid) {
      showNotice("error", "You cannot delete your own account here.");
      return;
    }

    if (devicesLoading || devicesFailed) {
      showNotice(
        "error",
        "Device data must load successfully before deleting a user."
      );
      return;
    }

    setTarget(user);
    setConfirmText("");
    setDeleteError("");
  };

  useEffect(() => {
    if (!target) return undefined;

    const timer = setTimeout(() => {
      dialogInputRef.current?.focus();
    }, 0);

    const onKeyDown = (event) => {
      if (event.key === "Escape" && !deleting) {
        closeDialog();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [target, deleting, closeDialog]);

  // If another admin removes this user, close the stale dialog.
  useEffect(() => {
    if (!target || deleting || usersLoading) return;

    if (!users.some((user) => user.id === target.id)) {
      resetDialog();
      showNotice("success", "This user has already been removed.");
    }
  }, [users, target, deleting, usersLoading, resetDialog, showNotice]);

  const canConfirm =
    confirmText.trim().toUpperCase() === CONFIRM_WORD &&
    isAdmin === true &&
    target !== null &&
    target.id !== authUser?.uid &&
    !devicesLoading &&
    !devicesFailed &&
    !deleting;

  const confirmDelete = async () => {
    if (!target || deleting || !canConfirm) return;

    if (isAdmin !== true || !authUser) {
      setDeleteError("Your admin session could not be verified.");
      return;
    }

    if (target.id === authUser.uid) {
      setDeleteError("You cannot delete your own account.");
      return;
    }

    if (devicesLoading || devicesFailed) {
      setDeleteError(
        "Device data is unavailable. Refresh the page before trying again."
      );
      return;
    }

    setDeleting(true);
    setDeleteError("");

    try {
      const userId = target.id;
      const label =
        getUserName(target) ?? target.email ?? "User";

      // Re-read the profile before making destructive changes.
      const userReference = doc(db, "users", userId);
      const latestUser = await getDoc(userReference);

      if (!latestUser.exists()) {
        resetDialog();
        showNotice("success", "This user has already been removed.");
        return;
      }

      // Re-read linked devices to reduce the risk of using stale data.
      const latestDevices = await getDocs(collection(db, "iotDevices"));

      const linkedDevices = latestDevices.docs
        .map((snapshot) => ({
          id: snapshot.id,
          ...snapshot.data(),
        }))
        .filter(
          (device) =>
            device.connectedUserId === userId ||
            (target.uid &&
              target.uid !== userId &&
              device.connectedUserId === target.uid)
        );

      // Delete notification documents in batches.
      // Firestore does not automatically remove subcollections.
      const notifications = await getDocs(
        collection(db, "users", userId, "notifications")
      );

      for (
        let index = 0;
        index < notifications.docs.length;
        index += WRITE_CHUNK
      ) {
        const batch = writeBatch(db);

        notifications.docs
          .slice(index, index + WRITE_CHUNK)
          .forEach((notification) => {
            batch.delete(notification.ref);
          });

        await batch.commit();
      }

      // Update linked devices and delete the profile together.
      // Firestore batch updates are atomic within this batch.
      const batch = writeBatch(db);

      for (const device of linkedDevices) {
        batch.update(doc(db, "iotDevices", device.id), {
          status: "available",
          connectedUserId: "",
        });
      }

      batch.delete(userReference);

      await batch.commit();

      resetDialog();

      showNotice(
        "success",
        `${label} was removed from the Firestore users list.`
      );
    } catch (error) {
      console.error("User deletion failed:", error);
      setDeleteError(getErrorText(error));
    } finally {
      setDeleting(false);
    }
  };

  const targetLabel = target
    ? getUserName(target) ?? target.email ?? "this user"
    : "";

  // ---------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------

  if (authReady && !authUser) {
    return (
      <div className={`mg-shell ${isDarkMode ? "mg-dark" : "mg-light"}`}>
        <div className="dash-page">
          <section className="dash-card vau-card">
            <p className="vau-muted">Redirecting to login...</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={`mg-shell ${isDarkMode ? "mg-dark" : "mg-light"}`}>
      <div className="dash-page">
        <header className="vau-header">
          <div className="vau-left">
            <span className="vau-brand-mark">{shieldIcon}</span>
            <div className="vau-brand-meta">
              <span className="vau-brand-text">
                Moto<span className="vau-brand-accent">Guard</span>
              </span>
              <span className="vau-brand-sub">
                IoT monitoring · Admin
              </span>
            </div>
          </div>

          <div className="vau-center">
            <h1 className="vau-title">All users</h1>
            <p className="vau-sub">
              Manage registered riders and linked devices.
            </p>
          </div>

          <div className="vau-right">
            {authUser && (
              <span
                className="vau-account"
                title={authUser.email ?? authUser.displayName ?? ""}
              >
                <span className="vau-account-email">
                  {authUser.email ?? authUser.displayName ?? "Admin account"}
                </span>

                {isAdmin === true && (
                  <span className="vau-badge vau-badge-ok">Admin</span>
                )}

                {isAdmin === false && (
                  <span className="vau-badge vau-badge-warn">
                    Restricted
                  </span>
                )}
              </span>
            )}

            <button
              type="button"
              className="dash-btn dash-btn-ghost dash-btn-with-icon"
              onClick={() => navigate("/dashboard")}
            >
              {backIcon}
              Back to dashboard
            </button>
          </div>
        </header>

        {isAdmin === false && (
          <section className="dash-card vau-card">
            <div style={{ padding: 20 }}>
              <h2 className="dash-card-title">Admin access required</h2>
              <p className="vau-muted">
                This account cannot access the user management data.
                Verify its admin document and Firestore security rules.
              </p>
              {errorMessage && (
                <p className="vau-dialog-error" role="alert">
                  {errorMessage}
                </p>
              )}
            </div>
          </section>
        )}

        {isAdmin === true && (
          <>
            <section className="vau-stats" aria-label="User summary">
              <div className="vau-stat">
                <span className="vau-stat-icon vau-tone-blue">
                  {usersIcon}
                </span>
                <div>
                  <strong>
                    {loading ? "…" : usersFailed ? "—" : stats.total}
                  </strong>
                  <span>Total users</span>
                </div>
              </div>

              <div className="vau-stat">
                <span className="vau-stat-icon vau-tone-teal">
                  {chipIcon}
                </span>
                <div>
                  <strong>
                    {loading || devicesLoading
                      ? "…"
                      : usersFailed || devicesFailed
                      ? "—"
                      : stats.withDevice}
                  </strong>
                  <span>With a device</span>
                </div>
              </div>

              <div className="vau-stat">
                <span className="vau-stat-icon vau-tone-amber">
                  {calendarIcon}
                </span>
                <div>
                  <strong>
                    {loading ? "…" : usersFailed ? "—" : stats.joinedThisMonth}
                  </strong>
                  <span>Joined this month</span>
                </div>
              </div>
            </section>

            <section className="dash-card vau-card" aria-label="All users">
              <div className="dash-card-head">
                <div>
                  <h2 className="dash-card-title">
                    Registered users
                    {!loading && !usersFailed && (
                      <span
                        className="vau-live"
                        title="Listening for Firestore updates"
                      >
                        <span
                          className="vau-live-dot"
                          aria-hidden="true"
                        />
                        Live
                      </span>
                    )}
                  </h2>
                  <p className="dash-card-sub">
                    {loading
                      ? "Loading users..."
                      : usersFailed
                      ? "Unable to load user data"
                      : `${users.length} registered ${
                          users.length === 1 ? "user" : "users"
                        }`}
                  </p>
                </div>
              </div>

              {errorMessage && !usersFailed && (
                <p className="vau-dialog-error" style={{ margin: 16 }}>
                  {errorMessage}
                </p>
              )}

              {devicesFailed && (
                <p className="vau-dialog-error" style={{ margin: 16 }}>
                  Device data unavailable: {deviceErrorMessage}
                </p>
              )}

              <div className="vau-toolbar">
                <label className="vau-search">
                  {searchIcon}
                  <input
                    type="search"
                    placeholder="Search name, email or device..."
                    aria-label="Search users"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>

                <div
                  className="vau-chips"
                  role="group"
                  aria-label="Filter users"
                >
                  {FILTERS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`vau-chip ${
                        filter === item.key ? "is-active" : ""
                      }`}
                      aria-pressed={filter === item.key}
                      onClick={() => setFilter(item.key)}
                    >
                      {item.label}
                      <span className="vau-chip-count">
                        {loading || usersFailed || devicesFailed
                          ? "–"
                          : counts[item.key]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="vau-table-wrap">
                <table className="vau-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Devices</th>
                      <th>Registered</th>
                      <th className="vau-col-action">
                        <span className="vau-sr">Actions</span>
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {loading && (
                      <tr className="vau-empty-row">
                        <td colSpan={5}>Loading users...</td>
                      </tr>
                    )}

                    {!loading && usersFailed && (
                      <tr className="vau-empty-row">
                        <td colSpan={5}>
                          Users could not be loaded. {errorMessage}
                        </td>
                      </tr>
                    )}

                    {!loading &&
                      !usersFailed &&
                      filteredRows.length === 0 && (
                        <tr className="vau-empty-row">
                          <td colSpan={5}>
                            {users.length === 0
                              ? "No registered users found."
                              : "No users match your search or filter."}
                          </td>
                        </tr>
                      )}

                    {!loading &&
                      !usersFailed &&
                      pageRows.map(({ user, devices }) => {
                        const name = getUserName(user);
                        const identity =
                          name ?? user.email ?? user.id;
                        const isSelf = user.id === authUser?.uid;
                        const blocked =
                          isSelf ||
                          devicesLoading ||
                          devicesFailed;

                        const reason = isSelf
                          ? "You cannot delete your own account"
                          : devicesLoading
                          ? "Waiting for device data"
                          : devicesFailed
                          ? "Device data is unavailable"
                          : `Delete ${identity}`;

                        const shownDevices = devices.slice(0, 2);
                        const extraDevices = devices.length - shownDevices.length;

                        return (
                          <tr key={user.id}>
                            <td
                              data-label="Name"
                              className="vau-cell-name"
                            >
                              <div className="vau-user">
                                <span
                                  className={`vau-avatar vau-avatar-${avatarTone(
                                    identity
                                  )}`}
                                  aria-hidden="true"
                                >
                                  {getInitials(name ?? user.email)}
                                </span>

                                <span className="vau-user-name">
                                  {name ?? "Unnamed rider"}
                                  {isSelf && (
                                    <em className="vau-you">You</em>
                                  )}
                                </span>
                              </div>
                            </td>

                            <td
                              data-label="Email"
                              className="vau-cell-email"
                            >
                              {user.email ?? "—"}
                            </td>

                            <td data-label="Devices">
                              {devicesFailed ? (
                                <span className="vau-muted">
                                  Unavailable
                                </span>
                              ) : devices.length === 0 ? (
                                <span className="vau-muted">None linked</span>
                              ) : (
                                <div className="vau-devchips">
                                  {shownDevices.map((device) => (
                                    <span
                                      key={device.id}
                                      className={`vau-devchip ${
                                        device.isOnline === true
                                          ? "is-on"
                                          : ""
                                      }`}
                                      title={
                                        device.name
                                          ? `${device.name} · ${
                                              device.deviceId ?? device.id
                                            }`
                                          : device.deviceId ?? device.id
                                      }
                                    >
                                      <span
                                        className="vau-devchip-dot"
                                        aria-hidden="true"
                                      />
                                      {device.deviceId ?? device.id}
                                    </span>
                                  ))}

                                  {extraDevices > 0 && (
                                    <span className="vau-devchip vau-devchip-more">
                                      +{extraDevices}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>

                            <td data-label="Registered">
                              {formatDate(getRegisteredAt(user))}
                            </td>

                            <td className="vau-col-action">
                              <button
                                type="button"
                                className="vau-icon-btn vau-icon-btn-danger"
                                onClick={() => openDelete(user)}
                                disabled={blocked}
                                title={reason}
                                aria-label={reason}
                              >
                                {trashIcon}
                                <span className="vau-btn-label">
                                  Delete user
                                </span>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              {!loading &&
                !usersFailed &&
                filteredRows.length > 0 && (
                  <div className="vau-pagination">
                    <span>
                      Showing {pageStart + 1}–
                      {Math.min(
                        pageStart + PAGE_SIZE,
                        filteredRows.length
                      )}{" "}
                      of {filteredRows.length}{" "}
                      {filteredRows.length === 1 ? "user" : "users"}
                    </span>

                    <div className="vau-pagination-controls">
                      <button
                        type="button"
                        className="vau-btn"
                        onClick={() => setPage(currentPage - 1)}
                        disabled={currentPage <= 1}
                      >
                        Previous
                      </button>

                      <span className="vau-pagination-page">
                        Page {currentPage} of {totalPages}
                      </span>

                      <button
                        type="button"
                        className="vau-btn"
                        onClick={() => setPage(currentPage + 1)}
                        disabled={currentPage >= totalPages}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
            </section>
          </>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {target && (
        <>
          <button
            type="button"
            className="vau-overlay"
            aria-label="Close delete confirmation"
            onClick={closeDialog}
            disabled={deleting}
          />

          <div
            className="vau-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="vau-dialog-title"
            aria-describedby="vau-dialog-desc"
          >
            <div className="vau-dialog-head">
              <span className="vau-dialog-icon">{warnIcon}</span>
              <h2 id="vau-dialog-title" className="vau-dialog-title">
                Delete {targetLabel}?
              </h2>
            </div>

            <div className="vau-dialog-user">
              <span
                className={`vau-avatar vau-avatar-${avatarTone(
                  getUserName(target) ?? target.email ?? target.id
                )}`}
                aria-hidden="true"
              >
                {getInitials(getUserName(target) ?? target.email)}
              </span>

              <div>
                <strong>
                  {getUserName(target) ?? "Unnamed rider"}
                </strong>
                <span>{target.email ?? "No email available"}</span>
              </div>
            </div>

            <div id="vau-dialog-desc" className="vau-dialog-text">
              <p>
                This removes the user's Firestore profile and direct
                notification history. This action cannot be undone.
              </p>

              {devicesLoading && (
                <p className="vau-muted">Checking linked devices...</p>
              )}

              {!devicesLoading &&
                !devicesFailed &&
                targetDevices.length > 0 && (
                  <p>
                    <strong>
                      {targetDevices.length} linked{" "}
                      {targetDevices.length === 1 ? "device" : "devices"}
                    </strong>{" "}
                    will be set to available and unlinked.
                    <br />
                    <span className="vau-mono">
                      {targetDevices
                        .map((device) => device.deviceId ?? device.id)
                        .join(", ")}
                    </span>
                  </p>
                )}

              {!devicesLoading &&
                !devicesFailed &&
                targetDevices.length === 0 && (
                  <p className="vau-muted">
                    No devices are linked to this rider.
                  </p>
                )}

              {devicesFailed && (
                <p className="vau-warning">
                  Device data is unavailable. Deletion is disabled until
                  the device list can be checked.
                </p>
              )}

              <p className="vau-warning">
                This action does not delete the user's Firebase
                Authentication account.
              </p>
            </div>

            <label className="vau-confirm">
              <span>
                Type <strong>{CONFIRM_WORD}</strong> to confirm deletion.
              </span>

              <input
                ref={dialogInputRef}
                type="text"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canConfirm) {
                    confirmDelete();
                  }
                }}
                autoComplete="off"
                disabled={deleting}
                placeholder="Type DELETE"
              />
            </label>

            {deleteError && (
              <p className="vau-dialog-error" role="alert">
                {deleteError}
              </p>
            )}

            <div className="vau-dialog-actions">
              <button
                type="button"
                className="vau-btn"
                onClick={closeDialog}
                disabled={deleting}
              >
                Cancel
              </button>

              <button
                type="button"
                className="vau-btn vau-btn-danger"
                onClick={confirmDelete}
                disabled={!canConfirm}
              >
                {trashIcon}
                {deleting ? "Deleting..." : "Delete user"}
              </button>
            </div>
          </div>
        </>
      )}

      {notice && (
        <div
          className={`vau-toast vau-toast-${notice.type}`}
          role="status"
          aria-live="polite"
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}
