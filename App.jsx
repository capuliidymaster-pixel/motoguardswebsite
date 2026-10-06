import React, { useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Dashboard from "./Dashboard.jsx";
import ViewAllUsers from "./ViewAllUsers.jsx";
import Map from "./Map.jsx";
import Profile from "./Profile.jsx";
import Login from "./login.jsx";
import ProtectedRoute from "./Protectedroute.jsx";

/**
 * MotoGuard App - Main router component
 * (Ang <BrowserRouter> ay nasa main.jsx, kaya walang Router dito.)
 */
function App() {
  const [isDarkMode, setIsDarkMode] = useState(true);

  const handleThemeChange = (newTheme) => {
    setIsDarkMode(newTheme);
  };

  return (
    <Routes>
      {/* Login Route - Public */}
      <Route path="/login" element={<Login />} />

      {/* Dashboard Route - Home Page (Protected) */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard
              isDarkMode={isDarkMode}
              onThemeChange={handleThemeChange}
            />
          </ProtectedRoute>
        }
      />

      {/* View All Users Route (Protected) */}
      <Route
        path="/users"
        element={
          <ProtectedRoute>
            <ViewAllUsers isDarkMode={isDarkMode} />
          </ProtectedRoute>
        }
      />

      {/* Map Route - Live Tracking (Protected) */}
      <Route
        path="/map"
        element={
          <ProtectedRoute>
            <Map isDarkMode={isDarkMode} />
          </ProtectedRoute>
        }
      />

      {/* Profile Route - User Profile (Protected) */}
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <Profile isDarkMode={isDarkMode} />
          </ProtectedRoute>
        }
      />

      {/* Default Route - deretso sa dashboard (ProtectedRoute ang magpapabalik sa /login kung hindi naka-login) */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

      {/* Catch-all - kahit anong hindi kilalang path */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;