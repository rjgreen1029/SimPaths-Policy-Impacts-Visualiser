/**
 * App.js — Top-level page: header banner, intro/"about" card, sidebar +
 * main visualisation area (delegated to DashboardSection), and the closing
 * credit/citation/feedback banner.
 *
 * App owns:
 *   - The dataset itself (`parsedCache`) — either the bundled default CSV
 *     (fetched on mount) or a user's own uploaded folder (via
 *     localFolderParser.js, triggered from the Connect Data panel).
 *   - Which variable is currently selected (`activeVariable`) — everything
 *     downstream (DashboardSection and its charts) is driven off this.
 *   - Responsive layout state (window width → mobile/tablet breakpoints).
 *
 * It does NOT own any chart rendering or data-filtering logic — that lives
 * in DashboardSection.js and useAggregatedData.js respectively. App.js's
 * job is page chrome + data sourcing, not visualisation.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as d3 from "d3";
import { csvParse } from "./csvParse.js";
import FolderStructureHelp from "./FolderStructureHelp";
import AggregateDataPanel from "./AggregateDataPanel";
import { downloadWorkbook } from "./datasetExport";
import { normaliseAggregateRows, comparisonLabel, sourceText, ComparisonNamesContext } from "./aggregateDataSource";
import DashboardSection from "./DashboardSection";
import ScenarioGraphic from "./ScenarioGraphic";
import StaticPage from "./StaticPage";
import { DatasetPage, ResourcesPage } from "./InfoPages";
import { VARIABLE_DESCRIPTIONS, BENEFIT_UNIT_NOTES, BENEFIT_UNIT_DEFINITION } from "./variableInfo";
import { parseCsvRow, titleCase } from "./useAggregatedData";
import { parseLocalFolder } from "./localFolderParser";

/** Top navigation tabs. Each has its own URL (#/id) so links can be shared and
 *  the browser's back button works. */
const TABS = [
  { id: "home",                 label: "Visualiser" },   // id stays "home" so existing links keep working
  { id: "dataset",              label: "Dataset" },
  { id: "interpreting-results", label: "Interpreting Results" },
  { id: "citation",             label: "Citation" },
  { id: "funders",              label: "Funders & Partners" },
  { id: "resources",            label: "More Resources" },
];
const tabFromHash = () => {
  const id = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#\/?/, "");
  // The visualiser is now on the Home page, so old "#/visualiser" links open Home.
  return TABS.some(t => t.id === id) ? id : "home";
};

/** Which variables appear under each of the four topic-chip domains in the intro card, and their display order within that domain. */
const DOMAIN_SECTIONS = {
  "Demographics": [
    "Highest Level of Education", "Ethnicity", "Partnership status",
    "Population Pyramid", "Population size",
      "Household Type", // ,"Number of children"
  ],
  "Activity status": ["Employment status", "Hours worked"],
  "Income": [
    "Income Quintile", "Universal Credit Benefits Flag", "Financial distress flag",
    "Equivalised yearly disposable income", "Hourly earnings",  "Personal private pension income",
     "Gross personal employment income", 
    "Capital Income", 
    "Amount of benefits received per month"
  ],
  "Health": [
    // "Self-Rated Health", // temporarily disabled
    "Disability Status",
    // "Psychological distress flag", // temporarily disabled
    "Psychological distress score", "Mental Component Summary (MCS)", "Physical Component Summary (PCS)", "Life Satisfaction Score",
    "Subjective wellbeing (GHQ)", "Received care", "Provided care",
  ]
};

/** One-line subtitle shown under each domain's topic chip in the intro card. */
const DOMAIN_BLURBS = {
  "Demographics": "Education, ethnicity, household make-up",
  "Activity status": "Employment and working hours",
  "Income": "Earnings, benefits, income quintiles",
  "Health": "Disability, wellbeing, life satisfaction",
};


/** Adds a small ⓘ after the first "benefit unit" in a description; hovering
 *  (or focusing) it shows what a benefit unit is. */
function withBenefitUnitInfo(text) {
  const m = /benefit unit/i.exec(text || "");
  if (!m) return text;
  const end = m.index + m[0].length;
  return (<>
    {text.slice(0, end)}
    <InfoTip label="Benefit unit" text={BENEFIT_UNIT_DEFINITION}/>
    {text.slice(end)}
  </>);
}

/** Small circled "i" that shows a definition straight away on hover, keyboard
 *  focus or tap (the browser's own title tooltip is slow and unreliable). */
function InfoTip({ label, text }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-block", verticalAlign: "1px" }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span tabIndex={0} role="button" aria-label={`What is a ${label.toLowerCase()}?`} aria-expanded={open}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, margin: "0 2px 0 4px", borderRadius: "50%", border: "1.5px solid #6095DA", color: "#1d2d41", fontSize: 10, fontStyle: "normal", fontWeight: 700, cursor: "help" }}>i</span>
      {open && (
        <span role="tooltip"
          style={{ position: "absolute", left: "50%", top: "calc(100% + 6px)", transform: "translateX(-50%)", zIndex: 50, width: 280, padding: "10px 12px", background: "rgba(15,23,42,0.95)", color: "#f8fafc", borderRadius: 8, fontSize: 12.5, fontStyle: "normal", lineHeight: 1.5, boxShadow: "0 4px 16px rgba(96,149,218,0.4)", whiteSpace: "normal" }}>
          <strong>{label}:</strong> {text}
        </span>
      )}
    </span>
  );
}


/** The full-dataset download: an .xlsx workbook with an "About" sheet first,
 *  then every aggregated estimate currently loaded (see datasetExport.js). */
function downloadFullDataset(rows, names, shownLabel) {
  return downloadWorkbook(rows, r => comparisonLabel(r.scenario, names), {
    filename: "SimPaths_aggregated_outputs.xlsx",
    title: "SimPaths Policy Impacts Visualiser — aggregated outputs",
    info: [["Data", shownLabel]],
    notes: ["The Data sheet holds every aggregated estimate in the visualiser. Each row is one estimate (a mean or a proportion) for one year, scenario, variable and population group, averaged across several SimPaths model runs."],
  });
}

/**
 * Top-level page component. See the file header above for what it owns vs.
 * delegates. Renders either a "screen too small" notice (below MIN_WIDTH),
 * or the full page: header banner → intro card → sidebar + DashboardSection
 * → closing banner.
 */
function App({ dataSource } = {}) {
  const [activeVariable, setActiveVariable]   = useState("Highest Level of Education");
  const [tab, setTab] = useState(tabFromHash);   // which top tab is showing
  // Follow the URL (#/id), so back/forward and shared links land on the right tab.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  /** Switch tab (updates the URL too) and scroll back to the top of the page.
   *  "visualiser" opens Home and scrolls down to the visualiser (Connect Data). */
  const navigate = useCallback((id) => {
    const toVis = id === "visualiser";
    if (toVis) id = "home";
    if (window.location.hash !== `#/${id}`) window.location.hash = `/${id}`;
    setTab(id);
    if (toVis) setTimeout(() => connectDataRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    else window.scrollTo({ top: 0 });
  }, []);
  const [parsedCache,    setParsedCache]       = useState([]);       // full dataset — default CSV or user upload, normalised to one row shape
  const [isUsingDefault, setIsUsingDefault]   = useState(true);      // true = showing bundled default data, false = user-uploaded folder
  const [defaultLoadFailed, setDefaultLoadFailed] = useState(false); // true = the default CSV fetch/parse failed — distinct from isUsingDefault, which alone can't tell success from failure
  const [statusMessage,  setStatusMessage]    = useState("");        // loading/error text shown near the Connect Data panel
  const [isProcessing,   setIsProcessing]     = useState(false);     // true while a local folder is being read/aggregated
  // A supplied source is controlled by its host, even while empty/loading.
  // It never falls back to default CSVs or performs an API request itself.
  const hasDataSource = dataSource != null;
  const sourceIsObject = typeof dataSource === "object" && !Array.isArray(dataSource);
  const suppliedRows = dataSource?.rows;
  // Optional intent hints are best-effort; they never change the active chart.
  function hintVariable(variable) {
    try { dataSource?.viewSource?.hint?.({variable}); } catch {}
  }
  function cancelHint() {
    try { dataSource?.viewSource?.cancelHint?.(); } catch {}
  }
  const connectedData = useMemo(() => {
    if (!hasDataSource) return { rows: [], error: "" };
    try {
      if (!sourceIsObject) throw new TypeError("Expected a data source object.");
      return { rows: normaliseAggregateRows(suppliedRows === undefined ? [] : suppliedRows), error: "" };
    } catch {
      return { rows: [], error: "Connected aggregate data could not be displayed. Ask the data source to supply chart-ready aggregate rows." };
    }
  }, [hasDataSource, sourceIsObject, suppliedRows]);
  const displayedRows = hasDataSource ? connectedData.rows : parsedCache;
  const sourceRef = useRef(dataSource);
  useEffect(() => { sourceRef.current = dataSource; }, [dataSource]);
  const requestGeneration = useRef(0);
  const [openDomains, setOpenDomains] = useState({ "Demographics": true }); // which sidebar domain accordions are expanded
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  // Only truly unusable widths (older feature-phone-class viewports) get the
  // "too small" message — everything from a modern phone upward gets a real,
  // responsive layout instead of being turned away.
  const MIN_WIDTH = 320;
  const isMobile = windowWidth < 640;
  const isTablet = windowWidth < 1200;

  /**
   * Fetches + parses the bundled default CSV. Shared by the initial mount
   * effect, the "reset to default" action (the ✕ next to "Currently
   * displaying: user uploaded data"), and the "Retry" button shown on
   * failure — all three now behave identically rather than having their own
   * slightly-different copies of this logic.
   *
   * Deliberately surfaces failures in the UI itself (exact URL attempted +
   * the underlying error message, right there in statusMessage) rather than
   * only logging to the console — this is what previously made a failed
   * fetch hard to tell apart from a successful one, since the "Currently
   * displaying: preloaded data" label used to show regardless of whether
   * the fetch actually succeeded.
   *
   * Uses PUBLIC_URL so the request resolves correctly whether the app is
   * running locally at the domain root or deployed under a GitHub Pages
   * project subpath (see package.json's "homepage" field) — PUBLIC_URL is
   * "" in development and only takes on the homepage's path once actually
   * built via `npm run build`.
   */
  const [isLoadingDefault, setIsLoadingDefault] = useState(true);

  const loadDefaultDataset = useCallback(() => {
    if (sourceRef.current != null) return;
    const generation = ++requestGeneration.current;
    setIsProcessing(false);
    setParsedCache([]);
    const url = `${process.env.PUBLIC_URL}/SimPaths_All_Aggregated_Outputs.csv`;
    setDefaultLoadFailed(false);
    setIsLoadingDefault(true);
    setStatusMessage("Loading default dataset…");
    d3.text(url)
      .then(text => csvParse(text, parseCsvRow))
      .then(rows => {
        if (generation !== requestGeneration.current || sourceRef.current != null) return;
        if (!rows.length) throw new Error("File was found but contained no rows — check it's the actual CSV and not an HTML/error page being served at that URL.");
        setParsedCache(rows);
        setIsUsingDefault(true);
        setDefaultLoadFailed(false);
        setStatusMessage("");
      })
      .catch(err => {
        if (generation !== requestGeneration.current || sourceRef.current != null) return;
        console.warn("Could not load the default dataset.", err);
        setIsUsingDefault(true);
        setDefaultLoadFailed(true);
        setParsedCache([]);
        setStatusMessage(
          `Could not load the default dataset from "${url}" (${err.message || "fetch failed"}). ` +
          `Check that SimPaths_All_Aggregated_Outputs.csv exists at exactly that path in your deployment's public folder — or select a simulation directory below.`
        );
      })
      .finally(() => {
        if (generation === requestGeneration.current && sourceRef.current == null) setIsLoadingDefault(false);
      });
  }, []);

  // Connected sources never request the bundled dataset. Fence stale loads.
  useEffect(() => {
    const requests = requestGeneration;
    requests.current++;
    if (!hasDataSource) loadDefaultDataset();
    return () => { requests.current++; };
  }, [hasDataSource, loadDefaultDataset]);

  // Tracks window width for the mobile/tablet responsive breakpoints above.
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  /**
   * "Visualise Locally Saved Data" handler — opens the native folder picker.
   */
  const handleSelectFolder = async () => {
    let generation = requestGeneration.current;
    try {
      const directoryHandle = await window.showDirectoryPicker();
      if (generation !== requestGeneration.current || sourceRef.current != null) return;
      generation = ++requestGeneration.current;
      setIsProcessing(true);
      setStatusMessage("Reading local folder hierarchy...");
      const freshlyAggregated = await parseLocalFolder(directoryHandle, msg => {
        if (generation === requestGeneration.current && sourceRef.current == null) setStatusMessage(msg);
      });
      if (generation !== requestGeneration.current || sourceRef.current != null) return;
      if (!Array.isArray(freshlyAggregated)) throw new Error("Aggregation returned no data.");
      setParsedCache(freshlyAggregated);
      setIsUsingDefault(false);
      setDefaultLoadFailed(false);
      setIsProcessing(false);
      setStatusMessage("");
    } catch (err) {
      if (generation !== requestGeneration.current || sourceRef.current != null) return;
      console.error(err);
      setIsProcessing(false);
      setStatusMessage(
        err.name === "AbortError"
          ? ""
          : `Aggregation Error: ${err.message || "Check folder tree construction."}`
      );
    }
  };

  /** Expands/collapses one domain's accordion in the sidebar variable picker. */
  const toggleDomain = (domain) => {
    setOpenDomains(prev => ({ ...prev, [domain]: !prev[domain] }));
  };

  const mainVizRef = useRef(null);
  const connectDataRef = useRef(null);   // the Connect Data panel (start of the visualiser)
  /** Selects a domain's first variable and scrolls the main visualisation into view — used by the intro card's topic chips as a "jump straight to this domain" shortcut. */
  const jumpToDomain = (domain) => {
    const firstVar = DOMAIN_SECTIONS[domain]?.[0];
    if (firstVar) setActiveVariable(firstVar);
    setOpenDomains(prev => ({ ...prev, [domain]: true }));
    mainVizRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ─── Design tokens ─────────────────────────────────────────────────────────
  // Shared across App.js, PasscodeGate.js, and the two static HTML pages
  // (interpreting-results.html / citation.html) — if you change these, update
  // all four places to keep the "in progress" gate, dashboard, and standalone
  // docs pages visually consistent.
  // SimPaths-style look: white page, pale blue header/footer, a PMH → SimPaths
  // gradient stripe, blue for things you click and orange for what you're
  // looking at. Chart colours are set separately (useAggregatedData.js).
  const BG       = "#ffffff";
  const BG_DARK  = "#ffffff";
  const BG_PANEL = "#d4e2f3";   // hairlines and card outlines (pale SimPaths blue)
  // Header and footer: pale SimPaths blue with dark navy text and a thin
  // blue line. BLUE is the SimPaths logo blue (#6095DA). It is too light for
  // text (3.1:1 on white), so it is used for fills, pills, underlines, borders
  // and charts, and the text with it is navy (TEAL below, 13:1 on white).
  const HEAD_BG   = "#f4f8fd";  // header/footer background
  const HEAD_LINE = "#d4e2f3";  // hairline under the header / above the footer
  const HEAD_INK  = "#1d2d41";  // text on the pale blue (13:1)
  const TAB_BLUE  = "#4d77ae";  // logo blue #6095DA + 20% black: active tab pill (white text on it 4.6:1)
  // Ribbon under the header and above the footer: Policy Modelling for Health's
  // gradient (yellow → coral) running into SimPaths' (pink → plum → blue).
  const STRIPE    = "linear-gradient(90deg,#f0cc60 0%,#f0b454 14%,#f09054 28%,#fc6048 42%,#D23A5F 56%,#972A6C 70%,#7C36A6 84%,#6095DA 100%)";
  const TEAL     = "#1d2d41";   // text that used to be teal: navy
  const AQUA = "#6095DA";        // SimPaths logo blue (decoration only, not text)
  const CORAL    = "#ff5d51";
  const INDIGO   = "#5975f8";
  const DOMAIN_COLORS = { "Demographics": TEAL, "Activity status": AQUA, "Income": CORAL, "Health": INDIGO };
  const TEXT_DARK = "#1e293b";
  const TEXT_MID  = "#475569";
  const linkBtnStyle = { color: AQUA, textDecoration: "none", fontSize: "14px", padding: "10px 14px", background: `${AQUA}10`, borderRadius: "6px", border: `1px solid ${AQUA}30`, transition: "all 0.2s", display: "inline-flex", alignItems: "center", fontWeight: 500 };
  // Compact pill variant used inline next to the "Explore changes across..." text
  const smallLinkStyle = { color: AQUA, textDecoration: "none", fontSize: "12px", padding: "5px 10px", background: `${AQUA}10`, borderRadius: "6px", border: `1px solid ${AQUA}30`, transition: "all 0.2s", display: "inline-flex", alignItems: "center", fontWeight: 500, whiteSpace: "nowrap" };
  // "Increased Education vs Baseline" — the scenarios in the data on show.
  const shownScenarios = useMemo(() => {
    const roles = [...new Set(displayedRows.map(r => r.scenario))].filter(r => r && r !== "baseline");
    if (!roles.length) return "";
    const names = hasDataSource ? dataSource.names : undefined;
    return `${roles.map(r => comparisonLabel(r, names)).join(", ")} vs ${comparisonLabel("baseline", names)}`;
  }, [displayedRows, hasDataSource, dataSource]);
  const shownLabel = `${hasDataSource ? "Connected data" : isUsingDefault ? "Preloaded data" : "Your data"}${shownScenarios ? `: ${shownScenarios}` : ""}`;
  const downloadButton = displayedRows.length > 0 && (<>
    <button type="button" onClick={() => downloadFullDataset(displayedRows, hasDataSource ? dataSource.names : undefined, shownLabel)}
      title="Every aggregated estimate currently loaded, as an .xlsx file whose first sheet explains each column. Estimates based on fewer than 20 people in a model run are left blank."
      style={{ alignSelf: "flex-start", padding: "6px 12px", borderRadius: 6, border: `1px solid ${AQUA}`, background: "#fff", color: TEAL, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
      ↓ Download full dataset (.xlsx)
    </button>
  </>);
  // Connect Data: stack the two panels on narrow screens.
  const stackConnect = windowWidth < 800;
  // Home page drop-down sections (both start closed).
  const [homeOpen, setHomeOpen] = useState({ howto: false, scenario: false, limits: false });
  const toggleHomeSection = key => setHomeOpen(o => ({ ...o, [key]: !o[key] }));
  /** "The default view: education policy scenario" drop-down, in the intro
   *  card on the Home page. */
  const renderDefaultViewSection = key => (<>
  <button type="button" onClick={() => toggleHomeSection(key)} aria-expanded={!!homeOpen[key]} aria-controls={`home-${key}`}
    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${BG_PANEL}`, padding: "8px 2px", margin: "2px 0 6px", cursor: "pointer", fontFamily: "inherit" }}>
    <span style={{ fontSize: 13, color: TEAL, display: "inline-block", transition: "transform 0.2s", transform: homeOpen[key] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
    <span style={{ fontSize: "clamp(18px, 2.4vw, 21px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.2px" }}>{hasDataSource ? "About this experiment" : "The default view: education policy scenario"}</span>
  </button>
  {homeOpen[key] && (<div id={`home-${key}`}>
  <div style={{ background: `${AQUA}08`, border: `1px solid ${AQUA}20`, borderRadius: "8px", padding: isMobile ? "16px" : "18px", marginBottom: "18px", borderLeft: `4px solid ${AQUA}` }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "18px", alignItems: "flex-start", marginBottom: "10px" }}>
  
  {/* Left column: both paragraphs */}
  <div style={{ flex: "1 1 320px", minWidth: 0 }}>
    <p style={{ margin: 0, lineHeight: 1.6, color: TEXT_MID, fontSize: "15.5px" }}>
      {hasDataSource ? sourceText(dataSource.description, "Explore the pre-aggregated results supplied by the connected service.") : <>
      The default view displays a pre-aggregated dataset showing a simulated education policy intervention applied to 16–29 year olds from 2025, compared against a <strong>Baseline</strong> with no policy change. The <strong>Increased Education Scenario</strong> increases the proportion of 16–29 year olds in education by 5%.
      </>}
    </p>
    <p style={{ margin: "16px 0 0", lineHeight: 1.6, color: TEXT_MID, fontSize: "15.5px" }}>
      To use your own data, SimPaths outputs must be organised into <strong>Baseline</strong> and <strong>Scenario</strong> folders, each containing the runs from your model output. Use "Visualise Locally Saved Data" to select the parent folder that your <strong>Baseline</strong> and <strong>Scenario</strong> folders sit within.
      <br /><br />
      {hasDataSource ? "Connected results are supplied by the host service." : "Local files are processed in your browser."}
    </p>
  </div>

  {/* Right column: graphic */}
  {!hasDataSource && <div style={{ flex: "1 1 340px", minWidth: 0 }}>
    <ScenarioGraphic isMobile={isMobile || windowWidth < 1200} />
  </div>}

</div>
  </div>
  </div>)}
  </>);


  if (windowWidth < MIN_WIDTH) {
    return (
      <div style={{
        fontFamily: "Inter, system-ui, sans-serif",
        minHeight: "100vh",
        background: BG,
        color: TEXT_DARK,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px"
      }}>
        <div style={{
          background: BG_DARK,
          border: `2px solid ${CORAL}`,
          borderRadius: "12px",
          padding: "40px",
          maxWidth: "500px",
          textAlign: "center",
          boxShadow: "0 4px 6px rgba(96,149,218,0.16)"
        }}>
          <h1 style={{ color: CORAL, fontSize: "28px", margin: "0 0 16px" }}>Screen Too Small</h1>
          <p style={{ fontSize: "16px", color: TEXT_MID, lineHeight: "1.6", margin: "0 0 20px" }}>
            Your screen is narrower than this dashboard can display. Please widen your browser window or rotate your device.
          </p>
          <p style={{ fontSize: "14px", color: "#64748b", margin: "0" }}>
            Current width: <strong>{windowWidth}px</strong>
          </p>
        </div>
      </div>
    );
  }

  return (
    <ComparisonNamesContext.Provider value={hasDataSource ? dataSource.names || {} : {}}>
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", minHeight: "100vh", background: BG, color: TEXT_DARK, display: "flex", flexDirection: "column", gap: 30 }}>
      
      {/* ── Header: pale blue bar with the SimPaths logo, title and tabs ── */}
      <header style={{ background: HEAD_BG }}>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: isMobile ? "8px 14px" : "10px 24px", padding: isMobile ? "10px 16px" : "10px 48px", minHeight: 60, boxSizing: "border-box" }}>
          <img src={`${process.env.PUBLIC_URL}/SimPaths-logo-transparent.png`} alt="SimPaths logo"
            style={{ height: isMobile ? 26 : 32, width: "auto", display: "block" }} />
          <p style={{ margin: 0, color: HEAD_INK, fontSize: isMobile ? 16 : 18, lineHeight: 1.2, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700 }}>SimPaths</span>{" "}<span style={{ fontWeight: 500, color: HEAD_INK, borderLeft: `1px solid ${HEAD_LINE}`, paddingLeft: 10, marginLeft: 10 }}>Policy Impacts Visualiser</span>
          </p>
          {hasDataSource && dataSource.navigation}
          <nav aria-label="Site sections" style={{ marginLeft: isMobile ? 0 : "auto", maxWidth: "100%" }}>
            <div role="tablist" style={{ display: "flex", alignItems: "center", gap: isMobile ? 2 : 4, overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "thin" }}>
              {TABS.map(t => {
                const active = tab === t.id;
                return (
                  <a key={t.id} role="tab" aria-selected={active} aria-current={active ? "page" : undefined}
                    href={`#/${t.id}`}
                    onClick={e => { e.preventDefault(); navigate(t.id); }}
                    style={{ display: "inline-block", padding: isMobile ? "6px 11px" : "7px 13px", borderRadius: 999, fontSize: isMobile ? 13 : 14, fontWeight: active ? 650 : 500, color: active ? "#ffffff" : HEAD_INK, background: active ? TAB_BLUE : "transparent", textDecoration: "none" }}>
                    {t.label}
                  </a>
                );
              })}
            </div>
          </nav>
        </div>
        <div aria-hidden="true" style={{ height: 4, background: STRIPE }} />
      </header>

      {/* Main Content Container */}
      <div style={{ padding: isMobile ? "10px 16px" : "10px 48px", display: "flex", flexDirection: "column", gap: isMobile ? 20 : 30 }}>
        
       {tab === "home" && (<>
       {/* Intro Card */}
<div style={{ background: BG_DARK, padding: isMobile ? "4px 0 0" : "8px 0 0" }}>

  {/* Two-column row: text left, links right */}
  <div style={{ display: "flex", gap: "40px", alignItems: "flex-start", flexWrap: windowWidth < 900 ? "wrap" : "nowrap", marginBottom: "24px" }}>

    {/* Left: tagline + description */}
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{ margin: "0 0 14px", fontSize: "clamp(22px, 3vw, 31px)", fontWeight: 650, color: TEXT_DARK, letterSpacing: "-0.03em", lineHeight: 1.2 }}>
        Explore how different policies could shape outcomes across the UK.
      </p>
      <p style={{ margin: "0 0 10px", lineHeight: 1.8, color: TEXT_DARK, fontSize: "clamp(14px, 2vw, 16px)" }}>
        This tool visualises outputs from <a href="https://simpaths.org/" target="_blank" rel="noopener noreferrer" style={{ color: TEAL, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "1px", transition: "opacity 0.2s" }}>SimPaths</a>, an open-source, dynamic microsimulation model developed by the Centre for Microsimulation and Policy Analysis (<a href="https://www.microsimulation.ac.uk/" target="_blank" rel="noopener noreferrer" style={{ color: TEAL, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "1px", transition: "opacity 0.2s" }}>CeMPA</a>) at the University of Essex. The Policy Impacts Visualiser was built by researchers at the University of Glasgow as part of the <a href="https://www.phiuk.org/policy-modelling-for-health" target="_blank" rel="noopener noreferrer" style={{ color: TEAL, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "1px", transition: "opacity 0.2s" }}>Policy Modelling for Health</a> (funded by UKRI) research group.
        Use it to view the projected impact of a policy scenario on a simulated UK population, broken down by variable, year, and population subgroup.
        {!hasDataSource && isUsingDefault && <> The example loaded here compares a <strong>Baseline</strong> with an <strong>Increased Education</strong> scenario, in which 5% more 16–29 year olds are in education from 2025. You can also load your own SimPaths data into the visualiser.</>}
      </p>
    </div>


  </div>

  {/* How to use — drop-down section */}
  <button type="button" onClick={() => toggleHomeSection("howto")} aria-expanded={!!homeOpen.howto} aria-controls="home-howto"
    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${BG_PANEL}`, padding: "8px 2px", margin: "2px 0 6px", cursor: "pointer", fontFamily: "inherit" }}>
    <span style={{ fontSize: 13, color: TEAL, display: "inline-block", transition: "transform 0.2s", transform: homeOpen.howto ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
    <span style={{ fontSize: "clamp(18px, 2.4vw, 21px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.2px" }}>How to use the visualiser</span>
  </button>
  {homeOpen.howto && (<div id="home-howto" style={{ marginBottom: 12 }}>
    <p style={{ margin: "4px 0 10px", lineHeight: 1.7, color: TEXT_DARK, fontSize: "clamp(14px, 2vw, 15.5px)" }}>
      SimPaths simulates the life-course trajectories of a population — how demographics, employment, income, wealth, health, and other variables change over time — and how those trajectories may change under a simulated policy scenario (e.g., an increase in the minimum wage).
      This visualiser lets you explore those simulated outcomes interactively: pick a variable, stratify it by age, gender, region and more, and compare Baseline data against Scenario data over time, at a single point in time, or as the difference between the two.
    </p>
    <p style={{ margin: "0 0 10px", lineHeight: 1.7, color: TEXT_DARK, fontSize: "clamp(14px, 2vw, 15.5px)" }}>
      For the example shown here, if you had simulated an increase in the proportion of young people in education, you could ask: how does mental health change by 2050 for this scenario vs a baseline simulation, and are the effects different across age groups?
      To explore this, select Mental Component Summary score as the variable, stratify the results by age and compare the Baseline and Scenario over time.
    </p>
  </div>)}

  {/* Default view (education scenario) — drop-down section */}
  {renderDefaultViewSection("scenario")}
    

  {/* Limitations — drop-down section */}
  <button type="button" onClick={() => toggleHomeSection("limits")} aria-expanded={!!homeOpen.limits} aria-controls="home-limits"
    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${BG_PANEL}`, padding: "8px 2px", margin: "2px 0 6px", cursor: "pointer", fontFamily: "inherit" }}>
    <span style={{ fontSize: 13, color: TEAL, display: "inline-block", transition: "transform 0.2s", transform: homeOpen.limits ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
    <span style={{ fontSize: "clamp(18px, 2.4vw, 21px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.2px" }}>Limitations &amp; interpretation</span>
  </button>
  {homeOpen.limits && (<div id="home-limits" style={{ marginBottom: 12 }}>
  <div id="interpreting-results" style={{ background: "#fff0ee", border: `1px solid #e07060`, borderRadius: "8px", padding: isMobile ? "14px 16px" : "16px 20px", borderLeft: `4px solid #d04030` }}>
    <p style={{ margin: "0 0 8px", fontSize: "15.5px", color: "#c03020", lineHeight: 1.65 }}>
      The outputs presented here are based on simulated data and are intended for research purposes only — they should not be interpreted as forecasts or official statistics.
    </p>
    <p style={{ margin: 0, fontSize: "15.5px", color: "#c03020", lineHeight: 1.65 }}>
      Every figure is an average across multiple model runs, shown with a 95% confidence interval; where the underlying sample within a run is too small to be reliable, that estimate is suppressed rather than shown. Differences between <strong>Baseline</strong> and <strong>Scenario</strong> reflect the modelled effect of the policy change being tested, not an observed real-world outcome.
    </p>
  </div>
  </div>)}

</div>

        {/* ── Visualiser (same page, below the intro) ── */}
        {/* Connect Data — full width, above the variable list and charts.
            Left: load your own data. Right: what is currently shown, with the
            full-dataset download. The two stack on narrow screens. */}
        <div ref={connectDataRef} style={{ background: BG_DARK, border: `1px solid ${BG_PANEL}`, padding: isMobile ? 16 : "18px 24px", borderRadius: 6, scrollMarginTop: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: stackConnect ? 18 : 28 }}>
            {/* Left: load your own data */}
            <div style={{ flex: "1 1 420px", minWidth: 0 }}>
              <h3 style={{ display: "inline-block", margin: "0 0 12px", fontSize: 17, fontWeight: 650, color: TEXT_DARK, letterSpacing: "-0.01em", borderBottom: `3px solid ${CORAL}`, paddingBottom: 3 }}>
                Connect data
              </h3>
              {hasDataSource ? <>
                <AggregateDataPanel source={dataSource} error={connectedData.error} rowCount={displayedRows.length} />
                <p style={{ margin: "8px 0 0", fontSize: 11.5, color: TEAL, lineHeight: 1.5, fontStyle: "italic" }}>Connected results are supplied by the host service.</p>
              </> : <>
                <p style={{ margin: "0 0 10px", fontSize: 14, color: TEXT_DARK, lineHeight: 1.55 }}>
                  Explore your own SimPaths output: choose a folder containing a <strong>Baseline</strong> folder and one or more <strong>Scenario</strong> folders of runs.{" "}
                  <FolderStructureHelp />
                </p>
                <button onClick={handleSelectFolder} disabled={isProcessing} style={{ padding: "8px 20px", borderRadius: 4, border: `1px solid ${CORAL}`, background: CORAL, color: "#fff", fontWeight: 700, fontSize: 19, cursor: isProcessing ? "default" : "pointer", width: isMobile ? "100%" : "auto", fontFamily: "inherit" }}>
                  {isProcessing ? "Aggregating data..." : "Visualise Locally Saved Data"}
                </button>
                <p style={{ margin: "6px 0 0", fontSize: 11.5, color: TEAL, lineHeight: 1.5, fontStyle: "italic" }}>
                  Files are processed entirely in your browser — nothing is uploaded.
                </p>
              </>}
              {statusMessage && <p style={{ fontSize: 11, color: "#c2410c", margin: "6px 0 0", fontStyle: "italic", lineHeight: 1.4 }}>{statusMessage}</p>}
            </div>

            {/* Right: what is currently shown, and its download */}
            <div style={{ flex: stackConnect ? "1 1 100%" : "0 1 330px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 6,
              ...(stackConnect ? { borderTop: "1px solid #e5ded3", paddingTop: 14 } : { borderLeft: "1px solid #e5ded3", paddingLeft: 28 }) }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: TEXT_MID }}>Data shown</div>
              {defaultLoadFailed && !hasDataSource ? (
                <div style={{ fontSize: 14, color: "#b91c1c", fontWeight: 600 }}>
                  Preloaded data failed to load.{" "}
                  <button type="button" onClick={loadDefaultDataset} style={{ background: "none", border: "none", padding: 0, color: TEAL, fontWeight: 700, textDecoration: "underline", cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}>↻ Retry</button>
                </div>
              ) : (<>
                <div style={{ fontSize: 15, color: TEXT_DARK, fontWeight: 600 }}>
                  {hasDataSource ? "Connected data" : isUsingDefault ? "Preloaded data" : "Your data"}
                </div>
                {shownScenarios && <div style={{ fontSize: 12.5, color: TEXT_MID, lineHeight: 1.45 }}>{shownScenarios}</div>}
                {!hasDataSource && !isUsingDefault && (
                  <button type="button" onClick={loadDefaultDataset} style={{ alignSelf: "flex-start", background: "none", border: "none", padding: 0, color: TEAL, fontWeight: 600, textDecoration: "underline", cursor: "pointer", fontSize: 12.5, fontFamily: "inherit" }}>
                    ← Back to the preloaded data
                  </button>
                )}
                {downloadButton && <div style={{ marginTop: 4, display: "flex", flexDirection: "column" }}>{downloadButton}</div>}
              </>)}
            </div>
          </div>
        </div>

        {/* Workspace Operations */}
        <div style={{ display: "flex", gap: 30, alignItems: "flex-start", flexWrap: windowWidth < 1200 ? "wrap" : "nowrap" }}>
          
          {/* Left Sidebar */}
          <div style={{ width: "300px", flexShrink: 0, display: "flex", flexDirection: "column", gap: 20, minWidth: windowWidth < 1200 ? "100%" : "300px" }}>
            
            {/* Explore Variables Card */}
            <div style={{ background: BG_DARK, border: `1px solid ${BG_PANEL}`, padding: "16px 20px", borderRadius: 6 }}>
              <h3 style={{ display: "inline-block", margin: "0 0 14px 4px", fontSize: 17, fontWeight: 650, color: TEXT_DARK, letterSpacing: "-0.01em", borderBottom: `3px solid ${CORAL}`, paddingBottom: 3 }}>Explore variables</h3>
              {Object.entries(DOMAIN_SECTIONS).map(([domain, vars]) => {
                const isOpen = !!openDomains[domain];
                return (
                  <div key={domain} style={{ marginBottom: 6 }}>
                    <button onClick={() => toggleDomain(domain)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: isOpen ? `${AQUA}26` : "transparent", border: "none", borderRadius: 6, padding: "7px 10px", cursor: "pointer", marginBottom: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: isOpen ? TEAL : "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>{domain}</span>
                      <span style={{ fontSize: 10, color: isOpen ? TEAL : "#64748b", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", display: "inline-block" }}>▼</span>
                    </button>

                    {isOpen && (
                      <div style={{ paddingLeft: 4, marginBottom: 6 }}>
                        {vars.map(v => (
                          <button key={v} onClick={() => setActiveVariable(v)}
                            onMouseEnter={() => hintVariable(v)} onFocus={() => hintVariable(v)}
                            onMouseLeave={cancelHint} onBlur={cancelHint}
                            style={{ display: "block", width: "100%", textAlign: "left", background: activeVariable === v ? `${CORAL}1f` : "transparent", border: "none", borderLeft: `3px solid ${activeVariable === v ? CORAL : "transparent"}`, fontSize: 13, padding: "6px 10px", borderRadius: "0 6px 6px 0", cursor: "pointer", marginBottom: 2, color: activeVariable === v ? TEXT_DARK : TEXT_MID, fontWeight: activeVariable === v ? 650 : 400, outline: "none", fontFamily: "inherit" }}>
                            {titleCase(v)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Main Visualization */}
          <div ref={mainVizRef} style={{ flex: 1, background: BG_DARK, border: `1px solid ${BG_PANEL}`, borderRadius: 6, padding: isMobile ? "16px" : "30px", minWidth: windowWidth < 1200 ? "100%" : "auto", boxSizing: "border-box" }}>
            <h2 style={{ margin: "0 0 8px", fontSize: "clamp(22px, 3vw, 30px)", color: CORAL, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.2 }}>{titleCase(activeVariable)}</h2>
            {VARIABLE_DESCRIPTIONS[activeVariable] && (
              <p style={{ margin: "0 0 6px", fontSize: "clamp(12px, 1.5vw, 13px)", color: TEXT_MID, fontStyle: "italic", lineHeight: 1.5 }}>
                {withBenefitUnitInfo(VARIABLE_DESCRIPTIONS[activeVariable])}
                  {activeVariable === "Mental Component Summary (MCS)" && (
    <>
      {" "}See{" "}
      <a
        href="https://www.understandingsociety.ac.uk/documentation/mainstage/variables/sf12mcs_dv/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "#2563eb",
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
       Understanding Society documentation
      </a>
      {" "}for further information.
    </>
  )}
   {activeVariable === "Physical Component Summary (PCS)" && (
    <>
      {" "}See{" "}
      <a
        href="https://www.understandingsociety.ac.uk/documentation/mainstage/variables/sf12pcs_dv/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "#2563eb",
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
       Understanding Society documentation
      </a>
      {" "}for further information.
    </>
  )}
{activeVariable === "Subjective wellbeing (GHQ)" && (
    <>
      {" "}See{" "}
      <a
        href="https://www.understandingsociety.ac.uk/documentation/mainstage/variables/scghq1_dv/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "#2563eb",
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
       Understanding Society documentation
      </a>
      {" "}for further information.
    </>
  )}

  {activeVariable === "Psychological distress score" && (
    <>
      {" "}See{" "}
      <a
        href="https://www.understandingsociety.ac.uk/documentation/mainstage/variables/scghq2_dv/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "#2563eb",
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
       Understanding Society documentation
      </a>
      {" "}for further information.
    </>
  )}
  {activeVariable === "Life Satisfaction Score" && (
    <>
      {" "}See{" "}
      <a
        href="https://www.understandingsociety.ac.uk/documentation/mainstage/variables/sclfsato/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "#2563eb",
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
       Understanding Society documentation
      </a>
      {" "}for further information.
    </>
 )}
    {activeVariable === "Financial distress flag" && (
    <>
      {" "}See{" "}
      <a
        href="https://www.understandingsociety.ac.uk/documentation/mainstage/variables/finnow/"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "#2563eb",
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
       Understanding Society documentation
      </a>
      {" "}for further information.
    </>
  )}
  

  
              </p>
            )}
            {BENEFIT_UNIT_NOTES[activeVariable] && (
              <p style={{ margin: "0 0 8px", padding: "7px 10px", fontSize: "clamp(12px, 1.5vw, 13px)", color: TEXT_MID, lineHeight: 1.5, background: `${AQUA}1a`, borderLeft: `3px solid ${AQUA}`, borderRadius: "0 4px 4px 0" }}>
                <strong style={{ color: TEXT_DARK }}>Benefit-unit variable.</strong> {BENEFIT_UNIT_NOTES[activeVariable]}
              </p>
            )}
            <p style={{ margin: "0 0 20px", fontSize: "clamp(12px, 1.5vw, 13px)", color: "#64748b" }}>
              {hasDataSource && dataSource.showDelta === false ? "Explore the available results for the selected configurations." : hasDataSource
                ? <>Compare <strong>{comparisonLabel("baseline", dataSource.names)}</strong> with the selected alternative scenarios.</>
                : <>Side-by-side comparative graphics between the <strong>Baseline</strong> and the chosen <strong>Policy Scenario</strong> outputs.</>}
            </p>
            {hasDataSource && sourceText(dataSource.notice) && <p style={{ fontSize: 13, color: TEXT_MID }}>{dataSource.notice}</p>}
            <hr style={{ border: "none", borderTop: `1px solid ${BG_PANEL}`, marginBottom: 20 }} />
            {!hasDataSource && isLoadingDefault
              ? <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:320,gap:20,padding:"40px 20px"}}>
                  <p style={{margin:0,fontSize:15,color:TEAL,fontWeight:600}}>Loading dataset…</p>
                  <div style={{width:"min(420px,90%)",background:BG_PANEL,borderRadius:8,overflow:"hidden",height:10}}>
                    <div style={{height:"100%",background:TEAL,borderRadius:8,animation:"loadbar 1.8s ease-in-out infinite"}}/>
                  </div>
                  <p style={{margin:0,fontSize:12.5,color:TEXT_MID}}>Fetching and parsing the pre-aggregated dataset — this may take a few moments.</p>
                  <style>{`@keyframes loadbar{0%{width:0%;margin-left:0}60%{width:80%;margin-left:0}100%{width:0%;margin-left:100%}}`}</style>
                </div>
              : (!hasDataSource || displayedRows.length > 0 || (dataSource.viewSource && !connectedData.error)) && <DashboardSection key={hasDataSource ? `connected:${sourceText(dataSource.key, "default")}` : "standalone"} showDelta={!hasDataSource || dataSource.showDelta !== false} viewSource={dataSource?.viewSource} parsedCache={displayedRows} targetVariable={activeVariable} bgBase={BG} bgDark={BG_DARK} bgPanel={BG_PANEL} />
            }
          </div>
        </div>
        </>)}

        {tab === "dataset" && <DatasetPage onNavigate={navigate} />}
        {tab === "interpreting-results" && <StaticPage file="interpreting-results.html" onNavigate={navigate} />}
        {tab === "citation" && <StaticPage file="citation.html" onNavigate={navigate} />}
        {tab === "funders" && <StaticPage file="funders.html" onNavigate={navigate} />}
        {tab === "resources" && <ResourcesPage />}
      </div>

      {/* Closing Banner — gradient ribbon, then pale blue like the header */}
      <footer>
      <div aria-hidden="true" style={{ height: 4, background: STRIPE }} />
      <div style={{ background: HEAD_BG, padding: isMobile ? "24px 20px" : "28px 48px" }}>
        <div style={{ display: "flex", gap: "40px", alignItems: "flex-start", flexWrap: windowWidth < 1024 ? "wrap" : "nowrap" }}>

          {/* LEFT: Credit Text */}
          <div style={{ flex: 1, minWidth: "260px" }}>
            <p style={{ color: HEAD_INK, margin: "0 0 14px", fontSize: "clamp(15px, 2.2vw, 18px)", fontWeight: 500, letterSpacing: "-0.2px", opacity: 1 }}>
              Credit &amp; Citation
            </p>

            {/* Citation Box */}
            <div id="citation" style={{ background: "#ffffff", border: `1px solid ${HEAD_LINE}`, borderRadius: "8px", padding: "12px 14px", marginBottom: "14px" }}>
              <p style={{ fontSize: "11px", color: HEAD_INK, margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
                Cite this dashboard:
              </p>
              <a href="https://doi.org/ADD-DOI" target="_blank" rel="noopener noreferrer" style={{ color: HEAD_INK, fontSize: "14px", fontWeight: 500, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "6px", borderBottom: `1.5px solid ${AQUA}`, paddingBottom: "2px" }}>
                DOI ↗
              </a>
            </div>

            {/* Description */}
            <p style={{ color: HEAD_INK, margin: "0 0 10px", fontSize: "13px", lineHeight: "1.6", opacity: 1, fontWeight: 400 }}>
              This tool visualises outputs from the SimPaths microsimulation model using data from Understanding Society: the UK Household Longitudinal Study.
            </p>

            <p style={{ color: HEAD_INK, margin: "0 0 14px", fontSize: "11px", lineHeight: "1.6", opacity: 1, fontWeight: 400 }}>
              We acknowledge the contributions of researchers, data providers, and funders supporting this work. Results are modelled estimates and should not be interpreted as forecasts or official statistics.
            </p>

            <p style={{ color: HEAD_INK, margin: "0 0 14px", fontSize: "11px", lineHeight: "1.6", opacity: 1, fontWeight: 400 }}>
              The SimPaths Policy Impacts Visualiser is open-source software, licensed under the European Union Public Licence v. 1.2 (EUPL-1.2).
            </p>

            {/* Links */}
            <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
              <a href="https://github.com/simpaths/SimPaths/blob/main/license.txt" target="_blank" rel="noopener noreferrer" style={{ color: HEAD_INK, fontSize: "12px", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", borderBottom: `1px solid ${TAB_BLUE}`, paddingBottom: "2px", fontWeight: 400, opacity: 1 }}>
                License (EUPL-1.2)
              </a>
            </div>
          </div>

          {/* RIGHT: Feedback — prominent, replaces the old logo slot */}
          <div style={{ width: windowWidth < 1024 ? "100%" : "300px", boxSizing: "border-box", flexShrink: 0, background: "#ffffff", border: `1px solid ${HEAD_LINE}`, borderRadius: "10px", padding: "18px 20px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: HEAD_INK }}>Feedback</h3>
            <p style={{ margin: "0 0 14px", fontSize: "13px", lineHeight: 1.5, color: HEAD_INK }}>
              We're happy to receive feedback about the dashboard — let us know what's working, what isn't, or what you'd like to see.
            </p>
            <a href="mailto:healthmod@glasgow.ac.uk?subject=SimPaths%20Data%20Visualiser" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", width: "100%", boxSizing: "border-box", padding: "10px 16px", borderRadius: "4px", background: CORAL, color: "#fff", fontWeight: 700, fontSize: "19px", textDecoration: "none" }}>
              Send Feedback
            </a>
          </div>

          
        </div>
      </div>
      </footer>
    </div>
    </ComparisonNamesContext.Provider>
  );
}

export default App;