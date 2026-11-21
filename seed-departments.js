const fs = require("node:fs");
const path = require("node:path");

async function main() {
  let admin;
  try {
    admin = require("firebase-admin");
  } catch (error) {
    throw new Error("Install dependencies with npm install before seeding departments.");
  }
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
  const departments = JSON.parse(fs.readFileSync(path.join(__dirname, "departments.json"), "utf8"));
  const db = admin.firestore();
  const batch = db.batch();
  for (const department of departments) {
    batch.set(db.collection("departments").doc(department.id), department, { merge: true });
  }
  await batch.commit();
  console.log(`Seeded ${departments.length} verified departments.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
