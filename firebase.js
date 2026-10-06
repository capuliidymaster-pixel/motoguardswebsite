import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyClhSx1mA0iwdw6DQmFd3Diz8IJwie3Lhk",
  authDomain: "seretei8.firebaseapp.com",
  databaseURL:
    "https://seretei8-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "seretei8",
  storageBucket: "seretei8.firebasestorage.app",
  messagingSenderId: "451246976546",
  appId: "1:451246976546:web:a8697b08e03fe5a0ed247b",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Firestore (users, admins, iotDevices)
export const db = getFirestore(app);

// Realtime Database (GPS data from the ESP32: gps/motorcycle_001)
export const rtdb = getDatabase(app);

export default app;