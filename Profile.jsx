import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LayoutGrid, MapPin, User, ChevronLeft, Bike } from "lucide-react";
import "./Profile.css";

/**
 * MotoGuard Profile page
 */
export default function Profile({ isDarkMode = true }) {
  const navigate = useNavigate();
  const [currentTab, setCurrentTab] = useState(2); // Profile is index 2

  const navItems = [
    { icon: LayoutGrid, label: "Home", path: "/dashboard" },
    { icon: MapPin, label: "Map", path: "/map" },
    { icon: User, label: "Profile", path: "/profile" },
  ];

  const handleNav = (i) => {
    setCurrentTab(i);
    navigate(navItems[i].path);
  };

  const handleBack = () => {
    navigate("/dashboard");
  };

  return (
    <div className={`mg-shell ${isDarkMode ? "mg-dark" : "mg-light"}`}>
      {/* Left icon sidebar */}
      <nav className="mg-sidebar" aria-label="Primary">
        <div className="mg-sidebar-mark">
          <Bike size={32} />
        </div>

        <ul className="mg-sidebar-nav">
          {navItems.map(({ icon: Icon, label }, i) => (
            <li key={label} className="mg-sidebar-item-wrap">
              {i > 0 && <span className="mg-sidebar-divider" aria-hidden="true" />}
              <button
                type="button"
                className={`mg-sidebar-item ${
                  currentTab === i ? "is-active" : ""
                }`}
                onClick={() => handleNav(i)}
                aria-current={currentTab === i ? "page" : undefined}
                aria-label={label}
                title={label}
              >
                <Icon size={20} />
                <span className="mg-sidebar-label">{label}</span>
              </button>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className="mg-sidebar-theme"
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          {isDarkMode ? "☾" : "☀"}
        </button>
      </nav>

      {/* Main content */}
      <div className="mg-main">
        <div className="mg-glow mg-glow-signal" />
        <div className="mg-scroll">
          {/* Header with back button */}
          <header className="mg-header">
            <button
              type="button"
              className="mg-back-btn"
              onClick={handleBack}
              aria-label="Back to dashboard"
            >
              <ChevronLeft size={22} />
            </button>
            <div className="mg-brand">
              <span className="mg-brand-text">
                MY <span className="mg-brand-accent">PROFILE</span>
              </span>
            </div>
          </header>

          {/* Profile content */}
          <section className="mg-profile-container" aria-label="User profile">
            <div className="mg-profile-card">
              <div className="mg-profile-avatar">
                <User size={64} />
              </div>
              <h1 className="mg-profile-name">Alex Rodriguez</h1>
              <p className="mg-profile-role">Rider</p>

              <div className="mg-profile-divider" />

              <div className="mg-profile-section">
                <h2 className="mg-profile-section-title">Account Info</h2>
                <div className="mg-profile-info-item">
                  <span className="mg-profile-label">Email</span>
                  <span className="mg-profile-value">alex@example.com</span>
                </div>
                <div className="mg-profile-info-item">
                  <span className="mg-profile-label">Phone</span>
                  <span className="mg-profile-value">+63 912 345 6789</span>
                </div>
                <div className="mg-profile-info-item">
                  <span className="mg-profile-label">Location</span>
                  <span className="mg-profile-value">Philippines</span>
                </div>
              </div>

              <div className="mg-profile-divider" />

              <div className="mg-profile-section">
                <h2 className="mg-profile-section-title">Motorcycle</h2>
                <div className="mg-profile-info-item">
                  <span className="mg-profile-label">Name</span>
                  <span className="mg-profile-value">Honda XRM 125</span>
                </div>
                <div className="mg-profile-info-item">
                  <span className="mg-profile-label">Year</span>
                  <span className="mg-profile-value">2023</span>
                </div>
                <div className="mg-profile-info-item">
                  <span className="mg-profile-label">Plate Number</span>
                  <span className="mg-profile-value">ABC 1234</span>
                </div>
              </div>

              <div className="mg-profile-divider" />

              <button className="mg-profile-btn">Edit Profile</button>
              <button className="mg-profile-btn mg-profile-btn-danger">
                Logout
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}