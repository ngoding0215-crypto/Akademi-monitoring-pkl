import { api, auth, db } from "./firebase-client.js";

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
})[char]);
const dateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const dateText = value => value ? new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric", month: "short", year: "numeric"
}).format(typeof value === "string" ? new Date(`${value}T00:00:00+07:00`) : new Date(Number(value))) : "—";
const timestampText = value => value ? new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
}).format(new Date(Number(value))) : "—";
const roleLabels = { admin: "Admin", mentor: "Pembimbing", student: "Siswa" };
const state = {
  user: null,
  profile: null,
  page: "overview",
  users: [],
  students: [],
  partners: [],
  attendance: [],
  journals: [],
  evaluations: [],
  period: {},
  student: null,
  assignedPartner: null,
  assignedPartnerId: "",
  unsubscribers: [],
  formKind: ""
};
let loginInProgress = false;
let handledUid = "";
let toastTimer;
let assignedPartnerUnsubscribe;
let mentorRecordUnsubscribers = new Map();

const navItems = {
  admin: [["overview", "Ringkasan"], ["accounts", "Akun pengguna"], ["students", "Siswa & penempatan"], ["partners", "Mitra industri"], ["evaluation", "Evaluasi & laporan"], ["settings", "Pengaturan periode"]],
  mentor: [["overview", "Ringkasan"], ["attendance", "Kehadiran"], ["journals", "Jurnal harian"], ["evaluation", "Evaluasi siswa"]],
  student: [["overview", "Ringkasan"], ["attendance", "Kehadiran"], ["journals", "Jurnal harian"], ["reports", "Evaluasi & laporan"]]
};
const pageNames = Object.fromEntries(Object.values(navItems).flat());

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function authErrorMessage(error) {
  const messages = {
    "auth/invalid-credential": "Email atau kata sandi tidak cocok.",
    "auth/invalid-email": "Format email belum benar.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi beberapa saat.",
    "auth/user-disabled": "Akun dinonaktifkan. Hubungi administrator.",
    "auth/network-request-failed": "Koneksi internet bermasalah. Periksa jaringan lalu coba lagi.",
    "auth/operation-not-allowed": "Login email/kata sandi belum diaktifkan di Firebase Console."
  };
  return messages[error.code] || error.message || "Login gagal. Periksa akun dan koneksi.";
}

function showLoginMessage(message, error = false) {
  const feedback = $("#loginFeedback");
  feedback.textContent = message;
  feedback.hidden = !message;
  if (error) feedback.dataset.error = "true";
  else feedback.removeAttribute("data-error");
}

function stopListeners() {
  state.unsubscribers.forEach(unsubscribe => unsubscribe());
  state.unsubscribers = [];
  assignedPartnerUnsubscribe?.();
  assignedPartnerUnsubscribe = null;
  mentorRecordUnsubscribers.forEach(unsubscribe => unsubscribe());
  mentorRecordUnsubscribers = new Map();
}

function clearAccountData() {
  state.users = [];
  state.students = [];
  state.partners = [];
  state.attendance = [];
  state.journals = [];
  state.evaluations = [];
  state.period = {};
  state.student = null;
  state.assignedPartner = null;
  state.assignedPartnerId = "";
}

function toggleWorkspace(isOpen) {
  $("#loginScreen").hidden = isOpen;
  $("#appShell").hidden = !isOpen;
}

function setBusy(isBusy) {
  $("#loginSubmit").disabled = isBusy;
  $("#loginEmail").disabled = isBusy;
  $("#loginPassword").disabled = isBusy;
  $("#loginSubmit").innerHTML = isBusy ? "Memeriksa akun…" : 'Masuk <span aria-hidden="true">→</span>';
}

async function enterWorkspace(user) {
  const profileSnapshot = await api.get(api.ref(db, `users/${user.uid}`));
  const profile = profileSnapshot.val();
  if (!profile) {
    throw new Error("Akun belum memiliki peran sistem. Minta administrator mengaktifkan akun Anda.");
  }
  if (profile.active !== true || !["admin", "mentor", "student"].includes(profile.role)) {
    throw new Error("Akun tidak aktif atau perannya belum valid. Hubungi administrator.");
  }
  if (profile.role === "mentor" && !["school", "industry"].includes(profile.mentorType)) {
    throw new Error("Jenis pembimbing belum diatur. Hubungi administrator.");
  }

  clearAccountData();
  state.user = user;
  state.profile = { ...profile, uid: user.uid };
  state.page = "overview";
  handledUid = user.uid;
  $("#userName").textContent = profile.fullName || user.displayName || user.email;
  $("#userRole").textContent = profile.role === "mentor"
    ? `Pembimbing · ${profile.mentorType === "school" ? "Guru sekolah" : "Industri"}`
    : roleLabels[profile.role];
  $("#userAvatar").textContent = (profile.fullName || user.email || "U").trim().slice(0, 1).toUpperCase();
  $("#sessionSummary").textContent = `Masuk sebagai ${roleLabels[profile.role]} · ${user.email || ""}`;
  toggleWorkspace(true);
  subscribeData();
  render();
}

async function processSession(user) {
  if (!user) {
    stopListeners();
    state.user = null;
    state.profile = null;
    clearAccountData();
    handledUid = "";
    toggleWorkspace(false);
    return;
  }
  if (loginInProgress || handledUid === user.uid) return;
  try {
    if (user.isAnonymous) {
      await api.signOut(auth);
      showLoginMessage("Sesi anonim lama sudah dihentikan. Masuk dengan akun yang diberikan administrator.", true);
      return;
    }
    await enterWorkspace(user);
  } catch (error) {
    console.error("Gagal memuat profil akun:", error);
    await api.signOut(auth);
    showLoginMessage(error.message || "Tidak dapat memuat profil akun.", true);
  }
}

function addListener(path, apply, label) {
  const unsubscribe = api.onValue(api.ref(db, path), snapshot => {
    apply(snapshot.val());
    render();
  }, error => {
    console.error(`Gagal memuat ${label}:`, error);
    toast(`Data ${label} gagal dimuat. Periksa koneksi dan aturan Realtime Database.`);
  });
  state.unsubscribers.push(unsubscribe);
  return unsubscribe;
}

function toRecords(value, parentId) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([id, record]) => ({
    ...record,
    ...(parentId ? { id, studentUid: parentId } : { id })
  }));
}

function listenCollection(path, key, transform = toRecords) {
  addListener(path, value => {
    state[key] = transform(value);
  }, path);
}

function replaceStudentRecords(key, studentUid, value) {
  state[key] = state[key].filter(record => record.studentUid !== studentUid)
    .concat(toRecords(value, studentUid));
}

function listenMentorStudentRecords(studentUid) {
  const uid = state.user.uid;
  const listeners = [
    [`students/${studentUid}`, value => {
      state.students = state.students.filter(student => student.id !== studentUid);
      if (value) state.students.push({ ...value, id: studentUid });
    }],
    [`attendance/${studentUid}`, value => replaceStudentRecords("attendance", studentUid, value)],
    [`journals/${studentUid}`, value => replaceStudentRecords("journals", studentUid, value)],
    [`evaluations/${studentUid}/${uid}`, value => {
      state.evaluations = state.evaluations.filter(item => item.studentUid !== studentUid);
      if (value) state.evaluations.push({ ...value, id: `${studentUid}_${uid}`, studentUid, mentorUid: uid });
    }]
  ];
  for (const [path, apply] of listeners) {
    const unsubscribe = api.onValue(api.ref(db, path), snapshot => {
      apply(snapshot.val());
      render();
    }, error => {
      console.error(`Gagal memuat ${path}:`, error);
      toast("Data siswa bimbingan gagal dimuat. Periksa aturan Realtime Database.");
    });
    mentorRecordUnsubscribers.set(path, unsubscribe);
  }
}

function subscribeData() {
  stopListeners();
  const uid = state.user.uid;
  const role = state.profile.role;
  if (role === "admin") {
    listenCollection("users", "users");
    listenCollection("students", "students");
    listenCollection("partners", "partners");
    listenCollection("attendance", "attendance", value => Object.entries(value || {}).flatMap(([studentUid, records]) => toRecords(records, studentUid)));
    listenCollection("journals", "journals", value => Object.entries(value || {}).flatMap(([studentUid, records]) => toRecords(records, studentUid)));
    listenCollection("evaluations", "evaluations", value => Object.entries(value || {}).flatMap(([studentUid, records]) =>
      Object.entries(records || {}).map(([mentorUid, record]) => ({ ...record, id: `${studentUid}_${mentorUid}`, studentUid, mentorUid }))
    ));
  } else if (role === "mentor") {
    addListener(`mentorStudents/${uid}`, value => {
      const studentUids = Object.keys(value || {}).filter(studentUid => value[studentUid] === true);
      const assigned = new Set(studentUids);
      for (const [path, unsubscribe] of mentorRecordUnsubscribers) {
        const studentUid = path.split("/")[1];
        if (!assigned.has(studentUid)) {
          unsubscribe();
          mentorRecordUnsubscribers.delete(path);
          state.students = state.students.filter(student => student.id !== studentUid);
          state.attendance = state.attendance.filter(record => record.studentUid !== studentUid);
          state.journals = state.journals.filter(record => record.studentUid !== studentUid);
          state.evaluations = state.evaluations.filter(record => record.studentUid !== studentUid);
        }
      }
      for (const studentUid of studentUids) {
        if (!mentorRecordUnsubscribers.has(`students/${studentUid}`)) listenMentorStudentRecords(studentUid);
      }
    }, "siswa bimbingan");
  } else {
    addListener(`students/${uid}`, value => {
      state.student = value ? { ...value, id: uid } : null;
      const partnerId = state.student?.partnerId || "";
      if (partnerId !== state.assignedPartnerId) {
        state.assignedPartnerId = partnerId;
        state.assignedPartner = null;
        assignedPartnerUnsubscribe?.();
        assignedPartnerUnsubscribe = null;
        if (partnerId) {
          assignedPartnerUnsubscribe = addListener(`partners/${partnerId}`, partner => {
            state.assignedPartner = partner ? { ...partner, id: partnerId } : null;
          }, "mitra penempatan");
        }
      }
    }, "profil siswa");
    listenCollection(`attendance/${uid}`, "attendance", value => toRecords(value, uid));
    listenCollection(`journals/${uid}`, "journals", value => toRecords(value, uid));
    listenCollection(`evaluations/${uid}`, "evaluations", value => Object.entries(value || {}).map(([mentorUid, record]) => ({
      ...record, id: `${uid}_${mentorUid}`, studentUid: uid, mentorUid
    })));
  }
  addListener("settings/period", value => {
    state.period = value || {};
    $("#periodTag").textContent = state.period.name ? state.period.name.toUpperCase() : "PERIODE BELUM DIATUR";
  }, "pengaturan periode");
}

function heading(kicker, title, description, actions = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="heading-desc">${esc(description)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;
}

function statusChip(status) {
  const good = ["Aktif", "Disetujui", "Terverifikasi", "Selesai", "Lengkap"].includes(status);
  return `<span class="status ${good ? "done" : "open"}">${esc(status || "Menunggu")}</span>`;
}

function renderNav() {
  const items = navItems[state.profile.role];
  const markup = items.map(([key, label]) => `<button class="nav-button" data-page="${key}" aria-current="${state.page === key ? "page" : "false"}"><span class="nav-symbol" aria-hidden="true">·</span><span>${label}</span></button>`).join("");
  $("#sideNav").innerHTML = markup;
  $("#mobileNav").style.gridTemplateColumns = `repeat(${items.length}, minmax(0, 1fr))`;
  $("#mobileNav").innerHTML = markup;
}

function empty(title, detail) {
  return `<div class="empty-state"><strong>${esc(title)}</strong>${esc(detail)}</div>`;
}

function renderDashboard() {
  const role = state.profile.role;
  const actions = role === "student"
    ? `<button class="button" data-action="checkin">Check-in hari ini</button><button class="button secondary" data-action="open-journal">Tulis jurnal</button>`
    : role === "admin"
      ? `<button class="button" data-page="accounts">Kelola akun</button>`
      : `<button class="button secondary" data-page="journals">Tinjau jurnal</button>`;
  const welcome = role === "admin"
    ? "Kelola akun, penempatan, mitra, dan hasil PKL."
    : role === "mentor" ? "Tinjau kehadiran, jurnal, dan perkembangan siswa bimbingan."
      : "Catat kehadiran dan kegiatan PKL. Data tersimpan di akun Anda.";
  const stats = role === "admin"
    ? [["Siswa", state.students.length], ["Pembimbing", state.users.filter(item => item.role === "mentor").length], ["Mitra", state.partners.length], ["Jurnal", state.journals.length]]
    : role === "mentor"
      ? [["Siswa bimbingan", state.students.length], ["Kehadiran", state.attendance.length], ["Jurnal", state.journals.length], ["Evaluasi", state.evaluations.length]]
      : [["Check-in", state.attendance.length], ["Jurnal", state.journals.length], ["Penempatan", state.student?.partnerId ? "Aktif" : "Belum"], ["Evaluasi", state.evaluations.length]];
  const statsMarkup = stats.map(([label, value], index) => `<article class="stat"><div class="stat-label">${label}</div><strong class="stat-value">${esc(value)}</strong><div class="stat-foot">${["01", "02", "03", "04"][index]}</div></article>`).join("");
  const recent = role === "student" ? [...state.journals].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 4)
    : [...state.journals].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 4);
  const recentRows = recent.map(item => `<div class="queue-item"><span class="queue-index">${esc(item.date || "—")}</span><div><div class="queue-title">${esc(item.activity || "Jurnal kegiatan")}</div><div class="queue-meta">${esc(item.studentName || state.profile.fullName || "")}</div></div>${statusChip(item.status)}</div>`).join("");
  return `${heading(roleLabels[role], role === "student" ? "Kegiatan PKL saya" : "Ringkasan sistem", welcome, actions)}
    <div class="stat-grid">${statsMarkup}</div>
    <div class="content-grid"><section class="panel"><div class="panel-head"><div><h2>Jurnal terbaru</h2><p>Data terkini dari Firebase</p></div><button class="link-button" data-page="${role === "admin" ? "evaluation" : "journals"}">Lihat semua</button></div><div class="panel-body">${recentRows || empty("Belum ada jurnal", role === "student" ? "Tulis jurnal kegiatan pertama Anda." : "Jurnal yang dikirim akan muncul di sini.")}</div></section>
    <section class="panel"><div class="panel-head"><div><h2>${role === "student" ? "Tempat PKL" : "Periode PKL"}</h2><p>${esc(role === "student" ? state.assignedPartner?.name || "Belum ditempatkan" : state.period.name || "Belum diatur")}</p></div></div><div class="panel-body">${role === "student"
      ? state.assignedPartner ? esc(state.assignedPartner.address || "Alamat belum dicatat") : empty("Penempatan belum tersedia", "Administrator akan mengatur mitra dan pembimbing Anda.")
      : state.period.startDate ? `${dateText(state.period.startDate)} – ${dateText(state.period.endDate)}` : empty("Periode belum tersedia", "Administrator dapat mengatur periode di menu Pengaturan.")}</div></section></div>`;
}

function dataTable(headers, rows, emptyTitle, emptyDetail) {
  if (!rows.length) return empty(emptyTitle, emptyDetail);
  return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function renderAccounts() {
  const rows = state.users.map(user => `<tr><td data-label="Nama"><strong>${esc(user.fullName || "—")}</strong><div class="table-sub">${esc(user.email || "")}</div></td><td data-label="Peran">${esc(roleLabels[user.role] || user.role)}${user.mentorType ? ` · ${user.mentorType === "school" ? "Sekolah" : "Industri"}` : ""}</td><td data-label="Status">${statusChip(user.active ? "Aktif" : "Nonaktif")}</td><td data-label="Tindakan"><button class="link-button" data-action="reset-password" data-email="${esc(user.email || "")}">Kirim reset sandi</button></td></tr>`);
  const setup = `<section class="panel"><div class="panel-head"><div><h2>Menambahkan pengguna</h2><p>Akun baru dibuat melalui Firebase Console.</p></div></div><div class="panel-body"><ol><li>Buat akun di Authentication → Users → Add user.</li><li>Salin UID dan buat profil di Realtime Database pada <code>users/{UID}</code>.</li><li>Isi peran, nama, email, dan status aktif sesuai panduan setup.</li><li>Untuk siswa, buat juga data penempatan awal di <code>students/{UID}</code>.</li></ol></div></section>`;
  return `${heading("Administrasi", "Akun pengguna", "Kelola profil dan kirim tautan reset kata sandi.")}${setup}<section class="panel">${dataTable(["Nama", "Peran", "Status", "Tindakan"], rows, "Belum ada akun tambahan", "Akun yang dibuat di Firebase Console akan tercatat di sini.")}</section>`;
}

function renderStudents() {
  const rows = state.students.map(student => {
    const partner = state.partners.find(item => item.id === student.partnerId);
    return `<tr><td data-label="Siswa"><strong>${esc(student.fullName || "—")}</strong><div class="table-sub">${esc(student.className || "Kelas belum diatur")}</div></td><td data-label="Tempat praktik">${esc(partner?.name || "Belum ditempatkan")}</td><td data-label="Status">${statusChip(student.status)}</td><td data-label="Tindakan"><button class="link-button" data-action="assign-student" data-id="${esc(student.id)}">Atur penempatan</button></td></tr>`;
  });
  return `${heading("Administrasi", "Siswa & penempatan", "Tempatkan siswa ke mitra dan tentukan pembimbing.", `<button class="button secondary" data-page="accounts">Panduan akun</button>`)}<section class="panel">${dataTable(["Siswa", "Tempat praktik", "Status", "Tindakan"], rows, "Belum ada siswa", "Buat akun dan profil siswa melalui Firebase Console, lalu atur penempatannya di sini.")}</section>`;
}

function renderPartners() {
  const rows = state.partners.map(partner => `<tr><td data-label="Mitra"><strong>${esc(partner.name)}</strong><div class="table-sub">${esc(partner.address || "")}</div></td><td data-label="Kontak">${esc(partner.contactName || "—")}<div class="table-sub">${esc(partner.phone || "")}</div></td><td data-label="Tindakan"><button class="link-button" data-action="edit-partner" data-id="${esc(partner.id)}">Ubah</button> <button class="link-button" data-action="delete-partner" data-id="${esc(partner.id)}">Hapus</button></td></tr>`);
  return `${heading("Administrasi", "Mitra industri", "Kelola tempat praktik dan informasi kontak.", `<button class="button" data-action="add-partner">＋ Tambah mitra</button>`)}<section class="panel">${dataTable(["Mitra", "Kontak", "Tindakan"], rows, "Belum ada mitra", "Tambahkan mitra industri untuk mengatur penempatan.")}</section>`;
}

function getStudentName(uid) {
  return state.students.find(student => student.id === uid)?.fullName || uid;
}

function reviewStatus(record, mentorType) {
  if (record.status === "Disetujui" || record.status === "Perlu revisi") return record.status;
  return mentorType === "school" ? record.schoolStatus || "Menunggu" : record.industryStatus || "Menunggu";
}

function combinedReviewStatus(record, kind) {
  const schoolAssigned = Boolean(record.schoolMentorUid);
  const industryAssigned = Boolean(record.industryMentorUid);
  const reviews = [];
  if (schoolAssigned) reviews.push(kind === "attendance" ? record.schoolStatus : record.schoolReview?.status);
  if (industryAssigned) reviews.push(kind === "attendance" ? record.industryStatus : record.industryReview?.status);
  if (!reviews.length) return "Menunggu penempatan";
  if (reviews.includes("Perlu revisi")) return "Perlu revisi";
  if (reviews.every(status => status === "Disetujui")) return "Disetujui";
  return "Menunggu tinjauan";
}

function renderAttendance() {
  const role = state.profile.role;
  const rows = [...state.attendance].sort((a, b) => String(b.date).localeCompare(String(a.date))).map(item => {
    const review = role === "mentor" ? reviewStatus(item, state.profile.mentorType) : combinedReviewStatus(item, "attendance");
    const action = role === "mentor" && review === "Menunggu" ? `<button class="mini-action primary" data-action="review-attendance" data-id="${esc(item.id)}">Tinjau</button>` : "";
    return `<tr><td data-label="Siswa"><strong>${esc(role === "student" ? state.profile.fullName : getStudentName(item.studentUid))}</strong></td><td data-label="Tanggal">${dateText(item.date)}<div class="table-sub">${esc(item.time || "")}</div></td><td data-label="Status">${statusChip(review)}</td><td data-label="Tindakan">${action || "—"}</td></tr>`;
  });
  const action = role === "student" ? `<button class="button" data-action="checkin">Check-in hari ini</button>` : `<button class="button secondary" data-action="export">Ekspor CSV</button>`;
  return `${heading("Kehadiran", "Catatan kehadiran", role === "student" ? "Check-in tercatat dengan waktu server pada akun Anda." : "Periksa kehadiran siswa yang ditugaskan kepada Anda.", action)}<section class="panel">${dataTable(["Siswa", "Tanggal", "Status", "Tindakan"], rows, "Belum ada kehadiran", role === "student" ? "Lakukan check-in saat mulai kegiatan PKL." : "Catatan siswa bimbingan akan muncul di sini.")}</section>`;
}

function renderJournals() {
  const role = state.profile.role;
  const rows = [...state.journals].sort((a, b) => String(b.date).localeCompare(String(a.date))).map(item => {
    const mentorType = state.profile.mentorType;
    const myReview = mentorType === "school" ? item.schoolReview : item.industryReview;
    const status = role === "student" ? combinedReviewStatus(item, "journal") : myReview?.status || "Menunggu";
    const action = role === "mentor" && status === "Menunggu" ? `<button class="mini-action primary" data-action="review-journal" data-id="${esc(item.id)}">Tinjau</button>` : "";
    const feedback = role === "student"
      ? [item.schoolReview?.note, item.industryReview?.note].filter(Boolean).join(" · ") || "—"
      : myReview?.note || "—";
    return `<tr><td data-label="Siswa"><strong>${esc(role === "student" ? state.profile.fullName : getStudentName(item.studentUid))}</strong><div class="table-sub">${dateText(item.date)} · ${esc(item.hours || "")}</div></td><td data-label="Kegiatan">${esc(item.activity)}</td><td data-label="Status">${statusChip(status)}</td><td data-label="Tindakan">${action || esc(feedback)}</td></tr>`;
  });
  const action = role === "student" ? `<button class="button" data-action="open-journal">＋ Tulis jurnal</button>` : "";
  return `${heading("Jurnal kegiatan", "Jurnal harian", role === "student" ? "Catat kegiatan yang benar-benar dilakukan selama PKL." : "Tinjau jurnal siswa dan berikan status serta catatan.", action)}<section class="panel">${dataTable(["Siswa", "Kegiatan", "Status", "Tindakan"], rows, "Belum ada jurnal", role === "student" ? "Jurnal yang dikirim akan muncul di sini." : "Belum ada jurnal yang perlu ditinjau.")}</section>`;
}

function renderEvaluation() {
  const role = state.profile.role;
  const items = role === "admin" ? state.students : role === "mentor" ? state.students : [];
  if (role === "student") {
    const rows = state.evaluations.map(item => `<tr><td data-label="Pembimbing">${item.mentorType === "school" ? "Guru sekolah" : "Pembimbing industri"}</td><td data-label="Nilai"><strong>${esc(item.score)}</strong> / 100</td><td data-label="Catatan">${esc(item.comment || "—")}</td></tr>`);
    return `${heading("Perkembangan", "Evaluasi & laporan", "Lihat hasil penilaian yang disimpan pembimbing.")}<section class="panel">${dataTable(["Pembimbing", "Nilai", "Catatan"], rows, "Belum ada hasil evaluasi", "Penilaian akan terlihat setelah pembimbing menyimpannya.")}</section>`;
  }
  if (role === "admin") {
    const rows = state.evaluations.map(item => `<tr><td data-label="Siswa"><strong>${esc(getStudentName(item.studentUid))}</strong></td><td data-label="Pembimbing">${item.mentorType === "school" ? "Guru sekolah" : "Industri"}</td><td data-label="Nilai">${esc(item.score)} / 100</td><td data-label="Catatan">${esc(item.comment || "—")}</td></tr>`);
    return `${heading("Administrasi", "Evaluasi & laporan", "Rekap nilai yang disimpan pembimbing.", `<button class="button secondary" data-action="export">Ekspor CSV</button>`)}<section class="panel">${dataTable(["Siswa", "Pembimbing", "Nilai", "Catatan"], rows, "Belum ada evaluasi", "Nilai dari pembimbing akan tercatat di sini.")}</section>`;
  }
  const rows = items.map(student => {
    const mine = state.evaluations.find(item => item.studentUid === student.id);
    return `<tr><td data-label="Siswa"><strong>${esc(student.fullName)}</strong><div class="table-sub">${esc(student.className || "")}</div></td><td data-label="Nilai">${mine ? `${esc(mine.score)} / 100` : "Belum dinilai"}</td><td data-label="Catatan">${esc(mine?.comment || "—")}</td><td data-label="Tindakan"><button class="link-button" data-action="evaluate-student" data-id="${esc(student.id)}">${mine ? "Ubah nilai" : "Beri nilai"}</button></td></tr>`;
  });
  return `${heading("Pembimbing", "Evaluasi siswa", "Simpan penilaian dan catatan berdasarkan kegiatan PKL.")}<section class="panel">${dataTable(["Siswa", "Nilai", "Catatan", "Tindakan"], rows, "Belum ada siswa bimbingan", "Siswa yang ditugaskan akan muncul di sini.")}</section>`;
}

function renderSettings() {
  if (state.profile.role !== "admin") return renderEvaluation();
  return `${heading("Administrasi", "Pengaturan periode", "Atur rentang tanggal periode PKL aktif.")}<section class="panel"><form id="settingsForm"><div class="form-grid"><div class="form-field"><label for="periodName">Nama periode</label><input id="periodName" name="name" required value="${esc(state.period.name || "")}" placeholder="Contoh: 2026/2027"></div><div class="form-field"><label for="periodStatus">Status</label><select id="periodStatus" name="status"><option value="Persiapan" ${state.period.status === "Persiapan" ? "selected" : ""}>Persiapan</option><option value="Aktif" ${state.period.status === "Aktif" ? "selected" : ""}>Aktif</option><option value="Selesai" ${state.period.status === "Selesai" ? "selected" : ""}>Selesai</option></select></div><div class="form-field"><label for="startDate">Tanggal mulai</label><input id="startDate" name="startDate" type="date" value="${esc(state.period.startDate || "")}" required></div><div class="form-field"><label for="endDate">Tanggal berakhir</label><input id="endDate" name="endDate" type="date" value="${esc(state.period.endDate || "")}" required></div></div><div class="form-footer"><button class="button" type="submit">Simpan periode</button></div></form></section>`;
}

function render() {
  if (!state.profile) return;
  const role = state.profile.role;
  if (!navItems[role].some(([key]) => key === state.page)) state.page = "overview";
  $("#appShell").dataset.canvasRole = role;
  $("#mainContent").className = `main role-canvas role-canvas--${role}`;
  $("#mainContent").setAttribute("aria-label", `${roleLabels[role]} · ruang kerja`);
  $("#crumbCurrent").textContent = pageNames[state.page] || "Ringkasan";
  renderNav();
  const content = state.page === "overview" ? renderDashboard()
    : state.page === "accounts" && role === "admin" ? renderAccounts()
      : state.page === "students" && role === "admin" ? renderStudents()
        : state.page === "partners" && role === "admin" ? renderPartners()
          : state.page === "attendance" ? renderAttendance()
            : state.page === "journals" ? renderJournals()
              : state.page === "evaluation" || state.page === "reports" ? renderEvaluation()
                : renderSettings();
  $("#mainContent").innerHTML = content;
  $("#dateNow").textContent = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(new Date());
}

function openModal(title, description, kind, fields) {
  state.formKind = kind;
  $("#recordModalTitle").textContent = title;
  $("#recordModalDescription").textContent = description;
  $("#recordFormFields").innerHTML = fields;
  $("#recordModal").hidden = false;
  $("#recordModal").querySelector("input,select,textarea")?.focus();
}

function closeRecordModal() {
  $("#recordModal").hidden = true;
  $("#mainContent").focus();
}

function partnerForm(partner = {}) {
  openModal(partner.id ? "Ubah mitra" : "Tambah mitra industri", "Informasi ini dapat digunakan untuk penempatan siswa.", "partner",
    `<div class="form-field"><label for="partnerName">Nama mitra</label><input id="partnerName" name="name" required maxlength="120" value="${esc(partner.name || "")}"></div>
     <div class="form-field"><label for="partnerContact">Nama kontak</label><input id="partnerContact" name="contactName" maxlength="100" value="${esc(partner.contactName || "")}"></div>
     <div class="form-field"><label for="partnerPhone">Nomor telepon</label><input id="partnerPhone" name="phone" type="tel" maxlength="30" value="${esc(partner.phone || "")}"></div>
     <div class="form-field full"><label for="partnerAddress">Alamat</label><textarea id="partnerAddress" name="address" maxlength="300">${esc(partner.address || "")}</textarea></div>`);
  $("#recordForm").dataset.id = partner.id || "";
}

function assignmentForm(student) {
  const partnerOptions = [`<option value="">Pilih mitra</option>`, ...state.partners.map(item => `<option value="${esc(item.id)}" ${item.id === student.partnerId ? "selected" : ""}>${esc(item.name)}</option>`)].join("");
  const mentorOptions = [`<option value="">Belum ditentukan</option>`, ...state.users.filter(user => user.role === "mentor").map(item => `<option value="${esc(item.id)}">${esc(item.fullName)} · ${item.mentorType === "school" ? "Sekolah" : "Industri"}</option>`)].join("");
  openModal("Atur penempatan", `Penempatan untuk ${student.fullName}.`, "assignment",
    `<div class="form-field"><label for="assignPartner">Mitra industri</label><select id="assignPartner" name="partnerId" required>${partnerOptions}</select></div>
     <div class="form-field"><label for="assignStatus">Status</label><select id="assignStatus" name="status"><option ${student.status === "Aktif" ? "selected" : ""}>Aktif</option><option ${student.status === "Perlu penempatan" ? "selected" : ""}>Perlu penempatan</option><option ${student.status === "Selesai" ? "selected" : ""}>Selesai</option></select></div>
     <div class="form-field"><label for="schoolMentor">Guru pembimbing</label><select id="schoolMentor" name="schoolMentorUid" required>${mentorOptions}</select></div>
     <div class="form-field"><label for="industryMentor">Pembimbing industri</label><select id="industryMentor" name="industryMentorUid" required>${mentorOptions}</select></div>
     <div class="form-field full"><span class="form-help">Pilih pembimbing sesuai jenis akun. Satu akun pembimbing dapat membimbing beberapa siswa.</span></div>`);
  $("#recordForm").dataset.id = student.id;
  const schoolSelect = $("#schoolMentor");
  const industrySelect = $("#industryMentor");
  schoolSelect.value = student.schoolMentorUid || "";
  industrySelect.value = student.industryMentorUid || "";
  [...schoolSelect.options].forEach(option => {
    if (option.value && state.users.find(user => user.id === option.value)?.mentorType !== "school") option.disabled = true;
  });
  [...industrySelect.options].forEach(option => {
    if (option.value && state.users.find(user => user.id === option.value)?.mentorType !== "industry") option.disabled = true;
  });
}

function reviewForm(kind, record) {
  openModal(kind === "attendance" ? "Tinjau kehadiran" : "Tinjau jurnal", "Simpan keputusan tinjauan Anda.", `review-${kind}`,
    `<div class="form-field"><label for="reviewStatus">Keputusan</label><select id="reviewStatus" name="status"><option>Disetujui</option><option>Perlu revisi</option></select></div>
     <div class="form-field full"><label for="reviewNote">Catatan</label><textarea id="reviewNote" name="note" maxlength="500" placeholder="Catatan untuk siswa (opsional)"></textarea></div>`);
  $("#recordForm").dataset.id = record.id;
}

function evaluationForm(student) {
  const existing = state.evaluations.find(item => item.studentUid === student.id && item.mentorUid === state.user.uid);
  openModal(existing ? "Ubah penilaian" : "Beri penilaian", `Penilaian untuk ${student.fullName}.`, "evaluation",
    `<div class="form-field"><label for="evaluationScore">Nilai (0–100)</label><input id="evaluationScore" name="score" type="number" min="0" max="100" step="1" required value="${esc(existing?.score ?? "")}"></div>
     <div class="form-field full"><label for="evaluationComment">Catatan pembimbing</label><textarea id="evaluationComment" name="comment" maxlength="1000" required>${esc(existing?.comment || "")}</textarea></div>`);
  $("#recordForm").dataset.studentUid = student.id;
}

function renderStudentReports() {
  const rows = state.evaluations.map(item => `<tr><td>${item.mentorType === "school" ? "Guru sekolah" : "Pembimbing industri"}</td><td>${esc(item.score)} / 100</td><td>${esc(item.comment || "—")}</td></tr>`);
  return `${heading("Perkembangan", "Evaluasi & laporan", "Lihat penilaian yang tersimpan untuk akun Anda.")}<section class="panel">${dataTable(["Pembimbing", "Nilai", "Catatan"], rows, "Belum ada penilaian", "Hasil akan muncul setelah pembimbing menilainya.")}</section>`;
}

async function checkIn() {
  if (!state.student) throw new Error("Profil siswa belum dibuat. Hubungi administrator.");
  if (!state.student.partnerId || !state.student.schoolMentorUid || !state.student.industryMentorUid) {
    throw new Error("Penempatan mitra dan kedua pembimbing harus diatur sebelum check-in.");
  }
  if (state.period.status !== "Aktif" || !state.period.startDate || !state.period.endDate) {
    throw new Error("Periode PKL belum diatur atau belum aktif.");
  }
  const date = dateKey();
  if (date < state.period.startDate || date > state.period.endDate) {
    throw new Error("Check-in hanya tersedia selama periode PKL aktif.");
  }
  const time = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
  const attendanceRef = api.ref(db, `attendance/${state.user.uid}/${date}`);
  const existing = await api.get(attendanceRef);
  if (existing.exists()) {
    toast("Check-in hari ini sudah tercatat.");
    return;
  }
  try {
    await api.set(attendanceRef, {
      studentUid: state.user.uid,
      studentName: state.profile.fullName,
      date,
      time,
      reviewerUids: state.student.mentorUids || {},
      schoolMentorUid: state.student.schoolMentorUid,
      industryMentorUid: state.student.industryMentorUid,
      status: "Menunggu",
      schoolStatus: "Menunggu",
      industryStatus: "Menunggu",
      createdAt: api.serverTimestamp()
    });
    toast("Check-in tersimpan. Waktu pencatatan mengikuti server; tanggal mengikuti perangkat.");
  } catch (error) {
    const duplicate = await api.get(attendanceRef).catch(() => null);
    if (duplicate?.exists()) {
      toast("Check-in hari ini sudah tercatat.");
      return;
    }
    throw error;
  }
}

async function submitJournal(form) {
  if (!state.student) throw new Error("Profil siswa belum dibuat. Hubungi administrator.");
  if (!state.student.partnerId || !state.student.schoolMentorUid || !state.student.industryMentorUid) {
    throw new Error("Penempatan mitra dan kedua pembimbing harus diatur sebelum mengirim jurnal.");
  }
  const values = new FormData(form);
  const activity = String(values.get("activity") || "").trim();
  const activityDate = String(values.get("date") || "");
  if (activity.length < 12) throw new Error("Uraian kegiatan minimal 12 karakter.");
  if (activityDate > dateKey()) throw new Error("Jurnal tidak dapat dikirim untuk tanggal yang akan datang.");
  if (state.period.status !== "Aktif" || activityDate < state.period.startDate || activityDate > state.period.endDate) {
    throw new Error("Tanggal jurnal harus berada dalam periode PKL yang sedang aktif.");
  }
  const journalRef = api.push(api.ref(db, `journals/${state.user.uid}`));
  await api.set(journalRef, {
    id: journalRef.key,
    studentUid: state.user.uid,
    studentName: state.profile.fullName,
    date: String(values.get("date")),
    hours: String(values.get("hours")),
    activity,
    proof: String(values.get("proof") || "").trim(),
    reviewerUids: state.student.mentorUids || {},
    schoolMentorUid: state.student.schoolMentorUid || "",
    industryMentorUid: state.student.industryMentorUid || "",
    status: "Menunggu",
    schoolReview: { status: "Menunggu", note: "" },
    industryReview: { status: "Menunggu", note: "" },
    createdAt: api.serverTimestamp()
  });
  form.reset();
  $("#journalModal").hidden = true;
  toast("Jurnal berhasil disimpan dan menunggu tinjauan.");
}

async function submitRecord(form) {
  const values = new FormData(form);
  const data = Object.fromEntries(values.entries());
  if (state.formKind === "partner") {
    const id = form.dataset.id;
    const reference = id ? api.ref(db, `partners/${id}`) : api.push(api.ref(db, "partners"));
    await api.set(reference, { name: data.name.trim(), contactName: data.contactName.trim(), phone: data.phone.trim(), address: data.address.trim(), updatedAt: api.serverTimestamp(), createdAt: id ? state.partners.find(partner => partner.id === id)?.createdAt || api.serverTimestamp() : api.serverTimestamp() });
    toast("Data mitra berhasil disimpan.");
  } else if (state.formKind === "assignment") {
    const student = state.students.find(item => item.id === form.dataset.id);
    const partner = state.partners.find(item => item.id === data.partnerId);
    if (!student || !partner) throw new Error("Siswa atau mitra tidak ditemukan.");
    if (!data.schoolMentorUid || !data.industryMentorUid || data.schoolMentorUid === data.industryMentorUid) {
      throw new Error("Pilih dua akun pembimbing yang berbeda.");
    }
    const schoolMentor = state.users.find(user => user.id === data.schoolMentorUid);
    const industryMentor = state.users.find(user => user.id === data.industryMentorUid);
    if (schoolMentor?.role !== "mentor" || schoolMentor.mentorType !== "school" || !schoolMentor.active
      || industryMentor?.role !== "mentor" || industryMentor.mentorType !== "industry" || !industryMentor.active) {
      throw new Error("Pilih akun pembimbing aktif dengan jenis yang sesuai.");
    }
    const mentorUids = { [data.schoolMentorUid]: true, [data.industryMentorUid]: true };
    const studentData = { ...student };
    delete studentData.id;
    const changes = {
      [`students/${student.id}`]: {
        ...studentData,
        partnerId: partner.id,
        schoolMentorUid: data.schoolMentorUid,
        industryMentorUid: data.industryMentorUid,
        mentorUids,
        status: data.status,
        updatedAt: api.serverTimestamp()
      }
    };
    for (const mentorUid of [student.schoolMentorUid, student.industryMentorUid].filter(Boolean)) {
      if (mentorUid !== data.schoolMentorUid && mentorUid !== data.industryMentorUid) {
        changes[`mentorStudents/${mentorUid}/${student.id}`] = null;
      }
    }
    changes[`mentorStudents/${data.schoolMentorUid}/${student.id}`] = true;
    changes[`mentorStudents/${data.industryMentorUid}/${student.id}`] = true;
    await api.update(api.ref(db), changes);
    toast("Penempatan siswa berhasil diperbarui.");
  } else if (state.formKind.startsWith("review-")) {
    const kind = state.formKind.slice("review-".length);
    const mentorType = state.profile.mentorType;
    const record = kind === "attendance"
      ? state.attendance.find(item => item.id === form.dataset.id)
      : state.journals.find(item => item.id === form.dataset.id);
    if (!record) throw new Error("Catatan tidak ditemukan.");
    const path = kind === "attendance"
      ? `attendance/${record.studentUid}/${record.date}`
      : `journals/${record.studentUid}/${record.id}`;
    const field = kind === "attendance" ? mentorType === "school" ? "schoolStatus" : "industryStatus" : mentorType === "school" ? "schoolReview" : "industryReview";
    const value = kind === "attendance" ? data.status : { status: data.status, note: String(data.note || "").trim(), reviewedAt: api.serverTimestamp(), reviewerUid: state.user.uid };
    await api.update(api.ref(db, path), { [field]: value, updatedAt: api.serverTimestamp() });
    toast("Tinjauan berhasil disimpan.");
  } else if (state.formKind === "evaluation") {
    const studentUid = form.dataset.studentUid;
    await api.set(api.ref(db, `evaluations/${studentUid}/${state.user.uid}`), {
      studentUid,
      mentorUid: state.user.uid,
      mentorType: state.profile.mentorType,
      score: Number(data.score),
      comment: String(data.comment).trim(),
      updatedAt: api.serverTimestamp()
    });
    toast("Penilaian berhasil disimpan.");
  }
}

function exportCsv() {
  let headers;
  let values;
  if (state.page === "evaluation") {
    headers = ["Siswa", "Pembimbing", "Nilai", "Catatan"];
    values = state.evaluations.map(item => [
      getStudentName(item.studentUid),
      item.mentorType === "school" ? "Guru sekolah" : "Pembimbing industri",
      item.score,
      item.comment || ""
    ]);
  } else if (state.page === "attendance") {
    headers = ["Tanggal", "Siswa", "Status"];
    values = state.attendance.map(item => [item.date, getStudentName(item.studentUid), reviewStatus(item, state.profile.mentorType)]);
  } else {
    headers = ["Nama", "Kelas", "Mitra", "Status"];
    values = state.students.map(item => [
      item.fullName,
      item.className || "",
      state.partners.find(partner => partner.id === item.partnerId)?.name || "",
      item.status
    ]);
  }
  const csv = [headers, ...values].map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  link.download = `laporan-pkl-${dateKey()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

document.addEventListener("click", async event => {
  const target = event.target.closest("button");
  if (!target) {
    if (event.target === $("#journalModal")) $("#journalModal").hidden = true;
    if (event.target === $("#recordModal")) closeRecordModal();
    return;
  }
  try {
    if (target.dataset.page) {
      state.page = target.dataset.page;
      render();
      $("#mainContent").focus();
      return;
    }
    const action = target.dataset.action;
    if (action === "logout") {
      target.disabled = true;
      await api.signOut(auth);
      stopListeners();
      state.user = null;
      state.profile = null;
      clearAccountData();
      state.page = "overview";
      toggleWorkspace(false);
      $("#loginPassword").value = "";
      showLoginMessage("");
    } else if (action === "open-journal") {
      $("#journalDate").value = dateKey();
      $("#journalDate").max = dateKey();
      $("#journalModal").hidden = false;
      $("#journalActivity").focus();
    } else if (action === "close-modal") {
      $("#journalModal").hidden = true;
    } else if (action === "close-record") {
      closeRecordModal();
    } else if (action === "checkin") {
      target.disabled = true;
      try {
        await checkIn();
      } finally {
        target.disabled = false;
      }
    } else if (action === "add-partner") {
      partnerForm();
    } else if (action === "edit-partner") {
      const partner = state.partners.find(item => item.id === target.dataset.id);
      if (partner) partnerForm(partner);
    } else if (action === "delete-partner") {
      const partner = state.partners.find(item => item.id === target.dataset.id);
      if (state.students.some(student => student.partnerId === target.dataset.id)) {
        throw new Error("Mitra masih digunakan oleh penempatan siswa. Ubah penempatan terlebih dahulu.");
      }
      if (partner && window.confirm(`Hapus mitra "${partner.name}"?`)) {
        await api.remove(api.ref(db, `partners/${partner.id}`));
        toast("Mitra dihapus.");
      }
    } else if (action === "assign-student") {
      const student = state.students.find(item => item.id === target.dataset.id);
      if (student) assignmentForm(student);
    } else if (action === "review-attendance") {
      const item = state.attendance.find(record => record.id === target.dataset.id);
      if (item) reviewForm("attendance", item);
    } else if (action === "review-journal") {
      const item = state.journals.find(record => record.id === target.dataset.id);
      if (item) reviewForm("journal", item);
    } else if (action === "evaluate-student") {
      const student = state.students.find(item => item.id === target.dataset.id);
      if (student) evaluationForm(student);
    } else if (action === "reset-password") {
      const email = target.dataset.email;
      if (email) {
        await api.sendPasswordResetEmail(auth, email);
        toast(`Tautan reset kata sandi dikirim ke ${email}.`);
      }
    } else if (action === "export") {
      exportCsv();
    }
  } catch (error) {
    console.error("Aksi gagal:", error);
    toast(error.message || "Aksi gagal. Periksa koneksi dan hak akses akun.");
    const submit = $("#recordSubmit");
    if (submit) submit.disabled = false;
  }
});

document.addEventListener("submit", async event => {
  const form = event.target;
  if (form.id === "loginForm") {
    event.preventDefault();
    loginInProgress = true;
    setBusy(true);
    showLoginMessage("Memeriksa akun dan peran…");
    try {
      const credential = await api.signInWithEmailAndPassword(auth, $("#loginEmail").value.trim(), $("#loginPassword").value);
      await enterWorkspace(credential.user);
      showLoginMessage("");
      $("#loginPassword").value = "";
    } catch (error) {
      console.error("Login gagal:", error);
      if (auth.currentUser) await api.signOut(auth);
      showLoginMessage(authErrorMessage(error), true);
    } finally {
      loginInProgress = false;
      setBusy(false);
    }
    return;
  }
  if (form.id === "journalForm") {
    event.preventDefault();
    try {
      await submitJournal(form);
    } catch (error) {
      toast(error.message || "Jurnal gagal disimpan.");
    }
    return;
  }
  if (form.id === "recordForm") {
    event.preventDefault();
    const submit = $("#recordSubmit");
    submit.disabled = true;
    try {
      await submitRecord(form);
      form.reset();
      closeRecordModal();
    } catch (error) {
      console.error("Gagal menyimpan data:", error);
      toast(error.message || "Data gagal disimpan.");
    } finally {
      submit.disabled = false;
    }
    return;
  }
  if (form.id === "settingsForm") {
    event.preventDefault();
    const values = new FormData(form);
    const startDate = String(values.get("startDate"));
    const endDate = String(values.get("endDate"));
    if (endDate < startDate) {
      toast("Tanggal berakhir tidak boleh lebih awal dari tanggal mulai.");
      return;
    }
    try {
      await api.set(api.ref(db, "settings/period"), {
        name: String(values.get("name")).trim(),
        status: String(values.get("status")),
        startDate,
        endDate,
        updatedAt: api.serverTimestamp()
      });
      toast("Periode PKL berhasil disimpan.");
    } catch (error) {
      console.error("Gagal menyimpan periode:", error);
      toast(error.message || "Periode gagal disimpan.");
    }
  }
});

$("#resetPassword").addEventListener("click", async () => {
  const email = $("#loginEmail").value.trim();
  if (!email) {
    showLoginMessage("Isi email akun terlebih dahulu untuk meminta tautan reset.", true);
    $("#loginEmail").focus();
    return;
  }
  try {
    await api.sendPasswordResetEmail(auth, email);
    showLoginMessage("Jika email terdaftar, tautan reset kata sandi telah dikirim.");
  } catch (error) {
    console.error("Permintaan reset kata sandi gagal:", error);
    showLoginMessage("Tautan reset gagal dikirim. Periksa alamat email dan pengaturan Firebase.", true);
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    $("#journalModal").hidden = true;
    if (!$("#recordModal").hidden) closeRecordModal();
  }
});

api.onAuthStateChanged(auth, user => { void processSession(user); });
