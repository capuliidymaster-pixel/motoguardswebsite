import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";

// Ise-save ang account sa Firestore "users" collection para lumabas sa admin list
export async function saveUserProfile(user) {
  if (!user) return;

  const ref = doc(db, "users", user.uid);
  const existing = await getDoc(ref);

  await setDoc(
    ref,
    {
      uid: user.uid,
      email: user.email ?? null,
      name:
        user.displayName ??
        (user.email ? user.email.split("@")[0] : null),
      // Ilalagay lang ang createdAt kapag wala pa
      ...(existing.exists() && existing.data().createdAt
        ? {}
        : {
            createdAt: user.metadata?.creationTime
              ? new Date(user.metadata.creationTime)
              : new Date(),
          }),
      lastLogin: serverTimestamp(),
    },
    { merge: true }
  );
}