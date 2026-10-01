// Enterprise features: shifts, late/overtime, leave balances, manager approvals,
// regularization (missed punch), geofence/IP check, audit log, reports + CSV, login throttling.
module.exports = ({ app, db, auth, admin, wrap, today, TZ }) => {
  const addCol = (t, c) => {
    try {
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`);
    } catch {}
  };
  addCol("users", "shift_id INTEGER DEFAULT 1");
  addCol("users", "manager_id INTEGER");
  addCol("users", "leave_quota INTEGER DEFAULT 18");
  db.exec(`
    CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, grace_min INTEGER NOT NULL DEFAULT 15);
    CREATE TABLE IF NOT EXISTS regularizations(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, date TEXT NOT NULL, t_in TEXT NOT NULL, t_out TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, detail TEXT);`);
  db.prepare(
    "INSERT OR IGNORE INTO shifts(id,name,start_time,end_time,grace_min) VALUES(1,'General','09:00','18:00',15)",
  ).run();

  // local "YYYY-MM-DD" + "HH:MM" in office TZ -> epoch ms
  function localToEpoch(d, t) {
    const [y, m, dd] = d.split("-").map(Number),
      [h, mi] = t.split(":").map(Number),
      guess = Date.UTC(y, m - 1, dd, h, mi);
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(guess))
      .reduce((o, x) => ((o[x.type] = x.value), o), {});
    return (
      guess -
      (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess)
    );
  }

  // ----- security: headers, login throttling, audit trail -----
  app.use((q, r, n) => {
    r.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    n();
  });
  const fails = new Map();
  app.post("/api/login", (req, res, next) => {
    let f = fails.get(req.ip);
    if (f && Date.now() >= f.until) {
      fails.delete(req.ip);
      f = null;
    }
    if (f && f.n >= 5)
      return res
        .status(429)
        .json({ error: "Too many failed attempts. Try again in 15 minutes." });
    res.on("finish", () => {
      if (res.statusCode === 401) {
        const x = fails.get(req.ip) || { n: 0 };
        x.n++;
        x.until = Date.now() + 9e5;
        fails.set(req.ip, x);
      } else if (res.statusCode === 200) fails.delete(req.ip);
    });
    next();
  });
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET")
      res.on("finish", () => {
        const url = req.originalUrl.split("?")[0];
        if (res.statusCode >= 400 || url === "/api/login") return;
        const b = { ...req.body };
        ["password", "old_password", "new_password"].forEach(
          (k) => delete b[k],
        );
        db.prepare(
          "INSERT INTO audit(ts,actor,action,detail) VALUES(?,?,?,?)",
        ).run(
          Date.now(),
          req.user?.emp_id || "-",
          req.method + " " + url,
          JSON.stringify(b).slice(0, 500),
        );
      });
    next();
  });
  app.get("/api/audit", auth, admin, (req, res) =>
    res.json(
      db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 200").all(),
    ),
  );

  // ----- geofence / office-network check on office punch-in -----
  const meters = (a, b, c, d) => {
    const r = (x) => (x * Math.PI) / 180,
      h =
        Math.sin(r(c - a) / 2) ** 2 +
        Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
    return 12742e3 * Math.asin(Math.sqrt(h));
  };
  app.post("/api/punch", auth, (req, res, next) => {
    const { action, location, lat, lng } = req.body;
    if (action !== "in" || location === "remote") return next();
    const ips = (process.env.OFFICE_IPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const {
      OFFICE_LAT: oa,
      OFFICE_LNG: ob,
      OFFICE_RADIUS_M: rad = 200,
    } = process.env;
    if (!ips.length && !oa) return next();
    const ipOk = ips.includes((req.ip || "").replace("::ffff:", ""));
    const geoOk =
      oa && lat != null && lng != null && meters(+oa, +ob, +lat, +lng) <= +rad;
    ipOk || geoOk
      ? next()
      : res
          .status(403)
          .json({
            error:
              "Office punch-in is only allowed from the office network/location. Choose Remote or move to the office.",
          });
  });

  // ----- leave balance + manager approvals -----
  const yr = () => today().slice(0, 4);
  function balance(uid) {
    const q = db
      .prepare("SELECT leave_quota q FROM users WHERE id=?")
      .get(uid).q;
    const c = (s) =>
      db
        .prepare(
          "SELECT COUNT(*) n FROM leaves WHERE user_id=? AND type='leave' AND status=? AND date LIKE ?",
        )
        .get(uid, s, yr() + "%").n;
    const used = c("approved"),
      pending = c("pending");
    return { quota: q, used, pending, balance: q - used - pending };
  }
  app.get("/api/leave-balance", auth, (req, res) =>
    res.json(
      balance(
        req.user.role === "admin" && req.query.user_id
          ? +req.query.user_id
          : req.user.id,
      ),
    ),
  );
  app.post("/api/leaves", auth, (req, res, next) =>
    req.body.type === "eto" || balance(req.user.id).balance > 0
      ? next()
      : res.status(400).json({ error: "No leave balance left" }),
  );
  const canApprove = (req, uid) => {
    if (req.user.role === "admin") return true;
    if (uid === req.user.id) return false; // no self-approval
    const t = db.prepare("SELECT manager_id FROM users WHERE id=?").get(uid);
    return !!t && t.manager_id === req.user.id;
  };
  app.patch(
    "/api/leaves/:id",
    auth,
    wrap((req, res) => {
      const l = db
        .prepare("SELECT * FROM leaves WHERE id=?")
        .get(+req.params.id);
      if (!l) throw new Error("Not found");
      if (l.status !== "pending")
        throw new Error(
          "This request is already " + l.status + " and cannot be changed",
        );
      if (!canApprove(req, l.user_id))
        return res.status(403).json({ error: "Not allowed" });
      if (!["approved", "rejected"].includes(req.body.status))
        throw new Error("bad status");
      db.prepare("UPDATE leaves SET status=? WHERE id=?").run(
        req.body.status,
        l.id,
      );
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/leaves/:id",
    auth,
    wrap((req, res) => {
      const l = db
        .prepare("SELECT * FROM leaves WHERE id=?")
        .get(+req.params.id);
      if (!l) throw new Error("Not found");
      if (l.user_id !== req.user.id && req.user.role !== "admin")
        return res.status(403).json({ error: "Not allowed" });
      if (l.status !== "pending")
        return res
          .status(400)
          .json({
            error:
              "Only a pending request can be cancelled. Approved or rejected leave is locked.",
          });
      db.prepare("DELETE FROM leaves WHERE id=?").run(l.id);
      res.json({ ok: true });
    }),
  );
  app.get("/api/approvals", auth, (req, res) => {
    const scope =
      req.user.role === "admin" ? "1=1" : "u.manager_id=" + +req.user.id;
    res.json({
      leaves: db
        .prepare(
          `SELECT l.id,u.emp_id,u.name,l.date,l.type FROM leaves l JOIN users u ON u.id=l.user_id WHERE l.status='pending' AND ${scope}`,
        )
        .all(),
      regs: db
        .prepare(
          `SELECT r.*,u.emp_id,u.name FROM regularizations r JOIN users u ON u.id=r.user_id WHERE r.status='pending' AND ${scope}`,
        )
        .all(),
    });
  });

  // ----- regularization (forgot to punch / wrong punch) -----
  const HHMM = /^\d{2}:\d{2}$/;
  app.post(
    "/api/regularizations",
    auth,
    wrap((req, res) => {
      const { date, t_in, t_out, reason } = req.body;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
        !HHMM.test(t_in || "") ||
        !HHMM.test(t_out || "") ||
        t_out <= t_in
      )
        throw new Error("Valid date, in-time and out-time required");
      if (date > today()) throw new Error("Cannot regularize a future date");
      db.prepare(
        "INSERT INTO regularizations(user_id,date,t_in,t_out,reason) VALUES(?,?,?,?,?)",
      ).run(req.user.id, date, t_in, t_out, reason || "");
      res.json({ ok: true });
    }),
  );
  app.get("/api/regularizations", auth, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM regularizations WHERE user_id=? ORDER BY id DESC",
        )
        .all(req.user.id),
    ),
  );
  app.patch(
    "/api/regularizations/:id",
    auth,
    wrap((req, res) => {
      const r = db
          .prepare("SELECT * FROM regularizations WHERE id=?")
          .get(+req.params.id),
        st = req.body.status;
      if (!r || r.status !== "pending")
        throw new Error("Not found or already processed");
      if (!["approved", "rejected"].includes(st)) throw new Error("bad status");
      if (!canApprove(req, r.user_id))
        return res.status(403).json({ error: "Not allowed" });
      db.transaction(() => {
        db.prepare("UPDATE regularizations SET status=? WHERE id=?").run(
          st,
          r.id,
        );
        if (st === "approved") {
          db.prepare("DELETE FROM attendance WHERE user_id=? AND date=?").run(
            r.user_id,
            r.date,
          );
          db.prepare(
            "INSERT INTO attendance(user_id,date,punch_in,punch_out,location) VALUES(?,?,?,?,'office')",
          ).run(
            r.user_id,
            r.date,
            localToEpoch(r.date, r.t_in),
            localToEpoch(r.date, r.t_out),
          );
        }
      })();
      res.json({ ok: true });
    }),
  );

  // ----- shifts & assignment -----
  app.get("/api/shifts", auth, (req, res) =>
    res.json(db.prepare("SELECT * FROM shifts").all()),
  );
  app.post(
    "/api/shifts",
    auth,
    admin,
    wrap((req, res) => {
      const b = req.body;
      if (
        !HHMM.test(b.start_time || "") ||
        !HHMM.test(b.end_time || "") ||
        !b.name
      )
        throw new Error("name, start_time, end_time (HH:MM) required");
      db.prepare(
        "INSERT INTO shifts(name,start_time,end_time,grace_min) VALUES(?,?,?,?)",
      ).run(b.name, b.start_time, b.end_time, +b.grace_min || 0);
      res.json({ ok: true });
    }),
  );
  app.patch(
    "/api/employees/assign",
    auth,
    admin,
    wrap((req, res) => {
      const b = req.body,
        u = db
          .prepare("SELECT id FROM users WHERE emp_id=?")
          .get(b.emp_id || "");
      if (!u) throw new Error("Employee not found");
      const m = b.manager_emp_id
        ? db
            .prepare("SELECT id FROM users WHERE emp_id=?")
            .get(b.manager_emp_id)
        : null;
      if (b.manager_emp_id && !m) throw new Error("Manager not found");
      db.prepare(
        "UPDATE users SET shift_id=COALESCE(?,shift_id),manager_id=?,leave_quota=COALESCE(?,leave_quota),role=COALESCE(?,role) WHERE id=?",
      ).run(
        b.shift_id || null,
        m ? m.id : null,
        b.leave_quota ?? null,
        ["admin", "manager", "employee"].includes(b.role) ? b.role : null,
        u.id,
      );
      res.json({ ok: true });
    }),
  );

  // ----- monthly report (present / late / absent / overtime) + CSV -----
  function report(month) {
    const [y, m] = month.split("-").map(Number),
      dates = [];
    for (let d = 1, n = new Date(Date.UTC(y, m, 0)).getUTCDate(); d <= n; d++) {
      const s = `${month}-${String(d).padStart(2, "0")}`;
      if (s <= today()) dates.push(s);
    }
    const hol = new Set(
      db
        .prepare("SELECT date FROM holidays WHERE date LIKE ?")
        .all(month + "%")
        .map((h) => h.date),
    );
    const wd = dates.filter((s) => {
      const w = new Date(s + "T00:00:00Z").getUTCDay();
      return w && w < 6 && !hol.has(s);
    });
    const hhmm = (t) =>
      new Date(t).toLocaleTimeString("en-GB", {
        timeZone: TZ,
        hour: "2-digit",
        minute: "2-digit",
      });
    const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
    const addMin = (t, n) => {
      const x = mins(t) + n;
      return (
        String(Math.floor(x / 60)).padStart(2, "0") +
        ":" +
        String(x % 60).padStart(2, "0")
      );
    };
    const users = db
      .prepare(
        "SELECT u.*,s.start_time,s.end_time,s.grace_min FROM users u LEFT JOIN shifts s ON s.id=u.shift_id WHERE u.active=1 AND u.role!='admin' ORDER BY u.emp_id",
      )
      .all();
    return users.map((u) => {
      const st = u.start_time || "09:00",
        en = u.end_time || "18:00",
        shiftH = (mins(en) - mins(st)) / 60;
      const by = {};
      db.prepare(
        "SELECT * FROM attendance WHERE user_id=? AND date LIKE ? ORDER BY punch_in",
      )
        .all(u.id, month + "%")
        .forEach((a) => (by[a.date] ??= []).push(a));
      let hours = 0,
        late = 0,
        ot = 0,
        office = 0,
        remote = 0;
      for (const list of Object.values(by)) {
        const h = list.reduce(
          (t, a) => t + ((a.punch_out || a.punch_in) - a.punch_in) / 36e5,
          0,
        );
        hours += h;
        ot += Math.max(0, h - shiftH);
        if (hhmm(list[0].punch_in) > addMin(st, u.grace_min ?? 15)) late++;
        list.some((a) => a.location === "office") ? office++ : remote++;
      }
      const lv = db
        .prepare(
          "SELECT date FROM leaves WHERE user_id=? AND status='approved' AND date LIKE ?",
        )
        .all(u.id, month + "%")
        .map((l) => l.date)
        .filter((d) => wd.includes(d));
      return {
        emp_id: u.emp_id,
        name: u.name,
        dept: u.dept,
        shift: `${st}-${en}`,
        working_days: wd.length,
        present: Object.keys(by).length,
        office_days: office,
        remote_days: remote,
        leave_days: lv.length,
        absent: wd.filter((d) => d < today() && !by[d] && !lv.includes(d))
          .length,
        late,
        total_hours: +hours.toFixed(1),
        overtime_hours: +ot.toFixed(1),
      };
    });
  }
  const mo = (req) =>
    /^\d{4}-\d{2}$/.test(req.query.month || "")
      ? req.query.month
      : today().slice(0, 7);
  app.get(
    "/api/reports/monthly",
    auth,
    admin,
    wrap((req, res) => res.json(report(mo(req)))),
  );
  app.get(
    "/api/reports/monthly.csv",
    auth,
    admin,
    wrap((req, res) => {
      const r = report(mo(req)),
        cols = Object.keys(r[0] || { emp_id: 1 });
      const esc = (v) => {
        let s = String(v);
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
      }; // CSV-injection safe
      res
        .type("text/csv")
        .attachment(`attendance-${mo(req)}.csv`)
        .send(
          [
            cols.join(","),
            ...r.map((x) => cols.map((c) => esc(x[c])).join(",")),
          ].join("\n"),
        );
    }),
  );
};
