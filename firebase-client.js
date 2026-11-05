import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  get,
  getDatabase,
  onValue,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
  update
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCJmzdyMasGR3YvVHZmajm3QOh0oEAO4t0",
  authDomain: "sistem-monitoring-pkl.firebaseapp.com",
  projectId: "sistem-monitoring-pkl",
  databaseURL: "https://sistem-monitoring-pkl-default-rtdb.asia-southeast1.firebasedatabase.app",
  storageBucket: "sistem-monitoring-pkl.firebasestorage.app",
  messagingSenderId: "119759469124",
  appId: "1:119759469124:web:f4bc45b2bc2e7492ca9a11",
  measurementId: "G-TZK1KY6NHK"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const api = {
  get,
  onAuthStateChanged,
  onValue,
  push,
  ref,
  remove,
  sendPasswordResetEmail,
  serverTimestamp,
  set,
  signInWithEmailAndPassword,
  signOut,
  update
};
