import { useState, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
// BUILD: 2026_03_29_build0007
// ============================================================
// PRAVIDLO #0 — PŘED KAŽDÝM ROZŠÍŘENÍM: průzkum → výběr → implementace
// PRAVIDLO #1 — NEFUNGUJE: zkontroluj kód. NEHÁDEJ.
// PRAVIDLO #1b — PO 2-3 NEÚSPĚŠNÝCH OPRAVÁCH: problém v architektuře
// PRAVIDLO #2 — TEXTY: wordBreak:break-word, žádný ellipsis
// PRAVIDLO #3 — OVĚŘIT: po každé změně zkontrolovat v souboru
// PRAVIDLO #4 — BUILD: aktualizovat řádek 1 + APP_BUILD konstantu
//
// DEPLOY: Vercel + GitHub (doco1971/podnajem) — src/App.jsx
//
// ============================================================
// AKTUÁLNÍ STAV (build0007)
// ============================================================
// ✅ Supabase: pzhcvfucgdukdyggkmso.supabase.co
// ✅ Tabulky: objekty, jednotky (dříve byty), najemnici,
//             smlouvy, smlouvy_jednotky, dodatky,
//             sazebnik, sazebnik_polozky,
//             platby, platby_polozky,
//             log_aktivit, nastaveni, uzivatele
//
// ARCHITEKTURA SMLUV:
//   najemnici — jen osobní údaje (jméno, kontakt, OP)
//   smlouvy — smlouva nájemníka (datum_od/do, kauce, aktivni)
//   smlouvy_jednotky — vazba smlouva ↔ jednotka (1 smlouva = více jednotek)
//   dodatky — historia změn smlouvy (prodloužení, sazby, jiné)
//   sazebnik — platné sazby od data (na smlouvu)
//   sazebnik_polozky — položky sazebníku (Nájem, Eon, Voda...)
//
// JEDNOTKY (dříve byty):
//   typ: byt / garáž / sklep / stání
//   lodzie_m2: rozměr lodžie
//
// FORMÁT DATUMŮ: dd.mm.yyyy v UI, ISO (yyyy-mm-dd) v DB
//
// ============================================================
// HISTORY BUILDŮ
// ============================================================
// BUILD0001 — Etapa 1: základ, auth, objekty, byty, nájemníci, log, záloha, XLSX
// BUILD0002 — Záložka Platby: generování předpisů, zaplaceno/saldo
// BUILD0003 — Flexibilní položky zálohy, pohled období, upozornění smluv
// BUILD0004 — Přepracovaná architektura: jednotky, smlouvy, sazebník, dodatky
//             Formát datumů dd.mm.yyyy, type=date všude
// BUILD0005 — FIX refresh plateb, automatické načtení sazebníku, roční vyúčtování
// BUILD0006 — FIX: chyba "invalid input syntax bigint undefined" při uložení platby
//             (položky ze sazebníku nemají id → PATCH na undefined → error)
//             FIX: platby_polozky INSERT místo PATCH pro nové položky ze sazebníku
//             FIX: saveVyuctovani guard pro undefined smlouva_id
//             FIX: castka_skutecnost_kc sloupec neexistuje → odstraněn z INSERT
// BUILD0007 — FIX: generování předpisů kontroluje datum_od/datum_do smlouvy
//             FIX: formulář platby — vždy jasně oddělený předpis vs. platba
//             NEW: nápověda — tlačítko ? s popisem každé záložky
//             NEW: checklist měsíčního uzávěrku v záložce Platby
//             NEW: roční přehled plateb (tabulka jako Excel, řádky=nájemníci, sloupce=měsíce)
//             NEW: kdo nezaplatil — červený přehled na záložce Přehled
//             NEW: celkové saldo smlouvy v detailu smlouvy
//
// ============================================================
const APP_BUILD = "build0007";
const SB_URL = import.meta.env.VITE_SB_URL;
const SB_KEY = import.meta.env.VITE_SB_KEY;
const MESICE = ["Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];
const JEDNOTKA_TYPY = ["byt","garáž","sklep","stání","jiná"];

// ── DB helper ─────────────────────────────────────────────
const sb = async (path, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      signal: controller.signal,
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${options._token || SB_KEY}`, "Content-Type": "application/json", "Prefer": options.prefer || "return=representation", ...options.headers },
      ...options,
    });
    if (!res.ok) { const e = await res.text(); throw new Error(e); }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Timeout 10s");
    throw e;
  } finally { clearTimeout(timer); }
};

const sbAuth = async (path, body) => {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, { method: "POST", headers: { "apikey": SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Auth chyba");
  return data;
};

const logAkce = async (uzivatel, akce, detail = "") => {
  try { await sb("log_aktivit", { method: "POST", body: JSON.stringify({ uzivatel, akce, detail }), prefer: "return=minimal" }); } catch {}
};

// ── Formátování ───────────────────────────────────────────
const fmt = (n) => n == null || n === "" ? "" : Number(n).toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtKc = (n) => n ? fmt(n) + " Kč" : "—";
// ISO → dd.mm.yyyy
const fmtDate = (s) => {
  if (!s) return "—";
  const d = s.slice ? s.slice(0, 10) : "";
  if (!d || d.length < 10) return s;
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y}`;
};
// dd.mm.yyyy → ISO
const toISO = (s) => {
  if (!s) return null;
  if (s.includes("-")) return s.slice(0, 10);
  const parts = s.split(".");
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`;
  return s;
};

const isSmlouvaBrzy = (datum) => {
  if (!datum) return false;
  const diff = (new Date(datum) - new Date()) / 86400000;
  return diff >= 0 && diff <= 60;
};
const isSmlouvaPropadla = (datum) => datum && new Date(datum) < new Date();

// ============================================================
// APP
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
  const [jednotky, setJednotky] = useState([]);
  const [najemnici, setNajemnici] = useState([]);
  const [smlouvy, setSmlouvy] = useState([]);
  const [smlouvyJednotky, setSmlouvyJednotky] = useState([]);
  const [dodatky, setDodatky] = useState([]);
  const [sazebnik, setSazebnik] = useState([]);
  const [sazebnikPolozky, setSazebnikPolozky] = useState([]);
  const [platby, setPlatby] = useState([]);
  const [platbyPolozky, setPlatbyPolozky] = useState([]);
  const [vyuctovani, setVyuctovani] = useState([]);
  const [logData, setLogData] = useState([]);

  // Platby stav
  const now = new Date();
  const [platbyMesic, setPlatbyMesic] = useState(now.getMonth());
  const [platbyRok, setPlatbyRok] = useState(now.getFullYear());
  const [platbySmlouva, setPlatbySmlouva] = useState("");
  const [platbyPohled, setPlatbyPohled] = useState("mesic");
  const [platbyRefresh, setPlatbyRefresh] = useState(0);

  // UI
  const [filterObjekt, setFilterObjekt] = useState("");
  const [msg, setMsg] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [importConfirm, setImportConfirm] = useState(null);
  const [importConfirmText, setImportConfirmText] = useState("");

  // Formuláře
  const [objektForm, setObjektForm] = useState(null);
  const [jednotkaForm, setJednotkaForm] = useState(null);
  const [najemnikForm, setNajemnikForm] = useState(null);
  const [smlouvaForm, setSmlouvaForm] = useState(null);
  const [dodatekForm, setDodatekForm] = useState(null);
  const [sazebnikForm, setSazebnikForm] = useState(null);
  const [editPlatba, setEditPlatba] = useState(null);
  const [vyuctovaniForm, setVyuctovaniForm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [detailSmlouva, setDetailSmlouva] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [platbyPohled2, setPlatbyPohled2] = useState("mesic"); // "mesic" | "rok" | "nezaplaceno"
  const [rocniPlatby, setRocniPlatby] = useState([]);
  const [rocniPolozky, setRocniPolozky] = useState([]);
  const [rocniRok, setRocniRok] = useState(now.getFullYear());
  const [rocniLoading, setRocniLoading] = useState(false);

  const isDark = theme === "dark";
  const isAdmin = userRole === "admin" || userRole === "superadmin";

  const showMsg = (text, type = "ok") => { setMsg({ text, type }); setTimeout(() => setMsg(null), 3500); };

  // ── Theme ─────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem("podnajem_theme", theme);
    document.body.style.background = isDark ? "#0f172a" : "#f1f5f9";
    document.body.style.color = isDark ? "#e2e8f0" : "#1e293b";
  }, [theme, isDark]);

  // ── Auth ──────────────────────────────────────────────────
  useEffect(() => { checkSession(); }, []);

  const checkSession = async () => {
    try {
      const stored = localStorage.getItem("podnajem_session");
      if (!stored) { setLoading(false); return; }
      const s = JSON.parse(stored);
      if (!s?.access_token) { setLoading(false); return; }
      const res = await fetch(`${SB_URL}/auth/v1/user`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${s.access_token}` } });
      if (!res.ok) { localStorage.removeItem("podnajem_session"); setLoading(false); return; }
      const user = await res.json();
      setSession(s);
      await loadUserRole(user.email, s.access_token);
    } catch { setLoading(false); }
  };

  const loadUserRole = async (email, token) => {
    try {
      const rows = await sb(`uzivatele?email=eq.${encodeURIComponent(email)}&limit=1`, { _token: token });
      if (rows?.length > 0) { setUserRole(rows[0].role); setUserName(rows[0].name || email); }
      else { setUserRole("cajten"); setUserName(email); }
    } catch { setUserRole("cajten"); setUserName(email); }
    finally { setLoading(false); }
  };

  const handleLogin = async (email, password) => {
    const data = await sbAuth("token?grant_type=password", { email, password });
    localStorage.setItem("podnajem_session", JSON.stringify(data));
    setSession(data);
    await loadUserRole(email, data.access_token);
    await logAkce(email, "Přihlášení", "");
  };

  const handleMagicLink = async (email) => {
    const res = await fetch(`${SB_URL}/auth/v1/magiclink`, { method: "POST", headers: { "apikey": SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    if (!res.ok) throw new Error("Chyba magic linku");
  };

  const handleLogout = async () => {
    await logAkce(userName, "Odhlášení", "");
    localStorage.removeItem("podnajem_session");
    setSession(null); setUserRole(null);
  };

  // ── Data loading ──────────────────────────────────────────
  useEffect(() => { if (session && userRole) loadAll(); }, [session, userRole]);

  useEffect(() => {
    if (session && userRole && activeTab === "platby") loadPlatby();
  }, [session, userRole, activeTab, platbyMesic, platbyRok, platbySmlouva, platbyPohled, platbyRefresh]);

  const loadAll = async () => {
    try {
      const [obj, jed, naj, sml, smlJ, dod, saz, sazP] = await Promise.all([
        sb("objekty?order=nazev.asc"),
        sb("jednotky?order=typ.asc,cislo_bytu.asc"),
        sb("najemnici?order=jmeno.asc"),
        sb("smlouvy?order=datum_od.desc"),
        sb("smlouvy_jednotky?order=smlouva_id.asc"),
        sb("dodatky?order=datum.desc"),
        sb("sazebnik?order=platne_od.desc"),
        sb("sazebnik_polozky?order=sazebnik_id.asc,poradi.asc"),
      ]);
      setObjekty(obj || []);
      setJednotky(jed || []);
      setNajemnici(naj || []);
      setSmlouvy(sml || []);
      setSmlouvyJednotky(smlJ || []);
      setDodatky(dod || []);
      setSazebnik(saz || []);
      setSazebnikPolozky(sazP || []);
    } catch (e) { showMsg("Chyba načítání: " + e.message, "err"); }
  };

  const loadPlatby = async () => {
    try {
      let path = platbyPohled === "mesic"
        ? `platby?rok=eq.${platbyRok}&mesic=eq.${platbyMesic + 1}&order=jednotka_id.asc`
        : `platby?order=rok.asc,mesic.asc,jednotka_id.asc`;
      if (platbySmlouva) path += `&smlouva_id=eq.${platbySmlouva}`;
      const pData = await sb(path);
      setPlatby(pData || []);
      if (pData?.length > 0) {
        const ids = pData.map(p => p.id).join(",");
        const pp = await sb(`platby_polozky?platba_id=in.(${ids})&order=platba_id.asc`);
        setPlatbyPolozky(pp || []);
      } else { setPlatbyPolozky([]); }
      // Načíst vyúčtování pro vybranou smlouvu
      if (platbySmlouva) {
        const vyuct = await sb(`vyuctovani?smlouva_id=eq.${platbySmlouva}&order=datum.desc`);
        setVyuctovani(vyuct || []);
      } else {
        const vyuct = await sb("vyuctovani?order=datum.desc&limit=50");
        setVyuctovani(vyuct || []);
      }
    } catch (e) { showMsg("Chyba plateb: " + e.message, "err"); }
  };

  // ── Computed ──────────────────────────────────────────────
  const aktivniSmlouvy = useMemo(() => smlouvy.filter(s => s.aktivni), [smlouvy]);

  const jednotkaSmlouva = useMemo(() => {
    const map = {};
    smlouvyJednotky.forEach(sj => {
      const s = aktivniSmlouvy.find(x => x.id === sj.smlouva_id);
      if (s) map[sj.jednotka_id] = s;
    });
    return map;
  }, [smlouvyJednotky, aktivniSmlouvy]);

  const smlouvaJednotky = useMemo(() => {
    const map = {};
    smlouvyJednotky.forEach(sj => {
      if (!map[sj.smlouva_id]) map[sj.smlouva_id] = [];
      map[sj.smlouva_id].push(sj.jednotka_id);
    });
    return map;
  }, [smlouvyJednotky]);

  const aktualniSazebnik = (smlouvaId) => {
    const saz = sazebnik.filter(s => s.smlouva_id === smlouvaId).sort((a, b) => b.platne_od.localeCompare(a.platne_od));
    return saz[0] || null;
  };

  const sazebnikKDatu = (smlouvaId, rok, mesic) => {
    const datum = `${rok}-${String(mesic).padStart(2,"0")}-01`;
    const saz = sazebnik
      .filter(s => s.smlouva_id === smlouvaId && s.platne_od <= datum)
      .sort((a, b) => b.platne_od.localeCompare(a.platne_od));
    return saz[0] || null;
  };

  const upozorneni = useMemo(() => {
    return aktivniSmlouvy.filter(s => isSmlouvaBrzy(s.datum_do) || isSmlouvaPropadla(s.datum_do));
  }, [aktivniSmlouvy]);

  const stats = useMemo(() => {
    const obsazeno = jednotky.filter(j => j.stav === "obsazený").length;
    const prijemMesic = sazebnikPolozky
      .filter(sp => {
        const saz = sazebnik.find(s => s.id === sp.sazebnik_id);
        if (!saz) return false;
        const sm = aktivniSmlouvy.find(s => s.id === saz.smlouva_id);
        return !!sm;
      })
      .reduce((sum, sp) => {
        const saz = sazebnik.find(s => s.id === sp.sazebnik_id);
        const sm = saz ? aktivniSmlouvy.find(s => s.id === saz.smlouva_id) : null;
        if (!sm) return sum;
        const akt = aktualniSazebnik(sm.id);
        return akt?.id === sp.sazebnik_id ? sum + (Number(sp.castka_kc) || 0) : sum;
      }, 0);
    return { celkem: jednotky.length, obsazeno, prijemMesic, upozorneni: upozorneni.length };
  }, [jednotky, sazebnikPolozky, sazebnik, aktivniSmlouvy, upozorneni]);

  const platbyStats = useMemo(() => {
    const predpis = platbyPolozky.reduce((s, pp) => s + (Number(pp.castka_predpis_kc || pp.predpis_kc) || 0), 0);
    const zaplaceno = platby.filter(p => p.zaplaceno).reduce((s, p) => s + (Number(p.banka_kc) || 0) + (Number(p.hotove_kc) || 0) + (Number(p.doplatek_kc) || 0), 0);
    return { predpis, zaplaceno, dluh: Math.max(0, predpis - zaplaceno) };
  }, [platby, platbyPolozky]);

  // ── CRUD — Objekty ────────────────────────────────────────
  const saveObjekt = async (data) => {
    try {
      const payload = { nazev: data.nazev, adresa: data.adresa, poznamka: data.poznamka };
      if (data.id) { await sb(`objekty?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" }); showMsg("Objekt uložen"); }
      else { await sb("objekty", { method: "POST", body: JSON.stringify(payload) }); showMsg("Objekt přidán"); }
      await logAkce(userName, data.id ? "Editace objektu" : "Přidání objektu", data.nazev);
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

  // ── CRUD — Jednotky ───────────────────────────────────────
  const saveJednotka = async (data) => {
    try {
      const payload = {
        objekt_id: Number(data.objekt_id), typ: data.typ || "byt",
        cislo_bytu: data.cislo_bytu, patro: data.patro,
        dispozice: data.dispozice, plocha_m2: data.plocha_m2 ? Number(data.plocha_m2) : null,
        lodzie_m2: data.lodzie_m2 ? Number(data.lodzie_m2) : null,
        stav: data.stav || "volná", poznamka: data.poznamka,
      };
      if (data.id) { await sb(`jednotky?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" }); showMsg("Jednotka uložena"); }
      else { await sb("jednotky", { method: "POST", body: JSON.stringify(payload) }); showMsg("Jednotka přidána"); }
      await logAkce(userName, data.id ? "Editace jednotky" : "Přidání jednotky", `${data.typ} ${data.cislo_bytu}`);
      await loadAll(); setJednotkaForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deleteJednotka = async (id) => {
    try {
      await sb(`jednotky?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      await logAkce(userName, "Smazání jednotky", `ID: ${id}`);
      showMsg("Jednotka smazána"); await loadAll(); setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── CRUD — Nájemníci ──────────────────────────────────────
  const saveNajemnik = async (data) => {
    try {
      const payload = { jmeno: data.jmeno, telefon: data.telefon, email: data.email, datum_narozeni: data.datum_narozeni, cislo_op: data.cislo_op, poznamka: data.poznamka };
      if (data.id) { await sb(`najemnici?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" }); showMsg("Nájemník uložen"); }
      else { await sb("najemnici", { method: "POST", body: JSON.stringify(payload) }); showMsg("Nájemník přidán"); }
      await logAkce(userName, data.id ? "Editace nájemníka" : "Přidání nájemníka", data.jmeno);
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

  // ── CRUD — Smlouvy ────────────────────────────────────────
  const saveSmlouva = async (data) => {
    try {
      const payload = {
        najemnik_id: Number(data.najemnik_id),
        datum_od: toISO(data.datum_od), datum_do: toISO(data.datum_do) || null,
        kauce_kc: data.kauce_kc ? Number(data.kauce_kc) : null,
        kauce_zaplacena: data.kauce_zaplacena || false,
        email_notifikace: data.email_notifikace !== false,
        aktivni: data.aktivni !== false,
        poznamka: data.poznamka,
      };
      let smlouvaId = data.id;
      if (data.id) {
        await sb(`smlouvy?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
        showMsg("Smlouva uložena");
      } else {
        const [nova] = await sb("smlouvy", { method: "POST", body: JSON.stringify(payload) });
        smlouvaId = nova.id;
        showMsg("Smlouva přidána");
      }
      // Uložit vazby jednotek
      if (smlouvaId && data.jednotky_ids) {
        await sb(`smlouvy_jednotky?smlouva_id=eq.${smlouvaId}`, { method: "DELETE", prefer: "return=minimal" });
        if (data.jednotky_ids.length > 0) {
          const rows = data.jednotky_ids.map(jid => ({ smlouva_id: smlouvaId, jednotka_id: Number(jid) }));
          await sb("smlouvy_jednotky", { method: "POST", body: JSON.stringify(rows), prefer: "return=minimal" });
        }
        // Aktualizovat stav jednotek
        for (const jid of data.jednotky_ids) {
          await sb(`jednotky?id=eq.${jid}`, { method: "PATCH", body: JSON.stringify({ stav: "obsazený" }), prefer: "return=minimal" });
        }
      }
      await logAkce(userName, data.id ? "Editace smlouvy" : "Přidání smlouvy", `ID: ${smlouvaId}`);
      await loadAll(); setSmlouvaForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const ukoncitSmlouvu = async (smlouvaId) => {
    try {
      await sb(`smlouvy?id=eq.${smlouvaId}`, { method: "PATCH", body: JSON.stringify({ aktivni: false }), prefer: "return=minimal" });
      // Osvobodit jednotky
      const jIds = smlouvaJednotky[smlouvaId] || [];
      for (const jid of jIds) {
        await sb(`jednotky?id=eq.${jid}`, { method: "PATCH", body: JSON.stringify({ stav: "volná" }), prefer: "return=minimal" });
      }
      await logAkce(userName, "Ukončení smlouvy", `ID: ${smlouvaId}`);
      showMsg("Smlouva ukončena"); await loadAll(); setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── CRUD — Dodatky ────────────────────────────────────────
  const saveDodatek = async (data) => {
    try {
      const payload = {
        smlouva_id: Number(data.smlouva_id),
        datum: toISO(data.datum),
        typ: data.typ || "jiné",
        nove_datum_do: toISO(data.nove_datum_do) || null,
        poznamka: data.poznamka,
      };
      if (data.id) { await sb(`dodatky?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" }); }
      else { await sb("dodatky", { method: "POST", body: JSON.stringify(payload) }); }
      // Pokud prodloužení — aktualizovat datum_do na smlouvě
      if (data.typ === "prodloužení" && data.nove_datum_do) {
        await sb(`smlouvy?id=eq.${data.smlouva_id}`, { method: "PATCH", body: JSON.stringify({ datum_do: toISO(data.nove_datum_do) }), prefer: "return=minimal" });
      }
      await logAkce(userName, "Přidání dodatku", `smlouva_id: ${data.smlouva_id}, typ: ${data.typ}`);
      showMsg("Dodatek uložen"); await loadAll(); setDodatekForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── CRUD — Sazebník ───────────────────────────────────────
  const saveSazebnik = async (data) => {
    try {
      const payload = { smlouva_id: Number(data.smlouva_id), platne_od: toISO(data.platne_od), poznamka: data.poznamka };
      let sazId = data.id;
      if (data.id) {
        await sb(`sazebnik?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
      } else {
        const [nova] = await sb("sazebnik", { method: "POST", body: JSON.stringify(payload) });
        sazId = nova.id;
      }
      // Uložit položky
      await sb(`sazebnik_polozky?sazebnik_id=eq.${sazId}`, { method: "DELETE", prefer: "return=minimal" });
      if (data.polozky?.length > 0) {
        const rows = data.polozky.map((p, i) => ({ sazebnik_id: sazId, nazev: p.nazev, castka_kc: Number(p.castka_kc) || 0, typ: p.typ || "záloha", poradi: i }));
        await sb("sazebnik_polozky", { method: "POST", body: JSON.stringify(rows), prefer: "return=minimal" });
      }
      await logAkce(userName, "Uložení sazebníku", `smlouva_id: ${data.smlouva_id}, od: ${data.platne_od}`);
      showMsg("Sazebník uložen"); await loadAll(); setSazebnikForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── CRUD — Platby ─────────────────────────────────────────
  const generujPredpisy = async () => {
    const mesicDB = platbyMesic + 1;
    const datumMesic = `${platbyRok}-${String(mesicDB).padStart(2,"0")}-01`;
    // Poslední den generovaného měsíce
    const datumMesicKonec = `${platbyRok}-${String(mesicDB).padStart(2,"0")}-${new Date(platbyRok, mesicDB, 0).getDate()}`;
    const aktivni = platbySmlouva ? aktivniSmlouvy.filter(s => s.id === Number(platbySmlouva)) : aktivniSmlouvy;
    if (aktivni.length === 0) { showMsg("Žádné aktivní smlouvy.", "err"); return; }
    let pridano = 0, preskoceno = 0, mimoDobu = 0;
    for (const smlouva of aktivni) {
      // FIX build0007: kontrola zda generovaný měsíc spadá do doby trvání smlouvy
      const smlOd = smlouva.datum_od || "0000-01-01";
      const smlDo = smlouva.datum_do || "9999-12-31";
      if (datumMesicKonec < smlOd || datumMesic > smlDo) { mimoDobu++; continue; }
      const jIds = smlouvaJednotky[smlouva.id] || [];
      for (const jid of jIds) {
        const existuje = platby.find(p => p.jednotka_id === jid && p.smlouva_id === smlouva.id && p.mesic === mesicDB && p.rok === platbyRok);
        if (existuje) { preskoceno++; continue; }
        // Najdi sazebník platný k tomuto měsíci
        const saz = sazebnikKDatu(smlouva.id, platbyRok, mesicDB);
        const [novaPlatba] = await sb("platby", { method: "POST", body: JSON.stringify({ smlouva_id: smlouva.id, jednotka_id: jid, rok: platbyRok, mesic: mesicDB, zaplaceno: false }) });
        // Zkopíruj položky ze sazebníku
        if (saz) {
          const polozky = sazebnikPolozky.filter(sp => sp.sazebnik_id === saz.id);
          if (polozky.length > 0) {
            const ppRows = polozky.map(sp => ({ platba_id: novaPlatba.id, nazev: sp.nazev, castka_predpis_kc: sp.castka_kc }));
            await sb("platby_polozky", { method: "POST", body: JSON.stringify(ppRows), prefer: "return=minimal" });
          }
        }
        pridano++;
      }
    }
    await logAkce(userName, "Generování předpisů", `${mesicDB}/${platbyRok}: ${pridano} nových`);
    const msg2 = [`Vygenerováno: ${pridano} nových`];
    if (preskoceno) msg2.push(`${preskoceno} již existuje`);
    if (mimoDobu) msg2.push(`${mimoDobu} mimo dobu smlouvy (přeskočeno)`);
    showMsg(msg2.join(", "));
    setPlatbyRefresh(r => r + 1);
  };

  const savePlatba = async (data) => {
    try {
      const payload = {
        datum_platby: toISO(data.datum_platby) || null,
        banka_kc: Number(data.banka_kc) || 0, hotove_kc: Number(data.hotove_kc) || 0,
        doplatek_kc: Number(data.doplatek_kc) || 0, srazky_kc: Number(data.srazky_kc) || 0,
        jine_platby_kc: Number(data.jine_platby_kc) || 0,
        nedoplatek_energie_kc: Number(data.nedoplatek_energie_kc) || 0,
        poznamka: data.poznamka || "",
        zaplaceno: (Number(data.banka_kc) || 0) + (Number(data.hotove_kc) || 0) + (Number(data.doplatek_kc) || 0) > 0,
      };
      await sb(`platby?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
      if (data.polozky && data.polozky.length > 0) {
        // Rozděl položky na existující (mají id) a nové (ze sazebníku, nemají id)
        const existujici = data.polozky.filter(pp => pp.id && !pp._fromSazebnik);
        const nove = data.polozky.filter(pp => !pp.id || pp._fromSazebnik);
        // PATCH existující
        for (const pp of existujici) {
          await sb(`platby_polozky?id=eq.${pp.id}`, {
            method: "PATCH",
            body: JSON.stringify({ castka_predpis_kc: Number(pp.castka_predpis_kc) || 0 }),
            prefer: "return=minimal"
          });
        }
        // INSERT nové (ze sazebníku)
        if (nove.length > 0) {
          const rows = nove.map(pp => ({
            platba_id: data.id,
            nazev: pp.nazev,
            castka_predpis_kc: Number(pp.castka_predpis_kc) || 0,
          }));
          await sb("platby_polozky", { method: "POST", body: JSON.stringify(rows), prefer: "return=minimal" });
        }
      }
      showMsg("Platba uložena"); await logAkce(userName, "Editace platby", `ID: ${data.id}`);
      setPlatbyRefresh(r => r + 1); setEditPlatba(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const deletePlatba = async (id) => {
    try {
      await sb(`platby?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
      showMsg("Platba smazána"); setPlatbyRefresh(r => r + 1); setDeleteConfirm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  // ── CRUD — Vyúčtování ─────────────────────────────────────
  const saveVyuctovani = async (data) => {
    try {
      if (!data.smlouva_id) { showMsg("Vyberte smlouvu.", "err"); return; }
      const payload = {
        smlouva_id: Number(data.smlouva_id),
        datum: toISO(data.datum),
        typ: data.typ || "nedoplatek",
        castka_kc: Number(data.castka_kc) || 0,
        popis: data.popis || "",
        uhrazeno: data.uhrazeno || false,
        datum_uhrazeni: data.uhrazeno && data.datum_uhrazeni ? toISO(data.datum_uhrazeni) : null,
      };
      if (data.id) {
        await sb(`vyuctovani?id=eq.${data.id}`, { method: "PATCH", body: JSON.stringify(payload), prefer: "return=minimal" });
      } else {
        await sb("vyuctovani", { method: "POST", body: JSON.stringify(payload) });
      }
      await logAkce(userName, "Vyúčtování", `smlouva_id: ${data.smlouva_id}, ${data.typ}: ${data.castka_kc} Kč`);
      showMsg("Vyúčtování uloženo");
      setPlatbyRefresh(r => r + 1);
      setVyuctovaniForm(null);
    } catch (e) { showMsg("Chyba: " + e.message, "err"); }
  };

  const loadRocniPrehled = async (rok) => {
    setRocniLoading(true);
    try {
      const pData = await sb(`platby?rok=eq.${rok}&order=smlouva_id.asc,mesic.asc`);
      setRocniPlatby(pData || []);
      if (pData?.length > 0) {
        const ids = pData.map(p => p.id).join(",");
        const pp = await sb(`platby_polozky?platba_id=in.(${ids})`);
        setRocniPolozky(pp || []);
      } else { setRocniPolozky([]); }
    } catch (e) { showMsg("Chyba ročního přehledu: " + e.message, "err"); }
    finally { setRocniLoading(false); }
  };
  const loadLog = async () => {
    try { const res = await sb("log_aktivit?order=cas.desc&limit=300&hidden=eq.false"); setLogData(res || []); } catch { setLogData([]); }
  };

  // ── Záloha ────────────────────────────────────────────────
  const exportJSON = async () => {
    try {
      const [obj, jed, naj, sml, smlJ, dod, saz, sazP, log] = await Promise.all([
        sb("objekty?order=id.asc"), sb("jednotky?order=id.asc"), sb("najemnici?order=id.asc"),
        sb("smlouvy?order=id.asc"), sb("smlouvy_jednotky?order=id.asc"), sb("dodatky?order=id.asc"),
        sb("sazebnik?order=id.asc"), sb("sazebnik_polozky?order=id.asc"), sb("log_aktivit?order=id.asc&limit=2000"),
      ]);
      const payload = { version: 3, created: new Date().toISOString(), objekty: obj, jednotky: jed, najemnici: naj, smlouvy: sml, smlouvy_jednotky: smlJ, dodatky: dod, sazebnik: saz, sazebnik_polozky: sazP, log_aktivit: log };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = `podnajem-zaloha-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      await logAkce(userName, "Export zálohy", ""); showMsg("Záloha stažena");
    } catch (e) { showMsg("Chyba zálohy: " + e.message, "err"); }
  };

  const exportXLSX = () => {
    const rows = jednotky.map(j => {
      const obj = objekty.find(o => o.id === j.objekt_id);
      const sml = jednotkaSmlouva[j.id];
      const naj = sml ? najemnici.find(n => n.id === sml.najemnik_id) : null;
      const saz = sml ? aktualniSazebnik(sml.id) : null;
      const polozky = saz ? sazebnikPolozky.filter(sp => sp.sazebnik_id === saz.id) : [];
      const celkem = polozky.reduce((s, p) => s + (Number(p.castka_kc) || 0), 0);
      return {
        "Dům": obj?.nazev || "", "Typ": j.typ, "Číslo": j.cislo_bytu, "Patro": j.patro || "",
        "Dispozice": j.dispozice || "", "Plocha m²": j.plocha_m2 || "", "Lodžie m²": j.lodzie_m2 || "",
        "Stav": j.stav, "Nájemník": naj?.jmeno || "", "Smlouva od": fmtDate(sml?.datum_od),
        "Smlouva do": fmtDate(sml?.datum_do), "Celkem Kč/měs": celkem || "",
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Jednotky");
    XLSX.writeFile(wb, `podnajem-export-${new Date().toISOString().slice(0,10)}.xlsx`);
    logAkce(userName, "Export XLSX", `${rows.length} jednotek`);
    showMsg("XLSX exportováno");
  };

  // ── Styly ─────────────────────────────────────────────────
  const bg = isDark ? "#0f172a" : "#f1f5f9";
  const surface = isDark ? "#1e293b" : "#ffffff";
  const border = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
  const text = isDark ? "#e2e8f0" : "#1e293b";
  const muted = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";
  const inputBg = isDark ? "#0f172a" : "#ffffff";
  const inputBorder = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)";
  const S = {
    input: { width: "100%", padding: "8px 11px", background: inputBg, border: `1px solid ${inputBorder}`, borderRadius: 7, color: text, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
    btnP: { padding: "9px 20px", background: "linear-gradient(135deg,#2563eb,#1d4ed8)", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" },
    btnS: { padding: "8px 16px", background: "transparent", border: `1px solid ${border}`, borderRadius: 8, color: text, cursor: "pointer", fontSize: 13, fontFamily: "inherit" },
    btnD: { padding: "8px 16px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#f87171", cursor: "pointer", fontSize: 13, fontFamily: "inherit" },
    card: { background: surface, border: `1px solid ${border}`, borderRadius: 12, padding: "16px 20px" },
    th: { padding: "9px 14px", textAlign: "left", color: muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${border}`, whiteSpace: "nowrap" },
    td: { padding: "9px 14px", borderBottom: `1px solid ${border}`, verticalAlign: "middle", color: text },
  };

  // ── Render ────────────────────────────────────────────────
  if (loading) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: bg, color: text, fontFamily: "inherit" }}>Načítání...</div>;
  if (!session) return <LoginScreen isDark={isDark} onLogin={handleLogin} onMagicLink={handleMagicLink} S={S} surface={surface} border={border} text={text} muted={muted} bg={bg} />;

  return (
    <div style={{ minHeight: "100vh", background: bg, fontFamily: "'Segoe UI',Tahoma,sans-serif", color: text }}>

      {/* TOAST */}
      {msg && <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, padding: "11px 20px", borderRadius: 10, background: msg.type === "err" ? "#dc2626" : "#16a34a", color: "#fff", fontSize: 13, fontWeight: 600 }}>{msg.type === "err" ? "⚠️ " : "✅ "}{msg.text}</div>}

      {/* UPOZORNĚNÍ */}
      {upozorneni.length > 0 && (
        <div style={{ background: "rgba(239,68,68,0.12)", borderBottom: "1px solid rgba(239,68,68,0.25)", padding: "7px 24px", fontSize: 12, color: "#fca5a5", cursor: "pointer" }} onClick={() => setActiveTab("smlouvy")}>
          ⚠️ {upozorneni.map(s => { const n = najemnici.find(x => x.id === s.najemnik_id); return `${n?.jmeno || "?"}: smlouva ${isSmlouvaPropadla(s.datum_do) ? "propadlá" : "končí"} ${fmtDate(s.datum_do)}`; }).join(" · ")}
        </div>
      )}

      {/* HEADER */}
      <div style={{ background: surface, borderBottom: `1px solid ${border}`, padding: "0 24px", display: "flex", alignItems: "center", height: 52, position: "sticky", top: upozorneni.length > 0 ? 33 : 0, zIndex: 100 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginRight: 32 }}>🏠 <span style={{ color: "#3b82f6" }}>Podnájem</span></div>
        {["prehled","platby","smlouvy","najemnici","jednotky"].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: "0 14px", height: 52, border: "none", background: "none", fontSize: 13, color: activeTab === tab ? "#3b82f6" : muted, borderBottom: activeTab === tab ? "2px solid #3b82f6" : "2px solid transparent", cursor: "pointer", fontWeight: activeTab === tab ? 600 : 400, fontFamily: "inherit" }}>
            {tab === "prehled" ? "Přehled" : tab === "platby" ? "Platby" : tab === "smlouvy" ? "Smlouvy" : tab === "najemnici" ? "Nájemníci" : "Jednotky"}
          </button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: muted }}>{userName}</span>
          <span style={{ fontSize: 11, color: muted, background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", padding: "2px 8px", borderRadius: 99 }}>{userRole}</span>
          {isAdmin && <>
            <button onClick={exportXLSX} style={{ ...S.btnS, padding: "5px 10px", fontSize: 12 }}>📊 XLSX</button>
            <button onClick={exportJSON} style={{ ...S.btnS, padding: "5px 10px", fontSize: 12 }}>💾 Záloha</button>
            <button onClick={() => { setShowLog(true); loadLog(); }} style={{ ...S.btnS, padding: "5px 10px", fontSize: 12 }}>📋 Log</button>
          </>}
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} style={{ ...S.btnS, padding: "5px 10px", fontSize: 12 }}>{isDark ? "☀️" : "🌙"}</button>
          <button onClick={() => setShowHelp(true)} style={{ ...S.btnS, padding: "5px 10px", fontSize: 12 }} title="Nápověda">?</button>
          <button onClick={handleLogout} style={{ ...S.btnS, padding: "5px 10px", fontSize: 12 }}>Odhlásit</button>
          <span style={{ fontSize: 11, color: muted }}>{APP_BUILD}</span>
        </div>
      </div>

      {/* CONTENT */}
      <div style={{ padding: "24px", maxWidth: 1500, margin: "0 auto" }}>

        {/* ── PŘEHLED ── */}
        {activeTab === "prehled" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 24 }}>
              {[
                { label: "Jednotek celkem", value: stats.celkem, color: "#3b82f6" },
                { label: "Obsazeno", value: stats.obsazeno, color: "#22c55e" },
                { label: "Příjem / měsíc", value: stats.prijemMesic ? fmt(stats.prijemMesic) + " Kč" : "—", color: "#f59e0b" },
                { label: "Pozor — smlouvy", value: stats.upozorneni, color: stats.upozorneni > 0 ? "#f87171" : "#22c55e" },
              ].map(c => (
                <div key={c.label} style={{ ...S.card, textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>{c.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            {/* Kdo nezaplatil — aktuální měsíc */}
            {(() => {
              const mesicNow = now.getMonth() + 1;
              const rokNow = now.getFullYear();
              // Tato data máme jen pokud jsme na záložce platby — proto použijeme jen smlouvy
              // a upozorníme uživatele ať přejde do Plateb
              const nezaplSmlouvy = aktivniSmlouvy.filter(s => {
                // Jen upozornění — data plateb na přehledu nenačítáme
                return false; // placeholder — viz Platby záložka
              });
              // Místo toho zobrazíme jen odkaz
              return null;
            })()}

            {/* Filtr */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: muted }}>Dům:</span>              {[{ id: "", nazev: "Vše" }, ...objekty].map(o => (
                <button key={o.id} onClick={() => setFilterObjekt(o.id === "" ? "" : o.id)} style={{ padding: "4px 14px", borderRadius: 99, fontSize: 12, cursor: "pointer", border: `1px solid ${filterObjekt === (o.id||"") ? "#3b82f6" : border}`, background: filterObjekt === (o.id||"") ? "rgba(59,130,246,0.15)" : "transparent", color: filterObjekt === (o.id||"") ? "#3b82f6" : text }}>{o.nazev}</button>
              ))}
            </div>

            {/* Tabulka jednotek */}
            <TabulkaJednotky jednotky={jednotky.filter(j => !filterObjekt || j.objekt_id === Number(filterObjekt))} objekty={objekty} najemnici={najemnici} smlouvy={smlouvy} jednotkaSmlouva={jednotkaSmlouva} sazebnik={sazebnik} sazebnikPolozky={sazebnikPolozky} isAdmin={isAdmin} S={S} border={border} muted={muted} text={text} isDark={isDark} fmtDate={fmtDate} fmtKc={fmtKc} fmt={fmt} aktualniSazebnik={aktualniSazebnik} isSmlouvaBrzy={isSmlouvaBrzy} isSmlouvaPropadla={isSmlouvaPropadla}
              onEditJednotka={setJednotkaForm}
              onDeleteJednotka={id => setDeleteConfirm({ type: "jednotka", id, nazev: jednotky.find(j=>j.id===id)?.cislo_bytu || "" })}
              onDetailSmlouva={setDetailSmlouva}
              onAddJednotka={() => setJednotkaForm({ stav: "volná", typ: "byt", objekt_id: filterObjekt || "" })}
            />
          </div>
        )}

        {/* ── PLATBY ── */}
        {activeTab === "platby" && (
          <div>
            {/* Přepínač pohledů */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", borderRadius: 8, padding: 3 }}>
                {[["mesic","Měsíc"],["rok","Roční přehled"],["nezaplaceno","Kdo nezaplatil"]].map(([v,l]) => (
                  <button key={v} onClick={() => {
                    setPlatbyPohled2(v);
                    if (v === "rok") loadRocniPrehled(rocniRok);
                  }} style={{ padding: "5px 14px", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", background: platbyPohled2 === v ? "#2563eb" : "transparent", color: platbyPohled2 === v ? "#fff" : muted, fontFamily: "inherit" }}>{l}</button>
                ))}
              </div>
              {/* Původní měsíc/období přepínač jen v pohledu měsíc */}
              {platbyPohled2 === "mesic" && <>
                <div style={{ display: "flex", background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", borderRadius: 8, padding: 3 }}>
                  {[["mesic","Měsíc"],["obdobi","Celé období"]].map(([v,l]) => (
                    <button key={v} onClick={() => setPlatbyPohled(v)} style={{ padding: "5px 14px", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", background: platbyPohled === v ? "#1e40af" : "transparent", color: platbyPohled === v ? "#fff" : muted, fontFamily: "inherit" }}>{l}</button>
                  ))}
                </div>
                <select style={{ ...S.input, width: "auto", minWidth: 200 }} value={platbySmlouva} onChange={e => setPlatbySmlouva(e.target.value)}>
                  <option value="">Všechny smlouvy</option>
                  {aktivniSmlouvy.map(s => { const n = najemnici.find(x => x.id === s.najemnik_id); return <option key={s.id} value={s.id}>{n?.jmeno || "?"} — od {fmtDate(s.datum_od)}</option>; })}
                </select>
                {platbyPohled === "mesic" && <>
                  <button onClick={() => { let m = platbyMesic-1, r = platbyRok; if(m<0){m=11;r--;} setPlatbyMesic(m); setPlatbyRok(r); }} style={{ ...S.btnS, padding: "6px 12px", fontSize: 14 }}>‹</button>
                  <span style={{ fontSize: 14, fontWeight: 600, minWidth: 130, textAlign: "center" }}>{MESICE[platbyMesic]} {platbyRok}</span>
                  <button onClick={() => { let m = platbyMesic+1, r = platbyRok; if(m>11){m=0;r++;} setPlatbyMesic(m); setPlatbyRok(r); }} style={{ ...S.btnS, padding: "6px 12px", fontSize: 14 }}>›</button>
                  {isAdmin && <button onClick={generujPredpisy} style={S.btnP}>+ Generovat předpisy</button>}
                  {isAdmin && platbySmlouva && <button onClick={() => setVyuctovaniForm({ smlouva_id: platbySmlouva, datum: new Date().toISOString().slice(0,10), typ: "nedoplatek", uhrazeno: false })} style={{ ...S.btnS, fontSize: 12 }}>+ Vyúčtování</button>}
                </>}
              </>}
              {platbyPohled2 === "rok" && <>
                <button onClick={() => { const r = rocniRok-1; setRocniRok(r); loadRocniPrehled(r); }} style={{ ...S.btnS, padding: "6px 12px", fontSize: 14 }}>‹</button>
                <span style={{ fontSize: 14, fontWeight: 600, minWidth: 60, textAlign: "center" }}>{rocniRok}</span>
                <button onClick={() => { const r = rocniRok+1; setRocniRok(r); loadRocniPrehled(r); }} style={{ ...S.btnS, padding: "6px 12px", fontSize: 14 }}>›</button>
              </>}
            </div>

            {/* ── POHLED: MĚSÍC (původní) ── */}
            {platbyPohled2 === "mesic" && (<>
              {/* Checklist měsíčního uzávěrku */}
              {platbyPohled === "mesic" && isAdmin && (() => {
                const mesicDB = platbyMesic + 1;
                const predpisyExistuji = platby.some(p => p.rok === platbyRok && p.mesic === mesicDB);
                const vsichniZaplatili = predpisyExistuji && platby.filter(p => p.rok === platbyRok && p.mesic === mesicDB).every(p => p.zaplaceno);
                const nezaplaceniCount = platby.filter(p => p.rok === platbyRok && p.mesic === mesicDB && !p.zaplaceno).length;
                const steps = [
                  { done: predpisyExistuji, label: "Vygenerovat předpisy", hint: "Klikněte + Generovat předpisy" },
                  { done: predpisyExistuji && nezaplaceniCount === 0, label: "Zadat platby nájemníků", hint: nezaplaceniCount > 0 ? `${nezaplaceniCount} nezaplaceno` : "Hotovo" },
                  { done: vsichniZaplatili, label: "Uzavřít měsíc", hint: vsichniZaplatili ? "Vše zaplaceno ✓" : "Čeká na platby" },
                ];
                return (
                  <div style={{ ...S.card, marginBottom: 16, padding: "12px 20px" }}>
                    <div style={{ fontSize: 12, color: muted, fontWeight: 600, marginBottom: 10 }}>PRŮVODCE — {MESICE[platbyMesic]} {platbyRok}</div>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                      {steps.map((st, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 22, height: 22, borderRadius: "50%", background: st.done ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.06)", border: `1.5px solid ${st.done ? "#4ade80" : border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: st.done ? "#4ade80" : muted, flexShrink: 0 }}>{st.done ? "✓" : i+1}</div>
                          <div>
                            <div style={{ fontSize: 13, color: st.done ? "#4ade80" : text, fontWeight: st.done ? 600 : 400 }}>{st.label}</div>
                            <div style={{ fontSize: 11, color: muted }}>{st.hint}</div>
                          </div>
                          {i < steps.length-1 && <div style={{ color: border, marginLeft: 4 }}>›</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {platbyPohled === "mesic" && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
                  {[
                    { label: "Předpis celkem", value: fmtKc(platbyStats.predpis), color: "#3b82f6" },
                    { label: "Zaplaceno", value: fmtKc(platbyStats.zaplaceno), color: "#22c55e" },
                    { label: "Dluh", value: platbyStats.dluh > 0 ? fmtKc(platbyStats.dluh) : "0 Kč", color: platbyStats.dluh > 0 ? "#f87171" : "#22c55e" },
                  ].map(c => (
                    <div key={c.label} style={{ ...S.card, textAlign: "center" }}>
                      <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>{c.label}</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                        {platbyPohled === "obdobi" && <th style={S.th}>Měsíc</th>}
                        <th style={S.th}>Nájemník</th><th style={S.th}>Jednotka</th><th style={S.th}>Předpis</th>
                        <th style={S.th}>Zaplaceno</th><th style={S.th}>Datum platby</th><th style={S.th}>Stav</th>
                        {isAdmin && <th style={S.th}>Akce</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {platby.length === 0 && <tr><td colSpan={8} style={{ padding: "40px", textAlign: "center", color: muted }}>Žádné záznamy.{platbyPohled === "mesic" && isAdmin && " Klikněte Generovat předpisy."}</td></tr>}
                      {platby.map(p => {
                        const jed = jednotky.find(j => j.id === p.jednotka_id);
                        const obj = jed ? objekty.find(o => o.id === jed.objekt_id) : null;
                        const sml = smlouvy.find(s => s.id === p.smlouva_id);
                        const naj = sml ? najemnici.find(n => n.id === sml.najemnik_id) : null;
                        const pp = platbyPolozky.filter(x => x.platba_id === p.id);
                        const predpis = pp.reduce((s,x) => s + (Number(x.castka_predpis_kc || x.predpis_kc) || 0), 0);
                        const zaplaceno = (Number(p.banka_kc)||0) + (Number(p.hotove_kc)||0) + (Number(p.doplatek_kc)||0);
                        return (
                          <tr key={p.id} style={{ borderBottom: `1px solid ${border}`, background: p.zaplaceno ? (isDark ? "rgba(34,197,94,0.04)" : "rgba(34,197,94,0.03)") : "transparent" }}>
                            {platbyPohled === "obdobi" && <td style={{ ...S.td, fontWeight: 600, whiteSpace: "nowrap" }}>{MESICE[p.mesic-1]} {p.rok}</td>}
                            <td style={S.td}>{naj?.jmeno || <span style={{ color: muted }}>—</span>}</td>
                            <td style={{ ...S.td, color: muted, fontSize: 12 }}>{obj?.nazev ? `${obj.nazev} / ` : ""}{jed?.cislo_bytu || "—"}</td>
                            <td style={S.td}>
                              {predpis > 0 ? <div>
                                <div style={{ fontWeight: 600 }}>{fmtKc(predpis)}</div>
                                {pp.map(x => <div key={x.id||x.nazev} style={{ fontSize: 11, color: muted }}>{x.nazev}: {fmtKc(x.castka_predpis_kc || x.predpis_kc)}</div>)}
                              </div> : <span style={{ color: muted }}>—</span>}
                            </td>
                            <td style={{ ...S.td, color: p.zaplaceno ? "#4ade80" : muted }}>
                              {zaplaceno > 0 ? <div>
                                <div style={{ fontWeight: 600 }}>{fmtKc(zaplaceno)}</div>
                                {Number(p.banka_kc) > 0 && <div style={{ fontSize: 11, color: muted }}>Banka: {fmtKc(p.banka_kc)}</div>}
                                {Number(p.hotove_kc) > 0 && <div style={{ fontSize: 11, color: muted }}>Hotově: {fmtKc(p.hotove_kc)}</div>}
                                {Number(p.srazky_kc) > 0 && <div style={{ fontSize: 11, color: "#f59e0b" }}>Srážka: -{fmtKc(p.srazky_kc)}</div>}
                              </div> : "—"}
                            </td>
                            <td style={{ ...S.td, color: muted, fontSize: 12 }}>{fmtDate(p.datum_platby)}</td>
                            <td style={S.td}><span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: p.zaplaceno ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: p.zaplaceno ? "#4ade80" : "#f87171" }}>{p.zaplaceno ? "zaplaceno" : "nezaplaceno"}</span>{p.poznamka && <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>{p.poznamka}</div>}</td>
                            {isAdmin && <td style={S.td}>
                              <button onClick={() => {
                                const pp2 = platbyPolozky.filter(x => x.platba_id === p.id);
                                let polozkyData = pp2.map(x => ({...x}));
                                if (polozkyData.length === 0 && p.smlouva_id) {
                                  const saz = sazebnikKDatu(p.smlouva_id, p.rok, p.mesic);
                                  if (saz) {
                                    polozkyData = sazebnikPolozky
                                      .filter(sp => sp.sazebnik_id === saz.id)
                                      .map(sp => ({ nazev: sp.nazev, castka_predpis_kc: sp.castka_kc, typ: sp.typ, _fromSazebnik: true }));
                                  }
                                }
                                setEditPlatba({ ...p, polozky: polozkyData });
                              }} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14 }}>✏️</button>
                              <button onClick={() => setDeleteConfirm({ type: "platba", id: p.id, nazev: `platba ${MESICE[p.mesic-1]} ${p.rok}` })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14 }}>🗑️</button>
                            </td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Vyúčtování energií */}
              {vyuctovani.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>Roční vyúčtování energií</span>
                    {isAdmin && platbySmlouva && <button onClick={() => setVyuctovaniForm({ smlouva_id: platbySmlouva, datum: new Date().toISOString().slice(0,10), typ: "nedoplatek", uhrazeno: false })} style={{ ...S.btnS, fontSize: 12 }}>+ Přidat vyúčtování</button>}
                  </div>
                  <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                            {["Datum","Typ","Popis","Částka","Uhrazeno","Datum úhrady",isAdmin?"Akce":""].filter(Boolean).map(h => <th key={h} style={S.th}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {vyuctovani.map(v => {
                            const sml = smlouvy.find(s => s.id === v.smlouva_id);
                            const naj = sml ? najemnici.find(n => n.id === sml.najemnik_id) : null;
                            return (
                              <tr key={v.id} style={{ borderBottom: `1px solid ${border}` }}>
                                <td style={{ ...S.td, color: muted }}>{fmtDate(v.datum)}</td>
                                <td style={S.td}><span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: v.typ === "nedoplatek" ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)", color: v.typ === "nedoplatek" ? "#f87171" : "#4ade80" }}>{v.typ}</span></td>
                                <td style={S.td}>{v.popis || <span style={{ color: muted }}>—</span>}{naj && <div style={{ fontSize: 11, color: muted }}>{naj.jmeno}</div>}</td>
                                <td style={{ ...S.td, fontWeight: 600, color: v.typ === "nedoplatek" ? "#f87171" : "#4ade80" }}>{fmtKc(v.castka_kc)}</td>
                                <td style={S.td}><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: v.uhrazeno ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.08)", color: v.uhrazeno ? "#4ade80" : "#f87171" }}>{v.uhrazeno ? "✓ ano" : "✗ ne"}</span></td>
                                <td style={{ ...S.td, color: muted }}>{fmtDate(v.datum_uhrazeni)}</td>
                                {isAdmin && <td style={S.td}>
                                  <button onClick={() => setVyuctovaniForm({ ...v })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 13 }}>✏️</button>
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
              {isAdmin && platbySmlouva && vyuctovani.length === 0 && (
                <div style={{ marginTop: 16, textAlign: "center" }}>
                  <button onClick={() => setVyuctovaniForm({ smlouva_id: platbySmlouva, datum: new Date().toISOString().slice(0,10), typ: "nedoplatek", uhrazeno: false })} style={{ ...S.btnS, fontSize: 12 }}>+ Přidat roční vyúčtování energií</button>
                </div>
              )}
            </>)}

            {/* ── POHLED: ROČNÍ PŘEHLED (tabulka jako Excel) ── */}
            {platbyPohled2 === "rok" && (
              <div>
                {rocniLoading ? (
                  <div style={{ padding: 40, textAlign: "center", color: muted }}>Načítám...</div>
                ) : (() => {
                  // Sestavíme tabulku: řádky = aktivní smlouvy, sloupce = měsíce 1–12
                  const smlRadky = aktivniSmlouvy.map(sml => {
                    const naj = najemnici.find(n => n.id === sml.najemnik_id);
                    const jIds = smlouvaJednotky[sml.id] || [];
                    const mesice = Array.from({length: 12}, (_,mi) => {
                      const mesicDB = mi + 1;
                      // Najdi platbu pro tuto smlouvu a měsíc (první jednotka smlouvy)
                      const platba = rocniPlatby.find(p => p.smlouva_id === sml.id && p.mesic === mesicDB && p.rok === rocniRok);
                      if (!platba) {
                        // Zkontroluj zda smlouva platila v tomto měsíci
                        const datumOd = sml.datum_od || "0000-01-01";
                        const datumDo = sml.datum_do || "9999-12-31";
                        const mStart = `${rocniRok}-${String(mesicDB).padStart(2,"0")}-01`;
                        const mKonec = `${rocniRok}-${String(mesicDB).padStart(2,"0")}-${new Date(rocniRok, mesicDB, 0).getDate()}`;
                        const bylaAktivni = mKonec >= datumOd && mStart <= datumDo;
                        return { stav: bylaAktivni ? "chybi" : "mimo", platba: null };
                      }
                      const pp = rocniPolozky.filter(x => x.platba_id === platba.id);
                      const predpis = pp.reduce((s,x) => s+(Number(x.castka_predpis_kc||x.predpis_kc)||0), 0);
                      const zapl = (Number(platba.banka_kc)||0)+(Number(platba.hotove_kc)||0)+(Number(platba.doplatek_kc)||0);
                      return { stav: platba.zaplaceno ? "ok" : "nezapl", predpis, zapl, platba };
                    });
                    const celkemPredpis = mesice.reduce((s,m) => s+(m.predpis||0), 0);
                    const celkemZapl = mesice.reduce((s,m) => s+(m.zapl||0), 0);
                    return { sml, naj, mesice, celkemPredpis, celkemZapl };
                  });
                  return (
                    <div>
                      <div style={{ fontSize: 12, color: muted, marginBottom: 10 }}>
                        Legenda: <span style={{ color: "#4ade80", fontWeight: 600 }}>zaplaceno</span> · <span style={{ color: "#f87171", fontWeight: 600 }}>nezaplaceno</span> · <span style={{ color: muted }}>— mimo dobu smlouvy</span> · <span style={{ color: "#f59e0b", fontWeight: 600 }}>chybí předpis</span>
                      </div>
                      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                            <thead>
                              <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                                <th style={{ ...S.th, minWidth: 140 }}>Nájemník</th>
                                {MESICE.map(m => <th key={m} style={{ ...S.th, textAlign: "center", minWidth: 70 }}>{m.slice(0,3)}</th>)}
                                <th style={{ ...S.th, textAlign: "right" }}>Předpis</th>
                                <th style={{ ...S.th, textAlign: "right" }}>Zaplaceno</th>
                                <th style={{ ...S.th, textAlign: "right" }}>Saldo</th>
                              </tr>
                            </thead>
                            <tbody>
                              {smlRadky.length === 0 && <tr><td colSpan={16} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné aktivní smlouvy.</td></tr>}
                              {smlRadky.map(({ sml, naj, mesice, celkemPredpis, celkemZapl }) => {
                                const saldo = celkemZapl - celkemPredpis;
                                return (
                                  <tr key={sml.id} style={{ borderBottom: `1px solid ${border}` }}>
                                    <td style={{ ...S.td, fontWeight: 600 }}>{naj?.jmeno || "?"}</td>
                                    {mesice.map((m, mi) => {
                                      let bg = "transparent", color = muted, label = "—";
                                      if (m.stav === "ok") { bg = isDark ? "rgba(34,197,94,0.15)" : "rgba(34,197,94,0.12)"; color = "#4ade80"; label = m.zapl ? fmt(m.zapl) : "✓"; }
                                      else if (m.stav === "nezapl") { bg = isDark ? "rgba(239,68,68,0.15)" : "rgba(239,68,68,0.1)"; color = "#f87171"; label = "✗"; }
                                      else if (m.stav === "chybi") { color = "#f59e0b"; label = "!"; }
                                      return (
                                        <td key={mi} style={{ ...S.td, textAlign: "center", background: bg, color, fontWeight: m.stav === "ok" || m.stav === "nezapl" ? 600 : 400, cursor: m.platba ? "pointer" : "default", fontSize: 11 }}
                                          onClick={() => {
                                            if (m.platba) {
                                              const pp2 = rocniPolozky.filter(x => x.platba_id === m.platba.id);
                                              setEditPlatba({ ...m.platba, polozky: pp2.map(x => ({...x})) });
                                            }
                                          }}
                                          title={m.platba ? `${MESICE[mi]}: předpis ${fmt(m.predpis)} Kč, zaplaceno ${fmt(m.zapl)} Kč` : ""}>
                                          {label}
                                        </td>
                                      );
                                    })}
                                    <td style={{ ...S.td, textAlign: "right", color: muted }}>{celkemPredpis ? fmt(celkemPredpis) : "—"}</td>
                                    <td style={{ ...S.td, textAlign: "right", color: "#4ade80", fontWeight: 600 }}>{celkemZapl ? fmt(celkemZapl) : "—"}</td>
                                    <td style={{ ...S.td, textAlign: "right", fontWeight: 600, color: saldo >= 0 ? "#4ade80" : "#f87171" }}>{saldo !== 0 ? (saldo > 0 ? "+" : "") + fmt(saldo) : "0"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <div style={{ marginTop: 10, fontSize: 12, color: muted }}>Kliknutím na buňku otevřeš detail platby.</div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── POHLED: KDO NEZAPLATIL ── */}
            {platbyPohled2 === "nezaplaceno" && (() => {
              // Najdi všechny nezaplacené platby v DB (pohled: celé období)
              // Musíme načíst z platby state — použijeme "celé období" data
              const vsechnyNezapl = platby.filter ? [] : []; // placeholder — použijeme vlastní fetch
              // Protože nemáme všechna data najednou, zobrazíme ze stávajícího stavu + info
              const nezaplacenoSeznam = (() => {
                // Projdeme roční data pokud jsou, jinak aktuální měsíční
                const zdrojPlatby = rocniPlatby.length > 0 ? rocniPlatby : platby;
                return zdrojPlatby.filter(p => !p.zaplaceno).map(p => {
                  const sml = smlouvy.find(s => s.id === p.smlouva_id);
                  const naj = sml ? najemnici.find(n => n.id === sml.najemnik_id) : null;
                  const jed = jednotky.find(j => j.id === p.jednotka_id);
                  const obj = jed ? objekty.find(o => o.id === jed.objekt_id) : null;
                  const pp = (rocniPlatby.length > 0 ? rocniPolozky : platbyPolozky).filter(x => x.platba_id === p.id);
                  const predpis = pp.reduce((s,x) => s+(Number(x.castka_predpis_kc||x.predpis_kc)||0), 0);
                  return { p, naj, jed, obj, predpis };
                }).sort((a,b) => a.p.rok !== b.p.rok ? b.p.rok - a.p.rok : b.p.mesic - a.p.mesic);
              })();
              return (
                <div>
                  <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 13, color: muted }}>
                      {rocniPlatby.length > 0 ? `Data za rok ${rocniRok}` : "Data za aktuální měsíc/filtr"} — pro úplný přehled přepni na Roční přehled a vyber rok.
                    </div>
                    <button onClick={() => { setPlatbyPohled2("rok"); loadRocniPrehled(rocniRok); }} style={{ ...S.btnS, fontSize: 12 }}>Načíst roční data</button>
                  </div>
                  {nezaplacenoSeznam.length === 0 ? (
                    <div style={{ ...S.card, padding: 40, textAlign: "center" }}>
                      <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
                      <div style={{ color: "#4ade80", fontWeight: 600 }}>Všichni zaplatili!</div>
                    </div>
                  ) : (
                    <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                              {["Nájemník","Jednotka","Měsíc","Předpis","Akce"].map(h => <th key={h} style={S.th}>{h}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {nezaplacenoSeznam.map(({ p, naj, jed, obj, predpis }) => (
                              <tr key={p.id} style={{ borderBottom: `1px solid ${border}`, background: isDark ? "rgba(239,68,68,0.06)" : "rgba(239,68,68,0.04)" }}>
                                <td style={{ ...S.td, fontWeight: 600, color: "#f87171" }}>{naj?.jmeno || "?"}</td>
                                <td style={{ ...S.td, color: muted, fontSize: 12 }}>{obj?.nazev ? `${obj.nazev} / ` : ""}{jed?.cislo_bytu || "—"}</td>
                                <td style={{ ...S.td, fontWeight: 600 }}>{MESICE[p.mesic-1]} {p.rok}</td>
                                <td style={{ ...S.td, color: "#f87171", fontWeight: 600 }}>{predpis ? fmtKc(predpis) : "—"}</td>
                                {isAdmin && <td style={S.td}>
                                  <button onClick={() => {
                                    const pp2 = (rocniPlatby.length > 0 ? rocniPolozky : platbyPolozky).filter(x => x.platba_id === p.id);
                                    let polozkyData = pp2.map(x => ({...x}));
                                    if (polozkyData.length === 0 && p.smlouva_id) {
                                      const saz = sazebnikKDatu(p.smlouva_id, p.rok, p.mesic);
                                      if (saz) polozkyData = sazebnikPolozky.filter(sp => sp.sazebnik_id === saz.id).map(sp => ({ nazev: sp.nazev, castka_predpis_kc: sp.castka_kc, _fromSazebnik: true }));
                                    }
                                    setEditPlatba({ ...p, polozky: polozkyData });
                                  }} style={{ ...S.btnP, padding: "4px 12px", fontSize: 12 }}>Zadat platbu</button>
                                </td>}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
        {activeTab === "smlouvy" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Smlouvy ({smlouvy.length})</span>
              {isAdmin && <button onClick={() => setSmlouvaForm({ aktivni: true, email_notifikace: true, kauce_zaplacena: false, jednotky_ids: [] })} style={S.btnP}>+ Nová smlouva</button>}
            </div>
            <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                      {["Nájemník","Jednotky","Smlouva od","Smlouva do","Kauce","Stav",isAdmin?"Akce":""].filter(Boolean).map(h => <th key={h} style={S.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {smlouvy.length === 0 && <tr><td colSpan={7} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné smlouvy.</td></tr>}
                    {smlouvy.map(s => {
                      const naj = najemnici.find(n => n.id === s.najemnik_id);
                      const jIds = smlouvaJednotky[s.id] || [];
                      const jedList = jIds.map(jid => jednotky.find(j => j.id === jid)).filter(Boolean);
                      const brzy = isSmlouvaBrzy(s.datum_do);
                      const propadla = isSmlouvaPropadla(s.datum_do);
                      const saz = aktualniSazebnik(s.id);
                      const polozky = saz ? sazebnikPolozky.filter(sp => sp.sazebnik_id === saz.id) : [];
                      const celkem = polozky.reduce((sum, p) => sum + (Number(p.castka_kc)||0), 0);
                      return (
                        <tr key={s.id} style={{ borderBottom: `1px solid ${border}`, background: !s.aktivni ? (isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)") : propadla ? (isDark?"rgba(239,68,68,0.06)":"rgba(239,68,68,0.04)") : brzy ? (isDark?"rgba(245,158,11,0.06)":"rgba(245,158,11,0.04)") : "transparent" }}>
                          <td style={{ ...S.td, fontWeight: 600 }}>{naj?.jmeno || "—"}{!s.aktivni && <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 6px", borderRadius: 99, background: "rgba(255,255,255,0.08)", color: muted }}>ukončena</span>}</td>
                          <td style={S.td}>{jedList.length > 0 ? jedList.map(j => { const o = objekty.find(x => x.id === j.objekt_id); return <div key={j.id} style={{ fontSize: 12 }}>{o?.nazev ? `${o.nazev} / ` : ""}{j.cislo_bytu} ({j.typ})</div>; }) : <span style={{ color: muted }}>—</span>}</td>
                          <td style={{ ...S.td, color: muted }}>{fmtDate(s.datum_od)}</td>
                          <td style={{ ...S.td, color: propadla ? "#f87171" : brzy ? "#f59e0b" : text, fontWeight: (brzy||propadla) ? 600 : 400 }}>{fmtDate(s.datum_do)}{propadla && " ⚠️"}{brzy && !propadla && " ⏰"}</td>
                          <td style={S.td}>{s.kauce_kc ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: s.kauce_zaplacena ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)", color: s.kauce_zaplacena ? "#4ade80" : "#f87171" }}>{s.kauce_zaplacena ? "✓" : "✗"} {fmt(s.kauce_kc)} Kč</span> : "—"}</td>
                          <td style={S.td}>
                            {celkem > 0 && <div style={{ fontSize: 12, color: "#60a5fa", marginBottom: 2 }}>{fmtKc(celkem)}/měs</div>}
                            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: s.aktivni ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.05)", color: s.aktivni ? "#4ade80" : muted }}>{s.aktivni ? "aktivní" : "ukončená"}</span>
                          </td>
                          {isAdmin && <td style={S.td}>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              <button onClick={() => setDetailSmlouva(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#60a5fa", fontSize: 13, padding: "2px 4px" }} title="Detail">📄</button>
                              <button onClick={() => setSmlouvaForm({ ...s, jednotky_ids: smlouvaJednotky[s.id] || [] })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 13, padding: "2px 4px" }} title="Editovat">✏️</button>
                              <button onClick={() => setDodatekForm({ smlouva_id: s.id, datum: new Date().toISOString().slice(0,10), typ: "prodloužení" })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f59e0b", fontSize: 13, padding: "2px 4px" }} title="Dodatek">📋</button>
                              <button onClick={() => setSazebnikForm({ smlouva_id: s.id, platne_od: new Date().toISOString().slice(0,10), polozky: saz ? sazebnikPolozky.filter(sp => sp.sazebnik_id === saz.id).map(sp => ({...sp})) : [{ nazev: "Nájem čistý", castka_kc: 0, typ: "najem" }] })} style={{ background: "none", border: "none", cursor: "pointer", color: "#a78bfa", fontSize: 13, padding: "2px 4px" }} title="Sazebník">💰</button>
                              {s.aktivni && <button onClick={() => setDeleteConfirm({ type: "smlouva_ukoncit", id: s.id, nazev: naj?.jmeno || "?" })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 13, padding: "2px 4px" }} title="Ukončit">🔴</button>}
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

        {/* ── NÁJEMNÍCI ── */}
        {activeTab === "najemnici" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Nájemníci ({najemnici.length})</span>
              {isAdmin && <button onClick={() => setNajemnikForm({})} style={S.btnP}>+ Přidat nájemníka</button>}
            </div>
            <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
                      {["Jméno","Telefon","Email","Datum nar.","Č. OP","Aktivní smlouvy","Poznámka",isAdmin?"Akce":""].filter(Boolean).map(h => <th key={h} style={S.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {najemnici.length === 0 && <tr><td colSpan={8} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádní nájemníci.</td></tr>}
                    {najemnici.map(n => {
                      const aktivniSml = aktivniSmlouvy.filter(s => s.najemnik_id === n.id);
                      return (
                        <tr key={n.id} style={{ borderBottom: `1px solid ${border}` }}>
                          <td style={{ ...S.td, fontWeight: 600 }}>{n.jmeno}</td>
                          <td style={S.td}>{n.telefon || "—"}</td>
                          <td style={{ ...S.td, color: "#60a5fa" }}>{n.email || "—"}</td>
                          <td style={{ ...S.td, color: muted }}>{n.datum_narozeni || "—"}</td>
                          <td style={{ ...S.td, color: muted }}>{n.cislo_op || "—"}</td>
                          <td style={S.td}>{aktivniSml.length > 0 ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80" }}>{aktivniSml.length} aktivní</span> : <span style={{ fontSize: 11, color: muted }}>žádná</span>}</td>
                          <td style={{ ...S.td, color: muted, fontSize: 12 }}>{n.poznamka || "—"}</td>
                          {isAdmin && <td style={S.td}>
                            <button onClick={() => setNajemnikForm({ ...n })} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 14 }}>✏️</button>
                            <button onClick={() => setDeleteConfirm({ type: "najemnik", id: n.id, nazev: n.jmeno })} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 14 }}>🗑️</button>
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

        {/* ── JEDNOTKY ── */}
        {activeTab === "jednotky" && (
          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 20 }}>
            <div>
              <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Bytové domy</span>
                  {isAdmin && <button onClick={() => setObjektForm({})} style={{ ...S.btnP, padding: "5px 12px", fontSize: 12 }}>+ Přidat</button>}
                </div>
                {objekty.map(o => {
                  const pocet = jednotky.filter(j => j.objekt_id === o.id).length;
                  const obsaz = jednotky.filter(j => j.objekt_id === o.id && j.stav === "obsazený").length;
                  return (
                    <div key={o.id} style={{ padding: "12px 20px", borderBottom: `1px solid ${border}`, cursor: "pointer" }} onClick={() => setFilterObjekt(String(o.id))}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>{o.nazev}</div>
                      <div style={{ fontSize: 12, color: muted, marginBottom: 6 }}>{o.adresa || "—"}</div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "rgba(59,130,246,0.12)", color: "#60a5fa" }}>{pocet} jednotek</span>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80" }}>{obsaz} obsazeno</span>
                      </div>
                      {isAdmin && <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button onClick={e => { e.stopPropagation(); setObjektForm({...o}); }} style={{ ...S.btnS, padding: "3px 10px", fontSize: 11 }}>✏️</button>
                        <button onClick={e => { e.stopPropagation(); setDeleteConfirm({ type: "objekt", id: o.id, nazev: o.nazev }); }} style={{ ...S.btnD, padding: "3px 10px", fontSize: 11 }}>🗑️</button>
                      </div>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{filterObjekt ? `Jednotky — ${objekty.find(o=>o.id===Number(filterObjekt))?.nazev}` : "Všechny jednotky"}</span>
                {isAdmin && <button onClick={() => setJednotkaForm({ stav: "volná", typ: "byt", objekt_id: filterObjekt || "" })} style={S.btnP}>+ Přidat jednotku</button>}
              </div>
              <TabulkaJednotky jednotky={jednotky.filter(j => !filterObjekt || j.objekt_id === Number(filterObjekt))} objekty={objekty} najemnici={najemnici} smlouvy={smlouvy} jednotkaSmlouva={jednotkaSmlouva} sazebnik={sazebnik} sazebnikPolozky={sazebnikPolozky} isAdmin={isAdmin} S={S} border={border} muted={muted} text={text} isDark={isDark} fmtDate={fmtDate} fmtKc={fmtKc} fmt={fmt} aktualniSazebnik={aktualniSazebnik} isSmlouvaBrzy={isSmlouvaBrzy} isSmlouvaPropadla={isSmlouvaPropadla}
                onEditJednotka={setJednotkaForm}
                onDeleteJednotka={id => setDeleteConfirm({ type: "jednotka", id, nazev: jednotky.find(j=>j.id===id)?.cislo_bytu || "" })}
                onDetailSmlouva={setDetailSmlouva}
                onAddJednotka={null}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── MODÁLY ── */}

      {objektForm && <Modal title={objektForm.id ? "Editace domu" : "Nový bytový dům"} onClose={() => setObjektForm(null)} surface={surface} border={border} text={text}>
        <FormObjekt data={objektForm} onChange={setObjektForm} onSave={saveObjekt} onCancel={() => setObjektForm(null)} S={S} muted={muted} />
      </Modal>}

      {jednotkaForm && <Modal title={jednotkaForm.id ? "Editace jednotky" : "Nová jednotka"} onClose={() => setJednotkaForm(null)} surface={surface} border={border} text={text}>
        <FormJednotka data={jednotkaForm} onChange={setJednotkaForm} onSave={saveJednotka} onCancel={() => setJednotkaForm(null)} objekty={objekty} S={S} muted={muted} text={text} />
      </Modal>}

      {najemnikForm && <Modal title={najemnikForm.id ? "Editace nájemníka" : "Nový nájemník"} onClose={() => setNajemnikForm(null)} surface={surface} border={border} text={text}>
        <FormNajemnik data={najemnikForm} onChange={setNajemnikForm} onSave={saveNajemnik} onCancel={() => setNajemnikForm(null)} S={S} muted={muted} text={text} />
      </Modal>}

      {smlouvaForm && <Modal title={smlouvaForm.id ? "Editace smlouvy" : "Nová smlouva"} onClose={() => setSmlouvaForm(null)} surface={surface} border={border} text={text} wide>
        <FormSmlouva data={smlouvaForm} onChange={setSmlouvaForm} onSave={saveSmlouva} onCancel={() => setSmlouvaForm(null)} najemnici={najemnici} jednotky={jednotky} objekty={objekty} S={S} muted={muted} text={text} border={border} isDark={isDark} />
      </Modal>}

      {dodatekForm && <Modal title="Nový dodatek ke smlouvě" onClose={() => setDodatekForm(null)} surface={surface} border={border} text={text}>
        <FormDodatek data={dodatekForm} onChange={setDodatekForm} onSave={saveDodatek} onCancel={() => setDodatekForm(null)} S={S} muted={muted} text={text} />
      </Modal>}

      {sazebnikForm && <Modal title="Nový sazebník" onClose={() => setSazebnikForm(null)} surface={surface} border={border} text={text} wide>
        <FormSazebnik data={sazebnikForm} onChange={setSazebnikForm} onSave={saveSazebnik} onCancel={() => setSazebnikForm(null)} S={S} muted={muted} text={text} border={border} />
      </Modal>}

      {editPlatba && <Modal title={`Platba — ${MESICE[editPlatba.mesic-1]} ${editPlatba.rok}`} onClose={() => setEditPlatba(null)} surface={surface} border={border} text={text} wide>
        <FormPlatba data={editPlatba} onChange={setEditPlatba} onSave={savePlatba} onCancel={() => setEditPlatba(null)} S={S} muted={muted} text={text} border={border} fmtKc={fmtKc} />
      </Modal>}

      {/* DETAIL SMLOUVY */}
      {detailSmlouva && (() => {
        const s = smlouvy.find(x => x.id === detailSmlouva);
        if (!s) return null;
        const naj = najemnici.find(n => n.id === s.najemnik_id);
        const jIds = smlouvaJednotky[s.id] || [];
        const jList = jIds.map(jid => jednotky.find(j => j.id === jid)).filter(Boolean);
        const smlDodatky = dodatky.filter(d => d.smlouva_id === s.id).sort((a,b) => b.datum.localeCompare(a.datum));
        const smlSazebnik = sazebnik.filter(sz => sz.smlouva_id === s.id).sort((a,b) => b.platne_od.localeCompare(a.platne_od));
        const smlVyuctovani = vyuctovani.filter(v => v.smlouva_id === s.id).sort((a,b) => b.datum.localeCompare(a.datum));
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
            <div style={{ background: surface, borderRadius: 16, width: "min(800px,96vw)", maxHeight: "90vh", overflow: "auto", border: `1px solid ${border}` }}>
              <div style={{ padding: "16px 24px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: surface }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: text }}>📄 Detail smlouvy — {naj?.jmeno}</span>
                <button onClick={() => setDetailSmlouva(null)} style={{ background: "none", border: "none", color: muted, fontSize: 20, cursor: "pointer" }}>✕</button>
              </div>
              <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
                {/* Základní info */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13 }}>
                  {[["Nájemník", naj?.jmeno], ["Telefon", naj?.telefon || "—"], ["Email", naj?.email || "—"], ["Smlouva od", fmtDate(s.datum_od)], ["Smlouva do", fmtDate(s.datum_do) || "neurčito"], ["Kauce", s.kauce_kc ? `${fmt(s.kauce_kc)} Kč ${s.kauce_zaplacena ? "(zaplacena)" : "(nezaplacena)"}` : "—"]].map(([l,v]) => (
                    <div key={l}><span style={{ color: muted, fontSize: 12 }}>{l}</span><div style={{ color: text, fontWeight: 500, marginTop: 2 }}>{v}</div></div>
                  ))}
                </div>
                {/* Jednotky */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: text }}>Jednotky v smlouvě</div>
                  {jList.map(j => { const o = objekty.find(x => x.id === j.objekt_id); return <div key={j.id} style={{ fontSize: 13, color: muted, padding: "4px 0" }}>{o?.nazev ? `${o.nazev} / ` : ""}{j.cislo_bytu} — {j.typ}{j.plocha_m2 ? `, ${j.plocha_m2} m²` : ""}{j.lodzie_m2 ? `, lodžie ${j.lodzie_m2} m²` : ""}</div>; })}
                </div>
                {/* Celkové saldo smlouvy */}
                {(() => {
                  const vsechnyPlatby = platby.filter(p => p.smlouva_id === s.id);
                  const vsechnyPP = platbyPolozky.filter(pp => vsechnyPlatby.some(p => p.id === pp.platba_id));
                  const celkemPredpis = vsechnyPP.reduce((sum,pp) => sum+(Number(pp.castka_predpis_kc||pp.predpis_kc)||0), 0);
                  const celkemZapl = vsechnyPlatby.reduce((sum,p) => sum+(Number(p.banka_kc)||0)+(Number(p.hotove_kc)||0)+(Number(p.doplatek_kc)||0), 0);
                  const saldo = celkemZapl - celkemPredpis;
                  const nezaplCount = vsechnyPlatby.filter(p => !p.zaplaceno).length;
                  if (vsechnyPlatby.length === 0) return null;
                  return (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
                      {[
                        { label: "Plateb celkem", value: vsechnyPlatby.length, color: "#60a5fa" },
                        { label: "Předpis (∑)", value: fmtKc(celkemPredpis), color: text },
                        { label: "Zaplaceno (∑)", value: fmtKc(celkemZapl), color: "#4ade80" },
                        { label: saldo >= 0 ? "Přeplatek" : "Dluh", value: fmtKc(Math.abs(saldo)), color: saldo >= 0 ? "#4ade80" : "#f87171" },
                      ].map(c => (
                        <div key={c.label} style={{ padding: "10px 14px", background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)", borderRadius: 8, border: `0.5px solid ${border}` }}>
                          <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>{c.label}</div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: c.color }}>{c.value}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {/* Sazebníky */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: text }}>Historie sazebníků</div>
                  {smlSazebnik.length === 0 ? <div style={{ color: muted, fontSize: 13 }}>Žádný sazebník.</div> : smlSazebnik.map(sz => {
                    const pol = sazebnikPolozky.filter(sp => sp.sazebnik_id === sz.id);
                    const celkem = pol.reduce((s,p) => s+(Number(p.castka_kc)||0), 0);
                    return (
                      <div key={sz.id} style={{ marginBottom: 12, padding: "10px 14px", background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)", borderRadius: 8, border: `0.5px solid ${border}` }}>
                        <div style={{ fontWeight: 600, fontSize: 12, color: "#60a5fa", marginBottom: 6 }}>Platné od {fmtDate(sz.platne_od)}{sz.poznamka ? ` — ${sz.poznamka}` : ""}</div>
                        {pol.map(p => <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: muted, padding: "2px 0" }}><span>{p.nazev}</span><span style={{ color: text }}>{fmtKc(p.castka_kc)}</span></div>)}
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, borderTop: `0.5px solid ${border}`, paddingTop: 6, marginTop: 4 }}><span>Celkem</span><span style={{ color: "#60a5fa" }}>{fmtKc(celkem)}</span></div>
                      </div>
                    );
                  })}
                </div>
                {/* Dodatky */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: text }}>Historie dodatků</div>
                  {smlDodatky.length === 0 ? <div style={{ color: muted, fontSize: 13 }}>Žádné dodatky.</div> : smlDodatky.map(d => (
                    <div key={d.id} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: `0.5px solid ${border}`, fontSize: 13 }}>
                      <span style={{ color: muted, minWidth: 90 }}>{fmtDate(d.datum)}</span>
                      <span style={{ padding: "1px 8px", borderRadius: 99, fontSize: 11, background: d.typ === "prodloužení" ? "rgba(34,197,94,0.12)" : d.typ === "změna sazby" ? "rgba(59,130,246,0.12)" : "rgba(255,255,255,0.06)", color: d.typ === "prodloužení" ? "#4ade80" : d.typ === "změna sazby" ? "#60a5fa" : muted }}>{d.typ}</span>
                      {d.nove_datum_do && <span style={{ color: muted }}>Nové datum do: {fmtDate(d.nove_datum_do)}</span>}
                      {d.poznamka && <span style={{ color: muted }}>{d.poznamka}</span>}
                    </div>
                  ))}
                </div>
                {/* Vyúčtování v detailu smlouvy */}
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: text }}>Roční vyúčtování</div>
                  {smlVyuctovani.length === 0 ? <div style={{ color: muted, fontSize: 13 }}>Žádné vyúčtování.</div> : smlVyuctovani.map(v => (
                    <div key={v.id} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: `0.5px solid ${border}`, fontSize: 13, alignItems: "center" }}>
                      <span style={{ color: muted, minWidth: 90 }}>{fmtDate(v.datum)}</span>
                      <span style={{ padding: "1px 8px", borderRadius: 99, fontSize: 11, background: v.typ === "nedoplatek" ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)", color: v.typ === "nedoplatek" ? "#f87171" : "#4ade80" }}>{v.typ}</span>
                      <span style={{ fontWeight: 600, color: v.typ === "nedoplatek" ? "#f87171" : "#4ade80" }}>{fmtKc(v.castka_kc)}</span>
                      {v.popis && <span style={{ color: muted }}>{v.popis}</span>}
                      <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 99, background: v.uhrazeno ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.05)", color: v.uhrazeno ? "#4ade80" : muted }}>{v.uhrazeno ? "uhrazeno" : "neuhrazeno"}</span>
                    </div>
                  ))}
                </div>
                {isAdmin && <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={() => { setDetailSmlouva(null); setDodatekForm({ smlouva_id: s.id, datum: new Date().toISOString().slice(0,10), typ: "prodloužení" }); }} style={S.btnS}>+ Dodatek</button>
                  <button onClick={() => { const saz = aktualniSazebnik(s.id); setDetailSmlouva(null); setSazebnikForm({ smlouva_id: s.id, platne_od: new Date().toISOString().slice(0,10), polozky: saz ? sazebnikPolozky.filter(sp => sp.sazebnik_id === saz.id).map(sp => ({...sp})) : [{ nazev: "Nájem čistý", castka_kc: 0, typ: "najem" }] }); }} style={S.btnS}>+ Sazebník</button>
                  <button onClick={() => { setDetailSmlouva(null); setVyuctovaniForm({ smlouva_id: s.id, datum: new Date().toISOString().slice(0,10), typ: "nedoplatek", uhrazeno: false }); }} style={S.btnS}>+ Vyúčtování</button>
                </div>}
              </div>
            </div>
          </div>
        );
      })()}

      {/* DELETE / UKONČIT CONFIRM */}
      {deleteConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
          <div style={{ background: surface, borderRadius: 14, padding: "28px 32px", width: 380, border: `1px solid ${deleteConfirm.type === "smlouva_ukoncit" ? "rgba(245,158,11,0.4)" : "rgba(239,68,68,0.4)"}` }}>
            <div style={{ fontSize: 32, textAlign: "center", marginBottom: 12 }}>{deleteConfirm.type === "smlouva_ukoncit" ? "🔴" : "🗑️"}</div>
            <h3 style={{ color: text, margin: "0 0 10px", fontSize: 16, textAlign: "center" }}>{deleteConfirm.type === "smlouva_ukoncit" ? "Ukončit smlouvu" : "Potvrdit smazání"}</h3>
            <p style={{ color: muted, fontSize: 13, textAlign: "center", marginBottom: 20 }}>{deleteConfirm.type === "smlouva_ukoncit" ? `Opravdu ukončit smlouvu nájemníka ${deleteConfirm.nazev}? Jednotky budou uvolněny.` : `Opravdu smazat ${deleteConfirm.nazev}?`}</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setDeleteConfirm(null)} style={{ flex: 1, ...S.btnS }}>Zrušit</button>
              <button onClick={() => {
                if (deleteConfirm.type === "objekt") deleteObjekt(deleteConfirm.id);
                else if (deleteConfirm.type === "jednotka") deleteJednotka(deleteConfirm.id);
                else if (deleteConfirm.type === "najemnik") deleteNajemnik(deleteConfirm.id);
                else if (deleteConfirm.type === "platba") deletePlatba(deleteConfirm.id);
                else if (deleteConfirm.type === "smlouva_ukoncit") ukoncitSmlouvu(deleteConfirm.id);
              }} style={{ flex: 1, ...S.btnD, fontWeight: 700 }}>{deleteConfirm.type === "smlouva_ukoncit" ? "Ukončit smlouvu" : "Smazat"}</button>
            </div>
          </div>
        </div>
      )}

      {/* VYÚČTOVÁNÍ FORM */}
      {vyuctovaniForm && <Modal title={vyuctovaniForm.id ? "Editace vyúčtování" : "Nové vyúčtování"} onClose={() => setVyuctovaniForm(null)} surface={surface} border={border} text={text}>
        <FormVyuctovani data={vyuctovaniForm} onChange={setVyuctovaniForm} onSave={saveVyuctovani} onCancel={() => setVyuctovaniForm(null)} S={S} muted={muted} text={text} />
      </Modal>}

      {/* LOG */}
      {showLog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
          <div style={{ background: surface, borderRadius: 16, width: "min(900px,96vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", border: `1px solid ${border}` }}>
            <div style={{ padding: "16px 24px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: text }}>📋 Log aktivit</span>
              <button onClick={() => setShowLog(false)} style={{ background: "none", border: "none", color: muted, fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)", position: "sticky", top: 0 }}>
                  {["Čas","Uživatel","Akce","Detail"].map(h => <th key={h} style={S.th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {logData.length === 0 && <tr><td colSpan={4} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné záznamy.</td></tr>}
                  {logData.map(r => (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${border}` }}>
                      <td style={{ ...S.td, color: muted, whiteSpace: "nowrap", fontSize: 12 }}>{r.cas ? new Date(r.cas).toLocaleString("cs-CZ", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                      <td style={{ ...S.td, fontWeight: 500 }}>{r.uzivatel}</td>
                      <td style={S.td}>{r.akce}</td>
                      <td style={{ ...S.td, color: muted, wordBreak: "break-word" }}>{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* NÁPOVĚDA */}
      {showHelp && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
          <div style={{ background: surface, borderRadius: 16, width: "min(640px,96vw)", maxHeight: "88vh", overflow: "auto", border: `1px solid ${border}` }}>
            <div style={{ padding: "16px 24px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: surface, zIndex: 1 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: text }}>Nápověda — Evidence podnájmů</span>
              <button onClick={() => setShowHelp(false)} style={{ background: "none", border: "none", color: muted, fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20, fontSize: 13 }}>

              {/* Jak funguje aplikace */}
              <div style={{ padding: "12px 16px", background: isDark ? "rgba(59,130,246,0.08)" : "rgba(59,130,246,0.06)", borderRadius: 10, border: `1px solid rgba(59,130,246,0.2)` }}>
                <div style={{ fontWeight: 600, color: "#60a5fa", marginBottom: 6 }}>Jak aplikace funguje</div>
                <div style={{ color: text, lineHeight: 1.6 }}>Aplikace eviduje podnájmy ve čtyřech vrstvách: <b>Jednotky</b> (byty, garáže, sklepy) → <b>Smlouvy</b> (kdo a jak dlouho) → <b>Sazebník</b> (kolik platí) → <b>Platby</b> (co skutečně přišlo).</div>
              </div>

              {/* Záložky */}
              {[
                {
                  tab: "Přehled", ico: "🏠",
                  co: "Rychlý přehled všech jednotek — kdo bydlí, do kdy má smlouvu, kolik platí.",
                  jak: "Použij filtr Dům pro zobrazení jen jednoho bytového domu. Kliknutím na jméno nájemníka otevřeš detail smlouvy.",
                },
                {
                  tab: "Platby", ico: "💰",
                  co: "Správa měsíčních plateb. Tři pohledy: Měsíc (aktuální měsíc), Roční přehled (tabulka jako Excel), Kdo nezaplatil.",
                  jak: [
                    "1. Vyber měsíc šipkami ‹ ›",
                    "2. Klikni + Generovat předpisy (vytvoří záznamy ze sazebníku)",
                    "3. Klikni ✏️ u platby a zadej datum + částku (Banka/Hotově)",
                    "Roční přehled: barevná tabulka — zelená = zaplaceno, červená = nezaplaceno, klik na buňku = detail",
                  ].join("\n"),
                },
                {
                  tab: "Smlouvy", ico: "📄",
                  co: "Přehled všech smluv. Červená = propadlá, oranžová = končí do 60 dní.",
                  jak: "📄 Detail smlouvy (sazebníky, dodatky, saldo) · ✏️ Editace · 📋 Přidat dodatek · 💰 Nový sazebník · 🔴 Ukončit smlouvu",
                },
                {
                  tab: "Nájemníci", ico: "👤",
                  co: "Osobní údaje nájemníků. Byt se nepřiřazuje zde — přiřazení je přes smlouvu.",
                  jak: "Přidej nájemníka → pak vytvoř smlouvu a tam vyber nájemníka + jednotky.",
                },
                {
                  tab: "Jednotky", ico: "🏢",
                  co: "Správa bytových domů a jednotek (byty, garáže, sklepy, stání).",
                  jak: "Nejprve přidej Bytový dům, pak teprve přidávej jednotky v rámci domu.",
                },
              ].map(item => (
                <div key={item.tab} style={{ borderBottom: `1px solid ${border}`, paddingBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 16 }}>{item.ico}</span>
                    <span style={{ fontWeight: 700, fontSize: 14, color: text }}>{item.tab}</span>
                  </div>
                  <div style={{ color: muted, marginBottom: 6 }}>{item.co}</div>
                  <div style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)", borderRadius: 7, padding: "8px 12px", color: text, lineHeight: 1.7, whiteSpace: "pre-line", fontSize: 12 }}>{item.jak}</div>
                </div>
              ))}

              {/* Měsíční rutina */}
              <div>
                <div style={{ fontWeight: 600, color: text, marginBottom: 10 }}>Typická měsíční rutina</div>
                {[
                  ["1.", "Záložka Platby → vyber aktuální měsíc"],
                  ["2.", "Klikni + Generovat předpisy (pouze jednou za měsíc)"],
                  ["3.", "Počkej na příchozí platby z banky"],
                  ["4.", "Klikni ✏️ u každé platby → zadej datum a částku (Banka)"],
                  ["5.", "Zkontroluj Kdo nezaplatil — připomeň nájemníkům"],
                  ["6.", "Na konci roku: + Vyúčtování pro nedoplatky/přeplatky energií"],
                ].map(([n, t]) => (
                  <div key={n} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: `1px solid ${border}` }}>
                    <span style={{ color: "#60a5fa", fontWeight: 700, minWidth: 20 }}>{n}</span>
                    <span style={{ color: text }}>{t}</span>
                  </div>
                ))}
              </div>

              <div style={{ color: muted, fontSize: 12, textAlign: "center" }}>{APP_BUILD} · podnajem.vercel.app</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TABULKA JEDNOTEK (sdílená komponenta) ─────────────────
function TabulkaJednotky({ jednotky, objekty, najemnici, smlouvy, jednotkaSmlouva, sazebnik, sazebnikPolozky, isAdmin, S, border, muted, text, isDark, fmtDate, fmtKc, fmt, aktualniSazebnik, isSmlouvaBrzy, isSmlouvaPropadla, onEditJednotka, onDeleteJednotka, onDetailSmlouva, onAddJednotka }) {
  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
      {onAddJednotka && (
        <div style={{ padding: "14px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Jednotky</span>
          {isAdmin && <button onClick={onAddJednotka} style={S.btnP}>+ Přidat jednotku</button>}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}>
              {["Dům","Typ","Číslo","Disp.","Plocha","Lodžie","Nájemník","Smlouva do","Sazba/měs","Stav",isAdmin?"Akce":""].filter(Boolean).map(h => <th key={h} style={S.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {jednotky.length === 0 && <tr><td colSpan={11} style={{ padding: "32px", textAlign: "center", color: muted }}>Žádné jednotky.</td></tr>}
            {jednotky.map(j => {
              const obj = objekty.find(o => o.id === j.objekt_id);
              const sml = jednotkaSmlouva[j.id];
              const naj = sml ? najemnici.find(n => n.id === sml.najemnik_id) : null;
              const brzy = sml && isSmlouvaBrzy(sml.datum_do);
              const propadla = sml && isSmlouvaPropadla(sml.datum_do);
              const saz = sml ? aktualniSazebnik(sml.id) : null;
              const polozky = saz ? sazebnikPolozky.filter(sp => sp.sazebnik_id === saz.id) : [];
              const celkem = polozky.reduce((s,p) => s+(Number(p.castka_kc)||0), 0);
              return (
                <tr key={j.id} style={{ borderBottom: `1px solid ${border}` }}
                  onMouseEnter={e => e.currentTarget.style.background = isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ ...S.td, color: muted, fontSize: 12 }}>{obj?.nazev || "—"}</td>
                  <td style={S.td}><span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: j.typ === "byt" ? "rgba(59,130,246,0.12)" : "rgba(255,255,255,0.06)", color: j.typ === "byt" ? "#60a5fa" : muted }}>{j.typ}</span></td>
                  <td style={{ ...S.td, fontWeight: 600 }}>{j.cislo_bytu}</td>
                  <td style={{ ...S.td, color: muted }}>{j.dispozice || "—"}</td>
                  <td style={{ ...S.td, color: muted }}>{j.plocha_m2 ? j.plocha_m2 + " m²" : "—"}</td>
                  <td style={{ ...S.td, color: muted }}>{j.lodzie_m2 ? j.lodzie_m2 + " m²" : "—"}</td>
                  <td style={S.td}>{naj ? <button onClick={() => sml && onDetailSmlouva(sml.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#60a5fa", fontSize: 13, padding: 0, textDecoration: "underline" }}>{naj.jmeno}</button> : <span style={{ color: muted }}>—</span>}</td>
                  <td style={{ ...S.td, color: propadla ? "#f87171" : brzy ? "#f59e0b" : text, fontWeight: (brzy||propadla) ? 600 : 400 }}>{sml ? fmtDate(sml.datum_do) || "neurčito" : "—"}{propadla && " ⚠️"}{brzy && !propadla && " ⏰"}</td>
                  <td style={S.td}>{celkem > 0 ? <span style={{ color: "#60a5fa", fontWeight: 600 }}>{fmtKc(celkem)}</span> : <span style={{ color: muted }}>—</span>}</td>
                  <td style={S.td}><StavBadge stav={j.stav} /></td>
                  {isAdmin && <td style={S.td}>
                    <button onClick={() => onEditJednotka({...j})} style={{ background: "none", border: "none", cursor: "pointer", color: muted, fontSize: 13, padding: "2px 4px" }}>✏️</button>
                    <button onClick={() => onDeleteJednotka(j.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", fontSize: 13, padding: "2px 4px" }}>🗑️</button>
                  </td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── HELPER KOMPONENTY ─────────────────────────────────────
function StavBadge({ stav }) {
  const map = { "obsazený": { bg: "rgba(34,197,94,0.15)", color: "#4ade80" }, "volná": { bg: "rgba(148,163,184,0.15)", color: "#94a3b8" }, "oprava": { bg: "rgba(59,130,246,0.15)", color: "#60a5fa" } };
  const c = map[stav] || map["volná"];
  return <span style={{ padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: c.bg, color: c.color }}>{stav || "—"}</span>;
}

function Modal({ title, onClose, children, surface, border, text, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI',Tahoma,sans-serif" }}>
      <div style={{ background: surface, borderRadius: 16, width: wide ? "min(680px,96vw)" : "min(480px,96vw)", maxHeight: "90vh", overflow: "auto", border: `1px solid ${border}` }}>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: surface, zIndex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: text }}>{title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(148,163,184,0.6)", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ padding: "20px 24px" }}>{children}</div>
      </div>
    </div>
  );
}

function FormRow({ label, children, muted }) {
  return <div style={{ marginBottom: 14 }}><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>{label}</label>{children}</div>;
}

function FormObjekt({ data, onChange, onSave, onCancel, S, muted }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <FormRow label="Název *" muted={muted}><input style={S.input} value={data.nazev||""} onChange={e=>onChange({...data,nazev:e.target.value})} placeholder="Palackého 12" /></FormRow>
    <FormRow label="Adresa" muted={muted}><input style={S.input} value={data.adresa||""} onChange={e=>onChange({...data,adresa:e.target.value})} /></FormRow>
    <FormRow label="Poznámka" muted={muted}><textarea style={{...S.input,resize:"vertical",minHeight:60}} value={data.poznamka||""} onChange={e=>onChange({...data,poznamka:e.target.value})} /></FormRow>
    <div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button><button onClick={()=>onSave(data)} disabled={!data.nazev} style={{flex:1,...S.btnP,opacity:data.nazev?1:0.5}}>Uložit</button></div>
  </div>;
}

function FormJednotka({ data, onChange, onSave, onCancel, objekty, S, muted, text }) {
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <FormRow label="Bytový dům *" muted={muted}><select style={S.input} value={data.objekt_id||""} onChange={e=>onChange({...data,objekt_id:e.target.value})}><option value="">— Vyberte —</option>{objekty.map(o=><option key={o.id} value={o.id}>{o.nazev}</option>)}</select></FormRow>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <FormRow label="Typ" muted={muted}><select style={S.input} value={data.typ||"byt"} onChange={e=>onChange({...data,typ:e.target.value})}>{["byt","garáž","sklep","stání","jiná"].map(t=><option key={t} value={t}>{t}</option>)}</select></FormRow>
      <FormRow label="Číslo / označení *" muted={muted}><input style={S.input} value={data.cislo_bytu||""} onChange={e=>onChange({...data,cislo_bytu:e.target.value})} placeholder="1, A, G1..." /></FormRow>
      <FormRow label="Patro" muted={muted}><input style={S.input} value={data.patro||""} onChange={e=>onChange({...data,patro:e.target.value})} /></FormRow>
      <FormRow label="Dispozice" muted={muted}><input style={S.input} value={data.dispozice||""} onChange={e=>onChange({...data,dispozice:e.target.value})} placeholder="2+kk" /></FormRow>
      <FormRow label="Plocha (m²)" muted={muted}><input style={S.input} type="number" value={data.plocha_m2||""} onChange={e=>onChange({...data,plocha_m2:e.target.value})} /></FormRow>
      <FormRow label="Lodžie (m²)" muted={muted}><input style={S.input} type="number" value={data.lodzie_m2||""} onChange={e=>onChange({...data,lodzie_m2:e.target.value})} /></FormRow>
    </div>
    <FormRow label="Stav" muted={muted}><select style={S.input} value={data.stav||"volná"} onChange={e=>onChange({...data,stav:e.target.value})}><option value="volná">Volná</option><option value="obsazený">Obsazená</option><option value="oprava">V opravě</option></select></FormRow>
    <FormRow label="Poznámka" muted={muted}><textarea style={{...S.input,resize:"vertical",minHeight:60}} value={data.poznamka||""} onChange={e=>onChange({...data,poznamka:e.target.value})} /></FormRow>
    <div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button><button onClick={()=>onSave(data)} disabled={!data.cislo_bytu||!data.objekt_id} style={{flex:1,...S.btnP,opacity:(data.cislo_bytu&&data.objekt_id)?1:0.5}}>Uložit</button></div>
  </div>;
}

function FormNajemnik({ data, onChange, onSave, onCancel, S, muted, text }) {
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <FormRow label="Jméno a příjmení *" muted={muted}><input style={S.input} value={data.jmeno||""} onChange={e=>onChange({...data,jmeno:e.target.value})} /></FormRow>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <FormRow label="Telefon" muted={muted}><input style={S.input} value={data.telefon||""} onChange={e=>onChange({...data,telefon:e.target.value})} /></FormRow>
      <FormRow label="Email" muted={muted}><input style={S.input} type="email" value={data.email||""} onChange={e=>onChange({...data,email:e.target.value})} /></FormRow>
      <FormRow label="Datum narození" muted={muted}><input style={S.input} value={data.datum_narozeni||""} onChange={e=>onChange({...data,datum_narozeni:e.target.value})} /></FormRow>
      <FormRow label="Číslo OP" muted={muted}><input style={S.input} value={data.cislo_op||""} onChange={e=>onChange({...data,cislo_op:e.target.value})} /></FormRow>
    </div>
    <FormRow label="Poznámka" muted={muted}><textarea style={{...S.input,resize:"vertical",minHeight:60}} value={data.poznamka||""} onChange={e=>onChange({...data,poznamka:e.target.value})} /></FormRow>
    <div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button><button onClick={()=>onSave(data)} disabled={!data.jmeno} style={{flex:1,...S.btnP,opacity:data.jmeno?1:0.5}}>Uložit</button></div>
  </div>;
}

function FormSmlouva({ data, onChange, onSave, onCancel, najemnici, jednotky, objekty, S, muted, text, border, isDark }) {
  const toggleJednotka = (jid) => {
    const ids = data.jednotky_ids || [];
    onChange({ ...data, jednotky_ids: ids.includes(jid) ? ids.filter(x => x !== jid) : [...ids, jid] });
  };
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <FormRow label="Nájemník *" muted={muted}><select style={S.input} value={data.najemnik_id||""} onChange={e=>onChange({...data,najemnik_id:e.target.value})}><option value="">— Vyberte —</option>{najemnici.map(n=><option key={n.id} value={n.id}>{n.jmeno}</option>)}</select></FormRow>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <FormRow label="Datum od *" muted={muted}><input style={S.input} type="date" value={data.datum_od||""} onChange={e=>onChange({...data,datum_od:e.target.value})} /></FormRow>
      <FormRow label="Datum do" muted={muted}><input style={S.input} type="date" value={data.datum_do||""} onChange={e=>onChange({...data,datum_do:e.target.value})} /></FormRow>
      <FormRow label="Kauce (Kč)" muted={muted}><input style={S.input} type="number" value={data.kauce_kc||""} onChange={e=>onChange({...data,kauce_kc:e.target.value})} /></FormRow>
      <div style={{display:"flex",flexDirection:"column",justifyContent:"flex-end",paddingBottom:2}}>
        <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:text}}><input type="checkbox" checked={data.kauce_zaplacena||false} onChange={e=>onChange({...data,kauce_zaplacena:e.target.checked})} /> Kauce zaplacena</label>
      </div>
    </div>
    <FormRow label="Jednotky v smlouvě" muted={muted}>
      <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:200,overflowY:"auto"}}>
        {jednotky.map(j => { const o = objekty.find(x=>x.id===j.objekt_id); const checked = (data.jednotky_ids||[]).includes(j.id); return (
          <label key={j.id} style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:text,padding:"4px 0"}}>
            <input type="checkbox" checked={checked} onChange={()=>toggleJednotka(j.id)} />
            {o?.nazev ? `${o.nazev} / ` : ""}{j.cislo_bytu} ({j.typ}){j.plocha_m2 ? `, ${j.plocha_m2} m²` : ""}
          </label>
        ); })}
      </div>
    </FormRow>
    <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:text}}><input type="checkbox" checked={data.email_notifikace!==false} onChange={e=>onChange({...data,email_notifikace:e.target.checked})} /> Posílat email notifikace</label>
    <FormRow label="Poznámka" muted={muted}><textarea style={{...S.input,resize:"vertical",minHeight:60}} value={data.poznamka||""} onChange={e=>onChange({...data,poznamka:e.target.value})} /></FormRow>
    <div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button><button onClick={()=>onSave(data)} disabled={!data.najemnik_id||!data.datum_od} style={{flex:1,...S.btnP,opacity:(data.najemnik_id&&data.datum_od)?1:0.5}}>Uložit</button></div>
  </div>;
}

function FormDodatek({ data, onChange, onSave, onCancel, S, muted, text }) {
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <FormRow label="Datum dodatku" muted={muted}><input style={S.input} type="date" value={data.datum||""} onChange={e=>onChange({...data,datum:e.target.value})} /></FormRow>
      <FormRow label="Typ" muted={muted}><select style={S.input} value={data.typ||"jiné"} onChange={e=>onChange({...data,typ:e.target.value})}><option value="prodloužení">Prodloužení smlouvy</option><option value="změna sazby">Změna sazby</option><option value="jiné">Jiné</option></select></FormRow>
    </div>
    {data.typ === "prodloužení" && <FormRow label="Nové datum do" muted={muted}><input style={S.input} type="date" value={data.nove_datum_do||""} onChange={e=>onChange({...data,nove_datum_do:e.target.value})} /></FormRow>}
    <FormRow label="Poznámka" muted={muted}><textarea style={{...S.input,resize:"vertical",minHeight:80}} value={data.poznamka||""} onChange={e=>onChange({...data,poznamka:e.target.value})} placeholder="Popis změny..." /></FormRow>
    <div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button><button onClick={()=>onSave(data)} disabled={!data.datum} style={{flex:1,...S.btnP,opacity:data.datum?1:0.5}}>Uložit</button></div>
  </div>;
}

function FormSazebnik({ data, onChange, onSave, onCancel, S, muted, text, border }) {
  const addPolozka = () => onChange({ ...data, polozky: [...(data.polozky||[]), { nazev: "", castka_kc: 0, typ: "záloha" }] });
  const removePolozka = (i) => onChange({ ...data, polozky: data.polozky.filter((_,idx)=>idx!==i) });
  const updatePolozka = (i, field, val) => onChange({ ...data, polozky: data.polozky.map((p,idx)=>idx===i?{...p,[field]:val}:p) });
  const celkem = (data.polozky||[]).reduce((s,p)=>s+(Number(p.castka_kc)||0),0);
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <FormRow label="Platné od *" muted={muted}><input style={S.input} type="date" value={data.platne_od||""} onChange={e=>onChange({...data,platne_od:e.target.value})} /></FormRow>
      <FormRow label="Poznámka (důvod změny)" muted={muted}><input style={S.input} value={data.poznamka||""} onChange={e=>onChange({...data,poznamka:e.target.value})} placeholder="např. zdražení energií" /></FormRow>
    </div>
    <div>
      <div style={{fontSize:12,color:muted,marginBottom:8,fontWeight:600}}>Položky sazebníku</div>
      {(data.polozky||[]).map((p,i) => (
        <div key={i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
          <input style={{...S.input,flex:2}} value={p.nazev} onChange={e=>updatePolozka(i,"nazev",e.target.value)} placeholder="Název položky" />
          <input style={{...S.input,width:110}} type="number" value={p.castka_kc||""} onChange={e=>updatePolozka(i,"castka_kc",e.target.value)} placeholder="Kč" />
          <select style={{...S.input,width:100}} value={p.typ||"záloha"} onChange={e=>updatePolozka(i,"typ",e.target.value)}><option value="najem">nájem</option><option value="záloha">záloha</option><option value="jiné">jiné</option></select>
          <button onClick={()=>removePolozka(i)} style={{...S.btnD,padding:"6px 10px",fontSize:12}}>✕</button>
        </div>
      ))}
      <button onClick={addPolozka} style={{...S.btnS,fontSize:12,padding:"6px 16px"}}>+ Přidat položku</button>
      {celkem > 0 && <div style={{marginTop:10,padding:"8px 14px",background:"rgba(59,130,246,0.1)",borderRadius:8,fontSize:13,fontWeight:600,color:"#60a5fa"}}>Celkem: {celkem.toLocaleString("cs-CZ")} Kč/měs</div>}
    </div>
    <div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button><button onClick={()=>onSave(data)} disabled={!data.platne_od} style={{flex:1,...S.btnP,opacity:data.platne_od?1:0.5}}>Uložit sazebník</button></div>
  </div>;
}

function FormPlatba({ data, onChange, onSave, onCancel, S, muted, text, border, fmtKc }) {
  const celkemPredpis = (data.polozky||[]).reduce((s,p)=>s+(Number(p.castka_predpis_kc||p.predpis_kc)||0),0);
  const celkemZapl = (Number(data.banka_kc)||0)+(Number(data.hotove_kc)||0)+(Number(data.doplatek_kc)||0);
  const rozdil = celkemZapl - celkemPredpis + (Number(data.srazky_kc)||0);
  return <div style={{display:"flex",flexDirection:"column",gap:16}}>
    {data.polozky?.length > 0 && <div>
      <div style={{fontSize:12,color:muted,marginBottom:8,fontWeight:600}}>PŘEDPIS — položky</div>
      {data.polozky.map((pp,i) => (
        <div key={pp.id||i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
          <span style={{fontSize:13,color:text,flex:1}}>{pp.nazev}</span>
          <input style={{...S.input,width:120}} type="number" value={pp.castka_predpis_kc||pp.predpis_kc||""} onChange={e=>onChange({...data,polozky:data.polozky.map((p,j)=>j===i?{...p,castka_predpis_kc:e.target.value}:p)})} />
          <span style={{fontSize:12,color:muted}}>Kč</span>
        </div>
      ))}
      <div style={{fontSize:13,fontWeight:600,color:text}}>Celkem předpis: {celkemPredpis.toLocaleString("cs-CZ")} Kč</div>
    </div>}
    <div style={{borderTop:`1px solid ${border}`,paddingTop:14}}>
      <div style={{fontSize:12,color:muted,marginBottom:8,fontWeight:600}}>PLATBA</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <FormRow label="Datum platby" muted={muted}><input style={S.input} type="date" value={data.datum_platby||""} onChange={e=>onChange({...data,datum_platby:e.target.value})} /></FormRow>
        <div></div>
        <FormRow label="Banka (Kč)" muted={muted}><input style={S.input} type="number" value={data.banka_kc||""} onChange={e=>onChange({...data,banka_kc:e.target.value})} /></FormRow>
        <FormRow label="Hotově (Kč)" muted={muted}><input style={S.input} type="number" value={data.hotove_kc||""} onChange={e=>onChange({...data,hotove_kc:e.target.value})} /></FormRow>
        <FormRow label="Doplatek (Kč)" muted={muted}><input style={S.input} type="number" value={data.doplatek_kc||""} onChange={e=>onChange({...data,doplatek_kc:e.target.value})} /></FormRow>
        <FormRow label="Srážka (Kč)" muted={muted}><input style={S.input} type="number" value={data.srazky_kc||""} onChange={e=>onChange({...data,srazky_kc:e.target.value})} /></FormRow>
        <FormRow label="Nedoplatek energií (Kč)" muted={muted}><input style={S.input} type="number" value={data.nedoplatek_energie_kc||""} onChange={e=>onChange({...data,nedoplatek_energie_kc:e.target.value})} /></FormRow>
        <FormRow label="Jiné platby (Kč)" muted={muted}><input style={S.input} type="number" value={data.jine_platby_kc||""} onChange={e=>onChange({...data,jine_platby_kc:e.target.value})} /></FormRow>
      </div>
      <div style={{padding:"10px 14px",borderRadius:8,background:rozdil>=0?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)",fontSize:13,fontWeight:600,color:rozdil>=0?"#4ade80":"#f87171"}}>
        {rozdil>=0?"✓ Přeplatek: ":"✗ Dluh: "}{Math.abs(rozdil).toLocaleString("cs-CZ")} Kč
      </div>
    </div>
    <FormRow label="Poznámka" muted={muted}><textarea style={{...S.input,resize:"vertical",minHeight:60}} value={data.poznamka||""} onChange={e=>onChange({...data,poznamka:e.target.value})} /></FormRow>
    <div style={{display:"flex",gap:10}}><button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button><button onClick={()=>onSave(data)} style={{flex:1,...S.btnP}}>Uložit platbu</button></div>
  </div>;
}

function FormVyuctovani({ data, onChange, onSave, onCancel, S, muted, text }) {
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <FormRow label="Datum" muted={muted}><input style={S.input} type="date" value={data.datum||""} onChange={e=>onChange({...data,datum:e.target.value})} /></FormRow>
      <FormRow label="Typ" muted={muted}>
        <select style={S.input} value={data.typ||"nedoplatek"} onChange={e=>onChange({...data,typ:e.target.value})}>
          <option value="nedoplatek">Nedoplatek</option>
          <option value="přeplatek">Přeplatek</option>
        </select>
      </FormRow>
      <FormRow label="Částka (Kč)" muted={muted}><input style={S.input} type="number" value={data.castka_kc||""} onChange={e=>onChange({...data,castka_kc:e.target.value})} placeholder="0" /></FormRow>
      <FormRow label="Popis" muted={muted}><input style={S.input} value={data.popis||""} onChange={e=>onChange({...data,popis:e.target.value})} placeholder="např. Eon 2024" /></FormRow>
    </div>
    <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:text}}>
      <input type="checkbox" checked={data.uhrazeno||false} onChange={e=>onChange({...data,uhrazeno:e.target.checked})} /> Uhrazeno
    </label>
    {data.uhrazeno && <FormRow label="Datum úhrady" muted={muted}><input style={S.input} type="date" value={data.datum_uhrazeni||""} onChange={e=>onChange({...data,datum_uhrazeni:e.target.value})} /></FormRow>}
    <div style={{display:"flex",gap:10,marginTop:8}}>
      <button onClick={onCancel} style={{flex:1,...S.btnS}}>Zrušit</button>
      <button onClick={()=>onSave(data)} disabled={!data.datum||!data.castka_kc} style={{flex:1,...S.btnP,opacity:(data.datum&&data.castka_kc)?1:0.5}}>Uložit</button>
    </div>
  </div>;
}

function LoginScreen({ isDark, onLogin, onMagicLink, S, surface, border, text, muted, bg }) {
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
      <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 16, padding: "40px 36px", width: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🏠</div>
          <h1 style={{ color: text, margin: 0, fontSize: 22, fontWeight: 700 }}>Podnájem</h1>
          <p style={{ color: muted, margin: "6px 0 0", fontSize: 13 }}>Evidence podnájmů</p>
        </div>
        {magicSent ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📧</div>
            <p style={{ color: text, fontWeight: 600 }}>Email odeslán!</p>
            <p style={{ color: muted, fontSize: 13, marginTop: 8 }}>Klikněte na odkaz v emailu.</p>
            <button onClick={() => { setMagicSent(false); setMode("password"); }} style={{ ...S.btnP, marginTop: 20, width: "100%" }}>Zpět</button>
          </div>
        ) : (<>
          <div style={{ display: "flex", background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", borderRadius: 8, padding: 3, marginBottom: 20 }}>
            {[["password","Heslo"],["magic","Magic link"]].map(([m,l]) => (
              <button key={m} onClick={() => { setMode(m); setErr(""); }} style={{ flex: 1, padding: "7px 0", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", background: mode===m?(isDark?"#1e40af":"#2563eb"):"transparent", color: mode===m?"#fff":muted, fontFamily: "inherit" }}>{l}</button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Email</label><input style={S.input} type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} /></div>
            {mode === "password" && <div><label style={{ fontSize: 12, color: muted, display: "block", marginBottom: 5 }}>Heslo</label><input style={S.input} type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} /></div>}
            {err && <div style={{ color: "#f87171", fontSize: 13, background: "rgba(239,68,68,0.1)", padding: "8px 12px", borderRadius: 7 }}>{err}</div>}
            <button onClick={handleSubmit} disabled={loading||!email||(mode==="password"&&!password)} style={{ ...S.btnP, width: "100%", opacity: (loading||!email||(mode==="password"&&!password))?0.6:1 }}>
              {loading ? "Přihlašuji..." : mode==="magic" ? "Odeslat magic link" : "Přihlásit se"}
            </button>
          </div>
        </>)}
      </div>
    </div>
  );
}
