import { useState, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
// BUILD: 2026_03_27_build0003
// ============================================================
// POZNÁMKY PRO CLAUDE (čti na začátku každé session)
// ============================================================
// PRAVIDLO #0 — PŘED KAŽDÝM NOVÝM ROZŠÍŘENÍM FUNKCIONALITY:
//   Nejprve důkladně prohledat internet, nabídnout min. 3-5 možností
//   s vysvětlením výhod/nevýhod, teprve pak implementovat zvolenou.
//   NESPOUŠTĚT implementaci bez průzkumu a výběru uživatelem!
//
// PRAVIDLO #1 — POKUD NĚCO NEFUNGUJE:
//   Nejprve důkladně zkontrolovat kód (logika, stavy, podmínky).
//   NEHÁDEJ — ZKONTROLUJ KÓD!
//
// PRAVIDLO #1b — KDYŽ OPRAVA NEFUNGUJE PO 2-3 POKUSECH:
//   Problém je v ARCHITEKTUŘE. Zastavit, přehodnotit, navrhnout správné řešení.
//
// PRAVIDLO #2 — TEXTY V TABULKÁCH:
//   Nikdy ellipsis tam kde je dost místa. wordBreak:break-word.
//
// PRAVIDLO #3 — VŽDY OVĚŘIT VÝSLEDEK:
//   Po každé změně ověřit že se oprava projevila v souboru.
//
// PRAVIDLO #4 — PŘI KAŽDÉM NOVÉM BUILDU POVINNĚ AKTUALIZOVAT:
//   a) Třetí řádek souboru:  // BUILD: DATUM_buildXXXX
//   b) Konstanta APP_BUILD: const APP_BUILD = "buildXXXX"
//
// DEPLOY: Vercel + GitHub (doco1971/podnajem)
//   Větev: main (produkce) — soubor: src/App.jsx
//
// ============================================================
// AKTUÁLNÍ STAV (build0003)
// ============================================================
// ✅ Supabase: pzhcvfucgdukdyggkmso.supabase.co
// ✅ Supabase Auth — email + magic link
// ✅ Role: admin, cajten
// ✅ Tabulky: objekty, byty, najemnici, platby, platby_polozky,
//             polozky_bytu, poruchy, log_aktivit, nastaveni, uzivatele
// ✅ RLS zapnuto na všech tabulkách
//
// PLATBY — architektura:
//   polozky_bytu: definice zálohy per byt (Nájem, Eon, Voda, Rezerva, Jiné...)
//   platby: hlavička měsíce (byt_id, rok, mesic, datum_platby, banka_kc, hotove_kc, doplatek_kc, srazky_kc, poznamka)
//   platby_polozky: částky per položka per měsíc (platba_id, polozka_id, predpis_kc, skutecnost_kc)
//
// ============================================================
// HISTORY BUILDŮ
// ============================================================
// BUILD0001 — Etapa 1: základ, auth, objekty, byty, nájemníci, log, záloha, XLSX
// BUILD0002 — Záložka Platby: generování předpisů, zaplaceno/saldo. Fix: type=date
// BUILD0003 — Přepracované platby: flexibilní položky zálohy per byt,
//             pohled měsíc + celé období, banka/hotově/doplatek/srážky,
//             upozornění konec smlouvy, nastavení položek bytu
//
// ============================================================
// SUPABASE CONFIG
// ============================================================
const APP_BUILD = "build0003";
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
const fmtKc = (n) => n ? fmt(n) + " Kč" : "—";
const MESICE = ["Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];

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
  const [polozkyBytu, setPolozkyBytu] = useState([]);
  const [platby, setPlatby] = useState([]);
  const [platbyPolozky, setPlatbyPolozky] = useState([]);
  const [logData, setLogData] = useState([]);

  // Platby stav
  const now = new Date();
  const [platbyMesic, setPlatbyMesic] = useState(now.getMonth());
  const [platbyRok, setPlatbyRok] = useState(now.getFullYear());
  const [platbyByt, setPlatbyByt] = useState(""); // "" = vše
  const [platbyPohled, setPlatbyPohled] = useState("mesic"); // "mesic" | "obdobi"
  const [editPlatba, setEditPlatba] = useState(null); // platba v editaci

  // UI stavy
  const [filterObjekt, setFilterObjekt] = useState("");
  const [msg, setMsg] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [importConfirm, setImportConfirm] = useState(null);
  const [importConfirmText, setImportConfirmText] = useState("");
  const [objektForm, setObjektForm] = useState(null);
  const [bytForm, setBytForm] = useState(null);
  const [najemnikForm, setNajemnikForm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [polozkyForm, setPolozkyForm] = useState(null); // byt_id pro editaci položek

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
  useEffect(() => { checkSession(); }, []);

  const checkSession = async () => {
    try {
      const stored = localStorage.getItem("podnajem_session");
      if (!stored) { setLoading(false); return; }
      const s = JSON.parse(stored);
      if (!s?.access_token) { setLoading(false); return; }
      const res = await fetch(`${SB_URL}/auth/v1/user`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${s.access_token}` }
      });
      if (!res.ok) { localStorage.removeItem("podnajem_session"); setLoading(false); return; }
      const user = await res.json();
      setSession(s);
      await loadUserRole(user.email, s.access_token);
    } catch { setLoading(false); }
  };

  const loadUserRole = async (email, token) => {
    try {
      const rows = await sb(`uzivatele?email=eq.${encodeURIComponent(email)}&limit=1`, { _token: token });
      if (rows && rows.length > 0) {
        setUserRole(rows[0].role);
        setUserName(rows[0].name || email);
      } else {
        setUserRole("cajten");
        setUserName(email);
      }
    } catch {
      setUserRole("cajten");
      setUserName(email);
    } finally { setLoading(false); }
  };

  const handleLogin = async (email, password) => {
    const data = await sbAuth("token?grant_type=password", { email, password });
    localStorage.setItem("podnajem_session", JSON.stringify(data));
    setSession(data);
    await loadUserRole(email, data.access_token);
    await logAkce(email, "Přihlášení", "");
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
    setSession(null); setUserRole(null);
    setObjekty([]); setByty([]); setNajemnici([]); setPlatby([]);
  };

  // ── DATA LOADING ────────────────────────────────────────────
  useEffect(() => {
    if (session && userRole) loadAll();
  }, [session, userRole]);

  useEffect(() => {
    if (session && userRole && activeTab === "platby") loadPlatby();
  }, [session, userRole, activeTab, platbyMesic, platbyRok, platbyByt, platbyPohled]);

  const loadAll = async () => {
    try {
      const [obj, byt, naj, pol] = await Promise.all([
        sb("objekty?order=nazev.asc"),
        sb("byty?order=cislo_bytu.asc"),
        sb("najemnici?order=jmeno.asc"),
        sb("polozky_bytu?order=byt_id.asc,poradi.asc"),
      ]);
      setObjekty(obj || []);
      setByty(byt || []);
      setNajemnici(naj || []);
      setPolozkyBytu(pol || []);
    } catch (e) { showMsg("Chyba načítání dat: " + e.message, "err"); }
  };

  const loadPlatby = async () => {
    try {
      let path;
      if (platbyPohled === "mesic") {
        path = `platby?rok=eq.${platbyRok}&mesic=eq.${platbyMesic + 1}&order=byt_id.asc`;
        if (platbyByt) path += `&byt_id=eq.${platbyByt}`;
      } else {
        // Pohled období — pro konkrétní byt nebo vše
        path = `platby?order=rok.asc,mesic.asc,byt_id.asc`;
        if (platbyByt) path += `&byt_id=eq.${platbyByt}`;
      }
      const pData = await sb(path);
      setPlatby(pData || []);
      // Načti položky pro tyto platby
      if (pData && pData.length > 0) {
        const ids = pData.map(p => p.id).join(",");
        const pp = await sb(`platby_polozky?platba_id=in.(${ids})&order=polozka_id.asc`);
        setPlatbyPolozky(pp || []);
      } else {
        setPlatbyPolozky([]);
      }
    } catch (e) { showMsg("Chyba načítání plateb: " + e.message, "err"); }
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
      await loadAll(); setObjektForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deleteObjekt = async (id) => {
    try {
      await sb(`objekty?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání objektu", `ID: ${id}`);
      showMsg("Objekt smazán"); await loadAll(); setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── BYTY CRUD ──────────────────────────────────────────────
  const saveByt = async (data) => {
    try {
      const payload = {
        objekt_id: Number(data.objekt_id), cislo_bytu: data.cislo_bytu,
        patro: data.patro, dispozice: data.dispozice,
        plocha_m2: data.plocha_m2 ? Number(data.plocha_m2) : null,
        najem_kc: data.najem_kc ? Number(data.najem_kc) : null,
        zalohy_kc: data.zalohy_kc ? Number(data.zalohy_kc) : null,
        stav: data.stav || "volný", poznamka: data.poznamka,
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
      await loadAll(); setBytForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deleteByt = async (id) => {
    try {
      await sb(`byty?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání bytu", `ID: ${id}`);
      showMsg("Byt smazán"); await loadAll(); setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── NÁJEMNÍCI CRUD ─────────────────────────────────────────
  const saveNajemnik = async (data) => {
    try {
      const payload = {
        byt_id: data.byt_id ? Number(data.byt_id) : null,
        jmeno: data.jmeno, telefon: data.telefon, email: data.email,
        datum_narozeni: data.datum_narozeni, cislo_op: data.cislo_op,
        smlouva_od: data.smlouva_od, smlouva_do: data.smlouva_do,
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
      await loadAll(); setNajemnikForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deleteNajemnik = async (id) => {
    try {
      await sb(`najemnici?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání nájemníka", `ID: ${id}`);
      showMsg("Nájemník smazán"); await loadAll(); setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── POLOŽKY BYTU CRUD ──────────────────────────────────────
  const savePolozkyBytu = async (bytId, polozky) => {
    try {
      // Smaž stávající a vlož nové
      await sb(`polozky_bytu?byt_id=eq.${bytId}`, { method: "DELETE", prefer: "return=minimal" });
      if (polozky.length > 0) {
        const rows = polozky.map((p, i) => ({ byt_id: Number(bytId), nazev: p.nazev, poradi: i }));
        await sb("polozky_bytu", { method: "POST", body: JSON.stringify(rows), prefer: "return=minimal" });
      }
      await logAkce(userName, "Editace položek bytu", `byt_id: ${bytId}, ${polozky.length} položek`);
      showMsg("Položky uloženy");
      await loadAll();
      setPolozkyForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── PLATBY CRUD ────────────────────────────────────────────
  const generujPredpisy = async () => {
    const obsazene = byty.filter(b => b.stav === "obsazený");
    const filtrovane = platbyByt ? obsazene.filter(b => b.id === Number(platbyByt)) : obsazene;
    if (filtrovane.length === 0) { showMsg("Žádné obsazené byty.", "err"); return; }
    const mesicDB = platbyMesic + 1;
    let pridano = 0, preskoceno = 0;
    for (const b of filtrovane) {
      const existuje = platby.find(p => p.byt_id === b.id && p.mesic === mesicDB && p.rok === platbyRok);
      if (existuje) { preskoceno++; continue; }
      const polozky = polozkyBytu.filter(p => p.byt_id === b.id);
      // Vytvoř hlavičku platby
      const [novaPlatba] = await sb("platby", { method: "POST", body: JSON.stringify({
        byt_id: b.id, rok: platbyRok, mesic: mesicDB, zaplaceno: false,
      }) });
      // Vytvoř položky — pokud jsou nadefinovány, jinak jen nájem
      if (polozky.length > 0) {
        const ppRows = polozky.map(p => ({ platba_id: novaPlatba.id, polozka_id: p.id, predpis_kc: 0, skutecnost_kc: null }));
        await sb("platby_polozky", { method: "POST", body: JSON.stringify(ppRows), prefer: "return=minimal" });
      }
      pridano++;
    }
    await logAkce(userName, "Generování předpisů", `${mesicDB}/${platbyRok}: ${pridano} nových`);
    showMsg(`Předpisy vygenerovány: ${pridano} nových${preskoceno ? `, ${preskoceno} přeskočeno` : ""}`);
    await loadPlatby();
  };

  const savePlatba = async (data) => {
    try {
      const payload = {
        datum_platby: data.datum_platby || null,
        banka_kc: Number(data.banka_kc) || 0,
        hotove_kc: Number(data.hotove_kc) || 0,
        doplatek_kc: Number(data.doplatek_kc) || 0,
        srazky_kc: Number(data.srazky_kc) || 0,
        jine_platby_kc: Number(data.jine_platby_kc) || 0,
        nedoplatek_energie_kc: Number(data.nedoplatek_energie_kc) || 0,
        poznamka: data.poznamka || "",
        zaplaceno: (Number(data.banka_kc) || 0) + (Number(data.hotove_kc) || 0) + (Number(data.doplatek_kc) || 0) > 0,
      };
      await sb(`platby?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
      // Ulož položky
      if (data.polozky) {
        for (const pp of data.polozky) {
          await sb(`platby_polozky?id=eq.${pp.id}`, { method: "PATCH", body: JSON.stringify({ predpis_kc: Number(pp.predpis_kc) || 0, skutecnost_kc: pp.skutecnost_kc ? Number(pp.skutecnost_kc) : null }), prefer: "return=minimal" });
        }
      }
      await logAkce(userName, "Editace platby", `ID: ${data.id}`);
      showMsg("Platba uložena");
      await loadPlatby();
      setEditPlatba(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deletePlatba = async (id) => {
    try {
      await sb(`platby?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání platby", `ID: ${id}`);
      showMsg("Platba smazána");
      await loadPlatby();
      setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── LOG ────────────────────────────────────────────────────
  const loadLog = async () => {
    try {
      const res = await sb("log_aktivit?order=cas.desc&limit=200&hidden=eq.false");
      setLogData(res || []);
    } catch { setLogData([]); }
  };

  // ── JSON ZÁLOHA ────────────────────────────────────────────
  const exportJSON = async () => {
    try {
      const [obj, byt, naj, log, pol] = await Promise.all([
        sb("objekty?order=id.asc"), sb("byty?order=id.asc"),
        sb("najemnici?order=id.asc"), sb("log_aktivit?order=id.asc&limit=2000"),
        sb("polozky_bytu?order=id.asc"),
      ]);
      const payload = { version: 2, created: new Date().toISOString(), prostredi: "PRODUKCE", objekty: obj, byty: byt, najemnici: naj, log_aktivit: log, polozky_bytu: pol };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `podnajem-zaloha-${new Date().toISOString().slice(0,10)}.json`;
      a.click(); URL.revokeObjectURL(url);
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
      await sb("najemnici?id=gt.0", { method: "DELETE", prefer: "return=minimal" });
      await sb("byty?id=gt.0", { method: "DELETE", prefer: "return=minimal" });
      await sb("objekty?id=gt.0", { method: "DELETE", prefer: "return=minimal" });
      if (payload.objekty?.length) await sb("objekty", { method: "POST", body: JSON.stringify(payload.objekty.map(r => { const {id,...x}=r; return x; })) });
      if (payload.byty?.length) await sb("byty", { method: "POST", body: JSON.stringify(payload.byty.map(r => { const {id,...x}=r; return x; })) });
      if (payload.najemnici?.length) await sb("najemnici", { method: "POST", body: JSON.stringify(payload.najemnici.map(r => { const {id,...x}=r; return x; })) });
      await logAkce(userName, "Import zálohy JSON", payload.fileName || "");
      showMsg("Import dokončen"); await loadAll();
      setImportConfirm(null); setImportConfirmText("");
    } catch (e) { showMsg("Chyba importu: " + e.message, "err"); }
  };

  // ── XLSX EXPORT ────────────────────────────────────────────
  const exportXLSX = () => {
    const rows = byty.map(b => {
      const obj = objekty.find(o => o.id === b.objekt_id);
      const naj = najemnici.find(n => n.byt_id === b.id);
      return {
        "Dům": obj?.nazev || "", "Adresa": obj?.adresa || "", "Byt č.": b.cislo_bytu,
        "Patro": b.patro || "", "Dispozice": b.dispozice || "", "Plocha m²": b.plocha_m2 || "",
        "Nájem Kč": b.najem_kc || "", "Zálohy Kč": b.zalohy_kc || "", "Stav": b.stav || "",
        "Nájemník": naj?.jmeno || "", "Telefon": naj?.telefon || "", "Email": naj?.email || "",
        "Smlouva od": naj?.smlouva_od || "", "Smlouva do": naj?.smlouva_do || "",
        "Kauce Kč": naj?.kauce_kc || "", "Kauce zaplacena": naj?.kauce_zaplacena ? "Ano" : "Ne",
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
    });
    const propadlaSml = najemnici.filter(n => n.smlouva_do && new Date(n.smlouva_do) < new Date());
    return { celkem: byty.length, obsazeno, prijemMesic, brzeKonec, propadlaSml };
  }, [byty, najemnici]);

  const platbyStats = useMemo(() => {
    const predpis = platbyPolozky.reduce((s, pp) => s + (Number(pp.predpis_kc) || 0), 0);
    const zaplaceno = platby.filter(p => p.zaplaceno).reduce((s, p) => s + (Number(p.banka_kc) || 0) + (Number(p.hotove_kc) || 0) + (Number(p.doplatek_kc) || 0), 0);
    const dluh = Math.max(0, predpis - zaplaceno);
    return { predpis, zaplaceno, dluh };
  }, [platby, platbyPolozky]);

  const isSmlouvaBrzy = (datum) => {
    if (!datum) return false;
    const diff = (new Date(datum) - new Date()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 60;
  };
  const isSmlouvaPropadla = (datum) => datum && new Date(datum) < new Date();

  // ── STYLY ──────────────────────────────────────────────────
  const bg = isDark ? "#0f172a" : "#f1f5f9";
  const surface = isDark ? "#1e293b" : "#ffffff";
  const border = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
  const text = isDark ? "#e2e8f0" : "#1e293b";
  const muted = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";
  const inputBg = isDark ? "#0f172a" : "#ffffff";
  const inputBorder = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)";
  const inputSx = { width: "100%", padding: "8px 11px", background: inputBg, border: `1px solid ${inputBorder}`, borderRadius: 7, color: text, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };
  const btnPrimary = { padding: "9px 20px", background: "linear-gradient(135deg,#2563eb,#1d4ed8)", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 };
  const btnSecondary = { padding: "8px 16px", background: "transparent", border: `1px solid ${border}`, borderRadius: 8, color: text, cursor: "pointer", fontSize: 13 };
  const btnDanger = { padding: "8px 16px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#f87171", cursor: "pointer", fontSize: 13 };
  const cardSx = { background: surface, border: `1px solid ${border}`, borderRadius: 12, padding: "16px 20px" };
  const thSx = { padding: "10px 14px", textAlign: "left", color: muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${border}`, whiteSpace: "nowrap" };
  const tdSx = { padding: "10px 14px", borderBottom: `1px solid ${border}`, verticalAlign: "middle" };

  // ── RENDER ─────────────────────────────────────────────────
  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: bg, color: text, fontFamily: "'Segoe UI',Tahoma,sans-serif", fontSize: 14 }}>Načítání...</div>
  );

  if (!session) return (
    <LoginScreen isDark={isDark} onLogin={handleLogin} onMagicLink={handleMagicLink} inputSx={inputSx} btnPrimary={btnPrimary} surface={surface} border={border} text={text} muted={muted} bg={bg} />
  );

  // Upozornění na smlouvy
  const upozorneni = [...stats.brzeKonec, ...stats.propadlaSml].filter((n, i, arr) => arr.findIndex(x => x.id === n.id) === i);

  return (
    <div style={{ minHeight: "100vh", background: bg, fontFamily: "'Segoe UI',Tahoma,sans-serif", color: text }}>

      {/* TOAST */}
      {msg && (
        <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, padding: "11px 20px", borderRadius: 10, background: msg.type === "err" ? "#dc2626" : "#16a34a", color: "#fff", fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
          {msg.type === "err" ? "⚠️ " : "✅ "}{msg.text}
        </div>
      )}

      {/* UPOZORNĚNÍ NA SMLOUVY */}
      {upozorneni.length > 0 && activeTab !== "najemnici" && (
        <div style={{ background: "rgba(239,68,68,0.12)", borderBottom: "1px solid rgba(239,68,68,0.25)", padding: "8px 24px", fontSize: 12, color: "#fca5a5", cursor: "pointer" }} onClick={() => setActiveTab("najemnici")}>
          ⚠️ {upozorneni.map(n => {
            const propadla = isSmlouvaPropadla(n.smlouva_do);
            return `${n.jmeno}: smlouva ${propadla ? "propadlá" : "končí"} ${n.smlouva_do}`;
          }).join(" · ")} — klikněte pro detail
        </div>
      )}

      {/* HEADER */}
      <div style={{ background: surface, borderBottom: `1px solid ${border}`, padding: "0 24px", display: "flex", alignItems: "center", height: 52, position: "sticky", top: upozorneni.length > 0 ? 33 : 0, zIndex: 100 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: text, marginRight: 32 }}>🏠 <span style={{ color: "#3b82f6" }}>Podnájem</span></div>
        {["prehled", "platby", "najemnici", "objekty"].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: "0 16px", height: 52, border: "none", background: "none", fontSize: 13,
            color: activeTab === tab ? "#3b82f6" : muted,
            borderBottom: activeTab === tab ? "2px solid #3b82f6" : "2px solid transparent",
            cursor: "pointer", fontWeight: activeTab === tab ? 600 : 400, fontFamily: "inherit",
          }}>
            {tab === "prehled" ? "Přehled" : tab === "platby" ? "Platby" : tab === "najemnici" ? "Nájemníci" : "Objekty a byty"}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: muted }}>{userName}</span>
          <span style={{ fontSize: 11, color: muted, background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", padding: "2px 8px", borderRadius: 99 }}>{userRole}</span>
          {isAdmin && (<>
            <button onClick={exportXLSX} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>📊 XLSX</button>
            <button onClick={exportJSON} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>💾 Záloha</button>
            <label style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
              📂 Import
              <input type="file" accept=".json" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; }} />
            </label>
            <button onClick={() => { setShowLog(true); loadLog(); }} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>📋 Log</button>
          </>)}
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>{isDark ? "☀️" : "🌙"}</button>
          <button onClick={handleLogout} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>Odhlásit</button>
          <span style={{ fontSize: 11, color: muted }}>{APP_BUILD}</span>
        </div>
      </div>

      {/* CONTENT */}
      <div style={{ padding: "24px", maxWidth: 1400, margin: "0 auto" }}>

        {/* ── TAB: PŘEHLED ── */}
        {activeTab === "prehled" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}>
              {[
                { label: "Bytů celkem", value: stats.celkem, color: "#3b82f6" },
                { label: "Obsazeno", value: stats.obsazeno, color: "#22c55e" },
                { label: "Příjem / měsíc", value: stats.prijemMesic ? fmt(stats.prijemMesic) + " Kč" : "—", color: "#f59e0b" },
                { label: "Pozor — smlouvy", value: upozorneni.length, color: upozorneni.length > 0 ? "#f87171" : "#22c55e" },
              ].map(c => (
                <div key={c.label} style={{ ...cardSx, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>{c.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: muted }}>Dům:</span>
              {[{ id: "", nazev: "Vše" }, ...objekty].map(o => (
                <button key={o.id} onClick={() => setFilterObjekt(o.id === "" ? "" : o.id)}
                  style={{ padding: "4px 14px", borderRadius: 99, fontSize: 12, cursor: "pointer", border: `1px solid ${filterObjekt === (o.id === "" ? "" : o.id) ? "#3b82f6" : border}`, background: filterObjekt === (o.id === "" ? "" : o.id) ? "rgba(59,130,246,0.15)" : "transparent", color: filterObjekt === (o.id === "" ? "" : o.id) ? "#3b82f6" : text, fontWeight: filterObjekt === (o.id === "" ? "" : o.id) ? 600 : 400 }}>
                  {o.nazev}
                </button>
              ))}
            </div>

            <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Byty</span>
                {isAdmin && <button onClick={() => setBytForm({ stav: "volný", objekt_id: filterObjekt || "" })} style={btnPrimary}>+ Přidat byt</button>}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                      {["Dům","Byt č.","Dispozice","Plocha","Nájem","Zálohy","Nájemník","Smlouva do","Kauce","Stav", isAdmin ? "Akce" : ""].filter(Boolean).map(h => <th key={h} style={thSx}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {bytySFiltered.length === 0 && <tr><td colSpan={11} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné byty.</td></tr>}
                    {bytySFiltered.map(b => {
                      const obj = objekty.find(o => o.id === b.objekt_id);
                      const naj = najemnici.find(n => n.byt_id === b.id);
                      const brzy = naj && isSmlouvaBrzy(naj.smlouva_do);
                      const propadla = naj && isSmlouvaPropadla(naj.smlouva_do);
                      return (
                        <tr key={b.id} style={{ borderBottom: `1px solid ${border}` }}
                          onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={tdSx}><span style={{ color: muted, fontSize: 12 }}>{obj?.nazev || "—"}</span></td>
                          <td style={tdSx}><strong>{b.cislo_bytu}</strong></td>
                          <td style={{ ...tdSx, color: muted }}>{b.dispozice || "—"}</td>
                          <td style={{ ...tdSx, color: muted }}>{b.plocha_m2 ? b.plocha_m2 + " m²" : "—"}</td>
                          <td style={tdSx}>{fmtKc(b.najem_kc)}</td>
                          <td style={{ ...tdSx, color: muted }}>{fmtKc(b.zalohy_kc)}</td>
                          <td style={tdSx}>{naj ? naj.jmeno : <span style={{ color: muted }}>—</span>}</td>
                          <td style={{ ...tdSx, color: propadla ? "#f87171" : brzy ? "#f59e0b" : text, fontWeight: (brzy || propadla) ? 600 : 400 }}>{naj?.smlouva_do || "—"}{propadla && " ⚠️"}{brzy && !propadla && " ⏰"}</td>
                          <td style={tdSx}>{naj?.kauce_kc ? <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, background: naj.kauce_zaplacena ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: naj.kauce_zaplacena ? "#4ade80" : "#f87171" }}>{naj.kauce_zaplacena ? "✓" : "✗"} {fmt(naj.kauce_kc)} Kč</span> : "—"}</td>
                          <td style={tdSx}><StavBadge stav={b.stav} /></td>
                          {isAdmin && <td style={tdSx}>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => setBytForm({ ...b })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14, padding: "2px 4px" }}>✏️</button>
                              <button onClick={() => setPolozkyForm(b.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#60a5fa", fontSize: 14, padding: "2px 4px" }} title="Položky zálohy">⚙️</button>
                              <button onClick={() => setDeleteConfirm({ type: "byt", id: b.id, nazev: b.cislo_bytu })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14, padding: "2px 4px" }}>🗑️</button>
                            </div>
                          </td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: PLATBY ── */}
        {activeTab === "platby" && (
          <div>
            {/* Toolbar */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              {/* Pohled přepínač */}
              <div style={{ display: "flex", background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", borderRadius: 8, padding: 3 }}>
                {[["mesic","Měsíc"],["obdobi","Celé období"]].map(([v, l]) => (
                  <button key={v} onClick={() => setPlatbyPohled(v)} style={{ padding: "5px 14px", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", background: platbyPohled === v ? (isDark ? "#1e40af" : "#2563eb") : "transparent", color: platbyPohled === v ? "#fff" : muted, fontFamily: "inherit" }}>{l}</button>
                ))}
              </div>

              {/* Filtr bytu */}
              <select style={{ ...inputSx, width: "auto", minWidth: 160 }} value={platbyByt} onChange={e => setPlatbyByt(e.target.value)}>
                <option value="">Všechny byty</option>
                {byty.map(b => {
                  const obj = objekty.find(o => o.id === b.objekt_id);
                  return <option key={b.id} value={b.id}>{obj?.nazev ? `${obj.nazev} / ` : ""}{b.cislo_bytu}</option>;
                })}
              </select>

              {/* Měsíc/rok — jen pro pohled měsíc */}
              {platbyPohled === "mesic" && (<>
                <button onClick={() => { let m = platbyMesic - 1, r = platbyRok; if (m < 0) { m = 11; r--; } setPlatbyMesic(m); setPlatbyRok(r); }} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 14 }}>‹</button>
                <span style={{ fontSize: 14, fontWeight: 600, minWidth: 130, textAlign: "center" }}>{MESICE[platbyMesic]} {platbyRok}</span>
                <button onClick={() => { let m = platbyMesic + 1, r = platbyRok; if (m > 11) { m = 0; r++; } setPlatbyMesic(m); setPlatbyRok(r); }} style={{ ...btnSecondary, padding: "6px 12px", fontSize: 14 }}>›</button>
                {isAdmin && <button onClick={generujPredpisy} style={btnPrimary}>+ Generovat předpisy</button>}
              </>)}
            </div>

            {/* Saldo karty — jen pro měsíční pohled */}
            {platbyPohled === "mesic" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
                {[
                  { label: "Předpis celkem", value: fmtKc(platbyStats.predpis) || "—", color: "#3b82f6" },
                  { label: "Zaplaceno", value: fmtKc(platbyStats.zaplaceno) || "—", color: "#22c55e" },
                  { label: "Dluh", value: platbyStats.dluh > 0 ? fmtKc(platbyStats.dluh) : "0 Kč", color: platbyStats.dluh > 0 ? "#f87171" : "#22c55e" },
                ].map(c => (
                  <div key={c.label} style={{ ...cardSx, textAlign: "center" }}>
                    <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>{c.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Tabulka plateb */}
            <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                      {platbyPohled === "obdobi" && <th style={thSx}>Měsíc / Rok</th>}
                      <th style={thSx}>Dům</th>
                      <th style={thSx}>Byt</th>
                      <th style={thSx}>Nájemník</th>
                      <th style={thSx}>Předpis</th>
                      <th style={thSx}>Zaplaceno</th>
                      <th style={thSx}>Datum platby</th>
                      <th style={thSx}>Stav</th>
                      {isAdmin && <th style={thSx}>Akce</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {platby.length === 0 && (
                      <tr><td colSpan={9} style={{ padding: "40px", textAlign: "center", color: muted }}>
                        Žádné záznamy.{platbyPohled === "mesic" && isAdmin && " Klikněte \"+ Generovat předpisy\"."}
                      </td></tr>
                    )}
                    {platby.map(p => {
                      const byt = byty.find(b => b.id === p.byt_id);
                      const obj = byt ? objekty.find(o => o.id === byt.objekt_id) : null;
                      const naj = najemnici.find(n => n.byt_id === p.byt_id);
                      const pp = platbyPolozky.filter(x => x.platba_id === p.id);
                      const predpis = pp.reduce((s, x) => s + (Number(x.predpis_kc) || 0), 0);
                      const zaplaceno = (Number(p.banka_kc) || 0) + (Number(p.hotove_kc) || 0) + (Number(p.doplatek_kc) || 0);
                      return (
                        <tr key={p.id} style={{ borderBottom: `1px solid ${border}`, background: p.zaplaceno ? (isDark ? "rgba(34,197,94,0.04)" : "rgba(34,197,94,0.03)") : "transparent" }}
                          onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                          onMouseLeave={e => e.currentTarget.style.background = p.zaplaceno ? (isDark ? "rgba(34,197,94,0.04)" : "rgba(34,197,94,0.03)") : "transparent"}>
                          {platbyPohled === "obdobi" && <td style={{ ...tdSx, fontWeight: 600, whiteSpace: "nowrap" }}>{MESICE[p.mesic - 1]} {p.rok}</td>}
                          <td style={{ ...tdSx, color: muted, fontSize: 12 }}>{obj?.nazev || "—"}</td>
                          <td style={{ ...tdSx }}><strong>{byt?.cislo_bytu || "—"}</strong></td>
                          <td style={tdSx}>{naj?.jmeno || <span style={{ color: muted }}>—</span>}</td>
                          <td style={tdSx}>
                            {predpis > 0 ? (
                              <div>
                                <div style={{ fontWeight: 600 }}>{fmtKc(predpis)}</div>
                                {pp.map(x => {
                                  const pol = polozkyBytu.find(pb => pb.id === x.polozka_id);
                                  return pol ? <div key={x.id} style={{ fontSize: 11, color: muted }}>{pol.nazev}: {fmtKc(x.predpis_kc)}</div> : null;
                                })}
                              </div>
                            ) : <span style={{ color: muted }}>—</span>}
                          </td>
                          <td style={{ ...tdSx, color: p.zaplaceno ? "#4ade80" : muted }}>
                            {zaplaceno > 0 ? (
                              <div>
                                <div style={{ fontWeight: 600 }}>{fmtKc(zaplaceno)}</div>
                                {Number(p.banka_kc) > 0 && <div style={{ fontSize: 11, color: muted }}>Banka: {fmtKc(p.banka_kc)}</div>}
                                {Number(p.hotove_kc) > 0 && <div style={{ fontSize: 11, color: muted }}>Hotově: {fmtKc(p.hotove_kc)}</div>}
                                {Number(p.doplatek_kc) > 0 && <div style={{ fontSize: 11, color: muted }}>Doplatek: {fmtKc(p.doplatek_kc)}</div>}
                                {Number(p.srazky_kc) > 0 && <div style={{ fontSize: 11, color: "#f59e0b" }}>Srážka: -{fmtKc(p.srazky_kc)}</div>}
                              </div>
                            ) : "—"}
                          </td>
                          <td style={{ ...tdSx, color: muted, fontSize: 12 }}>{p.datum_platby || "—"}</td>
                          <td style={tdSx}>
                            <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: p.zaplaceno ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: p.zaplaceno ? "#4ade80" : "#f87171" }}>
                              {p.zaplaceno ? "zaplaceno" : "nezaplaceno"}
                            </span>
                            {p.poznamka && <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>{p.poznamka}</div>}
                          </td>
                          {isAdmin && <td style={tdSx}>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => setEditPlatba({ ...p, polozky: pp.map(x => ({ ...x })) })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14, padding: "2px 4px" }}>✏️</button>
                              <button onClick={() => setDeleteConfirm({ type: "platba", id: p.id, nazev: `${byt?.cislo_bytu} ${MESICE[p.mesic-1]} ${p.rok}` })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14, padding: "2px 4px" }}>🗑️</button>
                            </div>
                          </td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: NÁJEMNÍCI ── */}
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
                      {["Jméno","Byt","Telefon","Email","Smlouva od","Smlouva do","Kauce","Notifikace", isAdmin ? "Akce" : ""].filter(Boolean).map(h => <th key={h} style={thSx}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {najemnici.length === 0 && <tr><td colSpan={9} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádní nájemníci.</td></tr>}
                    {najemnici.map(n => {
                      const byt = byty.find(b => b.id === n.byt_id);
                      const obj = byt ? objekty.find(o => o.id === byt.objekt_id) : null;
                      const brzy = isSmlouvaBrzy(n.smlouva_do);
                      const propadla = isSmlouvaPropadla(n.smlouva_do);
                      return (
                        <tr key={n.id} style={{ borderBottom: `1px solid ${border}`, background: propadla ? (isDark ? "rgba(239,68,68,0.06)" : "rgba(239,68,68,0.04)") : brzy ? (isDark ? "rgba(245,158,11,0.06)" : "rgba(245,158,11,0.04)") : "transparent" }}
                          onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                          onMouseLeave={e => e.currentTarget.style.background = propadla ? (isDark ? "rgba(239,68,68,0.06)" : "rgba(239,68,68,0.04)") : brzy ? (isDark ? "rgba(245,158,11,0.06)" : "rgba(245,158,11,0.04)") : "transparent"}>
                          <td style={{ ...tdSx, fontWeight: 600 }}>{n.jmeno}</td>
                          <td style={{ ...tdSx, color: muted, fontSize: 12 }}>{obj ? `${obj.nazev} / ${byt?.cislo_bytu}` : "—"}</td>
                          <td style={tdSx}>{n.telefon || "—"}</td>
                          <td style={{ ...tdSx, color: "#60a5fa" }}>{n.email || "—"}</td>
                          <td style={{ ...tdSx, color: muted }}>{n.smlouva_od || "—"}</td>
                          <td style={{ ...tdSx, color: propadla ? "#f87171" : brzy ? "#f59e0b" : text, fontWeight: (brzy || propadla) ? 600 : 400 }}>
                            {n.smlouva_do || "—"}{propadla && " ⚠️ propadlá"}{brzy && !propadla && " ⏰ brzy"}
                          </td>
                          <td style={tdSx}>{n.kauce_kc ? <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, background: n.kauce_zaplacena ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: n.kauce_zaplacena ? "#4ade80" : "#f87171" }}>{n.kauce_zaplacena ? "✓" : "✗"} {fmt(n.kauce_kc)} Kč</span> : "—"}</td>
                          <td style={tdSx}><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: n.email_notifikace ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.05)", color: n.email_notifikace ? "#4ade80" : muted }}>{n.email_notifikace ? "✓ Ano" : "✗ Ne"}</span></td>
                          {isAdmin && <td style={tdSx}>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => setNajemnikForm({ ...n })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14 }}>✏️</button>
                              <button onClick={() => setDeleteConfirm({ type: "najemnik", id: n.id, nazev: n.jmeno })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14 }}>🗑️</button>
                            </div>
                          </td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: OBJEKTY ── */}
        {activeTab === "objekty" && (
          <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20 }}>
            <div>
              <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Bytové domy</span>
                  {isAdmin && <button onClick={() => setObjektForm({})} style={{ ...btnPrimary, padding: "6px 14px", fontSize: 12 }}>+ Přidat</button>}
                </div>
                {objekty.length === 0 && <div style={{ padding: "32px", textAlign: "center", color: muted, fontSize: 13 }}>Žádné objekty.</div>}
                {objekty.map(o => {
                  const pocetBytu = byty.filter(b => b.objekt_id === o.id).length;
                  const obsazeno = byty.filter(b => b.objekt_id === o.id && b.stav === "obsazený").length;
                  return (
                    <div key={o.id} style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, cursor: "pointer" }} onClick={() => setFilterObjekt(o.id)}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{o.nazev}</div>
                      <div style={{ fontSize: 12, color: muted, marginBottom: 6 }}>{o.adresa || "—"}</div>
                      <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
                        <span style={{ padding: "2px 8px", borderRadius: 99, background: "rgba(59,130,246,0.12)", color: "#60a5fa" }}>{pocetBytu} bytů</span>
                        <span style={{ padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80" }}>{obsazeno} obsazeno</span>
                      </div>
                      {isAdmin && <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button onClick={e => { e.stopPropagation(); setObjektForm({ ...o }); }} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 11 }}>✏️ Editovat</button>
                        <button onClick={e => { e.stopPropagation(); setDeleteConfirm({ type: "objekt", id: o.id, nazev: o.nazev }); }} style={{ ...btnDanger, padding: "4px 10px", fontSize: 11 }}>🗑️ Smazat</button>
                      </div>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <div style={{ ...cardSx, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{filterObjekt ? `Byty — ${objekty.find(o => o.id === Number(filterObjekt))?.nazev || ""}` : "Byty (všechny)"}</span>
                  {isAdmin && <button onClick={() => setBytForm({ stav: "volný", objekt_id: filterObjekt || "" })} style={{ ...btnPrimary, padding: "6px 14px", fontSize: 12 }}>+ Přidat byt</button>}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                        {["Č.","Patro","Disp.","Plocha","Nájem","Zálohy","Položky","Stav", isAdmin ? "Akce" : ""].filter(Boolean).map(h => <th key={h} style={thSx}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {bytySFiltered.length === 0 && <tr><td colSpan={9} style={{ padding: "24px", textAlign: "center", color: muted }}>Žádné byty.</td></tr>}
                      {bytySFiltered.map(b => {
                        const polozky = polozkyBytu.filter(p => p.byt_id === b.id);
                        return (
                          <tr key={b.id} style={{ borderBottom: `1px solid ${border}` }}
                            onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <td style={{ ...tdSx, fontWeight: 600 }}>{b.cislo_bytu}</td>
                            <td style={{ ...tdSx, color: muted }}>{b.patro || "—"}</td>
                            <td style={{ ...tdSx, color: muted }}>{b.dispozice || "—"}</td>
                            <td style={{ ...tdSx, color: muted }}>{b.plocha_m2 ? b.plocha_m2 + " m²" : "—"}</td>
                            <td style={tdSx}>{fmtKc(b.najem_kc)}</td>
                            <td style={{ ...tdSx, color: muted }}>{fmtKc(b.zalohy_kc)}</td>
                            <td style={tdSx}>
                              {polozky.length > 0 ? <span style={{ fontSize: 11, color: "#60a5fa" }}>{polozky.length} položek</span> : <span style={{ fontSize: 11, color: muted }}>nenastaveno</span>}
                            </td>
                            <td style={tdSx}><StavBadge stav={b.stav} /></td>
                            {isAdmin && <td style={tdSx}>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button onClick={() => setBytForm({ ...b })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14 }}>✏️</button>
                                <button onClick={() => setPolozkyForm(b.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#60a5fa", fontSize: 14 }} title="Položky zálohy">⚙️</button>
                                <button onClick={() => setDeleteConfirm({ type: "byt", id: b.id, nazev: b.cislo_bytu })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14 }}>🗑️</button>
                              </div>
                            </td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── MODÁLY ── */}

      {objektForm && <Modal title={objektForm.id ? "Editace objektu" : "Nový objekt"} onClose={() => setObjektForm(null)} isDark={isDark} surface={surface} border={border} text={text}>
        <FormObjekt data={objektForm} onChange={setObjektForm} onSave={saveObjekt} onCancel={() => setObjektForm(null)} inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary} text={text} muted={muted} />
      </Modal>}

      {bytForm && <Modal title={bytForm.id ? "Editace bytu" : "Nový byt"} onClose={() => setBytForm(null)} isDark={isDark} surface={surface} border={border} text={text}>
        <FormByt data={bytForm} onChange={setBytForm} onSave={saveByt} onCancel={() => setBytForm(null)} objekty={objekty} inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary} text={text} muted={muted} border={border} isDark={isDark} />
      </Modal>}

      {najemnikForm && <Modal title={najemnikForm.id ? "Editace nájemníka" : "Nový nájemník"} onClose={() => setNajemnikForm(null)} isDark={isDark} surface={surface} border={border} text={text} wide>
        <FormNajemnik data={najemnikForm} onChange={setNajemnikForm} onSave={saveNajemnik} onCancel={() => setNajemnikForm(null)} byty={byty} objekty={objekty} inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary} text={text} muted={muted} border={border} isDark={isDark} />
      </Modal>}

      {/* POLOŽKY BYTU MODAL */}
      {polozkyForm && <Modal title={`Položky zálohy — byt ${byty.find(b => b.id === polozkyForm)?.cislo_bytu || ""}`} onClose={() => setPolozkyForm(null)} isDark={isDark} surface={surface} border={border} text={text}>
        <FormPolozkyBytu
          bytId={polozkyForm}
          polozky={polozkyBytu.filter(p => p.byt_id === polozkyForm)}
          onSave={savePolozkyBytu}
          onCancel={() => setPolozkyForm(null)}
          inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary} btnDanger={btnDanger}
          text={text} muted={muted} border={border} isDark={isDark}
        />
      </Modal>}

      {/* EDITACE PLATBY MODAL */}
      {editPlatba && <Modal title={`Platba — ${byty.find(b => b.id === editPlatba.byt_id)?.cislo_bytu || ""} — ${MESICE[editPlatba.mesic - 1]} ${editPlatba.rok}`} onClose={() => setEditPlatba(null)} isDark={isDark} surface={surface} border={border} text={text} wide>
        <FormPlatba
          data={editPlatba}
          onChange={setEditPlatba}
          onSave={savePlatba}
          onCancel={() => setEditPlatba(null)}
          polozkyBytu={polozkyBytu.filter(p => p.byt_id === editPlatba.byt_id)}
          inputSx={inputSx} btnPrimary={btnPrimary} btnSecondary={btnSecondary}
          text={text} muted={muted} border={border} isDark={isDark}
        />
      </Modal>}

      {/* DELETE CONFIRM */}
      {deleteConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: surface, borderRadius: 14, padding: "28px 32px", width: 380, border: "1px solid rgba(239,68,68,0.4)", fontFamily: "inherit" }}>
            <div style={{ fontSize: 32, textAlign: "center", marginBottom: 12 }}>🗑️</div>
            <h3 style={{ color: text, margin: "0 0 10px", fontSize: 16, textAlign: "center" }}>Potvrdit smazání</h3>
            <p style={{ color: muted, fontSize: 13, textAlign: "center", marginBottom: 20 }}>Opravdu smazat <strong style={{ color: text }}>{deleteConfirm.nazev}</strong>?</p>
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
                    {["Čas","Uživatel","Akce","Detail"].map(h => <th key={h} style={thSx}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {logData.length === 0 && <tr><td colSpan={4} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné záznamy.</td></tr>}
                  {logData.map(r => (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${border}` }}>
                      <td style={{ ...tdSx, color: muted, whiteSpace: "nowrap", fontSize: 12 }}>{r.cas ? new Date(r.cas).toLocaleString("cs-CZ", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                      <td style={{ ...tdSx, fontWeight: 500 }}>{r.uzivatel}</td>
                      <td style={tdSx}>{r.akce}</td>
                      <td style={{ ...tdSx, color: muted, wordBreak: "break-word" }}>{r.detail}</td>
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
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ color: muted }}>Soubor:</span><span style={{ color: text }}>{importConfirm.fileName}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ color: muted }}>Objektů:</span><span style={{ color: text, fontWeight: 700 }}>{importConfirm.payload.objekty?.length || 0}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: muted }}>Nájemníků:</span><span style={{ color: text, fontWeight: 700 }}>{importConfirm.payload.najemnici?.length || 0}</span></div>
            </div>
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#fca5a5" }}>
              ⚠️ Všechna stávající data budou <strong>trvale smazána</strong>.
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: muted, fontSize: 12, marginBottom: 6 }}>Napište <strong style={{ color: "#fbbf24" }}>POTVRDIT</strong>:</div>
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
  const map = { "obsazený": { bg: "rgba(34,197,94,0.15)", color: "#4ade80" }, "volný": { bg: "rgba(148,163,184,0.15)", color: "#94a3b8" }, "oprava": { bg: "rgba(59,130,246,0.15)", color: "#60a5fa" } };
  const c = map[stav] || map["volný"];
  return <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: c.bg, color: c.color }}>{stav || "—"}</span>;
}

function Modal({ title, onClose, children, isDark, surface, border, text, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI',Tahoma,sans-serif" }}>
      <div style={{ background: surface, borderRadius: 16, width: wide ? "min(700px,96vw)" : "min(480px,96vw)", maxHeight: "90vh", overflow: "auto", border: `1px solid ${border}` }}>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: surface, zIndex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: text }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(148,163,184,0.6)", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: "20px 24px" }}>{children}</div>
      </div>
    </div>
  );
}

function FormObjekt({ data, onChange, onSave, onCancel, inputSx, btnPrimary, btnSecondary, text, muted }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Název *</label><input style={inputSx} value={data.nazev || ""} onChange={e => onChange({ ...data, nazev: e.target.value })} placeholder="např. Palackého 12" /></div>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Adresa</label><input style={inputSx} value={data.adresa || ""} onChange={e => onChange({ ...data, adresa: e.target.value })} placeholder="Ulice č.p., Město" /></div>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Poznámka</label><textarea style={{ ...inputSx, resize: "vertical", minHeight: 70 }} value={data.poznamka || ""} onChange={e => onChange({ ...data, poznamka: e.target.value })} /></div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(data)} disabled={!data.nazev} style={{ flex: 1, ...btnPrimary, opacity: data.nazev ? 1 : 0.5 }}>Uložit</button>
      </div>
    </div>
  );
}

function FormByt({ data, onChange, onSave, onCancel, objekty, inputSx, btnPrimary, btnSecondary, text, muted }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Bytový dům *</label>
        <select style={inputSx} value={data.objekt_id || ""} onChange={e => onChange({ ...data, objekt_id: e.target.value })}>
          <option value="">— Vyberte dům —</option>
          {objekty.map(o => <option key={o.id} value={o.id}>{o.nazev}</option>)}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Číslo bytu *</label><input style={inputSx} value={data.cislo_bytu || ""} onChange={e => onChange({ ...data, cislo_bytu: e.target.value })} placeholder="např. 1, A, 2B" /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Patro</label><input style={inputSx} value={data.patro || ""} onChange={e => onChange({ ...data, patro: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Dispozice</label><input style={inputSx} value={data.dispozice || ""} onChange={e => onChange({ ...data, dispozice: e.target.value })} placeholder="2+kk" /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Plocha (m²)</label><input style={inputSx} type="number" value={data.plocha_m2 || ""} onChange={e => onChange({ ...data, plocha_m2: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Nájem (Kč)</label><input style={inputSx} type="number" value={data.najem_kc || ""} onChange={e => onChange({ ...data, najem_kc: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Zálohy (Kč)</label><input style={inputSx} type="number" value={data.zalohy_kc || ""} onChange={e => onChange({ ...data, zalohy_kc: e.target.value })} /></div>
      </div>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Stav</label>
        <select style={inputSx} value={data.stav || "volný"} onChange={e => onChange({ ...data, stav: e.target.value })}>
          <option value="volný">Volný</option><option value="obsazený">Obsazený</option><option value="oprava">V opravě</option>
        </select>
      </div>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Poznámka</label><textarea style={{ ...inputSx, resize: "vertical", minHeight: 60 }} value={data.poznamka || ""} onChange={e => onChange({ ...data, poznamka: e.target.value })} /></div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(data)} disabled={!data.cislo_bytu || !data.objekt_id} style={{ flex: 1, ...btnPrimary, opacity: (data.cislo_bytu && data.objekt_id) ? 1 : 0.5 }}>Uložit</button>
      </div>
    </div>
  );
}

function FormNajemnik({ data, onChange, onSave, onCancel, byty, objekty, inputSx, btnPrimary, btnSecondary, text, muted }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ gridColumn: "1/-1" }}><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Jméno a příjmení *</label><input style={inputSx} value={data.jmeno || ""} onChange={e => onChange({ ...data, jmeno: e.target.value })} placeholder="Jan Novák" /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Telefon</label><input style={inputSx} value={data.telefon || ""} onChange={e => onChange({ ...data, telefon: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Email</label><input style={inputSx} type="email" value={data.email || ""} onChange={e => onChange({ ...data, email: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Datum narození</label><input style={inputSx} value={data.datum_narozeni || ""} onChange={e => onChange({ ...data, datum_narozeni: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Číslo OP</label><input style={inputSx} value={data.cislo_op || ""} onChange={e => onChange({ ...data, cislo_op: e.target.value })} /></div>
      </div>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Přiřazený byt</label>
        <select style={inputSx} value={data.byt_id || ""} onChange={e => onChange({ ...data, byt_id: e.target.value })}>
          <option value="">— Bez bytu —</option>
          {byty.map(b => { const obj = objekty.find(o => o.id === b.objekt_id); return <option key={b.id} value={b.id}>{obj?.nazev ? `${obj.nazev} / ` : ""}{b.cislo_bytu}{b.dispozice ? ` (${b.dispozice})` : ""}</option>; })}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Smlouva od</label><input style={inputSx} type="date" value={data.smlouva_od || ""} onChange={e => onChange({ ...data, smlouva_od: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Smlouva do</label><input style={inputSx} type="date" value={data.smlouva_do || ""} onChange={e => onChange({ ...data, smlouva_do: e.target.value })} /></div>
        <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Kauce (Kč)</label><input style={inputSx} type="number" value={data.kauce_kc || ""} onChange={e => onChange({ ...data, kauce_kc: e.target.value })} /></div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: text }}>
            <input type="checkbox" checked={data.kauce_zaplacena || false} onChange={e => onChange({ ...data, kauce_zaplacena: e.target.checked })} /> Kauce zaplacena
          </label>
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: text }}>
        <input type="checkbox" checked={data.email_notifikace !== false} onChange={e => onChange({ ...data, email_notifikace: e.target.checked })} /> Posílat email notifikace
      </label>
      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Poznámka</label><textarea style={{ ...inputSx, resize: "vertical", minHeight: 60 }} value={data.poznamka || ""} onChange={e => onChange({ ...data, poznamka: e.target.value })} /></div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(data)} disabled={!data.jmeno} style={{ flex: 1, ...btnPrimary, opacity: data.jmeno ? 1 : 0.5 }}>Uložit</button>
      </div>
    </div>
  );
}

function FormPolozkyBytu({ bytId, polozky, onSave, onCancel, inputSx, btnPrimary, btnSecondary, btnDanger, text, muted }) {
  const [items, setItems] = useState(polozky.length > 0 ? polozky.map(p => ({ nazev: p.nazev })) : [{ nazev: "Nájem čistý" }, { nazev: "Záloha elektřina" }, { nazev: "Záloha voda / topení" }, { nazev: "Rezerva" }]);

  const add = () => setItems([...items, { nazev: "" }]);
  const remove = (i) => setItems(items.filter((_, idx) => idx !== i));
  const update = (i, val) => setItems(items.map((x, idx) => idx === i ? { nazev: val } : x));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, color: muted, margin: 0 }}>Definujte položky zálohy pro tento byt. Pořadí odpovídá zobrazení v tabulce plateb.</p>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: muted, minWidth: 20, textAlign: "right" }}>{i + 1}.</span>
          <input style={{ ...inputSx, flex: 1 }} value={item.nazev} onChange={e => update(i, e.target.value)} placeholder="např. Nájem čistý" />
          <button onClick={() => remove(i)} style={{ ...btnDanger, padding: "6px 10px", fontSize: 12 }}>✕</button>
        </div>
      ))}
      <button onClick={add} style={{ ...btnSecondary, fontSize: 12, padding: "6px 0" }}>+ Přidat položku</button>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(bytId, items.filter(x => x.nazev.trim()))} style={{ flex: 1, ...btnPrimary }}>Uložit</button>
      </div>
    </div>
  );
}

function FormPlatba({ data, onChange, onSave, onCancel, polozkyBytu, inputSx, btnPrimary, btnSecondary, text, muted, border }) {
  const updatePolozka = (id, field, val) => {
    const updated = data.polozky.map(p => p.id === id ? { ...p, [field]: val } : p);
    onChange({ ...data, polozky: updated });
  };

  const celkemPredpis = (data.polozky || []).reduce((s, p) => s + (Number(p.predpis_kc) || 0), 0);
  const celkemZaplaceno = (Number(data.banka_kc) || 0) + (Number(data.hotove_kc) || 0) + (Number(data.doplatek_kc) || 0);
  const rozdil = celkemZaplaceno - celkemPredpis + (Number(data.srazky_kc) || 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Položky předpisu */}
      {data.polozky && data.polozky.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: muted, marginBottom: 8, fontWeight: 600 }}>PŘEDPIS — položky</div>
          {data.polozky.map(pp => {
            const pol = polozkyBytu.find(p => p.id === pp.polozka_id);
            return (
              <div key={pp.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: text, minWidth: 180 }}>{pol?.nazev || "Položka"}</span>
                <input style={{ ...inputSx, width: 120 }} type="number" value={pp.predpis_kc || ""} onChange={e => updatePolozka(pp.id, "predpis_kc", e.target.value)} placeholder="Předpis Kč" />
              </div>
            );
          })}
          <div style={{ fontSize: 13, fontWeight: 600, color: text, marginTop: 4 }}>Celkem předpis: {celkemPredpis.toLocaleString("cs-CZ")} Kč</div>
        </div>
      )}

      <div style={{ borderTop: `1px solid ${border}`, paddingTop: 14 }}>
        <div style={{ fontSize: 12, color: muted, marginBottom: 8, fontWeight: 600 }}>PLATBA</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Datum platby</label><input style={inputSx} type="date" value={data.datum_platby || ""} onChange={e => onChange({ ...data, datum_platby: e.target.value })} /></div>
          <div></div>
          <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Banka (Kč)</label><input style={inputSx} type="number" value={data.banka_kc || ""} onChange={e => onChange({ ...data, banka_kc: e.target.value })} /></div>
          <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Hotově (Kč)</label><input style={inputSx} type="number" value={data.hotove_kc || ""} onChange={e => onChange({ ...data, hotove_kc: e.target.value })} /></div>
          <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Doplatek hotově (Kč)</label><input style={inputSx} type="number" value={data.doplatek_kc || ""} onChange={e => onChange({ ...data, doplatek_kc: e.target.value })} /></div>
          <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Srážka z nájmu (Kč)</label><input style={inputSx} type="number" value={data.srazky_kc || ""} onChange={e => onChange({ ...data, srazky_kc: e.target.value })} /></div>
          <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Nedoplatek energií (Kč)</label><input style={inputSx} type="number" value={data.nedoplatek_energie_kc || ""} onChange={e => onChange({ ...data, nedoplatek_energie_kc: e.target.value })} /></div>
          <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Jiné platby (Kč)</label><input style={inputSx} type="number" value={data.jine_platby_kc || ""} onChange={e => onChange({ ...data, jine_platby_kc: e.target.value })} /></div>
        </div>
        <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 8, background: rozdil >= 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", fontSize: 13, fontWeight: 600, color: rozdil >= 0 ? "#4ade80" : "#f87171" }}>
          {rozdil >= 0 ? "✓ Přeplatek / doplatek: " : "✗ Dluh: "}{Math.abs(rozdil).toLocaleString("cs-CZ")} Kč
        </div>
      </div>

      <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 4 }}>Poznámka</label><textarea style={{ ...inputSx, resize: "vertical", minHeight: 60 }} value={data.poznamka || ""} onChange={e => onChange({ ...data, poznamka: e.target.value })} /></div>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button onClick={onCancel} style={{ flex: 1, ...btnSecondary }}>Zrušit</button>
        <button onClick={() => onSave(data)} style={{ flex: 1, ...btnPrimary }}>Uložit platbu</button>
      </div>
    </div>
  );
}

function LoginScreen({ isDark, onLogin, onMagicLink, inputSx, btnPrimary, surface, border, text, muted, bg }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("password");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [magicSent, setMagicSent] = useState(false);

  const handleSubmit = async () => {
    setErr(""); setLoading(true);
    try {
      if (mode === "password") await onLogin(email, password);
      else { await onMagicLink(email); setMagicSent(true); }
    } catch (e) { setErr(e.message || "Chyba přihlášení"); }
    finally { setLoading(false); }
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
            <p style={{ color: muted, fontSize: 13 }}>Zkontrolujte inbox a klikněte na odkaz.</p>
            <button onClick={() => { setMagicSent(false); setMode("password"); }} style={{ ...btnPrimary, marginTop: 20, width: "100%" }}>Zpět</button>
          </div>
        ) : (<>
          <div style={{ display: "flex", background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", borderRadius: 8, padding: 3, marginBottom: 20 }}>
            {[["password","Heslo"],["magic","Magic link"]].map(([m, l]) => (
              <button key={m} onClick={() => { setMode(m); setErr(""); }} style={{ flex: 1, padding: "7px 0", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", background: mode === m ? (isDark ? "#1e40af" : "#2563eb") : "transparent", color: mode === m ? "#fff" : muted, fontWeight: mode === m ? 600 : 400, fontFamily: "inherit" }}>{l}</button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Email</label><input style={inputSx} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="vas@email.cz" onKeyDown={e => e.key === "Enter" && handleSubmit()} /></div>
            {mode === "password" && <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Heslo</label><input style={inputSx} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === "Enter" && handleSubmit()} /></div>}
            {err && <div style={{ color: "#f87171", fontSize: 13, background: "rgba(239,68,68,0.1)", padding: "8px 12px", borderRadius: 7 }}>{err}</div>}
            <button onClick={handleSubmit} disabled={loading || !email || (mode === "password" && !password)}
              style={{ ...btnPrimary, width: "100%", opacity: (loading || !email || (mode === "password" && !password)) ? 0.6 : 1, marginTop: 4 }}>
              {loading ? "Přihlašuji..." : mode === "magic" ? "Odeslat magic link" : "Přihlásit se"}
            </button>
          </div>
        </>)}
      </div>
    </div>
  );
}
