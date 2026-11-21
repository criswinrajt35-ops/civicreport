# CivicResolve

A Firebase-backed civic complaint management prototype. Start the app with Node.js 18 or newer:

```sh
npm install
npm start
```

Then open http://localhost:3000. Complaint records, status updates, department tasks and audit history are saved in Firestore.

## Gemini classification

The app uses a server-side Gemini integration when `GEMINI_API_KEY` is configured. The key stays on the server and is never sent to the browser. If Gemini or matching is unavailable, the complaint is sent to Super Admin verification rather than automatically assigned.

PowerShell:

```powershell
$env:GEMINI_API_KEY = "your-key"
npm start
```

Optionally set `GEMINI_MODEL` to use a different Gemini model. The default is `gemini-2.5-flash`.

## Firebase setup

Create a Firebase project and enable Email/Password authentication. Configure server environment variables from `.env.example`:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_WEB_API_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS` pointing to a Firebase Admin service-account JSON file

Seed the verified department registry:

```sh
npm run seed
```

Deploy `firestore.rules` with the Firebase CLI. The backend uses Firebase ID-token verification and server-side role, department, jurisdiction and reassignment checks. Firestore rules provide defense in depth.

The browser stores only the short-lived session and legacy local-demo data. Complaint, user, department, task and activity records are stored in Firestore.

## Resolution evidence

Citizens provide an optional before photo with their complaint. Department staff can add during photos while work is in progress and must attach an after photo before resolving or completing a complaint. Evidence stages are visible in citizen, department and Super Admin views and are included in complaint audit data.

## Duplicate complaint detection

Before submission, the server compares the complaint against the latest 100 complaint records and uses Gemini structured output to identify possible same-area duplicates. Citizens can view public status and support an existing complaint. Super Admins can merge verified duplicates; source complaint IDs, snapshots and activity history remain preserved.

## Deadlines, location and notifications

The server assigns a resolution deadline from complaint priority. The defaults are 24 hours for Critical, 72 hours for High, 7 days for Medium and 14 days for Low; all values are configurable through `.env.example`.

Complaints include browser-captured latitude and longitude when the citizen grants location permission. In-app notifications are stored per recipient and include unread counts. The Node process checks deadlines every 15 minutes, sends approaching-deadline reminders, escalates overdue work to department heads and then to Super Admins, and updates the citizen.

## Advanced duplicate detection

Duplicate detection compares complaints inside a configurable geographic radius (default 500 metres), category and normalized text similarity. Gemini verifies semantic duplicates when configured; the server uses a conservative local text/location fallback otherwise. The citizen warning requires a support action or explicit separate-report confirmation. Super Admin merges preserve source snapshots and activity history, mark source records as merged, aggregate support, and exclude merged sources from normal dashboards.

## Live complaint map

The Issue Map view uses Leaflet and OpenStreetMap. Reports with captured coordinates are plotted exactly; text-only reports are resolved through Nominatim when internet access is available and cached in the browser. The map supports governance, category, status and priority filters plus current-location centering. Popups show only complaint ID, title, category, location, priority and status.

## Complaint location picker

The complaint form includes "Pinpoint Problem Location on Map". Citizens can search for a place, click or drag a marker, use browser geolocation, and see exact latitude, longitude and reverse-geocoded address details before submission. Leaflet and OpenStreetMap provide the map; Nominatim provides place search and reverse geocoding.

## Voice complaint registration

The complaint form includes "Register Complaint Using Voice". It uses the browser Web Speech API for English (`en-IN`) recognition, live interim/final text, pause/resume, clear and editable transcript controls. Speech recognition availability depends on the browser and language service; unsupported browsers receive an actionable fallback.

## Smart notification system

Notifications are stored in the Firestore `notifications` collection and addressed to an authorized `recipientUid`. Notification types include submissions, AI/manual review, assignments, progress/evidence, status changes, deadline reminders and escalations. Normal, Important and Urgent priorities are deterministic for critical complaint events and rejected/verified updates.

The browser provides a notification dropdown, unread count, View All page, All/Unread/Read filters, governance and priority filters, mark-read, mark-all-read and notification preferences. SSE streams notifications in real time when Firebase is configured; the frontend falls back to polling every 30 seconds.

## Citizen feedback and reopening

Resolved complaints allow the original citizen to submit one immutable 1–5 rating, confirm whether the problem was actually resolved and add optional comments. Negative feedback and reopening requests notify the relevant departments and Super Admin. Reopening requires a reason and Super Admin approval or rejection. Approved reopening restores the complaint to `Reopened`; declined requests retain `Resolved`. Feedback and reopening records are append-only subcollections with separate audit history.

## Secure authority verification

Citizen accounts remain citizen-only. Government authority access is submitted through a server-created authority application containing role, department, employee ID, designation and verification facts. A verified Super Admin must approve or reject it. Approval sets the user role, department, jurisdiction and Firebase custom claims together. Verified status is enforced in backend complaint operations and Firestore rules. Authority approvals, rejections and applications are recorded in `authorityAudit`.

Provision the first Super Admin directly in Firestore and Firebase Custom Claims. The initial account must contain `role: "SUPER_ADMIN"`, `authorityStatus: "VERIFIED"` and the matching custom claim. Subsequent authority applications must be approved only through `/api/authority/applications/:uid`.
