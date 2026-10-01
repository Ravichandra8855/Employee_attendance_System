
https://employee-attendance-system-tp5n.onrender.com

# Attendance & Time-in-Office System

Node.js + Express + SQLite backend, single-page vanilla JS frontend.

## Run
    npm install
    export JWT_SECRET="long-random-string"   # required in production
    export TZ_NAME="Asia/Kolkata"            # your office timezone
    npm start                                # http://localhost:3000

First login: admin@abc.com / admin123  (change immediately: POST /api/me/password)

## Compliance rule (edit in server.js → /api/dashboard)
required = round((weekdays - holidays - approved leaves - approved ETO) x TIO%)
in office = distinct days with an "office" punch. Compliant when in office >= required.

## Key endpoints
POST /api/login · POST /api/punch · GET /api/attendance · GET /api/dashboard
CRUD: /api/employees, /api/leaves, /api/holidays
POST /api/attendance/import  {rows:[{emp_id,date:"2026-09-01",in:"09:05",out:"17:40",location:"office"}]}
  -> bulk load from a biometric/badge system.

## Before going live
Put it behind HTTPS (nginx/Caddy), set a strong JWT_SECRET, back up attendance.db,
add login rate-limiting (express-rate-limit), and adjust the +05:30 offset in the import route.

## Enterprise features (extras.js + public/extras.js)
- Shifts with grace period -> late marks, overtime hours
- Leave quota per employee with live balance; leave blocked when balance is 0
- Roles: employee / manager / admin. Managers approve their own team's leave and
  regularization requests (no self-approval). Assign managers in Employees -> Assign
- Regularization: employee requests a fix for a missed punch; approval rewrites that day's record
- Office verification on office punch-in: set OFFICE_IPS and/or OFFICE_LAT/OFFICE_LNG/OFFICE_RADIUS_M
  (behind a reverse proxy add `app.set('trust proxy', 1)` so the real IP is seen)
- Monthly report (present, absent, late, leave, WFH, hours, overtime) + CSV export for payroll
- Audit log of every change, login lockout after 5 failures, security headers

## Deploy
    JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
Put Caddy/nginx in front for HTTPS. Back up the /data volume (attendance.db) daily.
