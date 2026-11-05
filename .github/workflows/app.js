import { api, auth, db } from "./firebase.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c]);
const dateKey = (d = new Date()) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const v = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const dateText = v => v ? new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric" }).format(typeof v === "string" ? new Date(`${v}T00:00:00+07:00`) : new Date(Number(v))) : "—";
const roleLabels = { admin: "Admin", mentor: "Pembimbing", student: "Siswa" };

const state = {
  user: null, profile: null, page: "overview",
  users: [], students: [], partners: [], attendance: [], journals: [], evaluations: [],
  period: {}, student: null, assignedPartner: null, assignedPartnerId: "",
  unsubscribers: [], formKind: ""
};
let loginInProgress = false, handledUid = "", toastTimer;
let assignedPartnerUnsubscribe;
let mentorRecordUnsubscribers = new Map();

const navItems = {
  admin: [["overview","Ringkasan"],["accounts","Akun pengguna"],["students","Siswa & penempatan"],["partners","Mitra industri"],["evaluation","Evaluasi & laporan"],["settings","Pengaturan periode"]],
  mentor: [["overview","Ringkasan"],["attendance","Kehadiran"],["journals","Jurnal harian"],["evaluation","Evaluasi siswa"]],
  student: [["overview","Ringkasan"],["attendance","Kehadiran"],["journals","Jurnal harian"],["reports","Evaluasi & laporan"]]
};
const pageNames = Object.fromEntries(Object.values(navItems).flat());

function toast(msg) { const el = $("#toast"); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4000); }

function authErrorMessage(e) {
  const m = { "auth/invalid-credential":"Email atau kata sandi tidak cocok.", "auth/invalid-email":"Format email belum benar.", "auth/too-many-requests":"Terlalu banyak percobaan. Coba lagi beberapa saat.", "auth/user-disabled":"Akun dinonaktifkan. Hubungi administrator.", "auth/network-request-failed":"Koneksi internet bermasalah.", "auth/operation-not-allowed":"Login belum diaktifkan di Firebase Console." };
  return m[e.code] || e.message || "Login gagal.";
}

function showLoginMessage(msg, err = false) {
  const f = $("#loginFeedback"); f.textContent = msg; f.hidden = !msg;
  err ? f.dataset.error = "true" : f.removeAttribute("data-error");
}

function stopListeners() {
  state.unsubscribers.forEach(fn => fn()); state.unsubscribers = [];
  assignedPartnerUnsubscribe?.(); assignedPartnerUnsubscribe = null;
  mentorRecordUnsubscribers.forEach(fn => fn()); mentorRecordUnsubscribers = new Map();
}

function clearAccountData() {
  state.users = []; state.students = []; state.partners = [];
  state.attendance = []; state.journals = []; state.evaluations = [];
  state.period = {}; state.student = null; state.assignedPartner = null; state.assignedPartnerId = "";
}

function toggleWorkspace(open) { $("#loginScreen").hidden = open; $("#appShell").hidden = !open; }
function setBusy(busy) {
  $("#loginSubmit").disabled = busy; $("#loginEmail").disabled = busy; $("#loginPassword").disabled = busy;
  $("#loginSubmit").innerHTML = busy ? "Memeriksa akun…" : 'Masuk <span aria-hidden="true">→</span>';
}

async function enterWorkspace(user) {
  const snap = await api.get(api.ref(db, `users/${user.uid}`));
  const profile = snap.val();
  if (!profile) throw new Error("Akun belum memiliki peran sistem. Minta administrator mengaktifkan akun Anda.");
  if (profile.active !== true || !["admin","mentor","student"].includes(profile.role)) throw new Error("Akun tidak aktif atau perannya belum valid. Hubungi administrator.");
  if (profile.role === "mentor" && !["school","industry"].includes(profile.mentorType)) throw new Error("Jenis pembimbing belum diatur. Hubungi administrator.");
  clearAccountData();
  state.user = user; state.profile = { ...profile, uid: user.uid }; state.page = "overview"; handledUid = user.uid;
  $("#userName").textContent = profile.fullName || user.email;
  $("#userRole").textContent = profile.role === "mentor" ? `Pembimbing · ${profile.mentorType === "school" ? "Guru sekolah" : "Industri"}` : roleLabels[profile.role];
  $("#userAvatar").textContent = (profile.fullName || user.email || "U").trim().slice(0, 1).toUpperCase();
  $("#sessionSummary").textContent = `Masuk sebagai ${roleLabels[profile.role]} · ${user.email || ""}`;
  toggleWorkspace(true); subscribeData(); render();
}

async function processSession(user) {
  if (!user) { stopListeners(); state.user = null; state.profile = null; clearAccountData(); handledUid = ""; toggleWorkspace(false); return; }
  if (loginInProgress || handledUid === user.uid) return;
  try {
    if (user.isAnonymous) { await api.signOut(auth); showLoginMessage("Sesi anonim dihentikan.", true); return; }
    await enterWorkspace(user);
  } catch (e) { console.error(e); await api.signOut(auth); showLoginMessage(e.message || "Tidak dapat memuat profil.", true); }
}

function addListener(path, apply, label) {
  const unsub = api.onValue(api.ref(db, path), snap => { apply(snap.val()); render(); }, e => { console.error(e); toast(`Data ${label} gagal dimuat.`); });
  state.unsubscribers.push(unsub); return unsub;
}
function toRecords(val, pid) { if (!val || typeof val !== "object") return []; return Object.entries(val).map(([id, r]) => ({ ...r, ...(pid ? { id, studentUid: pid } : { id }) })); }
function listenCollection(path, key, transform = toRecords) { addListener(path, val => { state[key] = transform(val); }, path); }
function replaceStudentRecords(key, sUid, val) { state[key] = state[key].filter(r => r.studentUid !== sUid).concat(toRecords(val, sUid)); }

function listenMentorStudentRecords(sUid) {
  const uid = state.user.uid;
  const listeners = [
    [`students/${sUid}`, v => { state.students = state.students.filter(s => s.id !== sUid); if (v) state.students.push({ ...v, id: sUid }); }],
    [`attendance/${sUid}`, v => replaceStudentRecords("attendance", sUid, v)],
    [`journals/${sUid}`, v => replaceStudentRecords("journals", sUid, v)],
    [`evaluations/${sUid}/${uid}`, v => { state.evaluations = state.evaluations.filter(i => i.studentUid !== sUid); if (v) state.evaluations.push({ ...v, id: `${sUid}_${uid}`, studentUid: sUid, mentorUid: uid }); }]
  ];
  for (const [path, apply] of listeners) {
    const u = api.onValue(api.ref(db, path), s => { apply(s.val()); render(); }, e => { console.error(e); toast("Data siswa bimbingan gagal dimuat."); });
    mentorRecordUnsubscribers.set(path, u);
  }
}

function subscribeData() {
  stopListeners();
  const uid = state.user.uid, role = state.profile.role;
  if (role === "admin") {
    listenCollection("users", "users");
    listenCollection("students", "students");
    listenCollection("partners", "partners");
    listenCollection("attendance", "attendance", v => Object.entries(v || {}).flatMap(([su, r]) => toRecords(r, su)));
    listenCollection("journals", "journals", v => Object.entries(v || {}).flatMap(([su, r]) => toRecords(r, su)));
    listenCollection("evaluations", "evaluations", v => Object.entries(v || {}).flatMap(([su, r]) => Object.entries(r || {}).map(([mu, rec]) => ({ ...rec, id: `${su}_${mu}`, studentUid: su, mentorUid: mu }))));
  } else if (role === "mentor") {
    addListener(`mentorStudents/${uid}`, v => {
      const suids = Object.keys(v || {}).filter(k => v[k] === true);
      const asgn = new Set(suids);
      for (const [p, u] of mentorRecordUnsubscribers) {
        const su = p.split("/")[1];
        if (!asgn.has(su)) { u(); mentorRecordUnsubscribers.delete(p); state.students = state.students.filter(s => s.id !== su); state.attendance = state.attendance.filter(r => r.studentUid !== su); state.journals = state.journals.filter(r => r.studentUid !== su); state.evaluations = state.evaluations.filter(r => r.studentUid !== su); }
      }
      for (const su of suids) { if (!mentorRecordUnsubscribers.has(`students/${su}`)) listenMentorStudentRecords(su); }
    }, "siswa bimbingan");
  } else {
    addListener(`students/${uid}`, v => {
      state.student = v ? { ...v, id: uid } : null;
      const pid = state.student?.partnerId || "";
      if (pid !== state.assignedPartnerId) {
        state.assignedPartnerId = pid; state.assignedPartner = null;
        assignedPartnerUnsubscribe?.(); assignedPartnerUnsubscribe = null;
        if (pid) assignedPartnerUnsubscribe = addListener(`partners/${pid}`, p => { state.assignedPartner = p ? { ...p, id: pid } : null; }, "mitra penempatan");
      }
    }, "profil siswa");
    listenCollection(`attendance/${uid}`, "attendance", v => toRecords(v, uid));
    listenCollection(`journals/${uid}`, "journals", v => toRecords(v, uid));
    listenCollection(`evaluations/${uid}`, "evaluations", v => Object.entries(v || {}).map(([mu, r]) => ({ ...r, id: `${uid}_${mu}`, studentUid: uid, mentorUid: mu })));
  }
  addListener("settings/period", v => { state.period = v || {}; $("#periodTag").textContent = state.period.name ? state.period.name.toUpperCase() : "PERIODE BELUM DIATUR"; }, "pengaturan periode");
}

const heading = (kicker, title, desc, actions = "") => `<div class="page-heading"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="heading-desc">${esc(desc)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;
const statusChip = s => { const good = ["Aktif","Disetujui","Terverifikasi","Selesai","Lengkap"].includes(s); return `<span class="status ${good ? "done" : "open"}">${esc(s || "Menunggu")}</span>`; };
const empty = (t, d) => `<div class="empty-state"><strong>${esc(t)}</strong>${esc(d)}</div>`;
const dataTable = (hdrs, rows, et, ed) => rows.length ? `<div class="table-wrap"><table><thead><tr>${hdrs.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : empty(et, ed);
const getStudentName = uid => state.students.find(s => s.id === uid)?.fullName || uid;
const reviewStatus = (r, mt) => { if (r.status === "Disetujui" || r.status === "Perlu revisi") return r.status; return mt === "school" ? r.schoolStatus || "Menunggu" : r.industryStatus || "Menunggu"; };
function combinedReviewStatus(r, kind) {
  const reviews = [];
  if (r.schoolMentorUid) reviews.push(kind === "attendance" ? r.schoolStatus : r.schoolReview?.status);
  if (r.industryMentorUid) reviews.push(kind === "attendance" ? r.industryStatus : r.industryReview?.status);
  if (!reviews.length) return "Menunggu penempatan";
  if (reviews.includes("Perlu revisi")) return "Perlu revisi";
  if (reviews.every(s => s === "Disetujui")) return "Disetujui";
  return "Menunggu tinjauan";
}

function renderNav() {
  const items = navItems[state.profile.role];
  const m = items.map(([k, l]) => `<button class="nav-button" data-page="${k}" aria-current="${state.page === k ? "page" : "false"}"><span class="nav-symbol" aria-hidden="true">·</span><span>${l}</span></button>`).join("");
  $("#sideNav").innerHTML = m;
  $("#mobileNav").style.gridTemplateColumns = `repeat(${items.length}, minmax(0, 1fr))`;
  $("#mobileNav").innerHTML = m;
}

function renderDashboard() {
  const role = state.profile.role;
  const actions = role === "student" ? `<button class="button" data-action="checkin">Check-in hari ini</button><button class="button secondary" data-action="open-journal">Tulis jurnal</button>` : role === "admin" ? `<button class="button" data-page="accounts">Kelola akun</button>` : `<button class="button secondary" data-page="journals">Tinjau jurnal</button>`;
  const welcome = role === "admin" ? "Kelola akun, penempatan, mitra, dan hasil PKL." : role === "mentor" ? "Tinjau kehadiran, jurnal, dan perkembangan siswa bimbingan." : "Catat kehadiran dan kegiatan PKL. Data tersimpan di akun Anda.";
  const stats = role === "admin" ? [["Siswa",state.students.length],["Pembimbing",state.users.filter(u=>u.role==="mentor").length],["Mitra",state.partners.length],["Jurnal",state.journals.length]] : role === "mentor" ? [["Siswa bimbingan",state.students.length],["Kehadiran",state.attendance.length],["Jurnal",state.journals.length],["Evaluasi",state.evaluations.length]] : [["Check-in",state.attendance.length],["Jurnal",state.journals.length],["Penempatan",state.student?.partnerId?"Aktif":"Belum"],["Evaluasi",state.evaluations.length]];
  const sm = stats.map(([l, v], i) => `<article class="stat"><div class="stat-label">${l}</div><strong class="stat-value">${esc(v)}</strong><div class="stat-foot">${["01","02","03","04"][i]}</div></article>`).join("");
  const recent = role === "student" ? [...state.journals].sort((a,b) => String(b.date).localeCompare(String(a.date))).slice(0,4) : [...state.journals].sort((a,b) => Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,4);
  const rr = recent.map(item => `<div class="queue-item"><span class="queue-index">${esc(item.date||"—")}</span><div><div class="queue-title">${esc(item.activity||"Jurnal kegiatan")}</div><div class="queue-meta">${esc(item.studentName||state.profile.fullName||"")}</div></div>${statusChip(item.status)}</div>`).join("");
  return `${heading(roleLabels[role], role==="student"?"Kegiatan PKL saya":"Ringkasan sistem", welcome, actions)}<div class="stat-grid">${sm}</div><div class="content-grid"><section class="panel"><div class="panel-head"><div><h2>Jurnal terbaru</h2><p>Data terkini dari Firebase</p></div><button class="link-button" data-page="${role==="admin"?"evaluation":"journals"}">Lihat semua</button></div><div class="panel-body">${rr||empty("Belum ada jurnal",role==="student"?"Tulis jurnal kegiatan pertama Anda.":"Jurnal yang dikirim akan muncul di sini.")}</div></section><section class="panel"><div class="panel-head"><div><h2>${role==="student"?"Tempat PKL":"Periode PKL"}</h2><p>${esc(role==="student"?state.assignedPartner?.name||"Belum ditempatkan":state.period.name||"Belum diatur")}</p></div></div><div class="panel-body">${role==="student"?(state.assignedPartner?esc(state.assignedPartner.address||"Alamat belum dicatat"):empty("Penempatan belum tersedia","Administrator akan mengatur mitra dan pembimbing Anda.")):(state.period.startDate?`${dateText(state.period.startDate)} – ${dateText(state.period.endDate)}`:empty("Periode belum tersedia","Administrator dapat mengatur periode di menu Pengaturan."))}</div></section></div>`;
}

function renderAccounts() {
  const rows = state.users.map(u => `<tr><td data-label="Nama"><strong>${esc(u.fullName||"—")}</strong><div class="table-sub">${esc(u.email||"")}</div></td><td data-label="Peran">${esc(roleLabels[u.role]||u.role)}${u.mentorType?` · ${u.mentorType==="school"?"Sekolah":"Industri"}`:""}</td><td data-label="Status">${statusChip(u.active?"Aktif":"Nonaktif")}</td><td data-label="Tindakan"><button class="link-button" data-action="reset-password" data-email="${esc(u.email||"")}">Kirim reset sandi</button></td></tr>`);
  const setup = `<section class="panel"><div class="panel-head"><div><h2>Menambahkan pengguna</h2><p>Akun baru dibuat melalui Firebase Console.</p></div></div><div class="panel-body"><ol><li>Buat akun di Authentication → Users → Add user.</li><li>Salin UID dan buat profil di Realtime Database pada <code>users/{UID}</code>.</li><li>Isi peran, nama, email, dan status aktif sesuai panduan setup.</li><li>Untuk siswa, buat juga data penempatan awal di <code>students/{UID}</code>.</li></ol></div></section>`;
  return `${heading("Administrasi","Akun pengguna","Kelola profil dan kirim tautan reset kata sandi.")}${setup}<section class="panel">${dataTable(["Nama","Peran","Status","Tindakan"],rows,"Belum ada akun tambahan","Akun yang dibuat di Firebase Console akan tercatat di sini.")}</section>`;
}

function renderStudents() {
  const rows = state.students.map(s => { const p = state.partners.find(x => x.id === s.partnerId); return `<tr><td data-label="Siswa"><strong>${esc(s.fullName||"—")}</strong><div class="table-sub">${esc(s.className||"Kelas belum diatur")}</div></td><td data-label="Tempat praktik">${esc(p?.name||"Belum ditempatkan")}</td><td data-label="Status">${statusChip(s.status)}</td><td data-label="Tindakan"><button class="link-button" data-action="assign-student" data-id="${esc(s.id)}">Atur penempatan</button></td></tr>`; });
  return `${heading("Administrasi","Siswa & penempatan","Tempatkan siswa ke mitra dan tentukan pembimbing.",`<button class="button secondary" data-page="accounts">Panduan akun</button>`)}<section class="panel">${dataTable(["Siswa","Tempat praktik","Status","Tindakan"],rows,"Belum ada siswa","Buat akun dan profil siswa melalui Firebase Console, lalu atur penempatannya di sini.")}</section>`;
}

function renderPartners() {
  const rows = state.partners.map(p => `<tr><td data-label="Mitra"><strong>${esc(p.name)}</strong><div class="table-sub">${esc(p.address||"")}</div></td><td data-label="Kontak">${esc(p.contactName||"—")}<div class="table-sub">${esc(p.phone||"")}</div></td><td data-label="Tindakan"><button class="link-button" data-action="edit-partner" data-id="${esc(p.id)}">Ubah</button> <button class="link-button" data-action="delete-partner" data-id="${esc(p.id)}">Hapus</button></td></tr>`);
  return `${heading("Administrasi","Mitra industri","Kelola tempat praktik dan informasi kontak.",`<button class="button" data-action="add-partner">＋ Tambah mitra</button>`)}<section class="panel">${dataTable(["Mitra","Kontak","Tindakan"],rows,"Belum ada mitra","Tambahkan mitra industri untuk mengatur penempatan.")}</section>`;
}

function renderAttendance() {
  const role = state.profile.role;
  const rows = [...state.attendance].sort((a,b) => String(b.date).localeCompare(String(a.date))).map(item => {
    const rev = role === "mentor" ? reviewStatus(item, state.profile.mentorType) : combinedReviewStatus(item, "attendance");
    const act = role === "mentor" && rev === "Menunggu" ? `<button class="mini-action primary" data-action="review-attendance" data-id="${esc(item.id)}">Tinjau</button>` : "";
    return `<tr><td data-label="Siswa"><strong>${esc(role==="student"?state.profile.fullName:getStudentName(item.studentUid))}</strong></td><td data-label="Tanggal">${dateText(item.date)}<div class="table-sub">${esc(item.time||"")}</div></td><td data-label="Status">${statusChip(rev)}</td><td data-label="Tindakan">${act||"—"}</td></tr>`;
  });
  const act = role === "student" ? `<button class="button" data-action="checkin">Check-in hari ini</button>` : `<button class="button secondary" data-action="export">Ekspor CSV</button>`;
  return `${heading("Kehadiran","Catatan kehadiran",role==="student"?"Check-in tercatat dengan waktu server pada akun Anda.":"Periksa kehadiran siswa yang ditugaskan kepada Anda.",act)}<section class="panel">${dataTable(["Siswa","Tanggal","Status","Tindakan"],rows,"Belum ada kehadiran",role==="student"?"Lakukan check-in saat mulai kegiatan PKL.":"Catatan siswa bimbingan akan muncul di sini.")}</section>`;
}

function renderJournals() {
  const role = state.profile.role;
  const rows = [...state.journals].sort((a,b) => String(b.date).localeCompare(String(a.date))).map(item => {
    const myRev = state.profile.mentorType === "school" ? item.schoolReview : item.industryReview;
    const status = role === "student" ? combinedReviewStatus(item, "journal") : myRev?.status || "Menunggu";
    const act = role === "mentor" && status === "Menunggu" ? `<button class="mini-action primary" data-action="review-journal" data-id="${esc(item.id)}">Tinjau</button>` : "";
    const fb = role === "student" ? [item.schoolReview?.note, item.industryReview?.note].filter(Boolean).join(" · ") || "—" : myRev?.note || "—";
    return `<tr><td data-label="Siswa"><strong>${esc(role==="student"?state.profile.fullName:getStudentName(item.studentUid))}</strong><div class="table-sub">${dateText(item.date)} · ${esc(item.hours||"")}</div></td><td data-label="Kegiatan">${esc(item.activity)}</td><td data-label="Status">${statusChip(status)}</td><td data-label="Tindakan">${act||esc(fb)}</td></tr>`;
  });
  const act = role === "student" ? `<button class="button" data-action="open-journal">＋ Tulis jurnal</button>` : "";
  return `${heading("Jurnal kegiatan","Jurnal harian",role==="student"?"Catat kegiatan yang benar-benar dilakukan selama PKL.":"Tinjau jurnal siswa dan berikan status serta catatan.",act)}<section class="panel">${dataTable(["Siswa","Kegiatan","Status","Tindakan"],rows,"Belum ada jurnal",role==="student"?"Jurnal yang dikirim akan muncul di sini.":"Belum ada jurnal yang perlu ditinjau.")}</section>`;
}

function renderEvaluation() {
  const role = state.profile.role;
  if (role === "student") {
    const rows = state.evaluations.map(item => `<tr><td data-label="Pembimbing">${item.mentorType==="school"?"Guru sekolah":"Pembimbing industri"}</td><td data-label="Nilai"><strong>${esc(item.score)}</strong> / 100</td><td data-label="Catatan">${esc(item.comment||"—")}</td></tr>`);
    return `${heading("Perkembangan","Evaluasi & laporan","Lihat hasil penilaian yang disimpan pembimbing.")}<section class="panel">${dataTable(["Pembimbing","Nilai","Catatan"],rows,"Belum ada hasil evaluasi","Penilaian akan terlihat setelah pembimbing menyimpannya.")}</section>`;
  }
  if (role === "admin") {
    const rows = state.evaluations.map(item => `<tr><td data-label="Siswa"><strong>${esc(getStudentName(item.studentUid))}</strong></td><td data-label="Pembimbing">${item.mentorType==="school"?"Guru sekolah":"Industri"}</td><td data-label="Nilai">${esc(item.score)} / 100</td><td data-label="Catatan">${esc(item.comment||"—")}</td></tr>`);
    return `${heading("Administrasi","Evaluasi & laporan","Rekap nilai yang disimpan pembimbing.",`<button class="button secondary" data-action="export">Ekspor CSV</button>`)}<section class="panel">${dataTable(["Siswa","Pembimbing","Nilai","Catatan"],rows,"Belum ada evaluasi","Nilai dari pembimbing akan tercatat di sini.")}</section>`;
  }
  const rows = state.students.map(s => { const mine = state.evaluations.find(e => e.studentUid === s.id); return `<tr><td data-label="Siswa"><strong>${esc(s.fullName)}</strong><div class="table-sub">${esc(s.className||"")}</div></td><td data-label="Nilai">${mine?`${esc(mine.score)} / 100`:"Belum dinilai"}</td><td data-label="Catatan">${esc(mine?.comment||"—")}</td><td data-label="Tindakan"><button class="link-button" data-action="evaluate-student" data-id="${esc(s.id)}">${mine?"Ubah nilai":"Beri nilai"}</button></td></tr>`; });
  return `${heading("Pembimbing","Evaluasi siswa","Simpan penilaian dan catatan berdasarkan kegiatan PKL.")}<section class="panel">${dataTable(["Siswa","Nilai","Catatan","Tindakan"],rows,"Belum ada siswa bimbingan","Siswa yang ditugaskan akan muncul di sini.")}</section>`;
}

function renderSettings() {
  if (state.profile.role !== "admin") return renderEvaluation();
  return `${heading("Administrasi","Pengaturan periode","Atur rentang tanggal periode PKL aktif.")}<section class="panel"><form id="settingsForm"><div class="form-grid"><div class="form-field"><label for="periodName">Nama periode</label><input id="periodName" name="name" required value="${esc(state.period.name||"")}" placeholder="Contoh: 2026/2027"></div><div class="form-field"><label for="periodStatus">Status</label><select id="periodStatus" name="status"><option value="Persiapan" ${state.period.status==="Persiapan"?"selected":""}>Persiapan</option><option value="Aktif" ${state.period.status==="Aktif"?"selected":""}>Aktif</option><option value="Selesai" ${state.period.status==="Selesai"?"selected":""}>Selesai</option></select></div><div class="form-field"><label for="startDate">Tanggal mulai</label><input id="startDate" name="startDate" type="date" value="${esc(state.period.startDate||"")}" required></div><div class="form-field"><label for="endDate">Tanggal berakhir</label><input id="endDate" name="endDate" type="date" value="${esc(state.period.endDate||"")}" required></div></div><div class="form-footer"><button class="button" type="submit">Simpan periode</button></div></form></section>`;
}

function render() {
  if (!state.profile) return;
  const role = state.profile.role;
  if (!navItems[role].some(([k]) => k === state.page)) state.page = "overview";
  $("#appShell").dataset.canvasRole = role;
  $("#mainContent").className = `main role-canvas role-canvas--${role}`;
  $("#mainContent").setAttribute("aria-label", `${roleLabels[role]} · ruang kerja`);
  $("#crumbCurrent").textContent = pageNames[state.page] || "Ringkasan";
  renderNav();
  const content = state.page==="overview"?renderDashboard():state.page==="accounts"&&role==="admin"?renderAccounts():state.page==="students"&&role==="admin"?renderStudents():state.page==="partners"&&role==="admin"?renderPartners():state.page==="attendance"?renderAttendance():state.page==="journals"?renderJournals():state.page==="evaluation"||state.page==="reports"?renderEvaluation():renderSettings();
  $("#mainContent").innerHTML = content;
  $("#dateNow").textContent = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
}

function openModal(t, d, kind, fields) { state.formKind = kind; $("#recordModalTitle").textContent = t; $("#recordModalDescription").textContent = d; $("#recordFormFields").innerHTML = fields; $("#recordModal").hidden = false; $("#recordModal").querySelector("input,select,textarea")?.focus(); }
function closeRecordModal() { $("#recordModal").hidden = true; $("#mainContent").focus(); }

function partnerForm(p = {}) {
  openModal(p.id?"Ubah mitra":"Tambah mitra industri","Informasi ini dapat digunakan untuk penempatan siswa.","partner",`<div class="form-field"><label for="partnerName">Nama mitra</label><input id="partnerName" name="name" required maxlength="120" value="${esc(p.name||"")}"></div><div class="form-field"><label for="partnerContact">Nama kontak</label><input id="partnerContact" name="contactName" maxlength="100" value="${esc(p.contactName||"")}"></div><div class="form-field"><label for="partnerPhone">Nomor telepon</label><input id="partnerPhone" name="phone" type="tel" maxlength="30" value="${esc(p.phone||"")}"></div><div class="form-field full"><label for="partnerAddress">Alamat</label><textarea id="partnerAddress" name="address" maxlength="300">${esc(p.address||"")}</textarea></div>`);
  $("#recordForm").dataset.id = p.id || "";
}

function assignmentForm(student) {
  const po = [`<option value="">Pilih mitra</option>`, ...state.partners.map(p => `<option value="${esc(p.id)}" ${p.id===student.partnerId?"selected":""}>${esc(p.name)}</option>`)].join("");
  const mo = [`<option value="">Belum ditentukan</option>`, ...state.users.filter(u => u.role==="mentor").map(u => `<option value="${esc(u.id)}">${esc(u.fullName)} · ${u.mentorType==="school"?"Sekolah":"Industri"}</option>`)].join("");
  openModal("Atur penempatan",`Penempatan untuk ${student.fullName}.`,"assignment",`<div class="form-field"><label for="assignPartner">Mitra industri</label><select id="assignPartner" name="partnerId" required>${po}</select></div><div class="form-field"><label for="assignStatus">Status</label><select id="assignStatus" name="status"><option ${student.status==="Aktif"?"selected":""}>Aktif</option><option ${student.status==="Perlu penempatan"?"selected":""}>Perlu penempatan</option><option ${student.status==="Selesai"?"selected":""}>Selesai</option></select></div><div class="form-field"><label for="schoolMentor">Guru pembimbing</label><select id="schoolMentor" name="schoolMentorUid" required>${mo}</select></div><div class="form-field"><label for="industryMentor">Pembimbing industri</label><select id="industryMentor" name="industryMentorUid" required>${mo}</select></div>`);
  $("#recordForm").dataset.id = student.id;
  const ss = $("#schoolMentor"), is = $("#industryMentor");
  ss.value = student.schoolMentorUid || ""; is.value = student.industryMentorUid || "";
  [...ss.options].forEach(o => { if (o.value && state.users.find(u => u.id===o.value)?.mentorType !== "school") o.disabled = true; });
  [...is.options].forEach(o => { if (o.value && state.users.find(u => u.id===o.value)?.mentorType !== "industry") o.disabled = true; });
}

function reviewForm(kind, record) {
  openModal(kind==="attendance"?"Tinjau kehadiran":"Tinjau jurnal","Simpan keputusan tinjauan Anda.",`review-${kind}`,`<div class="form-field"><label for="reviewStatus">Keputusan</label><select id="reviewStatus" name="status"><option>Disetujui</option><option>Perlu revisi</option></select></div><div class="form-field full"><label for="reviewNote">Catatan</label><textarea id="reviewNote" name="note" maxlength="500" placeholder="Catatan untuk siswa (opsional)"></textarea></div>`);
  $("#recordForm").dataset.id = record.id;
}

function evaluationForm(student) {
  const ex = state.evaluations.find(e => e.studentUid===student.id && e.mentorUid===state.user.uid);
  openModal(ex?"Ubah penilaian":"Beri penilaian",`Penilaian untuk ${student.fullName}.`,"evaluation",`<div class="form-field"><label for="evaluationScore">Nilai (0–100)</label><input id="evaluationScore" name="score" type="number" min="0" max="100" step="1" required value="${esc(ex?.score??"")}"></div><div class="form-field full"><label for="evaluationComment">Catatan pembimbing</label><textarea id="evaluationComment" name="comment" maxlength="1000" required>${esc(ex?.comment||"")}</textarea></div>`);
  $("#recordForm").dataset.studentUid = student.id;
}

async function checkIn() {
  if (!state.student) throw new Error("Profil siswa belum dibuat. Hubungi administrator.");
  if (!state.student.partnerId || !state.student.schoolMentorUid || !state.student.industryMentorUid) throw new Error("Penempatan mitra dan kedua pembimbing harus diatur sebelum check-in.");
  if (state.period.status !== "Aktif" || !state.period.startDate || !state.period.endDate) throw new Error("Periode PKL belum diatur atau belum aktif.");
  const date = dateKey();
  if (date < state.period.startDate || date > state.period.endDate) throw new Error("Check-in hanya tersedia selama periode PKL aktif.");
  const time = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const aRef = api.ref(db, `attendance/${state.user.uid}/${date}`);
  const ex = await api.get(aRef);
  if (ex.exists()) { toast("Check-in hari ini sudah tercatat."); return; }
  try {
    await api.set(aRef, { studentUid: state.user.uid, studentName: state.profile.fullName, date, time, reviewerUids: state.student.mentorUids || {}, schoolMentorUid: state.student.schoolMentorUid, industryMentorUid: state.student.industryMentorUid, status: "Menunggu", schoolStatus: "Menunggu", industryStatus: "Menunggu", createdAt: api.serverTimestamp() });
    toast("Check-in tersimpan.");
  } catch (e) { const dup = await api.get(aRef).catch(() => null); if (dup?.exists()) { toast("Check-in hari ini sudah tercatat."); return; } throw e; }
}

async function submitJournal(form) {
  if (!state.student) throw new Error("Profil siswa belum dibuat. Hubungi administrator.");
  if (!state.student.partnerId || !state.student.schoolMentorUid || !state.student.industryMentorUid) throw new Error("Penempatan mitra dan kedua pembimbing harus diatur sebelum mengirim jurnal.");
  const vals = new FormData(form);
  const activity = String(vals.get("activity") || "").trim();
  const aDate = String(vals.get("date") || "");
  if (activity.length < 12) throw new Error("Uraian kegiatan minimal 12 karakter.");
  if (aDate > dateKey()) throw new Error("Jurnal tidak dapat dikirim untuk tanggal yang akan datang.");
  if (state.period.status !== "Aktif" || aDate < state.period.startDate || aDate > state.period.endDate) throw new Error("Tanggal jurnal harus berada dalam periode PKL yang sedang aktif.");
  const jRef = api.push(api.ref(db, `journals/${state.user.uid}`));
  await api.set(jRef, { id: jRef.key, studentUid: state.user.uid, studentName: state.profile.fullName, date: String(vals.get("date")), hours: String(vals.get("hours")), activity, proof: String(vals.get("proof") || "").trim(), reviewerUids: state.student.mentorUids || {}, schoolMentorUid: state.student.schoolMentorUid || "", industryMentorUid: state.student.industryMentorUid || "", status: "Menunggu", schoolReview: { status: "Menunggu", note: "" }, industryReview: { status: "Menunggu", note: "" }, createdAt: api.serverTimestamp() });
  form.reset(); $("#journalModal").hidden = true; toast("Jurnal berhasil disimpan dan menunggu tinjauan.");
}

async function submitRecord(form) {
  const vals = new FormData(form);
  const data = Object.fromEntries(vals.entries());
  if (state.formKind === "partner") {
    const id = form.dataset.id;
    const r = id ? api.ref(db, `partners/${id}`) : api.push(api.ref(db, "partners"));
    await api.set(r, { name: data.name.trim(), contactName: data.contactName.trim(), phone: data.phone.trim(), address: data.address.trim(), updatedAt: api.serverTimestamp(), createdAt: id ? state.partners.find(p => p.id===id)?.createdAt || api.serverTimestamp() : api.serverTimestamp() });
    toast("Data mitra berhasil disimpan.");
  } else if (state.formKind === "assignment") {
    const student = state.students.find(s => s.id===form.dataset.id);
    const partner = state.partners.find(p => p.id===data.partnerId);
    if (!student || !partner) throw new Error("Siswa atau mitra tidak ditemukan.");
    if (!data.schoolMentorUid || !data.industryMentorUid || data.schoolMentorUid===data.industryMentorUid) throw new Error("Pilih dua akun pembimbing yang berbeda.");
    const sm = state.users.find(u => u.id===data.schoolMentorUid);
    const im = state.users.find(u => u.id===data.industryMentorUid);
    if (sm?.role!=="mentor"||sm.mentorType!=="school"||!sm.active||im?.role!=="mentor"||im.mentorType!=="industry"||!im.active) throw new Error("Pilih akun pembimbing aktif dengan jenis yang sesuai.");
    const mentorUids = { [data.schoolMentorUid]: true, [data.industryMentorUid]: true };
    const sd = { ...student }; delete sd.id;
    const ch = { [`students/${student.id}`]: { ...sd, partnerId: partner.id, schoolMentorUid: data.schoolMentorUid, industryMentorUid: data.industryMentorUid, mentorUids, status: data.status, updatedAt: api.serverTimestamp() } };
    for (const mu of [student.schoolMentorUid, student.industryMentorUid].filter(Boolean)) { if (mu!==data.schoolMentorUid && mu!==data.industryMentorUid) ch[`mentorStudents/${mu}/${student.id}`] = null; }
    ch[`mentorStudents/${data.schoolMentorUid}/${student.id}`] = true;
    ch[`mentorStudents/${data.industryMentorUid}/${student.id}`] = true;
    await api.update(api.ref(db), ch); toast("Penempatan siswa berhasil diperbarui.");
  } else if (state.formKind.startsWith("review-")) {
    const kind = state.formKind.slice("review-".length);
    const mt = state.profile.mentorType;
    const rec = kind==="attendance" ? state.attendance.find(r => r.id===form.dataset.id) : state.journals.find(r => r.id===form.dataset.id);
    if (!rec) throw new Error("Catatan tidak ditemukan.");
    const path = kind==="attendance" ? `attendance/${rec.studentUid}/${rec.date}` : `journals/${rec.studentUid}/${rec.id}`;
    const field = kind==="attendance" ? (mt==="school"?"schoolStatus":"industryStatus") : (mt==="school"?"schoolReview":"industryReview");
    const val = kind==="attendance" ? data.status : { status: data.status, note: String(data.note||"").trim(), reviewedAt: api.serverTimestamp(), reviewerUid: state.user.uid };
    await api.update(api.ref(db, path), { [field]: val, updatedAt: api.serverTimestamp() }); toast("Tinjauan berhasil disimpan.");
  } else if (state.formKind === "evaluation") {
    const sUid = form.dataset.studentUid;
    await api.set(api.ref(db, `evaluations/${sUid}/${state.user.uid}`), { studentUid: sUid, mentorUid: state.user.uid, mentorType: state.profile.mentorType, score: Number(data.score), comment: String(data.comment).trim(), updatedAt: api.serverTimestamp() });
    toast("Penilaian berhasil disimpan.");
  }
}

function exportCsv() {
  let h, v;
  if (state.page === "evaluation") { h = ["Siswa","Pembimbing","Nilai","Catatan"]; v = state.evaluations.map(i => [getStudentName(i.studentUid), i.mentorType==="school"?"Guru sekolah":"Pembimbing industri", i.score, i.comment||""]); }
  else if (state.page === "attendance") { h = ["Tanggal","Siswa","Status"]; v = state.attendance.map(i => [i.date, getStudentName(i.studentUid), reviewStatus(i, state.profile.mentorType)]); }
  else { h = ["Nama","Kelas","Mitra","Status"]; v = state.students.map(i => [i.fullName, i.className||"", state.partners.find(p=>p.id===i.partnerId)?.name||"", i.status]); }
  const csv = [h, ...v].map(r => r.map(x => `"${String(x??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  a.download = `laporan-pkl-${dateKey()}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

document.addEventListener("click", async event => {
  const t = event.target.closest("button");
  if (!t) { if (event.target===$( "#journalModal")) $("#journalModal").hidden=true; if (event.target===$("#recordModal")) closeRecordModal(); return; }
  try {
    if (t.dataset.page) { state.page=t.dataset.page; render(); $("#mainContent").focus(); return; }
    const act = t.dataset.action;
    if (act==="logout") { t.disabled=true; await api.signOut(auth); stopListeners(); state.user=null; state.profile=null; clearAccountData(); state.page="overview"; toggleWorkspace(false); $("#loginPassword").value=""; showLoginMessage(""); }
    else if (act==="open-journal") { $("#journalDate").value=dateKey(); $("#journalDate").max=dateKey(); $("#journalModal").hidden=false; $("#journalActivity").focus(); }
    else if (act==="close-modal") $("#journalModal").hidden=true;
    else if (act==="close-record") closeRecordModal();
    else if (act==="checkin") { t.disabled=true; try { await checkIn(); } finally { t.disabled=false; } }
    else if (act==="add-partner") partnerForm();
    else if (act==="edit-partner") { const p=state.partners.find(x=>x.id===t.dataset.id); if(p) partnerForm(p); }
    else if (act==="delete-partner") { if(state.students.some(s=>s.partnerId===t.dataset.id)) throw new Error("Mitra masih digunakan oleh penempatan siswa."); const p=state.partners.find(x=>x.id===t.dataset.id); if(p&&window.confirm(`Hapus mitra "${p.name}"?`)){ await api.remove(api.ref(db,`partners/${p.id}`)); toast("Mitra dihapus."); } }
    else if (act==="assign-student") { const s=state.students.find(x=>x.id===t.dataset.id); if(s) assignmentForm(s); }
    else if (act==="review-attendance") { const i=state.attendance.find(r=>r.id===t.dataset.id); if(i) reviewForm("attendance",i); }
    else if (act==="review-journal") { const i=state.journals.find(r=>r.id===t.dataset.id); if(i) reviewForm("journal",i); }
    else if (act==="evaluate-student") { const s=state.students.find(x=>x.id===t.dataset.id); if(s) evaluationForm(s); }
    else if (act==="reset-password") { const em=t.dataset.email; if(em){ await api.sendPasswordResetEmail(auth,em); toast(`Tautan reset dikirim ke ${em}.`); } }
    else if (act==="export") exportCsv();
  } catch (e) { console.error(e); toast(e.message||"Aksi gagal."); const sub=$("#recordSubmit"); if(sub) sub.disabled=false; }
});

document.addEventListener("submit", async event => {
  const form = event.target;
  if (form.id==="loginForm") {
    event.preventDefault(); loginInProgress=true; setBusy(true); showLoginMessage("Memeriksa akun dan peran…");
    try { const c=await api.signInWithEmailAndPassword(auth,$("#loginEmail").value.trim(),$("#loginPassword").value); await enterWorkspace(c.user); showLoginMessage(""); $("#loginPassword").value=""; }
    catch (e) { console.error(e); if(auth.currentUser) await api.signOut(auth); showLoginMessage(authErrorMessage(e),true); }
    finally { loginInProgress=false; setBusy(false); } return;
  }
  if (form.id==="journalForm") { event.preventDefault(); try { await submitJournal(form); } catch(e) { toast(e.message||"Jurnal gagal disimpan."); } return; }
  if (form.id==="recordForm") {
    event.preventDefault(); const sub=$("#recordSubmit"); sub.disabled=true;
    try { await submitRecord(form); form.reset(); closeRecordModal(); } catch(e) { console.error(e); toast(e.message||"Data gagal disimpan."); } finally { sub.disabled=false; } return;
  }
  if (form.id==="settingsForm") {
    event.preventDefault(); const v=new FormData(form); const sd=String(v.get("startDate")), ed=String(v.get("endDate"));
    if(ed<sd){ toast("Tanggal berakhir tidak boleh lebih awal dari tanggal mulai."); return; }
    try { await api.set(api.ref(db,"settings/period"),{name:String(v.get("name")).trim(),status:String(v.get("status")),startDate:sd,endDate:ed,updatedAt:api.serverTimestamp()}); toast("Periode PKL berhasil disimpan."); }
    catch(e){ console.error(e); toast(e.message||"Periode gagal disimpan."); }
  }
});

$("#resetPassword").addEventListener("click", async () => {
  const em = $("#loginEmail").value.trim();
  if (!em) { showLoginMessage("Isi email akun terlebih dahulu.", true); $("#loginEmail").focus(); return; }
  try { await api.sendPasswordResetEmail(auth, em); showLoginMessage("Jika email terdaftar, tautan reset kata sandi telah dikirim."); }
  catch (e) { showLoginMessage("Tautan reset gagal dikirim. Periksa alamat email.", true); }
});

document.addEventListener("keydown", e => { if (e.key==="Escape") { $("#journalModal").hidden=true; if(!$("#recordModal").hidden) closeRecordModal(); } });

api.onAuthStateChanged(auth, user => { void processSession(user); });
