import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

/**
 * Hinaharang ang page kung:
 * 1. hindi naka-login sa Firebase
 * 2. hindi pa verified ang email
 * 3. wala sa "admins" collection ang UID ng account
 *
 * NOTE: may console.log para sa debugging. Tanggalin pagkatapos.
 */
function ProtectedRoute({ children }) {
  const location = useLocation();
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);

  console.log("[Guard] ProtectedRoute rendered at:", location.pathname);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      console.log("[Guard] user:", currentUser?.email, "uid:", currentUser?.uid);

      if (!currentUser || !currentUser.emailVerified) {
        console.log("[Guard] DENIED: no user or email not verified");
        setAllowed(false);
        setChecking(false);
        return;
      }

      try {
        const adminSnap = await getDoc(doc(db, "admins", currentUser.uid));
        console.log("[Guard] admin doc exists?", adminSnap.exists());

        if (adminSnap.exists()) {
          setAllowed(true);
        } else {
          await signOut(auth);
          setAllowed(false);
        }
      } catch (error) {
        // Fail closed: kung hindi ma-verify, hindi pinapapasok
        console.error("[Guard] Admin check failed:", error);
        await signOut(auth);
        setAllowed(false);
      }

      setChecking(false);
    });

    return unsubscribe;
  }, []);

  // Habang chine-check pa, loading screen (para hindi mag-flash ang /login)
  if (checking) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#05170c",
          color: "#00e676",
          fontFamily: "Inter, Arial, sans-serif",
          letterSpacing: "2px",
        }}
      >
        LOADING...
      </div>
    );
  }

  if (!allowed) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}

export default ProtectedRoute;