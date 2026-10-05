import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { auth, db } from "./firebase";
import "./Dashboard.css";

// Rows shown per page
const PAGE_SIZE = 10;

// =========================================================
// FIELD HELPERS
// =========================================================

const toDate = (value) => {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const getRegisteredAt = (u) => toDate(u.createdAt ?? u.registeredAt);

const formatDate = (date) =>
  date
    ? date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";

const backIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

export default function ViewAllUsers({ isDarkMode: isDarkModeProp = true }) {
  const navigate = useNavigate();

  const [isDarkMode] = useState(() => {
    try {
      const saved = localStorage.getItem("isDarkMode");
      return saved === null ? isDarkModeProp : saved === "true";
    } catch {
      return isDarkModeProp;
    }
  });

  // Auth state (we wait for it before touching Firestore)
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(null); // null = not checked yet

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  // =========================================================
  // 1) WAIT FOR FIREBASE AUTH
  // =========================================================

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setAuthUser(currentUser);
      setAuthReady(true);
    });

    return unsubscribe;
  }, []);

  // =========================================================
  // 2) LOAD USERS (only after we know who is signed in)
  // =========================================================

  useEffect(() => {
    if (!authReady) return;

    if (!authUser) {
      navigate("/login", { replace: true });
      return;
    }

    let cancelled = false;

    const loadUsers = async () => {
      setLoading(true);
      setLoadFailed(false);
      setErrorMessage("");

      // Is this account listed in the "admins" collection?
      let adminExists = false;
      try {
        const adminSnap = await getDoc(doc(db, "admins", authUser.uid));
        adminExists = adminSnap.exists();
      } catch (error) {
        console.error("Admin check failed:", error);
      }
      if (cancelled) return;
      setIsAdmin(adminExists);

      try {
        const snapshot = await getDocs(collection(db, "users"));
        if (cancelled) return;

        setUsers(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      } catch (error) {
        console.error("Failed to load users:", error);
        if (cancelled) return;

        setUsers([]);
        setLoadFailed(true);

        if (error?.code === "permission-denied") {
          setErrorMessage(
            adminExists
              ? "Permission denied. Publish the latest Firestore rules and try again."
              : "This account is not an admin. Add it to the 'admins' collection."
          );
        } else {
          setErrorMessage(error?.code ?? error?.message ?? "Unknown error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadUsers();

    return () => {
      cancelled = true;
    };
  }, [authReady, authUser, navigate]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  // =========================================================
  // DERIVED DATA
  // =========================================================

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();

    return users
      .filter((u) => {
        if (!q) return true;

        return [u.name, u.email]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(q));
      })
      .sort((a, b) => {
        const da = getRegisteredAt(a)?.getTime() ?? 0;
        const dbTime = getRegisteredAt(b)?.getTime() ?? 0;
        return dbTime - da; // newest first
      });
  }, [users, query]);

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageUsers = filteredUsers.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className={`mg-shell ${isDarkMode ? "mg-dark" : "mg-light"}`}>
      <div className="dash-page">
        {/* HEADER */}
        <header className="dash-header">
          <div className="dash-brand">
            <div className="dash-brand-meta">
              <span className="dash-brand-text">
                Moto<span className="dash-brand-accent">Guard</span>
              </span>
              <span className="dash-brand-sub">Admin dashboard</span>
            </div>
          </div>

          <div className="dash-header-right">
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

        {/* TITLE */}
        <div className="dash-intro">
          <h1 className="dash-title">All users</h1>
          <p className="dash-intro-sub">Every registered rider.</p>
          {authUser && (
            <p className="dash-intro-sub">
              Signed in as <strong>{authUser.email}</strong>
              {isAdmin === true && " · Admin"}
              {isAdmin === false && " · Not an admin"}
            </p>
          )}
        </div>

        {/* USERS TABLE */}
        <section className="dash-card" aria-label="All users">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">Registered users</h2>
              <p className="dash-card-sub">
                {loading
                  ? "Loading..."
                  : `${users.length} total ${
                      users.length === 1 ? "user" : "users"
                    }`}
              </p>
            </div>

            <div className="dash-card-tools">
              <input
                type="search"
                className="dash-search"
                placeholder="Search name or email"
                aria-label="Search users"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
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
                {(loading || !authReady) && (
                  <tr className="dash-empty-row">
                    <td colSpan={3}>Loading users...</td>
                  </tr>
                )}

                {!loading && authReady && loadFailed && (
                  <tr className="dash-empty-row">
                    <td colSpan={3}>Users could not be loaded. {errorMessage}</td>
                  </tr>
                )}

                {!loading &&
                  authReady &&
                  !loadFailed &&
                  filteredUsers.length === 0 && (
                    <tr className="dash-empty-row">
                      <td colSpan={3}>
                        {query
                          ? "No users match your search."
                          : "No users have registered yet."}
                      </td>
                    </tr>
                  )}

                {!loading &&
                  authReady &&
                  !loadFailed &&
                  pageUsers.map((u) => (
                    <tr key={u.id}>
                      <td data-label="Name" className="dash-cell-strong">
                        {u.name ?? "—"}
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

          {!loading && !loadFailed && filteredUsers.length > 0 && (
            <div className="dash-pagination">
              <span className="dash-pagination-info">
                Showing {pageStart + 1}–
                {Math.min(pageStart + PAGE_SIZE, filteredUsers.length)} of{" "}
                {filteredUsers.length}
              </span>

              <div className="dash-pagination-controls">
                <button
                  type="button"
                  className="dash-btn dash-btn-ghost dash-btn-sm"
                  onClick={() => setPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                >
                  Previous
                </button>

                <span className="dash-pagination-page">
                  Page {currentPage} of {totalPages}
                </span>

                <button
                  type="button"
                  className="dash-btn dash-btn-ghost dash-btn-sm"
                  onClick={() => setPage(currentPage + 1)}
                  disabled={currentPage >= totalPages}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}