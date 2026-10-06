import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import "./Login.css";

/* =========================================
   ICONS
   ========================================= */

const Svg = ({ children, size = 20 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const MailIcon = () => (
  <Svg>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </Svg>
);

const LockIcon = () => (
  <Svg>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);

const EyeIcon = () => (
  <Svg>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

const EyeOffIcon = () => (
  <Svg>
    <path d="M17.94 17.94A10.5 10.5 0 0 1 12 19c-6.5 0-10-7-10-7a17.7 17.7 0 0 1 4.06-5.06M9.9 4.24A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <path d="m2 2 20 20" />
  </Svg>
);

const ShieldIcon = () => (
  <Svg size={14}>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z" />
  </Svg>
);

const BackIcon = () => (
  <Svg size={22}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

/* =========================================
   LOGIN PAGE (ADMINS ONLY)
   ========================================= */

const Login = () => {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [obscure, setObscure] = useState(true);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // Auto-hide ng message (parang SnackBar)
  useEffect(() => {
    if (!toast) return;

    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const show = (text) => setToast({ text, id: Date.now() });

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (loading) return;

    if (!email.trim() || !password) {
      show("Please fill in all fields");
      return;
    }

    setLoading(true);

    try {
      const cred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );

      // Bawal mag-login kung hindi pa verified ang email
      if (!cred.user.emailVerified) {
        await signOut(auth);
        show("Please verify your email before logging in.");
        return;
      }

      // ADMIN CHECK: kailangang may document sa "admins" collection
      // na ang Document ID ay UID ng account.
      let isAdmin = false;

      try {
        const adminSnap = await getDoc(doc(db, "admins", cred.user.uid));
        isAdmin = adminSnap.exists();
      } catch (adminError) {
        // Kung hindi ma-verify, hindi pinapapasok (fail closed)
        console.error("Admin check failed:", adminError);
        await signOut(auth);
        show("Could not verify admin access. Please try again.");
        return;
      }

      if (!isAdmin) {
        await signOut(auth);
        show("Access denied. This account is not an administrator.");
        return;
      }

      navigate("/dashboard", { replace: true });
    } catch (err) {
      let message = "An unexpected error occurred";

      switch (err.code) {
        case "auth/user-not-found":
          message = "No account found for this email.";
          break;
        case "auth/wrong-password":
        case "auth/invalid-credential":
          message = "Incorrect email or password.";
          break;
        case "auth/invalid-email":
          message = "The email address is invalid.";
          break;
        case "auth/user-disabled":
          message = "This account has been disabled.";
          break;
        case "auth/too-many-requests":
          message = "Too many attempts. Please try again later.";
          break;
        case "auth/network-request-failed":
          message = "Network error. Please check your internet connection.";
          break;
        default:
          break;
      }

      show(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">

      {/* BACKGROUND EFFECTS */}
      <div className="login-glow-top"></div>
      <div className="login-glow-bottom"></div>
      <div className="login-grid"></div>

      {/* BACK BUTTON */}
      <button
        type="button"
        className="login-back"
        onClick={() => navigate("/")}
        aria-label="Back"
      >
        <BackIcon />
      </button>

      {/* CONTENT */}
      <div className="login-content">

        <h1 className="login-title">Welcome Back</h1>

        <p className="login-subtitle">
          Secure login to your MotoGuard system
        </p>

        {/* GLASS CARD */}
        <form className="login-card" onSubmit={handleSubmit} noValidate>

          {/* EMAIL */}
          <div className="login-field">
            <span className="login-field-icon"><MailIcon /></span>
            <input
              type="email"
              placeholder="Email Address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>

          {/* PASSWORD */}
          <div className="login-field">
            <span className="login-field-icon"><LockIcon /></span>
            <input
              type={obscure ? "password" : "text"}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="login-toggle"
              onClick={() => setObscure(!obscure)}
              aria-label={obscure ? "Show password" : "Hide password"}
            >
              {obscure ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>

          {/* FORGOT PASSWORD */}
          <div className="login-forgot-row">
            <button
              type="button"
              className="login-link-button"
              onClick={() => navigate("/forgot")}
            >
              Forgot Password?
            </button>
          </div>

          {/* LOGIN BUTTON */}
          <button
            type="submit"
            className="login-button"
            disabled={loading}
          >
            {loading ? <span className="login-spinner"></span> : "LOGIN"}
          </button>

          {/* SECURE */}
          <div className="login-secure">
            <ShieldIcon />
            <span>SECURE CONNECTION ACTIVE</span>
          </div>

        </form>

      </div>

      {/* MESSAGE (SNACKBAR) */}
      {toast && (
        <div className="login-toast" key={toast.id} role="alert">
          {toast.text}
        </div>
      )}

    </div>
  );
};

export default Login;