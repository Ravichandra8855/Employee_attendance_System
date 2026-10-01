(() => {
  const btns = (k, id) =>
    `<button class="k" onclick="decide('${k}',${id},'approved')">Approve</button> <button class="r" onclick="decide('${k}',${id},'rejected')">Reject</button>`;
  const table = (head, rows, empty) =>
    `<div class="tw"><table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows || `<tr><td colspan="${head.length}">${empty || "None"}</td></tr>`}</table></div>`;
  window.dl = async (p, name) => {
    const r = await fetch("/api" + p, {
      headers: { Authorization: "Bearer " + T() },
    });
    if (!r.ok) return alert("Export failed");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = name;
    a.click();
  };
  window.decide = (k, id, s) =>
    go(async () => {
      await api(`/${k}/${id}`, { method: "PATCH", body: { status: s } });
      show("Approvals");
    });

  V.Reports = async () => {
    const m = V.rm || new Date().toISOString().slice(0, 7),
      R = await api("/reports/monthly?month=" + m),
      c = R.length ? Object.keys(R[0]) : [];
    $("#view").innerHTML =
      `<div class="card"><div class="f"><input type="month" value="${m}" onchange="V.rm=this.value;show('Reports')">
  <button onclick="dl('/reports/monthly.csv?month=${m}','attendance-${m}.csv')">Export CSV</button></div>
  ${table(
    c.map((x) => x.replace(/_/g, " ")),
    R.map(
      (r) => `<tr>${c.map((k) => `<td>${esc(r[k])}</td>`).join("")}</tr>`,
    ).join(""),
    "No data",
  )}</div>`;
  };

  V.Shifts = async () => {
    const S = await api("/shifts");
    $("#view").innerHTML =
      `<div class="card"><h4>Add shift</h4><div class="f"><input id="s_n" placeholder="Name"><input id="s_a" type="time" value="09:00"><input id="s_b" type="time" value="18:00"><input id="s_g" type="number" value="15" style="width:90px" title="grace minutes"><button onclick="addShift()">Add</button></div></div>
  <div class="card">${table(["ID", "Name", "Start", "End", "Grace (min)"], S.map((s) => `<tr><td>${s.id}</td><td>${esc(s.name)}</td><td>${s.start_time}</td><td>${s.end_time}</td><td>${s.grace_min}</td></tr>`).join(""))}</div>`;
  };
  window.addShift = () =>
    go(async () => {
      await api("/shifts", {
        method: "POST",
        body: {
          name: $("#s_n").value,
          start_time: $("#s_a").value,
          end_time: $("#s_b").value,
          grace_min: $("#s_g").value,
        },
      });
      show("Shifts");
    });

  V.Regularize = async () => {
    const R = await api("/regularizations");
    $("#view").innerHTML =
      `<div class="card"><h4>Missed / wrong punch? Request correction</h4><div class="f"><input type="date" id="r_d"><input type="time" id="r_a" value="09:00"><input type="time" id="r_b" value="18:00"><input id="r_r" placeholder="Reason" style="flex:1"><button onclick="addReg()">Submit</button></div></div>
  <div class="card">${table(["Date", "In", "Out", "Reason", "Status"], R.map((r) => `<tr><td>${r.date}</td><td>${r.t_in}</td><td>${r.t_out}</td><td>${esc(r.reason)}</td><td>${r.status}</td></tr>`).join(""))}</div>`;
  };
  window.addReg = () =>
    go(async () => {
      await api("/regularizations", {
        method: "POST",
        body: {
          date: $("#r_d").value,
          t_in: $("#r_a").value,
          t_out: $("#r_b").value,
          reason: $("#r_r").value,
        },
      });
      show("Regularize");
    });

  V.Approvals = async () => {
    const A = await api("/approvals");
    $("#view").innerHTML =
      `<div class="card"><h4>Pending leave / ETO</h4>${table(["Employee", "Date", "Type", ""], A.leaves.map((l) => `<tr><td>${esc(l.emp_id)} ${esc(l.name)}</td><td>${l.date}</td><td>${l.type}</td><td>${btns("leaves", l.id)}</td></tr>`).join(""), "Nothing pending")}</div>
  <div class="card"><h4>Pending regularizations</h4>${table(["Employee", "Date", "In", "Out", "Reason", ""], A.regs.map((r) => `<tr><td>${esc(r.emp_id)} ${esc(r.name)}</td><td>${r.date}</td><td>${r.t_in}</td><td>${r.t_out}</td><td>${esc(r.reason)}</td><td>${btns("regularizations", r.id)}</td></tr>`).join(""), "Nothing pending")}</div>`;
  };

  V.Audit = async () => {
    const A = await api("/audit");
    $("#view").innerHTML =
      `<div class="card"><h4>Audit log (last 200 changes)</h4>${table(["Time", "Actor", "Action", "Detail"], A.map((a) => `<tr><td>${new Date(a.ts).toLocaleString()}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td style="white-space:normal;text-align:left">${esc(a.detail)}</td></tr>`).join(""))}</div>`;
  };

  const L0 = V.Leaves;
  V.Leaves = async () => {
    await L0();
    const b = await api("/leave-balance");
    $("#view").insertAdjacentHTML(
      "afterbegin",
      `<div class="card"><h4>Leave balance (${new Date().getFullYear()})</h4><div class="kpis"><div>Quota<span>${b.quota}</span></div><div>Used<span>${b.used}</span></div><div>Pending<span>${b.pending}</span></div><div>Available<span>${b.balance}</span></div></div></div>`,
    );
  };

  const E0 = V.Employees;
  V.Employees = async () => {
    await E0();
    const S = await api("/shifts");
    $("#view").insertAdjacentHTML(
      "beforeend",
      `<div class="card"><h4>Assign shift / manager / leave quota / role</h4><div class="f"><input id="a_e" placeholder="emp_id"><select id="a_s">${S.map((s) => `<option value="${s.id}">${esc(s.name)} ${s.start_time}-${s.end_time}</option>`).join("")}</select><input id="a_m" placeholder="manager emp_id"><input id="a_q" type="number" placeholder="leave quota" style="width:120px"><select id="a_r"><option>employee</option><option>manager</option><option>admin</option></select><button onclick="assign()">Save</button></div></div>`,
    );
  };
  window.assign = () =>
    go(async () => {
      await api("/employees/assign", {
        method: "PATCH",
        body: {
          emp_id: $("#a_e").value,
          shift_id: +$("#a_s").value,
          manager_emp_id: $("#a_m").value,
          leave_quota: $("#a_q").value === "" ? null : +$("#a_q").value,
          role: $("#a_r").value,
        },
      });
      alert("Saved");
      show("Employees");
    });

  window.chpw = () =>
    go(async () => {
      const o = prompt("Old password");
      if (o === null) return;
      const n = prompt("New password (min 8 characters)");
      if (n === null) return;
      await api("/me/password", {
        method: "POST",
        body: { old_password: o, new_password: n },
      });
      alert("Password changed. Please log in again.");
      logout();
    });
  document
    .querySelector("header")
    .insertAdjacentHTML(
      "beforeend",
      '<button class="s" onclick="chpw()">Change password</button>',
    );
  window.chem = () =>
    go(async () => {
      if (ME.role !== "admin") return alert("Only an admin can change emails");
      const e = prompt("New email address");
      if (!e) return;
      await api("/employees/" + ME.id, { method: "PUT", body: { email: e } });
      alert("Email changed. Please log in with the new email.");
      logout();
    });
  document
    .querySelector("header")
    .insertAdjacentHTML(
      "beforeend",
      '<button class="s" onclick="chem()">Change email</button>',
    );
  const E2 = V.Employees;
  V.Employees = async () => {
    await E2();
    const E = await api("/employees");
    window._E = E;
    const rows = document.querySelectorAll("#view .card.tw table tr");
    rows.forEach((tr, i) => {
      if (i === 0) tr.insertAdjacentHTML("beforeend", "<th>Edit</th>");
      else
        tr.insertAdjacentHTML(
          "beforeend",
          `<td><button onclick="editEmp(${i - 1})">Edit</button></td>`,
        );
    });
  };
  window.editEmp = (i) =>
    go(async () => {
      const e = window._E[i],
        f = {};
      for (const [k, l] of [
        ["name", "Name"],
        ["email", "Email"],
        ["dept", "Department"],
        ["grade", "Grade"],
        ["tio_pct", "TIO % (0-100)"],
      ]) {
        const v = prompt(l, e[k]);
        if (v === null) return;
        f[k] = k === "tio_pct" ? +v : v.trim();
      }
      if (isNaN(f.tio_pct) || f.tio_pct < 0 || f.tio_pct > 100)
        return alert("TIO % must be between 0 and 100");
      const p = prompt("New password (leave blank to keep the current one)");
      if (p === null) return;
      if (p) {
        if (p.length < 8)
          return alert("Password must be at least 8 characters");
        f.password = p;
      }
      await api("/employees/" + e.id, { method: "PUT", body: f });
      show("Employees");
    });
    const L2=V.Leaves;
V.Leaves=async()=>{
  await L2();
  const L=await api('/leaves');
  document.querySelectorAll('#view .card.tw table tr').forEach((tr,i)=>{
    if(i===0) tr.insertAdjacentHTML('beforeend','<th>Cancel</th>');
    else if(L[i-1]) tr.insertAdjacentHTML('beforeend', L[i-1].status==='pending'
      ? `<td><button class="r" onclick="cancelLeave(${L[i-1].id})">Cancel</button></td>`
      : '<td>🔒</td>');
  });
};
window.cancelLeave=id=>{ if(!confirm('Cancel this leave request?')) return;
  go(async()=>{await api('/leaves/'+id,{method:'DELETE'});show('Leaves')}); };
})();
