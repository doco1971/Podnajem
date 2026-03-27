import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import * as XLSX from "xlsx";
// BUILD: 2026_03_26_build0002
// ============================================================
// POZNÁMKY PRO CLAUDE (čti na začátku každé session)
// ============================================================
// PRAVIDLO #0 — PŘED KAŽDÝM NOVÝM ROZŠÍŘENÍM FUNKCIONALITY:
//   Nejprve důkladně prohledat internet, nabídnout min. 3-5 možností
//   s vysvětlením výhod/nevýhod, teprve pak implementovat zvolenou.
//   NESPOUŠTĚT implementaci bez průzkumu a výběru uživatelem!
//
// PRAVIDLO #1 — POKUD NĚCO NEFUNGUJE:
//   Nejprve důkladně zkontrolovat kód v App.jsx (logika, stavy, podmínky)
//   než se začne cokoliv jiného měnit nebo navrhovat.
//   NEHÁDEJ — ZKONTROLUJ KÓD!
//
// PRAVIDLO #1b — KDYŽ OPRAVA NEFUNGUJE PO 2-3 POKUSECH:
//   Je to signál že problém je v ARCHITEKTUŘE, ne v detailech.
//   Zastavit se, přehodnotit, navrhnout správné řešení.
//
// PRAVIDLO #2 — TEXTY V TABULKÁCH:
//   Nikdy nepoužívat textOverflow:ellipsis tam kde je dost místa.
//   Text se má zobrazit celý (wordBreak:break-word).
//
// PRAVIDLO #3 — VŽDY OVĚŘIT VÝSLEDEK:
//   Po každé změně zkontrolovat že se oprava skutečně projevila v souboru.
//
// PRAVIDLO #4 — PŘI KAŽDÉM NOVÉM BUILDU POVINNĚ AKTUALIZOVAT:
//   a) Třetí řádek souboru:  // BUILD: DATUM_buildXXXX
//   b) Konstanta APP_BUILD (~řádek 60): const APP_BUILD = "buildXXXX"
//
// DEPLOY: Vercel + GitHub (doco1971/podnajem)
//   Větev: main (produkce)
//   Soubor patří do: src/App.jsx
//
// ============================================================
// AKTUÁLNÍ STAV (build0001)
// ============================================================
// ✅ Supabase: pzhcvfucgdukdyggkmso.supabase.co
// ✅ Supabase Auth — email přihlášení
// ✅ Role: admin, cajten (čtenář/nájemník)
// ✅ Tabulky: objekty, byty, najemnici, platby, poruchy, log_aktivit, nastaveni, uzivatele
// ✅ RLS zapnuto
//
// ============================================================
// HISTORY BUILDŮ
// ============================================================
// BUILD0001 — Etapa 1: základ, auth, objekty, byty, nájemníci, log, záloha, XLSX
// BUILD0002 — Záložka Platby: generování předpisů, zaplaceno/saldo. Fix: type=date
//
// ============================================================
// SUPABASE CONFIG
// ============================================================
const APP_BUILD = "build0002";

const SB_URL = import.meta.env.VITE_SB_URL;
const SB_KEY = import.meta.env.VITE_SB_KEY;

const sb = async (path, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const token = options._token || SB_KEY;
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      signal: controller.signal,
      headers: {
        "apikey": SB_KEY,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Prefer": options.prefer || "return=representation",
        ...options.headers,
      },
      ...options,
    });
    if (!res.ok) { const e = await res.text(); throw new Error(e); }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Připojení k DB selhalo (timeout 10s)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

const sbUpsertNastaveni = async (klic, hodnota) => {
  const res = await sb(`nastaveni?klic=eq.${klic}`, { method: "PATCH", body: JSON.stringify({ hodnota }) });
  if (!res || (Array.isArray(res) && res.length === 0)) {
    await sb("nastaveni", { method: "POST", body: JSON.stringify({ klic, hodnota }), prefer: "return=minimal" });
  }
};

const logAkce = async (uzivatel, akce, detail = "") => {
  try {
    await sb("log_aktivit", { method: "POST", body: JSON.stringify({ uzivatel, akce, detail }), prefer: "return=minimal" });
  } catch (e) { console.warn("Log chyba:", e); }
};

// Supabase Auth helpers
const sbAuth = async (path, body) => {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "apikey": SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Auth chyba");
  return data;
};

const fmt = (n) => n == null || n === "" ? "" : Number(n).toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// ============================================================
// HLAVNÍ KOMPONENTA
// ============================================================
export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem("podnajem_theme") || "dark");
  const [session, setSession] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [userName, setUserName] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("prehled");

  // Data
  const [objekty, setObjekty] = useState([]);
  const [byty, setByty] = useState([]);
  const [najemnici, setNajemnici] = useState([]);
  const [platby, setPlatby] = useState([]);
  const [logData, setLogData] = useState([]);

  // Platby - aktuální měsíc/rok
  const now = new Date();
  const [platbyMesic, setPlatbyMesic] = useState(now.getMonth());
  const [platbyRok, setPlatbyRok] = useState(now.getFullYear());

  // UI stavy
  const [filterObjekt, setFilterObjekt] = useState("");
  const [msg, setMsg] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [showNastaveni, setShowNastaveni] = useState(false);
  const [importConfirm, setImportConfirm] = useState(null);
  const [importConfirmText, setImportConfirmText] = useState("");

  // Formuláře
  const [objektForm, setObjektForm] = useState(null);
  const [bytForm, setBytForm] = useState(null);
  const [najemnikForm, setNajemnikForm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const isDark = theme === "dark";
  const isAdmin = userRole === "admin" || userRole === "superadmin";

  const showMsg = (text, type = "ok") => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 3500);
  };

  // ── THEME ──────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem("podnajem_theme", theme);
    document.body.style.background = isDark ? "#0f172a" : "#f1f5f9";
    document.body.style.color = isDark ? "#e2e8f0" : "#1e293b";
  }, [theme, isDark]);

  // ── AUTH ───────────────────────────────────────────────────
  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    try {
      const stored = localStorage.getItem("podnajem_session");
      if (!stored) { setLoading(false); return; }
      const s = JSON.parse(stored);
      if (!s?.access_token) { setLoading(false); return; }
      // Ověř token
      const res = await fetch(`${SB_URL}/auth/v1/user`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${s.access_token}` }
      });
      if (!res.ok) { localStorage.removeItem("podnajem_session"); setLoading(false); return; }
      const user = await res.json();
      setSession(s);
      await loadUserRole(user.email, s.access_token);
    } catch {
      setLoading(false);
    }
  };

  const loadUserRole = async (email, token) => {
    try {
      const rows = await sb(`uzivatele?email=eq.${encodeURIComponent(email)}&limit=1`, { _token: token });
      if (rows && rows.length > 0) {
        setUserRole(rows[0].role);
        setUserName(rows[0].name || email);
      } else {
        // Pokud uživatel není v tabulce uzivatele, přidej ho jako cajten
        setUserRole("cajten");
        setUserName(email);
      }
    } catch {
      setUserRole("cajten");
      setUserName(email);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (email, password) => {
    try {
      const data = await sbAuth("token?grant_type=password", { email, password });
      localStorage.setItem("podnajem_session", JSON.stringify(data));
      setSession(data);
      await loadUserRole(email, data.access_token);
      await logAkce(email, "Přihlášení", `Role: ${userRole}`);
    } catch (e) {
      throw e;
    }
  };

  const handleMagicLink = async (email) => {
    const res = await fetch(`${SB_URL}/auth/v1/magiclink`, {
      method: "POST",
      headers: { "apikey": SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error("Chyba při odesílání magic linku");
  };

  const handleLogout = async () => {
    await logAkce(userName, "Odhlášení", "");
    localStorage.removeItem("podnajem_session");
    setSession(null);
    setUserRole(null);
    setObjekty([]); setByty([]); setNajemnici([]);
  };

  // ── NAČTENÍ DAT ────────────────────────────────────────────
  useEffect(() => {
    if (session && userRole) {
      loadAll();
    }
  }, [session, userRole]);

  useEffect(() => {
    if (session && userRole && activeTab === "platby") {
      loadPlatby(platbyMesic, platbyRok);
    }
  }, [session, userRole, activeTab, platbyMesic, platbyRok]);

  const loadAll = async () => {
    try {
      const [obj, byt, naj] = await Promise.all([
        sb("objekty?order=nazev.asc"),
        sb("byty?order=cislo_bytu.asc"),
        sb("najemnici?order=jmeno.asc"),
      ]);
      setObjekty(obj || []);
      setByty(byt || []);
      setNajemnici(naj || []);
    } catch (e) {
      showMsg("Chyba načítání dat: " + e.message, "err");
    }
  };

  const loadPlatby = async (mesic, rok) => {
    try {
      const res = await sb(`platby?rok=eq.${rok}&mesic=eq.${mesic + 1}&order=byt_id.asc`);
      setPlatby(res || []);
    } catch (e) {
      showMsg("Chyba načítání plateb: " + e.message, "err");
    }
  };

  // ── OBJEKTY CRUD ───────────────────────────────────────────
  const saveObjekt = async (data) => {
    try {
      if (data.id) {
        await sb(`objekty?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify({ nazev: data.nazev, adresa: data.adresa, poznamka: data.poznamka }), prefer: "return=minimal" });
        await logAkce(userName, "Editace objektu", `ID: ${data.id}, ${data.nazev}`);
        showMsg("Objekt uložen");
      } else {
        await sb("objekty", { method: "POST", body: JSON.stringify({ nazev: data.nazev, adresa: data.adresa, poznamka: data.poznamka }) });
        await logAkce(userName, "Přidání objektu", data.nazev);
        showMsg("Objekt přidán");
      }
      await loadAll();
      setObjektForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deleteObjekt = async (id) => {
    try {
      await sb(`objekty?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání objektu", `ID: ${id}`);
      showMsg("Objekt smazán");
      await loadAll();
      setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── BYTY CRUD ──────────────────────────────────────────────
  const saveByt = async (data) => {
    try {
      const payload = {
        objekt_id: Number(data.objekt_id),
        cislo_bytu: data.cislo_bytu,
        patro: data.patro,
        dispozice: data.dispozice,
        plocha_m2: data.plocha_m2 ? Number(data.plocha_m2) : null,
        najem_kc: data.najem_kc ? Number(data.najem_kc) : null,
        zalohy_kc: data.zalohy_kc ? Number(data.zalohy_kc) : null,
        stav: data.stav || "volný",
        poznamka: data.poznamka,
      };
      if (data.id) {
        await sb(`byty?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
        await logAkce(userName, "Editace bytu", `ID: ${data.id}, ${data.cislo_bytu}`);
        showMsg("Byt uložen");
      } else {
        await sb("byty", { method: "POST", body: JSON.stringify(payload) });
        await logAkce(userName, "Přidání bytu", data.cislo_bytu);
        showMsg("Byt přidán");
      }
      await loadAll();
      setBytForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deleteByt = async (id) => {
    try {
      await sb(`byty?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání bytu", `ID: ${id}`);
      showMsg("Byt smazán");
      await loadAll();
      setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── NÁJEMNÍCI CRUD ─────────────────────────────────────────
  const saveNajemnik = async (data) => {
    try {
      const payload = {
        byt_id: data.byt_id ? Number(data.byt_id) : null,
        jmeno: data.jmeno,
        telefon: data.telefon,
        email: data.email,
        datum_narozeni: data.datum_narozeni,
        cislo_op: data.cislo_op,
        smlouva_od: data.smlouva_od,
        smlouva_do: data.smlouva_do,
        kauce_kc: data.kauce_kc ? Number(data.kauce_kc) : null,
        kauce_zaplacena: data.kauce_zaplacena || false,
        email_notifikace: data.email_notifikace !== false,
        poznamka: data.poznamka,
      };
      if (data.id) {
        await sb(`najemnici?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
        await logAkce(userName, "Editace nájemníka", `ID: ${data.id}, ${data.jmeno}`);
        showMsg("Nájemník uložen");
      } else {
        await sb("najemnici", { method: "POST", body: JSON.stringify(payload) });
        await logAkce(userName, "Přidání nájemníka", data.jmeno);
        showMsg("Nájemník přidán");
      }
      await loadAll();
      setNajemnikForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deleteNajemnik = async (id) => {
    try {
      await sb(`najemnici?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání nájemníka", `ID: ${id}`);
      showMsg("Nájemník smazán");
      await loadAll();
      setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── PLATBY CRUD ────────────────────────────────────────────
  const generujPredpisy = async () => {
    const obsazene = byty.filter(b => b.stav === "obsazený" && b.najem_kc);
    if (obsazene.length === 0) { showMsg("Žádné obsazené byty s nájmem.", "err"); return; }
    const mesicDB = platbyMesic + 1;
    let pridano = 0, preskoceno = 0;
    for (const b of obsazene) {
      const existuje = platby.find(p => p.byt_id === b.id && p.mesic === mesicDB && p.rok === platbyRok);
      if (existuje) { preskoceno++; continue; }
      const predpis = (Number(b.najem_kc) || 0) + (Number(b.zalohy_kc) || 0);
      await sb("platby", { method: "POST", body: JSON.stringify({
        byt_id: b.id, rok: platbyRok, mesic: mesicDB,
        predpis_kc: predpis, zaplaceno: false,
      }), prefer: "return=minimal" });
      pridano++;
    }
    await logAkce(userName, "Generování předpisů", `${mesicDB}/${platbyRok}: ${pridano} nových, ${preskoceno} přeskočeno`);
    showMsg(`Předpisy vygenerovány: ${pridano} nových${preskoceno ? `, ${preskoceno} již existovalo` : ""}`);
    await loadPlatby(platbyMesic, platbyRok);
  };

  const toggleZaplaceno = async (platba, checked) => {
    const dnes = new Date().toISOString().slice(0, 10);
    const payload = {
      zaplaceno: checked,
      castka_kc: checked ? platba.predpis_kc : null,
      datum_platby: checked ? dnes : null,
    };
    await sb(`platby?id=eq.${platba.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
    await logAkce(userName, checked ? "Platba zaplacena" : "Platba zrušena", `ID platby: ${platba.id}, byt_id: ${platba.byt_id}`);
    await loadPlatby(platbyMesic, platbyRok);
  };

  const updateCastkaPlatby = async (platba, castka) => {
    await sb(`platby?id=eq.${platba.id}`, { method: "PATCH", body: JSON.stringify({ castka_kc: castka ? Number(castka) : null }), prefer: "return=minimal" });
    await loadPlatby(platbyMesic, platbyRok);
  };

  const deletePlatba = async (id) => {
    await sb(`platby?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
    await logAkce(userName, "Smazání platby", `ID: ${id}`);
    showMsg("Platba smazána");
    await loadPlatby(platbyMesic, platbyRok);
    setDeleteConfirm(null);
  };

  // ── LOG ────────────────────────────────────────────────────
  const loadLog = async () => {
    try {
      const res = await sb("log_aktivit?order=cas.desc&limit=200&hidden=eq.false");
      setLogData(res || []);
    } catch { setLogData([]); }
  };

  // ── ZÁLOHA JSON ────────────────────────────────────────────
  const exportJSON = async () => {
    try {
      const [obj, byt, naj, log] = await Promise.all([
        sb("objekty?order=id.asc"),
        sb("byty?order=id.asc"),
        sb("najemnici?order=id.asc"),
        sb("log_aktivit?order=id.asc&limit=2000"),
      ]);
      const payload = {
        version: 1,
        created: new Date().toISOString(),
        prostredi: "PRODUKCE",
        objekty: obj, byty: byt, najemnici: naj, log_aktivit: log,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `podnajem-zaloha-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      await logAkce(userName, "Export zálohy JSON", "");
      showMsg("Záloha stažena");
    } catch (e) { showMsg("Chyba zálohy: " + e.message, "err"); }
  };

  const importJSON = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const payload = JSON.parse(e.target.result);
        if (!payload.objekty) throw new Error("Neplatný formát zálohy");
        setImportConfirm({ payload, fileName: file.name });
        setImportConfirmText("");
      } catch (err) { showMsg("Chyba čtení souboru: " + err.message, "err"); }
    };
    reader.readAsText(file);
  };

  const doImportJSON = async () => {
    const { payload } = importConfirm;
    try {
      // Smazat vše
      await sb("najemnici?id=gt.0", { method: "DELETE", prefer: "return=minimal" });
      await sb("byty?id=gt.0", { method: "DELETE", prefer: "return=minimal" });
      await sb("objekty?id=gt.0", { method: "DELETE", prefer: "return=minimal" });
      // Vložit nová data
      if (payload.objekty?.length) await sb("objekty", { method: "POST", body: JSON.stringify(payload.objekty.map(r => { const {id,...x}=r; return x; })) });
      if (payload.byty?.length) await sb("byty", { method: "POST", body: JSON.stringify(payload.byty.map(r => { const {id,...x}=r; return x; })) });
      if (payload.najemnici?.length) await sb("najemnici", { method: "POST", body: JSON.stringify(payload.najemnici.map(r => { const {id,...x}=r; return x; })) });
      await logAkce(userName, "Import zálohy JSON", payload.fileName || "");
      showMsg("Import dokončen");
      await loadAll();
      setImportConfirm(null);
      setImportConfirmText("");
    } catch (e) { showMsg("Chyba importu: " + e.message, "err"); }
  };

  // ── XLSX EXPORT ────────────────────────────────────────────
  const exportXLSX = () => {
    const rows = byty.map(b => {
      const obj = objekty.find(o => o.id === b.objekt_id);
      const naj = najemnici.find(n => n.byt_id === b.id);
      return {
        "Dům": obj?.nazev || "",
        "Adresa": obj?.adresa || "",
        "Byt č.": b.cislo_bytu,
        "Patro": b.patro || "",
        "Dispozice": b.dispozice || "",
        "Plocha m²": b.plocha_m2 || "",
        "Nájem Kč": b.najem_kc || "",
        "Zálohy Kč": b.zalohy_kc || "",
        "Stav": b.stav || "",
        "Nájemník": naj?.jmeno || "",
        "Telefon": naj?.telefon || "",
        "Email": naj?.email || "",
        "Smlouva od": naj?.smlouva_od || "",
        "Smlouva do": naj?.smlouva_do || "",
        "Kauce Kč": naj?.kauce_kc || "",
        "Kauce zaplacena": naj?.kauce_zaplacena ? "Ano" : "Ne",
        "Poznámka byt": b.poznamka || "",
        "Poznámka nájemník": naj?.poznamka || "",
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Byty");
    XLSX.writeFile(wb, `podnajem-export-${new Date().toISOString().slice(0,10)}.xlsx`);
    logAkce(userName, "Export XLSX", `${rows.length} bytů`);
    showMsg("XLSX exportováno");
  };

  // ── COMPUTED ───────────────────────────────────────────────
  const bytySFiltered = useMemo(() => {
    if (!filterObjekt) return byty;
    return byty.filter(b => b.objekt_id === Number(filterObjekt));
  }, [byty, filterObjekt]);

  const stats = useMemo(() => {
    const obsazeno = byty.filter(b => b.stav === "obsazený").length;
    const prijemMesic = byty.reduce((s, b) => s + (Number(b.najem_kc) || 0) + (Number(b.zalohy_kc) || 0), 0);
    const brzeKonec = najemnici.filter(n => {
      if (!n.smlouva_do) return false;
      const diff = (new Date(n.smlouva_do) - new Date()) / (1000 * 60 * 60 * 24);
      return diff >= 0 && diff <= 60;
    }).length;
    return { celkem: byty.length, obsazeno, prijemMesic, brzeKonec };
  }, [byty, najemnici]);

  const platbyStats = useMemo(() => {
    const predpis = platby.reduce((s, p) => s + (Number(p.predpis_kc) || 0), 0);
    const zaplaceno = platby.filter(p => p.zaplaceno).reduce((s, p) => s + (Number(p.castka_kc) || Number(p.predpis_kc) || 0), 0);
    const dluh = predpis - zaplaceno;
    const pocetNezapl = platby.filter(p => !p.zaplaceno).length;
    return { predpis, zaplaceno, dluh, pocetNezapl };
  }, [platby]);

  const isSmlouvaBrzy = (datum) => {
    if (!datum) return false;
    const diff = (new Date(datum) - new Date()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 60;
  };

  const isSmlouvaPropadla = (datum) => {
    if (!datum) return false;
    return new Date(datum) < new Date();
  };

  // ── STYLY ──────────────────────────────────────────────────
  const bg = isDark ? "#0f172a" : "#f1f5f9";
  const surface = isDark ? "#1e293b" : "#ffffff";
  const surface2 = isDark ? "#0f172a" : "#f8fafc";
  const border = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
  const text = isDark ? "#e2e8f0" : "#1e293b";
  const muted = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";
  const inputBg = isDark ? "#0f172a" : "#ffffff";
  const inputBorder = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)";

  const inputSx = {
    width: "100%", padding: "8px 11px",
    background: inputBg, border: `1px solid ${inputBorder}`,
    borderRadius: 7, color: text, fontSize: 13, outline: "none",
    boxSizing: "border-box", fontFamily: "inherit",
  };

  const btnPrimary = {
    padding: "9px 20px", background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
    border: "none", borderRadius: 8, color: "#fff", cursor: "pointer",
    fontSize: 13, fontWeight: 600,
  };

  const btnSecondary = {
    padding: "8px 16px", background: "transparent",
    border: `1px solid ${border}`, borderRadius: 8, color: text,
    cursor: "pointer", fontSize: 13,
  };

  const btnDanger = {
    padding: "8px 16px", background: "rgba(239,68,68,0.1)",
    border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#f87171",
    cursor: "pointer", fontSize: 13,
  };

  const cardSx = {
    background: surface, border: `1px solid ${border}`,
    borderRadius: 12, padding: "16px 20px",
  };

  // ── RENDER: LOADING ────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: bg, color: text, fontFamily: "'Segoe UI',Tahoma,sans-serif", fontSize: 14 }}>
        Načítání...
      </div>
    );
  }

  // ── RENDER: LOGIN ──────────────────────────────────────────
  if (!session) {
    return <LoginScreen isDark={isDark} onLogin={handleLogin} onMagicLink={handleMagicLink} inputSx={inputSx} btnPrimary={btnPrimary} surface={surface} border={border} text={text} muted={muted} bg={bg} />;
  }

  // ── RENDER: HLAVNÍ APLIKACE ────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: bg, fontFamily: "'Segoe UI',Tahoma,sans-serif", color: text }}>

      {/* TOAST */}
      {msg && (
        <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, padding: "11px 20px", borderRadius: 10, background: msg.type === "err" ? "#dc2626" : "#16a34a", color: "#fff", fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
          {msg.type === "err" ? "⚠️ " : "✅ "}{msg.text}
        </div>
      )}

      {/* HEADER */}
      <div style={{ background: surface, borderBottom: `1px solid ${border}`, padding: "0 24px", display: "flex", alignItems: "center", height: 52, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: text, marginRight: 32 }}>
          🏠 <span style={{ color: "#3b82f6" }}>Podnájem</span>
        </div>
        {/* TABS */}
        {["prehled", "platby", "najemnici", "objekty"].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: "0 16px", height: 52, border: "none", background: "none",
            fontSize: 13, color: activeTab === tab ? "#3b82f6" : muted,
            borderBottom: activeTab === tab ? "2px solid #3b82f6" : "2px solid transparent",
            cursor: "pointer", fontWeight: activeTab === tab ? 600 : 400,
            fontFamily: "inherit",
          }}>
            {tab === "prehled" ? "Přehled" : tab === "platby" ? "Platby" : tab === "najemnici" ? "Nájemníci" : "Objekty a byty"}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: muted }}>{userName}</span>
          <span style={{ fontSize: 11, color: muted, background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", padding: "2px 8px", borderRadius: 99 }}>{userRole}</span>
          {isAdmin && (
            <>
              <button onClick={exportXLSX} title="Export XLSX" style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>📊 XLSX</button>
              <button onClick={exportJSON} title="Záloha JSON" style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>💾 Záloha</button>
              <label title="Import zálohy" style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
                📂 Import
                <input type="file" accept=".json" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; }} />
              </label>
              <button onClick={() => { setShowLog(true); loadLog(); }} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>📋 Log</button>
            </>
          )}
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>{isDark ? "☀️" : "🌙"}</button>
          <button onClick={handleLogout} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>Odhlásit</button>
          <span style={{ fontSize: 11, color: muted }}>{APP_BUILD}</span>
        </div>
      </div>

      {/* CONTENT */}
      <div style={{ padding: "24px", maxWidth: 1400, margin: "0 auto" }}>

        {/* TAB: PŘEHLED */}
        {activeTab === "prehled" && (
          <div>
            {/* Summary karty */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}>
              {[
                { label: "Bytů celkem", value: stats.celkem, color: "#3b82f6" },
                { label: "Obsazeno", value: stats.obsazeno, color: "#22c55e" },
                { label: "Příjem / měsíc", value: stats.prijemMesic ? fmt(stats.prijemMesic) + " Kč" : "—", color: "#f59e0b" },
                { label: "Brzy konec smlouvy", value: stats.brzeKonec, color: stats.brzeKonec > 0 ? "#f87171" : "#22c55e" },
              ].map(c => (
                <div key={c.label} style={{ ...cardSx, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>{c.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            {/* Filtr objektů */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: muted }}>Dům:</span>
              {[{ id: "", nazev: "Vše" }, ...objekty].map(o => (
                <button key={o.id} onClick={() => setFilterObjekt(o.id === "" ? "" : o.id)}
                  style={{
                    padding: "4px 14px", borderRadius: 99, fontSize: 12, cursor: "pointer",
                    border: `1px solid ${filterObjekt === (o.id === "" ? "" : o.id) ? "#3b82f6" : border}`,
                    background: filterObjekt === (o.id === "" ? "" : o.id) ? "rgba(59,130,246,0.15)" : "transparent",
                    color: filterObjekt === (o.id === "" ? "" : o.id) ? "#3b82f6" : text,
                    fontWeight: filterObjekt === (o.id === "" ? "" : o.id) ? 600 : 400,
                  }}>
                  {o.nazev}
                </button>
              ))}
            </div>

            {/* Tabulka bytů */}
            <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Byty</span>
                {isAdmin && <button onClick={() => setBytForm({ stav: "volný", objekt_id: filterObjekt || "" })} style={btnPrimary}>+ Přidat byt</button>}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                      {["Dům", "Byt č.", "Dispozice", "Plocha", "Nájem", "Zálohy", "Nájemník", "Smlouva do", "Kauce", "Stav", isAdmin ? "Akce" : ""].filter(Boolean).map(h => (
                        <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${border}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bytySFiltered.length === 0 && (
                      <tr><td colSpan={11} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné byty. {isAdmin && "Klikněte + Přidat byt."}</td></tr>
                    )}
                    {bytySFiltered.map(b => {
                      const obj = objekty.find(o => o.id === b.objekt_id);
                      const naj = najemnici.find(n => n.byt_id === b.id);
                      const brzy = naj && isSmlouvaBrzy(naj.smlouva_do);
                      const propadla = naj && isSmlouvaPropadla(naj.smlouva_do);
                      return (
                        <tr key={b.id} style={{ borderBottom: `1px solid ${border}` }}
                          onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "10px 14px", color: muted, fontSize: 12 }}>{obj?.nazev || "—"}</td>
                          <td style={{ padding: "10px 14px", fontWeight: 600 }}>{b.cislo_bytu}</td>
                          <td style={{ padding: "10px 14px", color: muted }}>{b.dispozice || "—"}</td>
                          <td style={{ padding: "10px 14px", color: muted }}>{b.plocha_m2 ? b.plocha_m2 + " m²" : "—"}</td>
                          <td style={{ padding: "10px 14px" }}>{b.najem_kc ? fmt(b.najem_kc) + " Kč" : "—"}</td>
                          <td style={{ padding: "10px 14px", color: muted }}>{b.zalohy_kc ? fmt(b.zalohy_kc) + " Kč" : "—"}</td>
                          <td style={{ padding: "10px 14px" }}>{naj ? naj.jmeno : <span style={{ color: muted }}>—</span>}</td>
                          <td style={{ padding: "10px 14px", color: propadla ? "#f87171" : brzy ? "#f59e0b" : text, fontWeight: (brzy || propadla) ? 600 : 400 }}>
                            {naj?.smlouva_do || "—"}
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            {naj?.kauce_kc ? (
                              <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, background: naj.kauce_zaplacena ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: naj.kauce_zaplacena ? "#4ade80" : "#f87171" }}>
                                {naj.kauce_zaplacena ? "✓" : "✗"} {fmt(naj.kauce_kc)} Kč
                              </span>
                            ) : "—"}
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            <StavBadge stav={b.stav} />
                          </td>
                          {isAdmin && (
                            <td style={{ padding: "10px 14px" }}>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button onClick={() => setBytForm({ ...b })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14, padding: "2px 4px" }} title="Editovat">✏️</button>
                                <button onClick={() => setDeleteConfirm({ type: "byt", id: b.id, nazev: b.cislo_bytu })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14, padding: "2px 4px" }} title="Smazat">🗑️</button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB: PLATBY */}
        {activeTab === "platby" && (
          <div>
            {/* Měsíc navigace */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
              <button onClick={() => { let m = platbyMesic - 1, r = platbyRok; if (m < 0) { m = 11; r--; } setPlatbyMesic(m); setPlatbyRok(r); }} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 14 }}>‹</button>
              <span style={{ fontSize: 15, fontWeight: 600, minWidth: 130, textAlign: "center" }}>
                {["Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"][platbyMesic]} {platbyRok}
              </span>
              <button onClick={() => { let m = platbyMesic + 1, r = platbyRok; if (m > 11) { m = 0; r++; } setPlatbyMesic(m); setPlatbyRok(r); }} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 14 }}>›</button>
              {isAdmin && (
                <button onClick={generujPredpisy} style={{ ...btnPrimary, marginLeft: 8 }}>
                  + Generovat předpisy
                </button>
              )}
              <span style={{ fontSize: 12, color: muted }}>
                {platby.length > 0 ? `${platby.length} předpisů` : "Žádné předpisy — klikněte Generovat"}
              </span>
            </div>

            {/* Saldo karty */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
              {[
                { label: "Předpis celkem", value: platbyStats.predpis ? fmt(platbyStats.predpis) + " Kč" : "—", color: "#3b82f6" },
                { label: "Zaplaceno", value: platbyStats.zaplaceno ? fmt(platbyStats.zaplaceno) + " Kč" : "—", color: "#22c55e" },
                { label: "Dluh", value: platbyStats.dluh > 0 ? fmt(platbyStats.dluh) + " Kč" : "0 Kč", color: platbyStats.dluh > 0 ? "#f87171" : "#22c55e" },
              ].map(c => (
                <div key={c.label} style={{ ...cardSx, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>{c.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            {/* Tabulka plateb */}
            <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                      {["Dům", "Byt", "Nájemník", "Předpis", "Zaplaceno", "Datum platby", "Stav", "Zapl.?", isAdmin ? "Akce" : ""].filter(Boolean).map(h => (
                        <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${border}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {platby.length === 0 && (
                      <tr><td colSpan={9} style={{ padding: "40px", textAlign: "center", color: muted }}>
                        Žádné předpisy pro tento měsíc.{isAdmin && " Klikněte \"+ Generovat předpisy\"."}
                      </td></tr>
                    )}
                    {platby.map(p => {
                      const byt = byty.find(b => b.id === p.byt_id);
                      const obj = byt ? objekty.find(o => o.id === byt.objekt_id) : null;
                      const naj = najemnici.find(n => n.byt_id === p.byt_id);
                      return (
                        <tr key={p.id} style={{ borderBottom: `1px solid ${border}`, background: p.zaplaceno ? (isDark ? "rgba(34,197,94,0.04)" : "rgba(34,197,94,0.03)") : "transparent" }}
                          onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                          onMouseLeave={e => e.currentTarget.style.background = p.zaplaceno ? (isDark ? "rgba(34,197,94,0.04)" : "rgba(34,197,94,0.03)") : "transparent"}>
                          <td style={{ padding: "10px 14px", color: muted, fontSize: 12 }}>{obj?.nazev || "—"}</td>
                          <td style={{ padding: "10px 14px", fontWeight: 600 }}>{byt?.cislo_bytu || "—"}</td>
                          <td style={{ padding: "10px 14px" }}>{naj?.jmeno || <span style={{ color: muted }}>—</span>}</td>
                          <td style={{ padding: "10px 14px", fontWeight: 500 }}>{p.predpis_kc ? fmt(p.predpis_kc) + " Kč" : "—"}</td>
                          <td style={{ padding: "10px 14px", color: p.zaplaceno ? "#4ade80" : muted }}>
                            {p.zaplaceno ? (fmt(p.castka_kc || p.predpis_kc) + " Kč") : "—"}
                          </td>
                          <td style={{ padding: "10px 14px", color: muted, fontSize: 12 }}>{p.datum_platby || "—"}</td>
                          <td style={{ padding: "10px 14px" }}>
                            <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: p.zaplaceno ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: p.zaplaceno ? "#4ade80" : "#f87171" }}>
                              {p.zaplaceno ? "zaplaceno" : "nezaplaceno"}
                            </span>
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            {isAdmin && (
                              <input type="checkbox" checked={p.zaplaceno || false}
                                onChange={e => toggleZaplaceno(p, e.target.checked)}
                                style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#22c55e" }} />
                            )}
                          </td>
                          {isAdmin && (
                            <td style={{ padding: "10px 14px" }}>
                              <button onClick={() => setDeleteConfirm({ type: "platba", id: p.id, nazev: `předpis byt ${byt?.cislo_bytu}` })}
                                style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14 }}>🗑️</button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB: NÁJEMNÍCI */}
        {activeTab === "najemnici" && (
          <div>
            <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Nájemníci ({najemnici.length})</span>
                {isAdmin && <button onClick={() => setNajemnikForm({ kauce_zaplacena: false, email_notifikace: true })} style={btnPrimary}>+ Přidat nájemníka</button>}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                      {["Jméno", "Byt", "Telefon", "Email", "Smlouva od", "Smlouva do", "Kauce", "Notifikace", isAdmin ? "Akce" : ""].filter(Boolean).map(h => (
                        <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${border}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {najemnici.length === 0 && (
                      <tr><td colSpan={9} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádní nájemníci.</td></tr>
                    )}
                    {najemnici.map(n => {
                      const byt = byty.find(b => b.id === n.byt_id);
                      const obj = byt ? objekty.find(o => o.id === byt.objekt_id) : null;
                      const brzy = isSmlouvaBrzy(n.smlouva_do);
                      const propadla = isSmlouvaPropadla(n.smlouva_do);
                      return (
                        <tr key={n.id} style={{ borderBottom: `1px solid ${border}` }}
                          onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "10px 14px", fontWeight: 600 }}>{n.jmeno}</td>
                          <td style={{ padding: "10px 14px", color: muted, fontSize: 12 }}>{obj ? `${obj.nazev} / ${byt?.cislo_bytu}` : "—"}</td>
                          <td style={{ padding: "10px 14px" }}>{n.telefon || "—"}</td>
                          <td style={{ padding: "10px 14px", color: "#60a5fa" }}>{n.email || "—"}</td>
                          <td style={{ padding: "10px 14px", color: muted }}>{n.smlouva_od || "—"}</td>
                          <td style={{ padding: "10px 14px", color: propadla ? "#f87171" : brzy ? "#f59e0b" : text, fontWeight: (brzy || propadla) ? 600 : 400 }}>
                            {n.smlouva_do || "—"}{brzy && " ⚠️"}
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            {n.kauce_kc ? (
                              <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, background: n.kauce_zaplacena ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: n.kauce_zaplacena ? "#4ade80" : "#f87171" }}>
                                {n.kauce_zaplacena ? "✓" : "✗"} {fmt(n.kauce_kc)} Kč
                              </span>
                            ) : "—"}
                          </td>
                          <td style={{ padding: "10px 14px" }}>
                            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: n.email_notifikace ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.05)", color: n.email_notifikace ? "#4ade80" : muted }}>
                              {n.email_notifikace ? "✓ Ano" : "✗ Ne"}
                            </span>
                          </td>
                          {isAdmin && (
                            <td style={{ padding: "10px 14px" }}>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button onClick={() => setNajemnikForm({ ...n })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14, padding: "2px 4px" }}>✏️</button>
                                <button onClick={() => setDeleteConfirm({ type: "najemnik", id: n.id, nazev: n.jmeno })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14, padding: "2px 4px" }}>🗑️</button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB: OBJEKTY */}
        {activeTab === "objekty" && (
          <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20 }}>
            {/* Seznam objektů */}
            <div>
              <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Bytové domy</span>
                  {isAdmin && <button onClick={() => setObjektForm({})} style={{ ...btnPrimary, padding: "6px 14px", fontSize: 12 }}>+ Přidat</button>}
                </div>
                {objekty.length === 0 && (
                  <div style={{ padding: "32px", textAlign: "center", color: muted, fontSize: 13 }}>Žádné objekty.</div>
                )}
                {objekty.map(o => {
                  const pocetBytu = byty.filter(b => b.objekt_id === o.id).length;
                  const obsazeno = byty.filter(b => b.objekt_id === o.id && b.stav === "obsazený").length;
                  return (
                    <div key={o.id} style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, cursor: "pointer" }}
                      onClick={() => setFilterObjekt(o.id)}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{o.nazev}</div>
                      <div style={{ fontSize: 12, color: muted, marginBottom: 6 }}>{o.adresa || "—"}</div>
                      <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
                        <span style={{ padding: "2px 8px", borderRadius: 99, background: "rgba(59,130,246,0.12)", color: "#60a5fa" }}>{pocetBytu} bytů</span>
                        <span style={{ padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80" }}>{obsazeno} obsazeno</span>
                      </div>
                      {isAdmin && (
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          <button onClick={e => { e.stopPropagation(); setObjektForm({ ...o }); }} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 11 }}>✏️ Editovat</button>
                          <button onClick={e => { e.stopPropagation(); setDeleteConfirm({ type: "objekt", id: o.id, nazev: o.nazev }); }} style={{ ...btnDanger, padding: "4px 10px", fontSize: 11 }}>🗑️ Smazat</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Byty v objektu */}
            <div>
              <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {filterObjekt ? `Byty — ${objekty.find(o => o.id === Number(filterObjekt))?.nazev || ""}` : "Byty (všechny)"}
                  </span>
                  {isAdmin && <button onClick={() => setBytForm({ stav: "volný", objekt_id: filterObjekt || "" })} style={{ ...btnPrimary, padding: "6px 14px", fontSize: 12 }}>+ Přidat byt</button>}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                        {["Č.", "Patro", "Disp.", "Plocha", "Nájem", "Zálohy", "Stav", isAdmin ? "Akce" : ""].filter(Boolean).map(h => (
                          <th key={h} style={{ padding: "9px 12px", textAlign: "left", color: muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bytySFiltered.length === 0 && (
                        <tr><td colSpan={8} style={{ padding: "24px", textAlign: "center", color: muted }}>Žádné byty.</td></tr>
                      )}
                      {bytySFiltered.map(b => (
                        <tr key={b.id} style={{ borderBottom: `1px solid ${border}` }}
                          onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "9px 12px", fontWeight: 600 }}>{b.cislo_bytu}</td>
                          <td style={{ padding: "9px 12px", color: muted }}>{b.patro || "—"}</td>
                          <td style={{ padding: "9px 12px", color: muted }}>{b.dispozice || "—"}</td>
                          <td style={{ padding: "9px 12px", color: muted }}>{b.plocha_m2 ? b.plocha_m2 + " m²" : "—"}</td>
                          <td style={{ padding: "9px 12px" }}>{b.najem_kc ? fmt(b.najem_kc) + " Kč" : "—"}</td>
                          <td style={{ padding: "9px 12px", color: muted }}>{b.zalohy_kc ? fmt(b.zalohy_kc) + " Kč" : "—"}</td>
                          <td style={{ padding: "9px 12px" }}><StavBadge stav={b.stav} /></td>
                          {isAdmin && (
                            <td style={{ padding: "9px 12px" }}>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button onClick={() => setBytForm({ ...b })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14 }}>✏️</button>
                                <button onClick={() => setDeleteConfirm({ type: "byt", id: b.id, nazev: b.cislo_bytu })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14 }}>🗑️</button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── MODÁLY ── */}

      {/* OBJEKT FORM */}
      {objektForm && (
        <Modal title={objektForm.id ? "Editace objektu" : "Nový objekt"} onClose={() => setObjektForm(null)} isDark={isDark} surface={surface} border={border} text={text}>
          <FormObjekt data={objektForm} onChange={setObjektForm} onSave={saveObjekt} onCancel={() => setObjektForm(null)} inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary} text={text} muted={muted} />
        </Modal>
      )}

      {/* BYT FORM */}
      {bytForm && (
        <Modal title={bytForm.id ? "Editace bytu" : "Nový byt"} onClose={() => setBytForm(null)} isDark={isDark} surface={surface} border={border} text={text}>
          <FormByt data={bytForm} onChange={setBytForm} onSave={saveByt} onCancel={() => setBytForm(null)} objekty={objekty} inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary} text={text} muted={muted} border={border} isDark={isDark} />
        </Modal>
      )}

      {/* NÁJEMNÍK FORM */}
      {najemnikForm && (
        <Modal title={najemnikForm.id ? "Editace nájemníka" : "Nový nájemník"} onClose={() => setNajemnikForm(null)} isDark={isDark} surface={surface} border={border} text={text} wide>
          <FormNajemnik data={najemnikForm} onChange={setNajemnikForm} onSave={saveNajemnik} onCancel={() => setNajemnikForm(null)} byty={byty} objekty={objekty} inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary} text={text} muted={muted} border={border} isDark={isDark} />
        </Modal>
      )}

      {/* DELETE CONFIRM */}
      {deleteConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: surface, borderRadius: 14, padding: "28px 32px", width: 380, border: `1px solid rgba(239,68,68,0.4)`, fontFamily: "inherit" }}>
            <div style={{ fontSize: 32, textAlign: "center", marginBottom: 12 }}>🗑️</div>
            <h3 style={{ color: text, margin: "0 0 10px", fontSize: 16, textAlign: "center" }}>Potvrdit smazání</h3>
            <p style={{ color: muted, fontSize: 13, textAlign: "center", marginBottom: 20 }}>Opravdu smazat <strong style={{ color: text }}>{deleteConfirm.nazev}</strong>? Tato akce je nevratná.</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setDeleteConfirm(null)} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
              <button onClick={() => {
                if (deleteConfirm.type === "objekt") deleteObjekt(deleteConfirm.id);
                else if (deleteConfirm.type === "byt") deleteByt(deleteConfirm.id);
                else if (deleteConfirm.type === "najemnik") deleteNajemnik(deleteConfirm.id);
                else if (deleteConfirm.type === "platba") deletePlatba(deleteConfirm.id);
              }} style={{ flex: 1, ...btnDanger, fontWeight: 700 }}>Smazat</button>
            </div>
          </div>
        </div>
      )}

      {/* LOG MODAL */}
      {showLog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: surface, borderRadius: 16, width: "min(900px,96vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", border: `1px solid ${border}`, fontFamily: "inherit" }}>
            <div style={{ padding: "16px 24px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: text }}>📋 Log aktivit</span>
              <button onClick={() => setShowLog(false)} style={{ background: "none", border: "none", color: muted, fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)", position: "sticky", top: 0 }}>
                    {["Čas", "Uživatel", "Akce", "Detail"].map(h => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logData.length === 0 && (
                    <tr><td colSpan={4} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné záznamy.</td></tr>
                  )}
                  {logData.map(r => (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${border}` }}>
                      <td style={{ padding: "9px 16px", color: muted, whiteSpace: "nowrap", fontSize: 12 }}>{r.cas ? new Date(r.cas).toLocaleString("cs-CZ", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                      <td style={{ padding: "9px 16px", fontWeight: 500 }}>{r.uzivatel}</td>
                      <td style={{ padding: "9px 16px" }}>{r.akce}</td>
                      <td style={{ padding: "9px 16px", color: muted, wordBreak: "break-word" }}>{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* IMPORT CONFIRM */}
      {importConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 9100, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
          <div style={{ background: surface, borderRadius: 16, padding: "28px 32px", width: 420, border: "1px solid rgba(251,191,36,0.4)" }}>
            <div style={{ fontSize: 32, textAlign: "center", marginBottom: 10 }}>⚠️</div>
            <h3 style={{ color: text, margin: "0 0 16px", fontSize: 16, textAlign: "center" }}>Potvrdit import zálohy</h3>
            <div style={{ background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)", borderRadius: 10, padding: "12px 16px", marginBottom: 14, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: muted }}>Soubor:</span><span style={{ color: text }}>{importConfirm.fileName}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: muted }}>Objektů:</span><span style={{ color: text, fontWeight: 700 }}>{importConfirm.payload.objekty?.length || 0}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: muted }}>Bytů:</span><span style={{ color: text, fontWeight: 700 }}>{importConfirm.payload.byty?.length || 0}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: muted }}>Nájemníků:</span><span style={{ color: text, fontWeight: 700 }}>{importConfirm.payload.najemnici?.length || 0}</span>
              </div>
            </div>
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#fca5a5" }}>
              ⚠️ Všechna stávající data budou <strong>trvale smazána</strong> a nahrazena daty ze zálohy.
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: muted, fontSize: 12, marginBottom: 6 }}>Pro pokračování napište <strong style={{ color: "#fbbf24" }}>POTVRDIT</strong>:</div>
              <input value={importConfirmText} onChange={e => setImportConfirmText(e.target.value)} placeholder="POTVRDIT" autoFocus style={{ ...inputSx, textAlign: "center", letterSpacing: 2, fontWeight: 700 }} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => { setImportConfirm(null); setImportConfirmText(""); }} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
              <button onClick={doImportJSON} disabled={importConfirmText.trim().toUpperCase() !== "POTVRDIT"}
                style={{ flex: 1, padding: "10px 0", background: importConfirmText.trim().toUpperCase() === "POTVRDIT" ? "linear-gradient(135deg,#d97706,#b45309)" : "rgba(255,255,255,0.05)", border: "none", borderRadius: 8, color: importConfirmText.trim().toUpperCase() === "POTVRDIT" ? "#fff" : muted, cursor: importConfirmText.trim().toUpperCase() === "POTVRDIT" ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 700 }}>
                ✅ Importovat
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ── HELPER KOMPONENTY ──────────────────────────────────────

function StavBadge({ stav }) {
  const colors = {
    "obsazený": { bg: "rgba(34,197,94,0.15)", color: "#4ade80" },
    "volný": { bg: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.45)" },
    "oprava": { bg: "rgba(59,130,246,0.15)", color: "#60a5fa" },
  };
  const c = colors[stav] || colors["volný"];
  return <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: c.bg, color: c.color }}>{stav || "—"}</span>;
}

function Modal({ title, onClose, children, isDark, surface, border, text, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI',Tahoma,sans-serif" }}>
      <div style={{ background: surface, borderRadius: 16, width: wide ? "min(700px,96vw)" : "min(480px,96vw)", maxHeight: "90vh", overflow: "auto", border: `1px solid ${border}` }}>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: surface, zIndex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: text }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: "20px 24px" }}>{children}</div>
      </div>
    </div>
  );
}

function FormObjekt({ data, onChange, onSave, onCancel, inputSx, btnPrimary, btnSecondary, text, muted }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Název *</label>
        <input style={inputSx} value={data.nazev || ""} onChange={e => onChange({ ...data, nazev: e.target.value })} placeholder="např. Palackého 12" />
      </div>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Adresa</label>
        <input style={inputSx} value={data.adresa || ""} onChange={e => onChange({ ...data, adresa: e.target.value })} placeholder="Ulice č.p., Město" />
      </div>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Poznámka</label>
        <textarea style={{ ...inputSx, resize: "vertical", minHeight: 70 }} value={data.poznamka || ""} onChange={e => onChange({ ...data, poznamka: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(data)} disabled={!data.nazev} style={{ flex: 1, ...btnPrimary, opacity: data.nazev ? 1 : 0.5 }}>Uložit</button>
      </div>
    </div>
  );
}

function FormByt({ data, onChange, onSave, onCancel, objekty, inputSx, btnPrimary, btnSecondary, text, muted, border, isDark }) {
  const selectSx = { ...inputSx };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Bytový dům *</label>
        <select style={selectSx} value={data.objekt_id || ""} onChange={e => onChange({ ...data, objekt_id: e.target.value })}>
          <option value="">— Vyberte dům —</option>
          {objekty.map(o => <option key={o.id} value={o.id}>{o.nazev}</option>)}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Číslo bytu *</label>
          <input style={inputSx} value={data.cislo_bytu || ""} onChange={e => onChange({ ...data, cislo_bytu: e.target.value })} placeholder="např. 1, A, 2B" />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Patro</label>
          <input style={inputSx} value={data.patro || ""} onChange={e => onChange({ ...data, patro: e.target.value })} placeholder="např. 2" />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Dispozice</label>
          <input style={inputSx} value={data.dispozice || ""} onChange={e => onChange({ ...data, dispozice: e.target.value })} placeholder="např. 2+kk" />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Plocha (m²)</label>
          <input style={inputSx} type="number" value={data.plocha_m2 || ""} onChange={e => onChange({ ...data, plocha_m2: e.target.value })} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Nájem (Kč)</label>
          <input style={inputSx} type="number" value={data.najem_kc || ""} onChange={e => onChange({ ...data, najem_kc: e.target.value })} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Zálohy (Kč)</label>
          <input style={inputSx} type="number" value={data.zalohy_kc || ""} onChange={e => onChange({ ...data, zalohy_kc: e.target.value })} />
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Stav</label>
        <select style={selectSx} value={data.stav || "volný"} onChange={e => onChange({ ...data, stav: e.target.value })}>
          <option value="volný">Volný</option>
          <option value="obsazený">Obsazený</option>
          <option value="oprava">V opravě</option>
        </select>
      </div>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Poznámka</label>
        <textarea style={{ ...inputSx, resize: "vertical", minHeight: 60 }} value={data.poznamka || ""} onChange={e => onChange({ ...data, poznamka: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(data)} disabled={!data.cislo_bytu || !data.objekt_id} style={{ flex: 1, ...btnPrimary, opacity: (data.cislo_bytu && data.objekt_id) ? 1 : 0.5 }}>Uložit</button>
      </div>
    </div>
  );
}

function FormNajemnik({ data, onChange, onSave, onCancel, byty, objekty, inputSx, btnPrimary, btnSecondary, text, muted, border, isDark }) {
  const selectSx = { ...inputSx };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ gridColumn: "1/-1" }}>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Jméno a příjmení *</label>
          <input style={inputSx} value={data.jmeno || ""} onChange={e => onChange({ ...data, jmeno: e.target.value })} placeholder="Jan Novák" />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Telefon</label>
          <input style={inputSx} value={data.telefon || ""} onChange={e => onChange({ ...data, telefon: e.target.value })} placeholder="777 123 456" />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Email</label>
          <input style={inputSx} type="email" value={data.email || ""} onChange={e => onChange({ ...data, email: e.target.value })} placeholder="jan@email.cz" />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Datum narození</label>
          <input style={inputSx} value={data.datum_narozeni || ""} onChange={e => onChange({ ...data, datum_narozeni: e.target.value })} placeholder="1. 1. 1980" />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Číslo OP</label>
          <input style={inputSx} value={data.cislo_op || ""} onChange={e => onChange({ ...data, cislo_op: e.target.value })} />
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Přiřazený byt</label>
        <select style={selectSx} value={data.byt_id || ""} onChange={e => onChange({ ...data, byt_id: e.target.value })}>
          <option value="">— Bez bytu —</option>
          {byty.map(b => {
            const obj = objekty.find(o => o.id === b.objekt_id);
            return <option key={b.id} value={b.id}>{obj?.nazev ? `${obj.nazev} / ` : ""}{b.cislo_bytu}{b.dispozice ? ` (${b.dispozice})` : ""}</option>;
          })}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Smlouva od</label>
          <input style={inputSx} type="date" value={data.smlouva_od || ""} onChange={e => onChange({ ...data, smlouva_od: e.target.value })} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Smlouva do</label>
          <input style={inputSx} type="date" value={data.smlouva_do || ""} onChange={e => onChange({ ...data, smlouva_do: e.target.value })} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Kauce (Kč)</label>
          <input style={inputSx} type="number" value={data.kauce_kc || ""} onChange={e => onChange({ ...data, kauce_kc: e.target.value })} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: text }}>
            <input type="checkbox" checked={data.kauce_zaplacena || false} onChange={e => onChange({ ...data, kauce_zaplacena: e.target.checked })} />
            Kauce zaplacena
          </label>
        </div>
      </div>
      <div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: text }}>
          <input type="checkbox" checked={data.email_notifikace !== false} onChange={e => onChange({ ...data, email_notifikace: e.target.checked })} />
          Posílat email notifikace tomuto nájemníkovi
        </label>
      </div>
      <div>
        <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Poznámka</label>
        <textarea style={{ ...inputSx, resize: "vertical", minHeight: 60 }} value={data.poznamka || ""} onChange={e => onChange({ ...data, poznamka: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(data)} disabled={!data.jmeno} style={{ flex: 1, ...btnPrimary, opacity: data.jmeno ? 1 : 0.5 }}>Uložit</button>
      </div>
    </div>
  );
}

function LoginScreen({ isDark, onLogin, onMagicLink, inputSx, btnPrimary, surface, border, text, muted, bg }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("password"); // "password" | "magic"
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [magicSent, setMagicSent] = useState(false);

  const handleSubmit = async () => {
    setErr(""); setLoading(true);
    try {
      if (mode === "password") {
        await onLogin(email, password);
      } else {
        await onMagicLink(email);
        setMagicSent(true);
      }
    } catch (e) {
      setErr(e.message || "Chyba přihlášení");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI',Tahoma,sans-serif" }}>
      <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 16, padding: "40px 36px", width: 380, boxShadow: isDark ? "0 24px 60px rgba(0,0,0,0.5)" : "0 8px 30px rgba(0,0,0,0.1)" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🏠</div>
          <h1 style={{ color: text, margin: 0, fontSize: 22, fontWeight: 700 }}>Podnájem</h1>
          <p style={{ color: muted, margin: "6px 0 0", fontSize: 13 }}>Evidence podnájmů</p>
        </div>

        {magicSent ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📧</div>
            <p style={{ color: text, fontWeight: 600, marginBottom: 8 }}>Email odeslán!</p>
            <p style={{ color: muted, fontSize: 13 }}>Zkontrolujte inbox a klikněte na odkaz pro přihlášení.</p>
            <button onClick={() => { setMagicSent(false); setMode("password"); }} style={{ ...btnPrimary, marginTop: 20, width: "100%" }}>Zpět</button>
          </div>
        ) : (
          <>
            {/* Přepínač módu */}
            <div style={{ display: "flex", background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", borderRadius: 8, padding: 3, marginBottom: 20 }}>
              {[["password", "Heslo"], ["magic", "Magic link"]].map(([m, label]) => (
                <button key={m} onClick={() => { setMode(m); setErr(""); }} style={{
                  flex: 1, padding: "7px 0", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer",
                  background: mode === m ? (isDark ? "#1e40af" : "#2563eb") : "transparent",
                  color: mode === m ? "#fff" : muted, fontWeight: mode === m ? 600 : 400, fontFamily: "inherit",
                }}>
                  {label}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Email</label>
                <input style={inputSx} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="vas@email.cz" onKeyDown={e => e.key === "Enter" && handleSubmit()} />
              </div>
              {mode === "password" && (
                <div>
                  <label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Heslo</label>
                  <input style={inputSx} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === "Enter" && handleSubmit()} />
                </div>
              )}
              {err && <div style={{ color: "#f87171", fontSize: 13, background: "rgba(239,68,68,0.1)", padding: "8px 12px", borderRadius: 7 }}>{err}</div>}
              <button onClick={handleSubmit} disabled={loading || !email || (mode === "password" && !password)}
                style={{ ...btnPrimary, width: "100%", opacity: (loading || !email || (mode === "password" && !password)) ? 0.6 : 1, marginTop: 4 }}>
                {loading ? "Přihlašuji..." : mode === "magic" ? "Odeslat magic link" : "Přihlásit se"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
