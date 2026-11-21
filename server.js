const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let admin;
let db;
try {
  admin = require("firebase-admin");
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  }
  db = admin.firestore();
} catch (error) {
  console.warn(`Firebase Admin is not initialized: ${error.message}`);
}

const departments = JSON.parse(fs.readFileSync(path.join(ROOT, "departments.json"), "utf8"));

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function sendFile(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${requested}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) return sendJson(response, 403, { error: "Forbidden" });
  fs.readFile(filePath, (error, content) => {
    if (error) return sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: error.code === "ENOENT" ? "Not found" : "Unable to read file" });
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://www.gstatic.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://firebasestorage.googleapis.com https://*.tile.openstreetmap.org https://unpkg.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.googleapis.com https://nominatim.openstreetmap.org",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), geolocation=()",
    });
    response.end(content);
  });
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 40 * 1024 * 1024) throw Object.assign(new Error("Request body is too large"), { status: 413 });
  }
  return body ? JSON.parse(body) : {};
}

function requireFirebase(response) {
  if (!admin || !db) {
    sendJson(response, 503, { error: "Firebase is not configured on this server." });
    return false;
  }
  return true;
}

async function verifyFirebaseToken(request, response) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) {
    sendJson(response, 401, { error: "Authentication required." });
    return null;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.role && ["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD", "SUPER_ADMIN"].includes(decoded.role) && decoded.authorityStatus !== "VERIFIED") {
      sendJson(response, 403, { error: "Authority access requires verification." });
      return null;
    }
    return decoded;
  } catch (error) {
    sendJson(response, 401, { error: "Your session is invalid or expired." });
    return null;
  }
}

async function getProfile(uid) {
  const snapshot = await db.collection("users").doc(uid).get();
  if (!snapshot.exists) return null;
  return { uid, ...snapshot.data() };
}

function isAuthorityVerified(profile) {
  return ["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD", "SUPER_ADMIN"].includes(profile?.role) &&
    profile?.authorityStatus === "VERIFIED";
}

async function appendAuthorityAudit(actor, action, targetUid, details, metadata = {}) {
  await db.collection("authorityAudit").add({
    actorUid: actor.uid,
    actorName: actor.displayName || actor.email,
    actorRole: actor.role,
    action,
    targetUid: targetUid || null,
    details: cleanText(details, 1200),
    metadata,
    timestamp: new Date().toISOString(),
  });
}

function jurisdictionMatches(department, analysis) {
  const equal = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  if (department.governanceLevel !== analysis.governanceLevel) return false;
  if (department.state && analysis.state && !equal(department.state, analysis.state)) return false;
  if (analysis.governanceLevel === "NATIONAL") return true;
  if (department.district && analysis.district && !equal(department.district, analysis.district)) return false;
  if (department.localBody && analysis.localBody && !equal(department.localBody, analysis.localBody)) return false;
  return true;
}

function findDepartmentMatches(analysis) {
  const names = [analysis.departmentName, ...(analysis.additionalDepartments || [])].filter(Boolean);
  return names.map((name) => departments.find((department) =>
    department.name.toLowerCase() === String(name).trim().toLowerCase() &&
    jurisdictionMatches(department, analysis)
  )).filter(Boolean);
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

async function handleAuth(request, response, mode) {
  if (!requireFirebase(response)) return;
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message });
    return;
  }
  const email = cleanText(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || password.length < 8) {
    sendJson(response, 400, { error: "A valid email and password of at least 8 characters are required." });
    return;
  }
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) {
    sendJson(response, 503, { error: "Firebase web authentication is not configured." });
    return;
  }
  const operation = mode === "register" ? "accounts:signUp" : "accounts:signInWithPassword";
  const result = await fetch(`https://identitytoolkit.googleapis.com/v1/${operation}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    sendJson(response, 401, { error: "Email or password is invalid." });
    return;
  }
  if (mode === "register") {
    await db.collection("users").doc(data.localId).set({
      email,
      role: "CITIZEN",
      departmentId: null,
      jurisdiction: { state: null, district: null, localBody: null },
      authorityStatus: "NOT_APPLICABLE",
      authorityRequestedAt: null,
      displayName: cleanText(body.displayName, 100) || email.split("@")[0],
      createdAt: new Date().toISOString(),
    }, { merge: true });
  }
  const profile = await getProfile(data.localId);
  sendJson(response, 200, { idToken: data.idToken, refreshToken: data.refreshToken, expiresIn: data.expiresIn, profile });
}

async function handleAuthorityApplication(request, response, profile) {
  if (!requireFirebase(response)) return;
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const departmentId = cleanText(body.departmentId, 100);
  const requestedRole = cleanText(body.requestedRole, 40).toUpperCase();
  const employeeId = cleanText(body.employeeId, 100);
  const designation = cleanText(body.designation, 160);
  const verificationNote = cleanText(body.verificationNote, 500);
  const department = departments.find((item) => item.id === departmentId);
  if (!department) return sendJson(response, 400, { error: "Select a verified department." });
  if (!["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD"].includes(requestedRole)) return sendJson(response, 400, { error: "Invalid authority role." });
  if (!employeeId || !designation) return sendJson(response, 400, { error: "Employee ID and designation are required." });
  if (profile.role !== "CITIZEN") return sendJson(response, 403, { error: "This account is not eligible for authority application." });
  if (profile.authorityStatus === "PENDING") return sendJson(response, 409, { error: "An authority application is already awaiting review." });
  const now = new Date().toISOString();
  await db.collection("users").doc(profile.uid).set({
    authorityStatus: "PENDING",
    authorityApplication: {
      requestedRole,
      departmentId,
      departmentName: department.name,
      jurisdiction: {
        governanceLevel: department.governanceLevel,
        state: department.state,
        district: department.district,
        localBody: department.localBody,
      },
      employeeId,
      designation,
      verificationNote,
      submittedAt: now,
    },
    authorityRequestedAt: now,
  }, { merge: true });
  await appendAuthorityAudit(profile, "AUTHORITY_APPLICATION_SUBMITTED", profile.uid, `Requested ${requestedRole} verification for ${department.name}.`, { departmentId, employeeId });
  sendJson(response, 201, { authorityStatus: "PENDING" });
}

async function classifyWithGemini(report) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("Gemini is not configured on this server."), { status: 503 });
  const registryNames = departments.map((department) => department.name).join(", ");
  const prompt = [
    "Analyze this citizen infrastructure complaint.",
    "Use the title, description, location and uploaded image if present.",
    report.coordinates ? `Selected map coordinates: ${Number(report.coordinates.latitude).toFixed(6)}, ${Number(report.coordinates.longitude).toFixed(6)}.` : "",
    "Return only valid JSON. Do not invent a department or jurisdiction.",
    "Governance level must be NATIONAL, STATE or LOCAL.",
    `Verified department names: ${registryNames}.`,
    "For every additional department, use an exact verified department name.",
    `Title: ${cleanText(report.title, 90)}`,
    `Description: ${cleanText(report.description, 1200)}`,
    `Location: ${cleanText(report.location, 120)}`,
  ].join("\n");

  const parts = [{ text: prompt }];
  if (report.image && /^data:image\/(jpeg|png|webp);base64,/i.test(report.image)) {
    const match = report.image.match(/^data:(image\/[^;]+);base64,(.+)$/s);
    parts.push({ inlineData: { mimeType: match[1], data: match[2].slice(0, 7 * 1024 * 1024) } });
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const geminiResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING" },
            governanceLevel: { type: "STRING", enum: ["NATIONAL", "STATE", "LOCAL"] },
            departmentName: { type: "STRING" },
            state: { type: "STRING" },
            district: { type: "STRING" },
            localBody: { type: "STRING" },
            priority: { type: "STRING", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
            publicImpact: { type: "STRING" },
            recommendedAction: { type: "STRING" },
            reason: { type: "STRING" },
            confidence: { type: "NUMBER" },
            requiresManualReview: { type: "BOOLEAN" },
            additionalDepartments: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["category", "governanceLevel", "departmentName", "state", "district", "localBody", "priority", "publicImpact", "recommendedAction", "reason", "confidence", "requiresManualReview", "additionalDepartments"],
        },
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!geminiResponse.ok) throw Object.assign(new Error("Gemini could not analyze the complaint."), { status: 502 });
  const result = await geminiResponse.json();
  const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Gemini returned an invalid classification."), { status: 502 });
  }
}

function validateAnalysis(analysis) {
  const validGovernance = ["NATIONAL", "STATE", "LOCAL"].includes(analysis.governanceLevel);
  const validPriority = ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(analysis.priority);
  const confidence = Number(analysis.confidence);
  const textFields = ["category", "departmentName", "state", "district", "localBody", "publicImpact", "recommendedAction", "reason"].every((field) => typeof analysis[field] === "string");
  if (!validGovernance || !validPriority || !textFields || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !Array.isArray(analysis.additionalDepartments)) {
    throw Object.assign(new Error("Gemini returned an unsupported classification."), { status: 502 });
  }
  analysis.confidence = confidence;
  analysis.additionalDepartments = analysis.additionalDepartments.filter((name) => typeof name === "string").slice(0, 4);
  return analysis;
}

function canReadComplaint(profile, complaint) {
  if (profile.role === "SUPER_ADMIN") return isAuthorityVerified(profile);
  if (profile.role === "CITIZEN") return complaint.citizenUid === profile.uid;
  if (["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD"].includes(profile.role)) {
    if (!isAuthorityVerified(profile)) return false;
    const departmentIds = complaint.departmentIds || (complaint.assignments || []).map((assignment) => assignment.departmentId);
    return (complaint.assignments || []).some((assignment) =>
      departmentIds.includes(profile.departmentId) &&
      assignment.departmentId === profile.departmentId &&
      String(assignment.state || "").toLowerCase() === String(profile.jurisdiction?.state || "").toLowerCase() &&
      (!profile.jurisdiction?.district || String(assignment.district || "").toLowerCase() === String(profile.jurisdiction.district).toLowerCase()) &&
      (!profile.jurisdiction?.localBody || String(assignment.localBody || "").toLowerCase() === String(profile.jurisdiction.localBody).toLowerCase())
    );
  }
  return false;
}

async function appendActivity(dbComplaintRef, uid, displayName, action, details) {
  await dbComplaintRef.collection("activity").add({
    uid,
    displayName,
    action,
    details,
    timestamp: new Date().toISOString(),
  });
}

async function createNotification({ recipientUid, recipientRole, recipientDepartmentId, type, title, message, complaintId, priority = "NORMAL", governanceLevel = null, eventKey = null, deliveryChannel = "IN_APP" }) {
  if (!recipientUid || !db) return;
  const userSnapshot = await db.collection("users").doc(recipientUid).get();
  const userProfile = userSnapshot.exists ? userSnapshot.data() : {};
  const preferences = userProfile.notificationPreferences || {};
  const preferenceEnabled = (category) => preferences[category] !== false;
  const categoryEnabled = {
    COMPLAINT_SUBMITTED: "statusUpdates",
    AI_ANALYSED: "statusUpdates",
    COMPLAINT_ASSIGNED: "assignmentUpdates",
    COMPLAINT_STATUS_UPDATED: "statusUpdates",
    TASK_ASSIGNED: "assignmentUpdates",
    PROGRESS_UPDATED: "progressUpdates",
    EVIDENCE_UPLOADED: "progressUpdates",
    DEADLINE_APPROACHING: "deadlineReminders",
    DEADLINE_UPDATED: "deadlineReminders",
    COMPLAINT_DELAYED: "escalationAlerts",
    COMPLAINT_ESCALATED: "escalationAlerts",
    COMPLAINT_ESCALATED_SUPER_ADMIN: "escalationAlerts",
  }[type];
  if (categoryEnabled && !preferenceEnabled(categoryEnabled) && priority !== "URGENT") return;
  const now = new Date().toISOString();
  const dedupeKey = eventKey || `${type}:${complaintId || "platform"}:${recipientUid}`;
  const notificationId = crypto.createHash("sha256").update(dedupeKey).digest("hex");
  const ref = db.collection("notifications").doc(notificationId);
  const existing = await ref.get();
  if (existing.exists) return existing.id;
  await ref.set({
    notificationId,
    recipientUid,
    recipientRole: recipientRole || null,
    recipientDepartmentId: recipientDepartmentId || null,
    type,
    title,
    message,
    complaintId: complaintId || null,
    priority,
    governanceLevel,
    read: false,
    readAt: null,
    deliveryStatus: "DELIVERED",
    deliveryChannel,
    eventKey: dedupeKey,
    createdAt: now,
  });
  return notificationId;
}

function deadlineHours(priority) {
  const defaults = { CRITICAL: 24, HIGH: 72, MEDIUM: 168, LOW: 336 };
  const fromEnv = {
    CRITICAL: Number(process.env.CRITICAL_DEADLINE_HOURS),
    HIGH: Number(process.env.HIGH_DEADLINE_HOURS),
    MEDIUM: Number(process.env.MEDIUM_DEADLINE_HOURS),
    LOW: Number(process.env.LOW_DEADLINE_HOURS),
  };
  const hours = fromEnv[priority] > 0 ? fromEnv[priority] : defaults[priority] || defaults.MEDIUM;
  return hours;
}

async function notifyComplaintAssignment(complaint, actorUid, actorName) {
  const departmentIds = (complaint.assignments || []).map((assignment) => assignment.departmentId).filter(Boolean);
  if (departmentIds.length === 0) return;
  const usersSnapshot = await db.collection("users").get();
  const recipients = [];
  usersSnapshot.forEach((doc) => {
    const profile = doc.data();
    if (departmentIds.includes(profile.departmentId) &&
      ["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD"].includes(profile.role)) recipients.push({ uid: doc.id, profile });
  });
  await Promise.all(recipients.map((recipient) => createNotification({
    recipientUid: recipient.uid,
    recipientRole: recipient.profile.role,
    recipientDepartmentId: recipient.profile.departmentId,
    type: "COMPLAINT_ASSIGNED",
    priority: complaint.priority === "CRITICAL" ? "URGENT" : complaint.priority === "HIGH" ? "IMPORTANT" : "NORMAL",
    governanceLevel: complaint.governanceLevel,
    eventKey: `COMPLAINT_ASSIGNED:${complaint.complaintId}:${recipient.uid}`,
    title: "New complaint assigned",
    message: `${complaint.title} was assigned to ${recipient.profile.departmentId}.`,
    complaintId: complaint.complaintId,
  })));
  await createNotification({
    recipientUid: complaint.citizenUid,
    recipientRole: "CITIZEN",
    type: "COMPLAINT_ASSIGNED",
    priority: complaint.priority === "CRITICAL" ? "URGENT" : "IMPORTANT",
    governanceLevel: complaint.governanceLevel,
    eventKey: `COMPLAINT_ASSIGNED:${complaint.complaintId}:${complaint.citizenUid}`,
    title: "Complaint assigned",
    message: `Your complaint "${complaint.title}" has been assigned to a responsible department.`,
    complaintId: complaint.complaintId,
  });
}

async function handleCreateComplaint(request, response, profile) {
  if (!requireFirebase(response)) return;
  const idempotencyKey = cleanText(request.headers["x-idempotency-key"], 128);
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message });
    return;
  }
  const title = cleanText(body.title, 90);
  const description = cleanText(body.description, 1200);
  const location = cleanText(body.location, 120);
  if (!title || !description || !location) return sendJson(response, 400, { error: "Title, description and location are required." });
  if (idempotencyKey) {
    const existingSnapshot = await db.collection("complaints").where("submissionKey", "==", idempotencyKey).limit(1).get();
    if (!existingSnapshot.empty) {
      const existing = existingSnapshot.docs[0].data();
      if (existing.citizenUid === profile.uid) {
        sendJson(response, 200, existing);
        return;
      }
    }
  }
  let coordinates = null;
  if (body.coordinates && Number.isFinite(body.coordinates.latitude) && Number.isFinite(body.coordinates.longitude)) {
    const latitude = Number(body.coordinates.latitude);
    const longitude = Number(body.coordinates.longitude);
    if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      coordinates = { latitude, longitude, accuracyMeters: Number.isFinite(body.coordinates.accuracyMeters) ? Math.min(Math.max(body.coordinates.accuracyMeters, 0), 100000) : null };
    }
  }
  const image = typeof body.image === "string" && body.image.length <= 9 * 1024 * 1024 ? body.image : "";
  let analysis;
  try {
    analysis = validateAnalysis(await classifyWithGemini({ title, description, location, coordinates, image }));
  } catch (error) {
    const manual = {
      category: "Unclassified",
      governanceLevel: "LOCAL",
      departmentName: "",
      state: "",
      district: "",
      localBody: "",
      priority: "MEDIUM",
      publicImpact: "Requires manual assessment",
      recommendedAction: "Have a Super Admin verify and assign this complaint",
      reason: "Automatic analysis was unavailable",
      confidence: 0,
      requiresManualReview: true,
      additionalDepartments: [],
    };
    analysis = manual;
  }
  const matches = findDepartmentMatches(analysis);
  const requiresReview = analysis.requiresManualReview || analysis.confidence < 0.7 || matches.length === 0;
  const complaintId = crypto.randomUUID();
  const now = new Date().toISOString();
  const hoursUntilDeadline = deadlineHours(analysis.priority);
  const deadlineAt = new Date(Date.now() + hoursUntilDeadline * 60 * 60 * 1000).toISOString();
  const duplicateSuggestions = await detectDuplicateComplaints({
    complaintId,
    title,
    description,
    category: analysis.category,
    location,
    coordinates,
  }).catch(() => []);
  const assignments = matches.map((department) => ({
    departmentId: department.id,
    departmentName: department.name,
    governanceLevel: department.governanceLevel,
    state: department.state,
    district: department.district,
    localBody: department.localBody,
  }));
  const departmentIds = assignments.map((assignment) => assignment.departmentId);
  const complaint = {
    complaintId,
    citizenUid: profile.uid,
    citizenName: profile.displayName || profile.email,
    title,
    description,
    location,
    coordinates,
    image,
    evidence: {
      before: image ? [{ photo: image, uploadedBy: profile.uid, uploadedByName: profile.displayName || profile.email, uploadedAt: now }] : [],
      during: [],
      after: [],
    },
    aiAnalysis: analysis,
    category: analysis.category,
    governanceLevel: analysis.governanceLevel,
    priority: analysis.priority,
    assignments,
    departmentIds,
    duplicateSuggestions,
    submissionKey: idempotencyKey || null,
    supporterUids: [],
    supportCount: 0,
    deadlineAt,
    deadlineExtendedAt: null,
    deadlineExtendedReason: null,
    deadlineExtendedBy: null,
    escalationHistory: [],
    reminderSentAt: null,
    status: requiresReview ? "Awaiting Admin Verification" : "Assigned",
    resolution: null,
    createdAt: now,
    updatedAt: now,
  };
  const ref = db.collection("complaints").doc(complaintId);
  await ref.set(complaint);
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "REPORTED", "Citizen submitted the complaint");
  await appendActivity(ref, "SYSTEM", "CivicResolve AI", "AI_ANALYSED", `Confidence ${Math.round(analysis.confidence * 100)}%; ${requiresReview ? "manual verification required" : "assigned by verified registry"}`);
  if (requiresReview) {
    const adminsSnapshot = await db.collection("users").where("role", "==", "SUPER_ADMIN").get();
    const adminNotifications = [];
    adminsSnapshot.forEach((adminDoc) => adminNotifications.push(adminDoc.id));
    await Promise.all(adminNotifications.map((recipientUid) => createNotification({
      recipientUid,
      recipientRole: "SUPER_ADMIN",
      type: "MANUAL_CLASSIFICATION_REQUIRED",
      title: "Complaint requires manual review",
      message: `Complaint "${title}" could not be assigned with sufficient verified confidence.`,
      complaintId,
      priority: "IMPORTANT",
      governanceLevel: analysis.governanceLevel,
      eventKey: `MANUAL_REVIEW:${complaintId}:${recipientUid}`,
    })));
  }
  if (analysis.priority === "CRITICAL") {
    const adminsSnapshot = await db.collection("users").where("role", "==", "SUPER_ADMIN").get();
    const adminNotifications = [];
    adminsSnapshot.forEach((adminDoc) => adminNotifications.push(adminDoc.id));
    await Promise.all(adminNotifications.map((recipientUid) => createNotification({
      recipientUid,
      recipientRole: "SUPER_ADMIN",
      type: "CRITICAL_COMPLAINT_RECEIVED",
      title: "Critical complaint received",
      message: `Critical complaint "${title}" requires immediate attention.`,
      complaintId,
      priority: "URGENT",
      governanceLevel: analysis.governanceLevel,
      eventKey: `CRITICAL:${complaintId}:${recipientUid}`,
    })));
  }
  await createNotification({
    recipientUid: profile.uid,
    recipientRole: "CITIZEN",
    type: "COMPLAINT_SUBMITTED",
    priority: "NORMAL",
    governanceLevel: analysis.governanceLevel,
    eventKey: `COMPLAINT_SUBMITTED:${complaintId}:${profile.uid}`,
    title: "Complaint submitted",
    message: `Your complaint "${title}" was received and assigned ID ${complaintId}.`,
    complaintId,
  });
  if (!requiresReview) await notifyComplaintAssignment(complaint, profile.uid, profile.displayName || profile.email);
  sendJson(response, 201, complaint);
}

async function handleAnalyzeComplaint(request, response) {
  if (!requireFirebase(response)) return;
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message });
    return;
  }
  const title = cleanText(body.title, 90);
  const description = cleanText(body.description, 1200);
  const location = cleanText(body.location, 120);
  if (!title || !description || !location) return sendJson(response, 400, { error: "Title, description and location are required." });
  const image = typeof body.image === "string" && body.image.length <= 9 * 1024 * 1024 ? body.image : "";
  let analysis;
  try {
    analysis = validateAnalysis(await classifyWithGemini({ title, description, location, coordinates: body.coordinates || null, image }));
  } catch (error) {
    analysis = {
      category: "Unclassified",
      governanceLevel: "LOCAL",
      departmentName: "",
      state: "",
      district: "",
      localBody: "",
      priority: "MEDIUM",
      publicImpact: "Requires manual assessment",
      recommendedAction: "Have a Super Admin verify and assign this complaint",
      reason: "Automatic analysis was unavailable",
      confidence: 0,
      requiresManualReview: true,
      additionalDepartments: [],
    };
  }
  const matches = findDepartmentMatches(analysis);
  sendJson(response, 200, {
    analysis,
    assignments: matches.map((department) => ({
      departmentId: department.id,
      departmentName: department.name,
      governanceLevel: department.governanceLevel,
      state: department.state,
      district: department.district,
      localBody: department.localBody,
    })),
    requiresManualReview: analysis.requiresManualReview || analysis.confidence < 0.7 || matches.length === 0,
  });
}

async function detectDuplicateComplaints(report) {
  const radiusMeters = Number(process.env.DUPLICATE_RADIUS_METERS) > 0 ? Number(process.env.DUPLICATE_RADIUS_METERS) : 500;
  const snapshot = await db.collection("complaints").limit(250).get();
  const candidates = [];
  const reportCoordinates = report.coordinates &&
    Number.isFinite(Number(report.coordinates.latitude)) &&
    Number.isFinite(Number(report.coordinates.longitude))
    ? { latitude: Number(report.coordinates.latitude), longitude: Number(report.coordinates.longitude) }
    : null;
  const distanceMeters = (a, b) => {
    const radians = (value) => value * Math.PI / 180;
    const earthRadius = 6371000;
    const latitudeDelta = radians(b.latitude - a.latitude);
    const longitudeDelta = radians(b.longitude - a.longitude);
    const latitudeA = radians(a.latitude);
    const latitudeB = radians(b.latitude);
    const haversine = Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  };
  const normalizeText = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const similarity = (left, right) => {
    const leftWords = new Set(normalizeText(left).split(" ").filter((word) => word.length > 2));
    const rightWords = new Set(normalizeText(right).split(" ").filter((word) => word.length > 2));
    if (!leftWords.size || !rightWords.size) return 0;
    let overlap = 0;
    leftWords.forEach((word) => { if (rightWords.has(word)) overlap++; });
    return overlap / new Set([...leftWords, ...rightWords]).size;
  };
  snapshot.forEach((doc) => {
    const complaint = doc.data();
    if (complaint.complaintId === report.complaintId) return;
    if (complaint.isMerged || complaint.mergedIntoComplaintId) return;
    const existingCoordinates = complaint.coordinates &&
      Number.isFinite(Number(complaint.coordinates.latitude)) &&
      Number.isFinite(Number(complaint.coordinates.longitude))
      ? { latitude: Number(complaint.coordinates.latitude), longitude: Number(complaint.coordinates.longitude) }
      : null;
    const distance = reportCoordinates && existingCoordinates
      ? distanceMeters(reportCoordinates, existingCoordinates)
      : null;
    if (reportCoordinates && existingCoordinates && distance > radiusMeters) return;
    if (!existingCoordinates && normalizeText(complaint.location) !== normalizeText(report.location) &&
      !normalizeText(complaint.location).includes(normalizeText(report.location).slice(0, 18))) return;
    const textSimilarity = Math.max(
      similarity(`${report.title} ${report.description}`, `${complaint.title} ${complaint.description}`),
      similarity(report.description, complaint.description)
    );
    candidates.push({
      complaintId: complaint.complaintId,
      title: cleanText(complaint.title, 90),
      description: cleanText(complaint.description, 1200),
      category: complaint.category,
      location: complaint.location,
      status: complaint.status,
      governanceLevel: complaint.governanceLevel,
      coordinates: existingCoordinates,
      distanceMeters: distance === null ? null : Math.round(distance),
      textSimilarity: Math.round(textSimilarity * 100) / 100,
    });
  });
  if (candidates.length === 0) return [];
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return candidates
      .filter((candidate) => {
        const categoryMatch = !candidate.category || !report.category ||
          normalizeText(candidate.category) === normalizeText(report.category);
        const likelyDuplicate = candidate.textSimilarity >= 0.38 && categoryMatch;
        const closeBy = candidate.distanceMeters === null || candidate.distanceMeters <= radiusMeters;
        return likelyDuplicate && closeBy;
      })
      .sort((left, right) => (right.textSimilarity - left.textSimilarity))
      .slice(0, 5)
      .map((candidate) => ({
        ...candidate,
        similarityScore: candidate.textSimilarity,
        reason: "Local text and location similarity; Gemini verification unavailable.",
        verificationMode: "LOCAL_FALLBACK",
      }));
  }
  const prompt = [
    "Compare the new civic complaint with nearby existing complaints.",
    "Only return matches that describe the same civic problem within the supplied area.",
    "Use the category, title, description, location text and coordinate distance.",
    "A high confidence match requires both geographic proximity and semantic problem similarity.",
    "Use only complaintId values supplied below; never invent a complaint.",
    "Return JSON with a bestMatches array of objects: complaintId, similarityScore (0-1), reason.",
    "If uncertain, return an empty bestMatches array.",
    `New complaint: ${JSON.stringify({ title: report.title, description: report.description, category: report.category, location: report.location, coordinates: reportCoordinates })}`,
    `Existing complaints: ${JSON.stringify(candidates)}`,
  ].join("\n");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const geminiResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.05,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            bestMatches: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  complaintId: { type: "STRING" },
                  similarityScore: { type: "NUMBER" },
                  reason: { type: "STRING" },
                },
                required: ["complaintId", "similarityScore", "reason"],
              },
            },
          },
          required: ["bestMatches"],
        },
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!geminiResponse.ok) return [];
  const result = await geminiResponse.json();
  const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const ids = new Set(candidates.map((candidate) => candidate.complaintId));
  return (parsed.bestMatches || []).filter((match) =>
    ids.has(match.complaintId) &&
    Number.isFinite(match.similarityScore) &&
    match.similarityScore >= 0.7
  ).slice(0, 5).map((match) => {
    const candidate = candidates.find((item) => item.complaintId === match.complaintId);
    return {
      ...candidate,
      similarityScore: match.similarityScore,
      reason: cleanText(match.reason, 300),
      verificationMode: "GEMINI",
    };
  });
}

async function handleDuplicateCheck(request, response, profile) {
  if (!requireFirebase(response)) return;
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, error.status || 400, { error: error.message }); }
  const report = {
    title: cleanText(body.title, 90),
    description: cleanText(body.description, 1200),
    category: cleanText(body.category, 100),
    location: cleanText(body.location, 120),
    coordinates: body.coordinates &&
      Number.isFinite(Number(body.coordinates.latitude)) &&
      Number.isFinite(Number(body.coordinates.longitude))
      ? { latitude: Number(body.coordinates.latitude), longitude: Number(body.coordinates.longitude) }
      : null,
  };
  if (!report.title || !report.description || !report.location) return sendJson(response, 400, { error: "Title, description and location are required." });
  const matches = await detectDuplicateComplaints(report);
  if (matches.length > 0) {
    const adminsSnapshot = await db.collection("users").where("role", "==", "SUPER_ADMIN").get();
    const recipients = [];
    adminsSnapshot.forEach((adminDoc) => recipients.push(adminDoc.id));
    await Promise.all(recipients.map((recipientUid) => createNotification({
      recipientUid,
      recipientRole: "SUPER_ADMIN",
      type: "DUPLICATE_REVIEW_REQUIRED",
      title: "Suspected duplicate complaint",
      message: `A possible duplicate has been identified near ${report.location}.`,
      priority: "IMPORTANT",
      governanceLevel: null,
      eventKey: `DUPLICATE_REVIEW:${report.title}:${report.location}:${recipientUid}`,
    })));
  }
  sendJson(response, 200, {
    possibleDuplicates: matches,
  });
}

async function handleSupportComplaint(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  const ref = db.collection("complaints").doc(complaintId);
  try {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw Object.assign(new Error("Complaint not found."), { status: 404 });
      const complaint = snapshot.data();
      if (complaint.isMerged || complaint.mergedIntoComplaintId) throw Object.assign(new Error("This complaint has already been merged and cannot receive support."), { status: 409 });
      const supporters = Array.isArray(complaint.supporterUids) ? complaint.supporterUids : [];
      if (supporters.includes(profile.uid)) throw Object.assign(new Error("You already support this complaint."), { status: 409 });
      if (complaint.citizenUid === profile.uid) throw Object.assign(new Error("You cannot support your own complaint."), { status: 400 });
      supporters.push(profile.uid);
      transaction.update(ref, {
        supporterUids: supporters,
        supportCount: supporters.length,
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (error) {
    sendJson(response, error.status || 409, { error: error.message || "Unable to record support." });
    return;
  }
  const snapshot = await ref.get();
  const complaint = snapshot.data();
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "COMPLAINT_SUPPORTED", "Citizen supported an existing complaint");
  sendJson(response, 200, {
    complaintId,
    supportCount: complaint.supportCount || 0,
    coordinates: complaint.coordinates || null,
  });
}

async function handleMergeComplaints(request, response, profile, canonicalId) {
  if (!requireFirebase(response)) return;
  if (profile.role !== "SUPER_ADMIN" || !isAuthorityVerified(profile)) return sendJson(response, 403, { error: "Only a verified Super Admin can merge duplicate complaints." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const duplicateIds = Array.isArray(body.duplicateComplaintIds) ? [...new Set(body.duplicateComplaintIds.map((id) => cleanText(id, 128)).filter(Boolean))] : [];
  if (duplicateIds.length === 0) return sendJson(response, 400, { error: "Select at least one source complaint to merge." });
  if (duplicateIds.includes(canonicalId)) return sendJson(response, 400, { error: "A complaint cannot be merged into itself." });
  const canonicalRef = db.collection("complaints").doc(canonicalId);
  const canonicalSnapshot = await canonicalRef.get();
  if (!canonicalSnapshot.exists) return sendJson(response, 404, { error: "Canonical complaint not found." });
  const canonical = canonicalSnapshot.data();
  const now = new Date().toISOString();
  const mergedRecords = Array.isArray(canonical.mergedComplaintIds) ? canonical.mergedComplaintIds : [];
  for (const duplicateId of duplicateIds) {
    const sourceRef = db.collection("complaints").doc(duplicateId);
    const sourceSnapshot = await sourceRef.get();
    if (!sourceSnapshot.exists) continue;
    const source = sourceSnapshot.data();
    const sourceActivity = await sourceRef.collection("activity").orderBy("timestamp", "asc").get();
    const preserved = [];
    sourceActivity.forEach((activity) => preserved.push(activity.data()));
    await canonicalRef.collection("merged_history").doc(duplicateId).set({
      sourceComplaintId: duplicateId,
      sourceSnapshot: source,
      activity: preserved,
      mergedBy: profile.uid,
      mergedByName: profile.displayName || profile.email,
      mergedAt: now,
      reason: cleanText(body.reason, 500),
    });
    await sourceRef.update({
      isMerged: true,
      mergedIntoComplaintId: canonicalId,
      mergedAt: now,
      updatedAt: now,
    });
    await appendActivity(canonicalRef, profile.uid, profile.displayName || profile.email, "DUPLICATE_MERGED", `Merged complaint ${duplicateId}: ${cleanText(body.reason, 500)}`);
    if (!mergedRecords.includes(duplicateId)) mergedRecords.push(duplicateId);
  }
  const supporterUids = new Set(Array.isArray(canonical.supporterUids) ? canonical.supporterUids : []);
  for (const duplicateId of duplicateIds) {
    const sourceSnapshot = await db.collection("complaints").doc(duplicateId).get();
    if (!sourceSnapshot.exists) continue;
    const source = sourceSnapshot.data();
    (source.supporterUids || []).forEach((uid) => supporterUids.add(uid));
  }
  await canonicalRef.update({
    mergedComplaintIds: mergedRecords,
    supporterUids: [...supporterUids],
    supportCount: supporterUids.size,
    duplicateMergeVerifiedBy: profile.uid,
    duplicateMergeVerifiedAt: now,
    updatedAt: now,
  });
  sendJson(response, 200, {
    canonicalComplaintId: canonicalId,
    mergedComplaintIds: mergedRecords,
    supportCount: supporterUids.size,
  });
}

async function handleListComplaints(request, response, profile) {
  if (!requireFirebase(response)) return;
  let snapshot;
  if (profile.role === "CITIZEN") {
    snapshot = await db.collection("complaints").where("citizenUid", "==", profile.uid).get();
  } else if (profile.role === "SUPER_ADMIN") {
    snapshot = await db.collection("complaints").get();
  } else {
    snapshot = await db.collection("complaints").get();
  }
  const complaints = [];
  snapshot.forEach((doc) => {
    const complaint = doc.data();
    if (complaint.isMerged || complaint.mergedIntoComplaintId) return;
    if (canReadComplaint(profile, complaint)) complaints.push(complaint);
  });
  complaints.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  sendJson(response, 200, { complaints });
}

async function handleGetComplaint(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  if (complaint.isMerged || complaint.mergedIntoComplaintId) return sendJson(response, 404, { error: "This complaint is represented by its canonical record." });
  if (!canReadComplaint(profile, complaint)) return sendJson(response, 403, { error: "You are not authorized to view this complaint." });
  const activitySnapshot = await ref.collection("activity").orderBy("timestamp", "asc").get();
  const activity = [];
  activitySnapshot.forEach((doc) => activity.push(doc.data()));
  const taskSnapshot = await ref.collection("tasks").get();
  const tasks = [];
  taskSnapshot.forEach((doc) => tasks.push(doc.data()));
  sendJson(response, 200, { complaint, activity, tasks });
}

async function handleCitizenFeedback(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  if (profile.role !== "CITIZEN") return sendJson(response, 403, { error: "Only the citizen who reported the complaint can submit feedback." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const rating = Number(body.rating);
  const resolved = body.problemResolved === true;
  const comments = cleanText(body.comments, 1200);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return sendJson(response, 400, { error: "Rating must be a whole number from 1 to 5." });
  if (typeof body.problemResolved !== "boolean") return sendJson(response, 400, { error: "Confirm whether the problem was resolved." });
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  if (complaint.citizenUid !== profile.uid) return sendJson(response, 403, { error: "You can only provide feedback for your own complaint." });
  if (complaint.status !== "Resolved") return sendJson(response, 409, { error: "Feedback can only be submitted after the complaint is resolved." });
  if (complaint.feedback?.submittedAt) return sendJson(response, 409, { error: "Feedback has already been submitted for this resolution." });
  const now = new Date().toISOString();
  const feedback = {
    rating,
    problemResolved: resolved,
    comments,
    citizenUid: profile.uid,
    submittedAt: now,
  };
  await ref.update({ feedback, feedbackSubmittedAt: now, updatedAt: now });
  await ref.collection("feedbackHistory").add(feedback);
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "FEEDBACK_SUBMITTED", `Rating ${rating}/5; problem resolved: ${resolved ? "yes" : "no"}; ${comments}`);
  await createNotification({
    recipientUid: complaint.citizenUid,
    recipientRole: "CITIZEN",
    type: "FEEDBACK_SUBMITTED",
    title: "Feedback submitted",
    message: `Thank you for rating complaint "${complaint.title}".`,
    complaintId,
    priority: "NORMAL",
    governanceLevel: complaint.governanceLevel,
    eventKey: `FEEDBACK_SUBMITTED:${complaintId}:${profile.uid}:${now}`,
  });
  for (const departmentId of complaint.departmentIds || []) {
    const usersSnapshot = await db.collection("users").get();
    const recipients = [];
    usersSnapshot.forEach((doc) => {
      const user = doc.data();
      if (user.departmentId === departmentId && ["DEPARTMENT_HEAD", "DEPARTMENT_MEMBER"].includes(user.role)) recipients.push(doc.id);
    });
    await Promise.all(recipients.map((recipientUid) => createNotification({
      recipientUid,
      recipientRole: "DEPARTMENT",
      recipientDepartmentId: departmentId,
      type: "CITIZEN_FEEDBACK",
      title: "Citizen feedback received",
      message: `Complaint "${complaint.title}" received a ${rating}/5 rating.`,
      complaintId,
      priority: rating <= 2 ? "IMPORTANT" : "NORMAL",
      governanceLevel: complaint.governanceLevel,
      eventKey: `CITIZEN_FEEDBACK:${complaintId}:${departmentId}:${now}`,
    })));
  }
  sendJson(response, 201, { feedback });
}

async function handleCitizenReopen(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  if (profile.role !== "CITIZEN") return sendJson(response, 403, { error: "Only the citizen who reported the complaint can request reopening." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const reason = cleanText(body.reason, 1200);
  if (!reason) return sendJson(response, 400, { error: "A reason is required to reopen a complaint." });
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  if (complaint.citizenUid !== profile.uid) return sendJson(response, 403, { error: "You can only reopen your own complaint." });
  if (complaint.status !== "Resolved") return sendJson(response, 409, { error: "Only resolved complaints can be reopened." });
  if (complaint.reopenRequest?.status === "PENDING") return sendJson(response, 409, { error: "A reopening request is already awaiting review." });
  const now = new Date().toISOString();
  const reopenRequest = {
    status: "PENDING",
    reason,
    citizenUid: profile.uid,
    requestedAt: now,
    previousResolution: complaint.resolution || null,
  };
  await ref.update({ reopenRequest, reopenRequestedAt: now, reopenStatus: "PENDING", updatedAt: now });
  await ref.collection("reopeningHistory").add(reopenRequest);
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "REOPEN_REQUESTED", reason);
  await createNotification({
    recipientUid: complaint.citizenUid,
    recipientRole: "CITIZEN",
    type: "REOPEN_REQUEST_SUBMITTED",
    title: "Reopening request submitted",
    message: `Your reopening request for "${complaint.title}" is awaiting Super Admin review.`,
    complaintId,
    priority: "IMPORTANT",
    governanceLevel: complaint.governanceLevel,
    eventKey: `REOPEN_REQUEST:${complaintId}:${profile.uid}:${now}`,
  });
  const adminsSnapshot = await db.collection("users").where("role", "==", "SUPER_ADMIN").get();
  const adminRecipients = [];
  adminsSnapshot.forEach((doc) => adminRecipients.push(doc.id));
  await Promise.all(adminRecipients.map((recipientUid) => createNotification({
    recipientUid,
    recipientRole: "SUPER_ADMIN",
    type: "REOPEN_REQUEST_REVIEW",
    title: "Reopening request requires review",
    message: `Complaint "${complaint.title}" was requested to be reopened.`,
    complaintId,
    priority: "IMPORTANT",
    governanceLevel: complaint.governanceLevel,
    eventKey: `REOPEN_REVIEW:${complaintId}:${recipientUid}:${now}`,
  })));
  sendJson(response, 201, { reopenRequest });
}

async function handleReopenReview(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  if (profile.role !== "SUPER_ADMIN" || !isAuthorityVerified(profile)) return sendJson(response, 403, { error: "Only a verified Super Admin can review reopening requests." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  if (!["APPROVED", "REJECTED"].includes(body.decision)) return sendJson(response, 400, { error: "Decision must be APPROVED or REJECTED." });
  const remarks = cleanText(body.remarks, 1200);
  if (!remarks) return sendJson(response, 400, { error: "Review remarks are required." });
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  if (complaint.reopenRequest?.status !== "PENDING") return sendJson(response, 409, { error: "There is no pending reopening request." });
  const now = new Date().toISOString();
  const review = {
    status: body.decision,
    remarks,
    reviewedBy: profile.uid,
    reviewedByName: profile.displayName || profile.email,
    reviewedAt: now,
  };
  const reopenRequest = { ...complaint.reopenRequest, ...review };
  await ref.update({
    reopenRequest,
    reopenStatus: body.decision,
    status: body.decision === "APPROVED" ? "Reopened" : "Resolved",
    reopenedAt: body.decision === "APPROVED" ? now : null,
    updatedAt: now,
  });
  await ref.collection("reopeningHistory").add(reopenRequest);
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "REOPEN_REQUEST_REVIEWED", `${body.decision}: ${remarks}`);
  await createNotification({
    recipientUid: complaint.citizenUid,
    recipientRole: "CITIZEN",
    type: body.decision === "APPROVED" ? "COMPLAINT_REOPENED" : "REOPEN_REQUEST_REJECTED",
    title: body.decision === "APPROVED" ? "Complaint reopened" : "Reopening request declined",
    message: `${body.decision === "APPROVED" ? "Your complaint has been reopened" : "Your reopening request was declined"}: ${remarks}`,
    complaintId,
    priority: "IMPORTANT",
    governanceLevel: complaint.governanceLevel,
    eventKey: `REOPEN_REVIEW:${complaintId}:${profile.uid}:${body.decision}:${now}`,
  });
  sendJson(response, 200, { reopenRequest });
}

async function handleUpdateStatus(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  if (!["CITIZEN", "DEPARTMENT_MEMBER", "DEPARTMENT_HEAD", "SUPER_ADMIN"].includes(profile.role)) return sendJson(response, 403, { error: "Your account role is not authorized." });
  if (["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD", "SUPER_ADMIN"].includes(profile.role) && profile.authorityStatus !== "VERIFIED") {
    return sendJson(response, 403, { error: "Authority access requires verification." });
  }
  if (!["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD", "SUPER_ADMIN"].includes(profile.role)) return sendJson(response, 403, { error: "Only department staff or Super Admins can update complaints." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const allowed = ["Reported", "AI Analysed", "Awaiting Admin Verification", "Assigned", "Accepted", "In Progress", "Awaiting Additional Information", "Resolved", "Rejected", "Reopened"];
  if (!allowed.includes(body.status)) return sendJson(response, 400, { error: "Unsupported complaint status." });
  if (["Rejected", "Awaiting Additional Information"].includes(body.status) && !cleanText(body.remarks, 1200)) {
    return sendJson(response, 400, { error: `A reason is required when setting status to ${body.status}.` });
  }
  const evidence = body.evidence && typeof body.evidence === "object" ? body.evidence : {};
  const duringPhoto = cleanText(evidence.during, 9 * 1024 * 1024);
  const afterPhoto = cleanText(evidence.after, 9 * 1024 * 1024);
  if (body.status === "Resolved" && !afterPhoto && !cleanText(body.resolutionPhoto, 9 * 1024 * 1024)) return sendJson(response, 400, { error: "An after photograph is required before resolving a complaint." });
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  if (!canReadComplaint(profile, complaint) && profile.role !== "SUPER_ADMIN") return sendJson(response, 403, { error: "You are not authorized to update this complaint." });
  const update = { status: body.status, updatedAt: new Date().toISOString() };
  const existingEvidence = complaint.evidence || { before: [], during: [], after: [] };
  const evidenceUpdate = {
    before: Array.isArray(existingEvidence.before) ? existingEvidence.before : [],
    during: Array.isArray(existingEvidence.during) ? existingEvidence.during : [],
    after: Array.isArray(existingEvidence.after) ? existingEvidence.after : [],
  };
  if (duringPhoto) evidenceUpdate.during.push({ photo: duringPhoto, uploadedBy: profile.uid, uploadedByName: profile.displayName || profile.email, uploadedAt: update.updatedAt });
  if (afterPhoto || cleanText(body.resolutionPhoto, 9 * 1024 * 1024)) {
    evidenceUpdate.after.push({ photo: afterPhoto || cleanText(body.resolutionPhoto, 9 * 1024 * 1024), uploadedBy: profile.uid, uploadedByName: profile.displayName || profile.email, uploadedAt: update.updatedAt });
  }
  update.evidence = evidenceUpdate;
  if (body.status === "Resolved") update.resolution = { remarks: cleanText(body.remarks, 1200), photo: evidenceUpdate.after.at(-1)?.photo || "", resolvedBy: profile.uid, resolvedAt: update.updatedAt };
  await ref.update(update);
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "STATUS_UPDATED", `${body.status}: ${cleanText(body.remarks, 1200)}`);
  await createNotification({
    recipientUid: complaint.citizenUid,
    recipientRole: "CITIZEN",
    type: body.status === "Resolved" ? "COMPLAINT_RESOLVED" : body.status === "Rejected" ? "COMPLAINT_REJECTED" : body.status === "Awaiting Additional Information" ? "ADDITIONAL_INFORMATION_REQUESTED" : body.status === "Reopened" ? "COMPLAINT_REOPENED" : "COMPLAINT_STATUS_UPDATED",
    priority: body.status === "Resolved" ? "IMPORTANT" : "NORMAL",
    governanceLevel: complaint.governanceLevel,
    eventKey: `${body.status}:${complaintId}:${complaint.citizenUid}:${update.updatedAt}`,
    title: body.status === "Resolved" ? "Complaint resolved" : "Complaint progress updated",
    message: `Complaint "${complaint.title}" is now ${body.status}.${cleanText(body.remarks, 1200) ? ` ${cleanText(body.remarks, 1200)}` : ""}`,
    complaintId,
  });
  sendJson(response, 200, { complaintId, ...update });
}

async function handleVerifyAssignment(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  if (!isAuthorityVerified(profile)) return sendJson(response, 403, { error: "Authority access requires verification." });
  if (profile.role !== "SUPER_ADMIN") return sendJson(response, 403, { error: "Only a Super Admin can verify assignments." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const departmentIds = Array.isArray(body.departmentIds) ? body.departmentIds.filter((id) => typeof id === "string") : [];
  if (departmentIds.length === 0) return sendJson(response, 400, { error: "Select at least one verified department." });
  const selected = departments.filter((department) => departmentIds.includes(department.id));
  if (selected.length !== departmentIds.length) return sendJson(response, 400, { error: "One or more departments are not in the verified registry." });
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  const assignments = selected.map((department) => ({
    departmentId: department.id,
    departmentName: department.name,
    governanceLevel: department.governanceLevel,
    state: department.state,
    district: department.district,
    localBody: department.localBody,
  }));
  const departmentIds = selected.map((department) => department.id);
  await ref.update({ assignments, departmentIds, status: "Assigned", aiAnalysis: { ...complaint.aiAnalysis, requiresManualReview: false }, updatedAt: new Date().toISOString() });
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "ASSIGNMENT_VERIFIED", selected.map((department) => department.name).join(", "));
  sendJson(response, 200, { complaintId, assignments });
}

async function handleTaskUpdate(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  if (!isAuthorityVerified(profile)) return sendJson(response, 403, { error: "Authority access requires verification." });
  if (!["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD"].includes(profile.role)) return sendJson(response, 403, { error: "Only department staff or heads can update tasks." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const departmentId = cleanText(body.departmentId, 100);
  if (!departmentId || departmentId !== profile.departmentId) return sendJson(response, 403, { error: "You can only update tasks for your own department." });
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  const departmentIds = complaint.departmentIds || (complaint.assignments || []).map((assignment) => assignment.departmentId);
  if (!departmentIds.includes(departmentId)) return sendJson(response, 403, { error: "This complaint is not assigned to your department." });

  let assigneeUid = profile.uid;
  if (body.employeeUid) {
    if (profile.role !== "DEPARTMENT_HEAD") return sendJson(response, 403, { error: "Only a Department Head can assign work to employees." });
    const employee = await db.collection("users").doc(cleanText(body.employeeUid, 128)).get();
    if (!employee.exists) return sendJson(response, 404, { error: "Employee not found." });
    const employeeProfile = employee.data();
    if (employeeProfile.role !== "DEPARTMENT_MEMBER" || employeeProfile.departmentId !== departmentId) {
      return sendJson(response, 403, { error: "The employee is outside this department's jurisdiction." });
    }
    assigneeUid = cleanText(body.employeeUid, 128);
  }
  const taskStatus = ["OPEN", "IN_PROGRESS", "COMPLETED"].includes(body.status) ? body.status : "OPEN";
  const now = new Date().toISOString();
  const taskId = cleanText(body.taskId, 128) || crypto.randomUUID();
  const evidence = body.evidence && typeof body.evidence === "object" ? body.evidence : {};
  const duringPhoto = cleanText(evidence.during, 9 * 1024 * 1024);
  const afterPhoto = cleanText(evidence.after, 9 * 1024 * 1024);
  if (taskStatus === "COMPLETED" && !afterPhoto) return sendJson(response, 400, { error: "An after photograph is required to complete this department task." });
  await ref.collection("tasks").doc(taskId).set({
    taskId,
    departmentId,
    assigneeUid,
    status: taskStatus,
    remarks: cleanText(body.remarks, 1200),
    resolutionPhoto: cleanText(body.resolutionPhoto, 9 * 1024 * 1024),
    evidence: {
      before: cleanText(evidence.before, 9 * 1024 * 1024),
      during: duringPhoto,
      after: afterPhoto,
    },
    updatedBy: profile.uid,
    updatedAt: now,
  }, { merge: true });
  if (duringPhoto || afterPhoto) {
    const existingEvidence = complaint.evidence || { before: [], during: [], after: [] };
    const evidenceUpdate = {
      before: Array.isArray(existingEvidence.before) ? existingEvidence.before : [],
      during: Array.isArray(existingEvidence.during) ? existingEvidence.during : [],
      after: Array.isArray(existingEvidence.after) ? existingEvidence.after : [],
    };
    if (duringPhoto) evidenceUpdate.during.push({ photo: duringPhoto, uploadedBy: profile.uid, uploadedByName: profile.displayName || profile.email, uploadedAt: now });
    if (afterPhoto) evidenceUpdate.after.push({ photo: afterPhoto, uploadedBy: profile.uid, uploadedByName: profile.displayName || profile.email, uploadedAt: now });
    await ref.update({ evidence: evidenceUpdate, updatedAt: now });
  }
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "TASK_UPDATED", `${taskStatus}: ${cleanText(body.remarks, 1200)}`);
  await createNotification({
    recipientUid: complaint.citizenUid,
    recipientRole: "CITIZEN",
    type: "PROGRESS_UPDATED",
    title: taskStatus === "COMPLETED" ? "Department task completed" : "Complaint work updated",
    message: `${taskStatus === "COMPLETED" ? "A department task was completed" : "A department task was updated"} for "${complaint.title}".`,
    complaintId,
    priority: "IMPORTANT",
    governanceLevel: complaint.governanceLevel,
    eventKey: `TASK_UPDATED:${taskId}:${taskStatus}:${now}`,
  });
  if (assigneeUid && assigneeUid !== profile.uid) {
    await createNotification({
      recipientUid: assigneeUid,
      recipientRole: "DEPARTMENT_MEMBER",
      recipientDepartmentId: departmentId,
      type: "TASK_ASSIGNED",
      title: "Complaint task assigned",
      message: `A task for "${complaint.title}" was assigned or updated.`,
      complaintId,
      priority: complaint.priority === "CRITICAL" ? "URGENT" : "IMPORTANT",
      governanceLevel: complaint.governanceLevel,
      eventKey: `TASK_ASSIGNED:${taskId}:${assigneeUid}:${now}`,
    });
  }
  sendJson(response, 200, { taskId, departmentId, assigneeUid, status: taskStatus });
}

async function handleCivicIntelligence(request, response, profile) {
  if (!requireFirebase(response)) return;
  if (!["SUPER_ADMIN", "DEPARTMENT_MEMBER", "DEPARTMENT_HEAD"].includes(profile.role) || !isAuthorityVerified(profile)) {
    return sendJson(response, 403, { error: "Civic intelligence is available only to verified authority accounts." });
  }
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const now = Date.now();
  const range = url.searchParams.get("range") || "30";
  const customStart = url.searchParams.get("start");
  const customEnd = url.searchParams.get("end");
  let start = now - Number(range) * 24 * 60 * 60 * 1000;
  let end = now;
  if (customStart && customEnd) {
    start = Date.parse(customStart);
    end = Date.parse(customEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return sendJson(response, 400, { error: "A valid date range is required." });
  }
  const governance = url.searchParams.get("governance") || "ALL";
  const department = url.searchParams.get("department") || "ALL";

  const snapshot = await db.collection("complaints").get();
  let complaints = [];
  snapshot.forEach((doc) => {
    const complaint = doc.data();
    if (complaint.isMerged || complaint.mergedIntoComplaintId) return;
    if (!canReadComplaint(profile, complaint)) return;
    const created = Date.parse(complaint.createdAt);
    if (!Number.isFinite(created) || created < start || created > end) return;
    if (governance !== "ALL" && complaint.governanceLevel !== governance) return;
    if (department !== "ALL" && !(complaint.assignments || []).some((assignment) => assignment.departmentId === department)) return;
    complaints.push(complaint);
  });

  const unresolvedStatuses = ["Reported", "AI Analysed", "Awaiting Admin Verification", "Assigned", "Accepted", "In Progress", "Awaiting Additional Information", "Reopened"];
  const countBy = (items, key) => {
    const totals = {};
    items.forEach((item) => {
      const value = typeof key === "function" ? key(item) : item[key];
      if (!value) return;
      totals[value] = (totals[value] || 0) + 1;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  };
  const resolved = complaints.filter((item) => item.status === "Resolved");
  const unresolved = complaints.filter((item) => unresolvedStatuses.includes(item.status));
  const reopened = complaints.filter((item) => item.status === "Reopened" || item.reopenRequest?.status === "APPROVED");
  const overdue = unresolved.filter((item) => item.deadlineAt && Date.parse(item.deadlineAt) < now);
  const resolutionTimes = resolved.map((item) => {
    const created = Date.parse(item.createdAt);
    const resolvedAt = Date.parse(item.resolution?.resolvedAt || item.updatedAt);
    return Number.isFinite(created) && Number.isFinite(resolvedAt) && resolvedAt >= created ? (resolvedAt - created) / 86400000 : null;
  }).filter((days) => days !== null);
  const averageResolutionDays = resolutionTimes.length
    ? Math.round((resolutionTimes.reduce((sum, days) => sum + days, 0) / resolutionTimes.length) * 10) / 10
    : 0;

  const locationGroups = {};
  complaints.forEach((item) => {
    const location = cleanText(item.location, 160) || "Location unavailable";
    if (!locationGroups[location]) locationGroups[location] = { location, complaints: [], unresolved: 0, reopened: 0 };
    locationGroups[location].complaints.push(item);
    if (unresolvedStatuses.includes(item.status)) locationGroups[location].unresolved++;
    if (item.status === "Reopened" || item.reopenRequest?.status === "APPROVED") locationGroups[location].reopened++;
  });
  const hotspots = Object.values(locationGroups).map((group) => {
    const ages = group.complaints.map((item) => {
      const created = Date.parse(item.createdAt);
      return Number.isFinite(created) ? Math.max(0, (now - created) / 86400000) : 0;
    });
    const averageAgeDays = ages.length ? Math.round((ages.reduce((sum, age) => sum + age, 0) / ages.length) * 10) / 10 : 0;
    const categories = countBy(group.complaints, "category");
    const highAttention = group.complaints.filter((item) => ["HIGH", "CRITICAL"].includes(item.priority)).length;
    const score = group.unresolved * 3 + group.reopened * 2 + highAttention;
    return {
      location: group.location,
      total: group.complaints.length,
      unresolved: group.unresolved,
      reopened: group.reopened,
      averageAgeDays,
      priorityDistribution: countBy(group.complaints, "priority"),
      mostCommonCategory: categories[0]?.name || "Unknown",
      score,
    };
  }).sort((a, b) => b.score - a.score).slice(0, 10);

  const departmentGroups = {};
  complaints.forEach((item) => {
    (item.assignments || []).forEach((assignment) => {
      if (!assignment.departmentId) return;
      if (!departmentGroups[assignment.departmentId]) departmentGroups[assignment.departmentId] = {
        departmentId: assignment.departmentId,
        departmentName: assignment.departmentName,
        assigned: 0,
        pending: 0,
        inProgress: 0,
        resolved: 0,
        overdue: 0,
        reopened: 0,
      };
      const group = departmentGroups[assignment.departmentId];
      group.assigned++;
      if (unresolvedStatuses.includes(item.status)) group.pending++;
      if (item.status === "In Progress") group.inProgress++;
      if (item.status === "Resolved") group.resolved++;
      if (item.deadlineAt && Date.parse(item.deadlineAt) < now && unresolvedStatuses.includes(item.status)) group.overdue++;
      if (item.status === "Reopened") group.reopened++;
    });
  });
  const departmentWorkload = Object.values(departmentGroups).sort((a, b) => b.pending - a.pending);

  const categoryTrends = countBy(complaints, "category");
  const roadGroups = countBy(complaints.filter((item) =>
    ["Roads & sidewalks", "Street lighting", "Water & drainage", "Waste management"].includes(item.category)
  ), "location");
  const recurringLocations = roadGroups.filter((item) => item.count >= 2).slice(0, 10).map((item) => ({
    location: item.name,
    count: item.count,
  }));

  const previousStart = start - (end - start);
  const previousSnapshot = await db.collection("complaints").get();
  let previousCount = 0;
  let previousCategoryCounts = {};
  previousSnapshot.forEach((doc) => {
    const item = doc.data();
    if (item.isMerged || item.mergedIntoComplaintId) return;
    if (!canReadComplaint(profile, item)) return;
    const created = Date.parse(item.createdAt);
    if (created >= previousStart && created < start) {
      previousCount++;
      previousCategoryCounts[item.category] = (previousCategoryCounts[item.category] || 0) + 1;
    }
  });
  const trendPercent = previousCount ? Math.round(((complaints.length - previousCount) / previousCount) * 100) : 0;
  const predictions = categoryTrends.slice(0, 5).map((category) => {
    const previous = previousCategoryCounts[category.name] || 0;
    const change = previous ? Math.round(((category.count - previous) / previous) * 100) : 0;
    return {
      category: category.name,
      period: "Next 30 days",
      confidence: complaints.length >= 20 ? "Medium" : "Low",
      evidence: `${category.count} complaints in the selected period; ${previous} in the previous period.`,
      changePercent: change,
      potentialArea: hotspots[0]?.location || "Insufficient location data",
      prediction: change > 15 ? "Complaint activity may increase." : "No strong increase detected.",
      limitations: "Experimental prediction based only on complaint volume trends.",
    };
  });

  let aiInsights = null;
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey && complaints.length >= 5) {
    try {
      const aggregated = {
        total: complaints.length,
        unresolved: unresolved.length,
        resolved: resolved.length,
        overdue: overdue.length,
        reopened: reopened.length,
        averageResolutionDays,
        categories: categoryTrends.slice(0, 8),
        hotspots: hotspots.slice(0, 5),
        departmentWorkload: departmentWorkload.slice(0, 8),
        recurringLocations,
        trendPercent,
      };
      const prompt = [
        "Analyze verified CivicResolve aggregated analytics.",
        "Do not invent or restate values outside the supplied JSON.",
        "Return only structured JSON.",
        "Identify key findings, unresolved hotspots, department workload observations, recurring infrastructure patterns, attention items, recommended actions and data limitations.",
        "Clearly mark recommendations as advisory.",
        `Aggregated data: ${JSON.stringify(aggregated)}`,
      ].join("\n");
      const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                keyFindings: { type: "ARRAY", items: { type: "STRING" } },
                hotspotObservations: { type: "ARRAY", items: { type: "STRING" } },
                departmentObservations: { type: "ARRAY", items: { type: "STRING" } },
                recurringIssues: { type: "ARRAY", items: { type: "STRING" } },
                attentionItems: { type: "ARRAY", items: { type: "STRING" } },
                recommendedActions: { type: "ARRAY", items: { type: "STRING" } },
                dataLimitations: { type: "ARRAY", items: { type: "STRING" } },
                confidence: { type: "STRING" },
              },
              required: ["keyFindings", "hotspotObservations", "departmentObservations", "recurringIssues", "attentionItems", "recommendedActions", "dataLimitations", "confidence"],
            },
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (geminiResponse.ok) {
        const result = await geminiResponse.json();
        const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
        aiInsights = JSON.parse(text);
      }
    } catch (error) {
      aiInsights = { error: "Gemini analysis was temporarily unavailable.", dataLimitations: ["AI interpretation unavailable; verified statistics remain available."], confidence: "Low" };
    }
  }

  sendJson(response, 200, {
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), rangeDays: Math.round((end - start) / 86400000) },
    summary: {
      total: complaints.length,
      unresolved: unresolved.length,
      resolved: resolved.length,
      overdue: overdue.length,
      reopened: reopened.length,
      averageResolutionDays,
      trendPercent,
    },
    categories: categoryTrends,
    hotspots,
    departmentWorkload,
    recurringLocations,
    predictions,
    aiInsights,
  });
}

async function handleDashboard(request, response, profile) {
  if (!requireFirebase(response)) return;
  const snapshot = await db.collection("complaints").get();
  const complaints = [];
  snapshot.forEach((doc) => {
    const complaint = doc.data();
    if (complaint.isMerged || complaint.mergedIntoComplaintId) return;
    if (canReadComplaint(profile, complaint)) complaints.push(complaint);
  });
  const count = (predicate) => complaints.filter(predicate).length;
  const dashboard = {
    total: complaints.length,
    national: count((item) => item.governanceLevel === "NATIONAL"),
    state: count((item) => item.governanceLevel === "STATE"),
    local: count((item) => item.governanceLevel === "LOCAL"),
    awaitingVerification: count((item) => item.status === "Awaiting Admin Verification"),
    awaitingAssignment: count((item) => item.status === "Reported" || item.status === "AI Analysed"),
    pending: count((item) => ["Reported", "AI Analysed", "Awaiting Admin Verification", "Assigned"].includes(item.status)),
    inProgress: count((item) => item.status === "In Progress"),
    resolved: count((item) => item.status === "Resolved"),
    priority: {
      LOW: count((item) => item.priority === "LOW"),
      MEDIUM: count((item) => item.priority === "MEDIUM"),
      HIGH: count((item) => item.priority === "HIGH"),
      CRITICAL: count((item) => item.priority === "CRITICAL"),
    },
    feedback: {
      submitted: count((item) => Boolean(item.feedback?.submittedAt)),
      resolved: count((item) => item.feedback?.problemResolved === true),
      unresolved: count((item) => item.feedback?.problemResolved === false),
      averageRating: (() => {
        const ratings = complaints.map((item) => item.feedback?.rating).filter((rating) => Number.isFinite(rating));
        return ratings.length ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10 : 0;
      })(),
      reopeningRequests: count((item) => item.reopenRequest?.status === "PENDING"),
    },
  };
  sendJson(response, 200, dashboard);
}

async function handleNotifications(request, response, profile) {
  if (!requireFirebase(response)) return;
  const snapshot = await db.collection("notifications").where("recipientUid", "==", profile.uid).get();
  const notifications = [];
  snapshot.forEach((doc) => notifications.push({ notificationId: doc.id, ...doc.data() }));
  notifications.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const filter = url.searchParams.get("filter") || "ALL";
  const governance = url.searchParams.get("governance") || "ALL";
  const priority = url.searchParams.get("priority") || "ALL";
  const filtered = notifications.filter((item) =>
    (filter === "ALL" || (filter === "UNREAD" ? !item.read : Boolean(item.read))) &&
    (governance === "ALL" || !item.governanceLevel || item.governanceLevel === governance) &&
    (priority === "ALL" || item.priority === priority)
  );
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  sendJson(response, 200, {
    notifications: filtered.slice(0, limit),
    unreadCount: notifications.filter((item) => !item.read).length,
  });
}

async function handleMarkNotificationRead(request, response, profile, notificationId) {
  if (!requireFirebase(response)) return;
  const ref = db.collection("notifications").doc(notificationId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Notification not found." });
  const notification = snapshot.data();
  if (notification.recipientUid !== profile.uid) return sendJson(response, 403, { error: "You cannot read another user's notification." });
  await ref.update({ read: true, readAt: new Date().toISOString() });
  sendJson(response, 200, { notificationId, read: true });
}

async function handleMarkAllNotificationsRead(request, response, profile) {
  if (!requireFirebase(response)) return;
  const snapshot = await db.collection("notifications").where("recipientUid", "==", profile.uid).where("read", "==", false).get();
  const batch = db.batch();
  let count = 0;
  snapshot.forEach((doc) => {
    batch.update(doc.ref, { read: true, readAt: new Date().toISOString() });
    count++;
  });
  if (count > 0) await batch.commit();
  sendJson(response, 200, { markedRead: count, unreadCount: 0 });
}

async function handleNotificationPreferences(request, response, profile) {
  if (!requireFirebase(response)) return;
  if (request.method === "GET") {
    return sendJson(response, 200, { preferences: profile.notificationPreferences || {
      statusUpdates: true,
      assignmentUpdates: true,
      progressUpdates: true,
      deadlineReminders: true,
      escalationAlerts: true,
      emailEnabled: false,
      pushEnabled: false,
    } });
  }
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const allowed = ["statusUpdates", "assignmentUpdates", "progressUpdates", "deadlineReminders", "escalationAlerts", "emailEnabled", "pushEnabled"];
  const preferences = {};
  allowed.forEach((key) => {
    if (typeof body[key] === "boolean") preferences[key] = body[key];
  });
  await db.collection("users").doc(profile.uid).set({ notificationPreferences: preferences }, { merge: true });
  sendJson(response, 200, { preferences });
}

async function handleExtendDeadline(request, response, profile, complaintId) {
  if (!requireFirebase(response)) return;
  if (profile.role !== "SUPER_ADMIN" || !isAuthorityVerified(profile)) return sendJson(response, 403, { error: "Only a verified Super Admin can extend a complaint deadline." });
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  const extendedHours = Number(body.extendedHours);
  const reason = cleanText(body.reason, 500);
  if (!Number.isFinite(extendedHours) || extendedHours <= 0 || extendedHours > 720) return sendJson(response, 400, { error: "Extension must be between 1 and 720 hours." });
  if (!reason) return sendJson(response, 400, { error: "A reason is mandatory for a deadline extension." });
  const ref = db.collection("complaints").doc(complaintId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
  const complaint = snapshot.data();
  const base = Date.parse(complaint.deadlineAt) > Date.now() ? Date.parse(complaint.deadlineAt) : Date.now();
  const deadlineAt = new Date(base + extendedHours * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const history = Array.isArray(complaint.deadlineHistory) ? complaint.deadlineHistory : [];
  history.push({
    previousDeadlineAt: complaint.deadlineAt || null,
    deadlineAt,
    extendedHours,
    reason,
    extendedBy: profile.uid,
    extendedByName: profile.displayName || profile.email,
    extendedAt: now,
  });
  await ref.update({
    deadlineAt,
    deadlineHistory: history,
    deadlineExtendedAt: now,
    deadlineExtendedReason: reason,
    deadlineExtendedBy: profile.uid,
    updatedAt: now,
  });
  await appendActivity(ref, profile.uid, profile.displayName || profile.email, "DEADLINE_EXTENDED", `${extendedHours} hours; ${reason}`);
  await createNotification({
    recipientUid: complaint.citizenUid,
    recipientRole: "CITIZEN",
    type: "DEADLINE_UPDATED",
    priority: "IMPORTANT",
    governanceLevel: complaint.governanceLevel,
    eventKey: `DEADLINE_UPDATED:${complaintId}:${now}`,
    title: "Resolution deadline updated",
    message: `The deadline for "${complaint.title}" was extended. Reason: ${reason}`,
    complaintId,
  });
  sendJson(response, 200, { complaintId, deadlineAt, reason });
}

async function handleAuthorityApplications(request, response, profile) {
  if (!requireFirebase(response)) return;
  if (profile.role !== "SUPER_ADMIN" || profile.authorityStatus !== "VERIFIED") {
    return sendJson(response, 403, { error: "Only a verified Super Admin can review authority applications." });
  }
  const snapshot = await db.collection("users").where("authorityStatus", "==", "PENDING").get();
  const applications = [];
  snapshot.forEach((doc) => {
    const user = doc.data();
    applications.push({
      uid: doc.id,
      email: user.email,
      displayName: user.displayName,
      authorityApplication: user.authorityApplication || null,
      authorityRequestedAt: user.authorityRequestedAt,
    });
  });
  applications.sort((a, b) => String(b.authorityRequestedAt).localeCompare(String(a.authorityRequestedAt)));
  sendJson(response, 200, { applications });
}

async function handleAuthorityReview(request, response, profile, targetUid) {
  if (!requireFirebase(response)) return;
  if (profile.role !== "SUPER_ADMIN" || profile.authorityStatus !== "VERIFIED") {
    return sendJson(response, 403, { error: "Only a verified Super Admin can review authority applications." });
  }
  let body;
  try { body = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
  if (!["APPROVE", "REJECT"].includes(body.decision)) return sendJson(response, 400, { error: "Decision must be APPROVE or REJECT." });
  const remarks = cleanText(body.remarks, 1200);
  if (!remarks) return sendJson(response, 400, { error: "Verification remarks are required." });
  const targetRef = db.collection("users").doc(targetUid);
  const targetSnapshot = await targetRef.get();
  if (!targetSnapshot.exists) return sendJson(response, 404, { error: "Applicant account not found." });
  const target = targetSnapshot.data();
  if (target.authorityStatus !== "PENDING" || !target.authorityApplication) {
    return sendJson(response, 409, { error: "This application is no longer pending." });
  }
  const application = target.authorityApplication;
  const department = departments.find((item) => item.id === application.departmentId);
  if (!department) return sendJson(response, 400, { error: "The requested department is no longer verified." });
  const now = new Date().toISOString();
  if (body.decision === "APPROVE") {
    await targetRef.update({
      role: application.requestedRole,
      departmentId: department.id,
      jurisdiction: application.jurisdiction,
      authorityStatus: "VERIFIED",
      authorityVerifiedAt: now,
      authorityVerifiedBy: profile.uid,
      authorityVerificationRemarks: remarks,
      authorityRejectedAt: null,
      updatedAt: now,
    });
    await admin.auth().setCustomUserClaims(targetUid, {
      role: application.requestedRole,
      authorityStatus: "VERIFIED",
      departmentId: department.id,
      jurisdiction: application.jurisdiction,
    });
  } else {
    await targetRef.update({
      role: "CITIZEN",
      departmentId: null,
      jurisdiction: { governanceLevel: null, state: null, district: null, localBody: null },
      authorityStatus: "REJECTED",
      authorityRejectedAt: now,
      authorityRejectedBy: profile.uid,
      authorityVerificationRemarks: remarks,
      updatedAt: now,
    });
    await admin.auth().setCustomUserClaims(targetUid, { role: "CITIZEN", authorityStatus: "REJECTED", departmentId: null, jurisdiction: null });
  }
  await appendAuthorityAudit(profile, body.decision === "APPROVE" ? "AUTHORITY_APPROVED" : "AUTHORITY_REJECTED", targetUid, remarks, {
    departmentId: department.id,
    requestedRole: application.requestedRole,
  });
  await db.collection("notifications").add({
    notificationId: crypto.createHash("sha256").update(`AUTHORITY_${body.decision}:${targetUid}:${now}`).digest("hex"),
    recipientUid: targetUid,
    recipientRole: "CITIZEN",
    type: body.decision === "APPROVE" ? "AUTHORITY_VERIFIED" : "AUTHORITY_REJECTED",
    title: body.decision === "APPROVE" ? "Authority account verified" : "Authority application rejected",
    message: remarks,
    complaintId: null,
    priority: "IMPORTANT",
    governanceLevel: department.governanceLevel,
    read: false,
    createdAt: now,
  });
  sendJson(response, 200, { targetUid, decision: body.decision, authorityStatus: body.decision === "APPROVE" ? "VERIFIED" : "REJECTED" });
}

async function handleDepartmentList(request, response, profile) {
  if (!requireFirebase(response)) return;
  if (["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD", "SUPER_ADMIN"].includes(profile.role) && !isAuthorityVerified(profile)) {
    return sendJson(response, 403, { error: "Authority access requires verification." });
  }
  if (profile.role === "SUPER_ADMIN") return sendJson(response, 200, { departments });
  if (!profile.departmentId) return sendJson(response, 403, { error: "This user is not assigned to a department." });
  const department = departments.find((item) => item.id === profile.departmentId);
  sendJson(response, 200, { departments: department ? [department] : [] });
}

async function processDeadlineEscalations() {
  if (!db) return;
  const snapshot = await db.collection("complaints").get();
  const firstEscalationHours = Number(process.env.DEADLINE_ESCALATION_HOURS) > 0 ? Number(process.env.DEADLINE_ESCALATION_HOURS) : 24;
  const finalEscalationHours = Number(process.env.FINAL_ESCALATION_HOURS) > 0 ? Number(process.env.FINAL_ESCALATION_HOURS) : 72;
  const now = Date.now();
  for (const doc of snapshot.docs) {
    const complaint = doc.data();
    if (!complaint.deadlineAt || ["Resolved", "Reopened"].includes(complaint.status)) continue;
    const deadline = Date.parse(complaint.deadlineAt);
    if (!Number.isFinite(deadline)) continue;
    const remainingHours = (deadline - now) / 3600000;
    if (remainingHours > 0 && remainingHours <= 24 && !complaint.reminderSentAt) {
      await doc.ref.update({ reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const usersSnapshot = await db.collection("users").get();
      const recipients = [];
      usersSnapshot.forEach((userDoc) => {
        const user = userDoc.data();
        if ((["DEPARTMENT_MEMBER", "DEPARTMENT_HEAD"].includes(user.role) && (complaint.departmentIds || []).includes(user.departmentId)) || user.role === "SUPER_ADMIN") recipients.push(userDoc.id);
      });
      await Promise.all(recipients.map((recipientUid) => createNotification({
        recipientUid,
        recipientRole: "AUTHORITY",
        type: "DEADLINE_APPROACHING",
        priority: "IMPORTANT",
        governanceLevel: complaint.governanceLevel,
        eventKey: `DEADLINE_APPROACHING:${complaint.complaintId}:${recipientUid}:${complaint.deadlineAt}`,
        title: "Deadline approaching",
        message: `Complaint "${complaint.title}" is due within 24 hours.`,
        complaintId: complaint.complaintId,
      })));
      continue;
    }
    if (now <= deadline) continue;
    const overdueHours = (now - deadline) / 3600000;
    const history = Array.isArray(complaint.escalationHistory) ? complaint.escalationHistory : [];
    const firstEscalated = history.some((item) => item.level === "DEPARTMENT_HEAD");
    const finalEscalated = history.some((item) => item.level === "SUPER_ADMIN");
    let level = null;
    if (!firstEscalated) level = "DEPARTMENT_HEAD";
    else if (!finalEscalated && overdueHours >= finalEscalationHours) level = "SUPER_ADMIN";
    if (!level) continue;

    const event = {
      level,
      overdueHours: Math.round(overdueHours * 10) / 10,
      escalatedAt: new Date().toISOString(),
      deadlineAt: complaint.deadlineAt,
    };
    history.push(event);
    await doc.ref.update({ escalationHistory: history, escalatedAt: event.escalatedAt, escalatedTo: level, updatedAt: event.escalatedAt });
    await appendActivity(doc.ref, "SYSTEM", "CivicResolve Scheduler", level === "SUPER_ADMIN" ? "ESCALATED_TO_SUPER_ADMIN" : "ESCALATED_TO_DEPARTMENT_HEAD", `Complaint remained unresolved past its deadline.`);

    const usersSnapshot = await db.collection("users").get();
    const recipients = [];
    usersSnapshot.forEach((userDoc) => {
      const user = userDoc.data();
      if (level === "SUPER_ADMIN" ? user.role === "SUPER_ADMIN" : (user.role === "DEPARTMENT_HEAD" && (complaint.departmentIds || []).includes(user.departmentId))) {
        recipients.push(userDoc.id);
      }
    });
    await Promise.all(recipients.map((recipientUid) => createNotification({
      recipientUid,
      recipientRole: level,
      type: level === "SUPER_ADMIN" ? "COMPLAINT_ESCALATED_SUPER_ADMIN" : "COMPLAINT_ESCALATED",
      priority: "URGENT",
      governanceLevel: complaint.governanceLevel,
      eventKey: `${level}:${complaint.complaintId}:${recipientUid}:${complaint.deadlineAt}`,
      title: level === "SUPER_ADMIN" ? "Complaint escalated to Super Admin" : "Complaint overdue",
      message: `Complaint "${complaint.title}" exceeded its deadline and was escalated.`,
      complaintId: complaint.complaintId,
    })));
    await createNotification({
      recipientUid: complaint.citizenUid,
      recipientRole: "CITIZEN",
      type: "COMPLAINT_DELAYED",
      priority: "URGENT",
      governanceLevel: complaint.governanceLevel,
      eventKey: `COMPLAINT_DELAYED:${complaint.complaintId}:${complaint.citizenUid}:${complaint.deadlineAt}`,
      title: "Complaint resolution delayed",
      message: `Complaint "${complaint.title}" is overdue and has been escalated.`,
      complaintId: complaint.complaintId,
    });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/notifications/stream") {
    if (!requireFirebase(response)) return;
    const token = url.searchParams.get("token");
    if (!token) {
      sendJson(response, 401, { error: "Authentication required." });
      return;
    }
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(token); } catch {
      sendJson(response, 401, { error: "Your session is invalid or expired." });
      return;
    }
    const profile = await getProfile(decoded.uid);
    if (!profile) {
      sendJson(response, 403, { error: "Your user profile is missing." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");
    const unsubscribe = db.collection("notifications").where("recipientUid", "==", profile.uid).onSnapshot((snapshot) => {
      const notifications = [];
      snapshot.forEach((doc) => notifications.push({ notificationId: doc.id, ...doc.data() }));
      notifications.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      response.write(`event: notifications\ndata: ${JSON.stringify({ notifications: notifications.slice(0, 100), unreadCount: notifications.filter((item) => !item.read).length })}\n\n`);
    }, (error) => {
      response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    });
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 25000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }
  if (url.pathname === "/api/health") return sendJson(response, 200, { status: "ok", firebaseConfigured: Boolean(admin && db), geminiConfigured: Boolean(process.env.GEMINI_API_KEY) });
  const publicComplaintMatch = url.pathname.match(/^\/api\/public\/complaints\/([a-zA-Z0-9-]+)$/);
  if (publicComplaintMatch && request.method === "GET") {
    if (!requireFirebase(response)) return;
    const snapshot = await db.collection("complaints").doc(publicComplaintMatch[1]).get();
    if (!snapshot.exists) return sendJson(response, 404, { error: "Complaint not found." });
    const complaint = snapshot.data();
    return sendJson(response, 200, {
      complaint: {
        complaintId: complaint.complaintId,
        title: complaint.title,
        category: complaint.category,
        governanceLevel: complaint.governanceLevel,
        location: complaint.location,
        priority: complaint.priority,
        status: complaint.status,
        locationText: complaint.location,
        deadlineAt: complaint.deadlineAt || null,
        coordinates: complaint.coordinates || null,
        supportCount: complaint.supportCount || 0,
      },
    });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") return handleAuth(request, response, "login");
  if (request.method === "POST" && url.pathname === "/api/auth/register") return handleAuth(request, response, "register");
  if (request.method === "POST" && url.pathname === "/api/authority/apply") {
    if (!requireFirebase(response)) return;
    const authorization = request.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return sendJson(response, 401, { error: "Authentication required." });
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      const profile = await getProfile(decoded.uid);
      if (!profile) return sendJson(response, 403, { error: "Your user profile is missing." });
      return handleAuthorityApplication(request, response, profile);
    } catch {
      return sendJson(response, 401, { error: "Your session is invalid or expired." });
    }
  }
  if (request.method === "GET" && url.pathname === "/api/departments") {
    const profile = await (async () => {
      if (!requireFirebase(response)) return null;
      const decoded = await verifyFirebaseToken(request, response);
      return decoded ? getProfile(decoded.uid) : null;
    })();
    if (profile) return handleDepartmentList(request, response, profile);
    return;
  }
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH") return sendJson(response, 405, { error: "Method not allowed" });
  if (!requireFirebase(response)) return;

  let decoded;
  try {
    decoded = await verifyFirebaseToken(request, response);
  } catch (error) {
    return;
  }
  if (!decoded) return;
  const profile = await getProfile(decoded.uid);
  if (!profile) return sendJson(response, 403, { error: "Your user profile is missing." });

  if (request.method === "POST" && url.pathname === "/api/analyze") return handleAnalyzeComplaint(request, response);
  if (request.method === "POST" && url.pathname === "/api/complaints") return handleCreateComplaint(request, response, profile);
  if (request.method === "POST" && url.pathname === "/api/complaints/check-duplicates") return handleDuplicateCheck(request, response, profile);
  if (request.method === "GET" && url.pathname === "/api/complaints") return handleListComplaints(request, response, profile);
  if (request.method === "GET" && url.pathname === "/api/dashboard") return handleDashboard(request, response, profile);
  if (request.method === "GET" && url.pathname === "/api/intelligence") return handleCivicIntelligence(request, response, profile);
  if (request.method === "GET" && url.pathname === "/api/authority/applications") return handleAuthorityApplications(request, response, profile);
  if (request.method === "GET" && url.pathname === "/api/notifications") return handleNotifications(request, response, profile);
  if (url.pathname === "/api/notifications/read-all" && request.method === "POST") return handleMarkAllNotificationsRead(request, response, profile);
  if (url.pathname === "/api/notifications/preferences" && ["GET", "PATCH"].includes(request.method)) return handleNotificationPreferences(request, response, profile);
  const complaintMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)$/);
  if (complaintMatch) {
    if (request.method === "GET") return handleGetComplaint(request, response, profile, complaintMatch[1]);
  }
  const statusMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/status$/);
  if (statusMatch && request.method === "PATCH") return handleUpdateStatus(request, response, profile, statusMatch[1]);
  const verifyMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/verify$/);
  if (verifyMatch && request.method === "PATCH") return handleVerifyAssignment(request, response, profile, verifyMatch[1]);
  const taskMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/tasks$/);
  if (taskMatch && request.method === "POST") return handleTaskUpdate(request, response, profile, taskMatch[1]);
  const supportMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/support$/);
  if (supportMatch && request.method === "POST") return handleSupportComplaint(request, response, profile, supportMatch[1]);
  const mergeMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/merge$/);
  if (mergeMatch && request.method === "PATCH") return handleMergeComplaints(request, response, profile, mergeMatch[1]);
  const feedbackMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/feedback$/);
  if (feedbackMatch && request.method === "POST") return handleCitizenFeedback(request, response, profile, feedbackMatch[1]);
  const reopenMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/reopen$/);
  if (reopenMatch && request.method === "POST") return handleCitizenReopen(request, response, profile, reopenMatch[1]);
  const reopenReviewMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/reopen\/review$/);
  if (reopenReviewMatch && request.method === "PATCH") return handleReopenReview(request, response, profile, reopenReviewMatch[1]);
  const deadlineMatch = url.pathname.match(/^\/api\/complaints\/([a-zA-Z0-9-]+)\/deadline$/);
  if (deadlineMatch && request.method === "PATCH") return handleExtendDeadline(request, response, profile, deadlineMatch[1]);
  const notificationMatch = url.pathname.match(/^\/api\/notifications\/([a-zA-Z0-9-]+)\/read$/);
  if (notificationMatch && request.method === "PATCH") return handleMarkNotificationRead(request, response, profile, notificationMatch[1]);
  const authorityReviewMatch = url.pathname.match(/^\/api\/authority\/applications\/([a-zA-Z0-9-]+)$/);
  if (authorityReviewMatch && request.method === "PATCH") return handleAuthorityReview(request, response, profile, authorityReviewMatch[1]);
  sendJson(response, 404, { error: "Endpoint not found." });
});

server.listen(PORT, () => {
  console.log(`CivicResolve is running at http://localhost:${PORT}`);
  console.log(`Firebase: ${admin && db ? "configured" : "not configured"}; Gemini: ${process.env.GEMINI_API_KEY ? "configured" : "not configured"}`);
  if (db) {
    processDeadlineEscalations().catch((error) => console.error("Deadline processing failed:", error.message));
    setInterval(() => {
      processDeadlineEscalations().catch((error) => console.error("Deadline processing failed:", error.message));
    }, 15 * 60 * 1000);
  }
});
