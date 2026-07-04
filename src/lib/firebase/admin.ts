import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";

function getServiceAccount() {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!rawServiceAccount) {
    return null;
  }

  const decodedServiceAccount = rawServiceAccount.trim().startsWith("{")
    ? rawServiceAccount
    : Buffer.from(rawServiceAccount, "base64").toString("utf8");

  return JSON.parse(decodedServiceAccount) as Parameters<typeof cert>[0];
}

const serviceAccount = getServiceAccount();
export const firebaseAdminApp =
  getApps()[0] ??
  initializeApp({
    credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
    ...(process.env.FIREBASE_DATABASE_URL
      ? { databaseURL: process.env.FIREBASE_DATABASE_URL }
      : {}),
    projectId: process.env.FIREBASE_PROJECT_ID ?? "jobsheet-291c1"
  });

export const firebaseAdminAuth = getAuth(firebaseAdminApp);
export const firebaseAdminDb = getFirestore(firebaseAdminApp);
export const firebaseAdminRealtimeDb = getDatabase(firebaseAdminApp);
