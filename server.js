const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const SECRET = process.env.JWT_SECRET || "change-me-in-production";
const TZ = process.env.TZ_NAME || "Asia/Kolkata";
const PORT = process.env.PORT || 3000;
const db = new Database(process.env.DB_FILE || "attendance.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, emp_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee', dept TEXT DEFAULT 'General',
  grade TEXT DEFAULT 'A', tio_pct INTEGER NOT NULL DEFAULT 60, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS attendance(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL, punch_in INTEGER NOT NULL, punch_out INTEGER,
  location TEXT NOT NULL DEFAULT 'office');
CREATE INDEX IF NOT EXISTS idx_att ON attendance(user_id, date);
CREATE TABLE IF NOT EXISTS leaves(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'leave',
  status TEXT NOT NULL DEFAULT 'pending', UNIQUE(user_id, date));
CREATE TABLE IF NOT EXISTS holidays(date TEXT PRIMARY KEY, name TEXT NOT NULL);
`);
if (!db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
  db.prepare(
    "INSERT INTO users(emp_id,name,email,password_hash,role,dept) VALUES(?,?,?,?,?,?)",
  ).run(
    "ADMIN01",
    "HR Admin",
    "admin@abc.com",
    bcrypt.hashSync("admin123", 10),
    "admin",
    "HR",
  );
  console.log("Seeded admin: admin@abc.com / admin123  (change it!)");
}

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- auth ----------
const auth = (req, res, next) => {
  try {
    const t = (req.headers.authorization || "").replace("Bearer ", "");
    const p = jwt.verify(t, SECRET);
    const u = db
      .prepare("SELECT * FROM users WHERE id=? AND active=1")
      .get(p.id);
    if (!u) throw 0;
    req.user = u;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
};
const admin = (req, res, next) =>
  req.user.role === "admin"
    ? next()
    : res.status(403).json({ error: "Admin only" });
const safe = (u) => {
  const { password_hash, ...r } = u;
  return r;
};
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    res
      .status(e.code === "SQLITE_CONSTRAINT_UNIQUE" ? 409 : 400)
      .json({ error: e.message });
  }
};

require("./extras")({ app, db, auth, admin, wrap, today, TZ });

app.post(
  "/api/login",
  wrap((req, res) => {
    const { email, password } = req.body;
    const u = db
      .prepare("SELECT * FROM users WHERE email=? AND active=1")
      .get(email || "");
    if (!u || !bcrypt.compareSync(password || "", u.password_hash))
      return res.status(401).json({ error: "Invalid email or password" });
    res.json({
      token: jwt.sign({ id: u.id }, SECRET, { expiresIn: "12h" }),
      user: safe(u),
    });
  }),
);
app.get("/api/me", auth, (req, res) => res.json(safe(req.user)));
app.post(
  "/api/me/password",
  auth,
  wrap((req, res) => {
    const { old_password, new_password } = req.body;
    if (!bcrypt.compareSync(old_password || "", req.user.password_hash))
      throw new Error("Old password is wrong");
    if ((new_password || "").length < 8)
      throw new Error("Password must be at least 8 characters");
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
      bcrypt.hashSync(new_password, 10),
      req.user.id,
    );
    res.json({ ok: true });
  }),
);

// ---------- employees ----------
app.get("/api/employees", auth, admin, (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT id,emp_id,name,email,role,dept,grade,tio_pct,active FROM users ORDER BY emp_id",
      )
      .all(),
  ),
);
app.post(
  "/api/employees",
  auth,
  admin,
  wrap((req, res) => {
    const b = req.body;
    if (!b.emp_id || !b.name || !b.email || (b.password || "").length < 8)
      throw new Error("emp_id, name, email and password (8+ chars) required");
    const r = db
      .prepare(
        "INSERT INTO users(emp_id,name,email,password_hash,role,dept,grade,tio_pct) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        b.emp_id,
        b.name,
        b.email,
        bcrypt.hashSync(b.password, 10),
        b.role === "admin" ? "admin" : "employee",
        b.dept || "General",
        b.grade || "A",
        +b.tio_pct || 60,
      );
    res.json({ id: r.lastInsertRowid });
  }),
);
app.put(
  "/api/employees/:id",
  auth,
  admin,
  wrap((req, res) => {
    const b = req.body,
      id = +req.params.id;
    db.prepare(
      "UPDATE users SET name=COALESCE(?,name),email=COALESCE(?,email),dept=COALESCE(?,dept),grade=COALESCE(?,grade),tio_pct=COALESCE(?,tio_pct),active=COALESCE(?,active),role=COALESCE(?,role) WHERE id=?",
    ).run(
      b.name ?? null,
      b.email ?? null,
      b.dept ?? null,
      b.grade ?? null,
      b.tio_pct ?? null,
      b.active ?? null,
      b.role ?? null,
      id,
    );
    if (b.password)
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
        bcrypt.hashSync(b.password, 10),
        id,
      );
    res.json({ ok: true });
  }),
);

// ---------- attendance ----------
app.post(
  "/api/punch",
  auth,
  wrap((req, res) => {
    const { action, location } = req.body,
      d = today(),
      now = Date.now();
    const open = db
      .prepare(
        "SELECT * FROM attendance WHERE user_id=? AND date=? AND punch_out IS NULL ORDER BY id DESC",
      )
      .get(req.user.id, d);
    if (action === "in") {
      if (open) throw new Error("Already punched in");
      db.prepare(
        "INSERT INTO attendance(user_id,date,punch_in,location) VALUES(?,?,?,?)",
      ).run(req.user.id, d, now, location === "remote" ? "remote" : "office");
    } else if (action === "out") {
      if (!open) throw new Error("Not punched in");
      db.prepare("UPDATE attendance SET punch_out=? WHERE id=?").run(
        now,
        open.id,
      );
    } else throw new Error("action must be in or out");
    res.json({ ok: true });
  }),
);
app.get(
  "/api/attendance",
  auth,
  wrap((req, res) => {
    const uid =
      req.user.role === "admin" && req.query.user_id
        ? +req.query.user_id
        : req.user.id;
    const m = req.query.month || today().slice(0, 7);
    res.json(
      db
        .prepare(
          "SELECT * FROM attendance WHERE user_id=? AND date LIKE ? ORDER BY punch_in DESC",
        )
        .all(uid, m + "%"),
    );
  }),
);
// bulk import from biometric / badge system: [{emp_id,date,in:"09:05",out:"17:40",location}]
app.post(
  "/api/attendance/import",
  auth,
  admin,
  wrap((req, res) => {
    const ins = db.prepare(
      "INSERT INTO attendance(user_id,date,punch_in,punch_out,location) VALUES(?,?,?,?,?)",
    );
    const find = db.prepare("SELECT id FROM users WHERE emp_id=?");
    let n = 0;
    db.transaction((rows) =>
      rows.forEach((r) => {
        const u = find.get(r.emp_id);
        if (!u) return;
        const ts = (t) =>
          t ? new Date(`${r.date}T${t}:00+05:30`).getTime() : null; // adjust offset for your TZ
        ins.run(
          u.id,
          r.date,
          ts(r.in),
          ts(r.out),
          r.location === "remote" ? "remote" : "office",
        );
        n++;
      }),
    )(req.body.rows || []);
    res.json({ imported: n });
  }),
);

// ---------- leaves & holidays ----------
app.get("/api/leaves", auth, (req, res) => {
  const q = `SELECT l.*,u.name,u.emp_id FROM leaves l JOIN users u ON u.id=l.user_id`;
  res.json(
    req.user.role === "admin"
      ? db.prepare(q + " ORDER BY date DESC").all()
      : db
          .prepare(q + " WHERE l.user_id=? ORDER BY date DESC")
          .all(req.user.id),
  );
});
app.post(
  "/api/leaves",
  auth,
  wrap((req, res) => {
    const { date, type } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || ""))
      throw new Error("Invalid date");
    db.prepare(
      "INSERT INTO leaves(user_id,date,type,status) VALUES(?,?,?,?)",
    ).run(
      req.user.id,
      date,
      type === "eto" ? "eto" : "leave",
      req.user.role === "admin" ? "approved" : "pending",
    );
    res.json({ ok: true });
  }),
);
app.patch(
  "/api/leaves/:id",
  auth,
  admin,
  wrap((req, res) => {
    if (!["approved", "rejected"].includes(req.body.status))
      throw new Error("bad status");
    db.prepare("UPDATE leaves SET status=? WHERE id=?").run(
      req.body.status,
      +req.params.id,
    );
    res.json({ ok: true });
  }),
);
app.get("/api/holidays", auth, (req, res) =>
  res.json(db.prepare("SELECT * FROM holidays ORDER BY date").all()),
);
app.post(
  "/api/holidays",
  auth,
  admin,
  wrap((req, res) => {
    db.prepare("INSERT OR REPLACE INTO holidays(date,name) VALUES(?,?)").run(
      req.body.date,
      req.body.name,
    );
    res.json({ ok: true });
  }),
);
app.delete("/api/holidays/:date", auth, admin, (req, res) => {
  db.prepare("DELETE FROM holidays WHERE date=?").run(req.params.date);
  res.json({ ok: true });
});

// ---------- compliance dashboard ----------
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const isWeekday = (d) => {
  const w = new Date(d + "T00:00:00Z").getUTCDay();
  return w !== 0 && w !== 6;
};
function monthDates(y, m) {
  // m: 0-11
  const out = [],
    n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  for (let i = 1; i <= n; i++)
    out.push(
      `${y}-${String(m + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`,
    );
  return out;
}
app.get(
  "/api/dashboard",
  auth,
  admin,
  wrap((req, res) => {
    const year = +req.query.year || +today().slice(0, 4),
      dept = req.query.dept;
    const nowY = +today().slice(0, 4),
      nowM = +today().slice(5, 7) - 1;
    const lastM = year < nowY ? 11 : year > nowY ? -1 : nowM;
    const emps = db
      .prepare(
        `SELECT * FROM users WHERE active=1 AND role!='admin' ${dept && dept !== "All" ? "AND dept=?" : ""} ORDER BY emp_id`,
      )
      .all(...(dept && dept !== "All" ? [dept] : []));
    const hols = new Set(
      db
        .prepare("SELECT date FROM holidays WHERE date LIKE ?")
        .all(year + "%")
        .map((h) => h.date),
    );
    const leaveQ = db.prepare(
      "SELECT date,type FROM leaves WHERE user_id=? AND status='approved' AND date LIKE ?",
    );
    const attQ = db.prepare(
      "SELECT date,punch_in,punch_out FROM attendance WHERE user_id=? AND location='office' AND date LIKE ?",
    );
    const rows = [];
    for (const e of emps) {
      const lv = leaveQ.all(e.id, year + "%"),
        at = attQ.all(e.id, year + "%");
      for (let m = 0; m <= lastM; m++) {
        const ds = monthDates(year, m).filter(isWeekday),
          pre = `${year}-${String(m + 1).padStart(2, "0")}`;
        const holidays = ds.filter((d) => hols.has(d)).length;
        const leaves = lv.filter(
          (l) =>
            l.type === "leave" &&
            l.date.startsWith(pre) &&
            isWeekday(l.date) &&
            !hols.has(l.date),
        ).length;
        const eto = lv.filter(
          (l) =>
            l.type === "eto" &&
            l.date.startsWith(pre) &&
            isWeekday(l.date) &&
            !hols.has(l.date),
        ).length;
        const required = Math.round(
          ((ds.length - holidays - leaves - eto) * e.tio_pct) / 100,
        );
        const mine = at.filter((a) => a.date.startsWith(pre));
        const days = new Set(mine.map((a) => a.date)),
          hrs = {};
        mine.forEach((a) => {
          hrs[a.date] =
            (hrs[a.date] || 0) +
            ((a.punch_out || a.punch_in) - a.punch_in) / 36e5;
        });
        const inOffice = days.size;
        const avg = inOffice
          ? Object.values(hrs).reduce((a, b) => a + b, 0) / inOffice
          : 0;
        rows.push({
          emp_id: e.emp_id,
          name: e.name,
          dept: e.dept,
          grade: e.grade,
          year,
          month: MONTHS[m],
          month_no: m,
          tio_pct: e.tio_pct,
          working_days: ds.length,
          holidays,
          leaves,
          eto,
          required,
          in_office: inOffice,
          avg_hours: +avg.toFixed(2),
          compliant: inOffice >= required,
        });
      }
    }
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const summary = {
      declared_holidays: hols.size,
      approved_leaves: sum("leaves"),
      approved_eto: sum("eto"),
      days_required: sum("required"),
      days_in_office: sum("in_office"),
      additional_required: rows.reduce(
        (a, r) => a + Math.max(0, r.required - r.in_office),
        0,
      ),
      is_compliant: rows.every((r) => r.compliant),
      as_on: today(),
    };
    const monthly = MONTHS.map((name, m) => {
      const r = rows.filter((x) => x.month_no === m);
      return {
        month: name,
        avg_days: r.length
          ? +(r.reduce((a, x) => a + x.in_office, 0) / r.length).toFixed(1)
          : 0,
        compliant: r.every((x) => x.compliant),
        has_data: r.length > 0,
      };
    });
    const depts = db
      .prepare("SELECT DISTINCT dept FROM users WHERE role!='admin'")
      .all()
      .map((d) => d.dept);
    res.json({ summary, rows, monthly, depts });
  }),
);

app.listen(PORT, () =>
  console.log(`Attendance system running on http://localhost:${PORT}`),
);
