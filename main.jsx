import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";

// Global error logging
window.addEventListener("error", (event) => {
  console.error("🚨 Global Error:", event.error);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("🚨 Unhandled Promise Rejection:", event.reason);
});

// React root
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error('Missing <div id="root"></div> in index.html');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);