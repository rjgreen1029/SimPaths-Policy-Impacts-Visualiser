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
import DashboardSection, { MIN_RUNS_WARN } from "./DashboardSection";
import ScenarioGraphic from "./ScenarioGraphic";
import StaticPage from "./StaticPage";
import { DatasetPage, ResourcesPage, BENEFIT_UNIT_DEFINITION } from "./InfoPages";
import { parseCsvRow, scenarioLabel, titleCase } from "./useAggregatedData";
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

/** Tooltip/help text shown alongside each variable in the sidebar variable picker. Exported so DashboardSection (or any other consumer) can reuse the same descriptions. */
export const VARIABLE_DESCRIPTIONS = {
  "Highest Level of Education":           "Highest qualification attained. High education (degree), medium education (Other higher degree, A-level, GCSE etc.), and low education (other qualification, no qualification).",
  "Ethnicity":                            "Self-identified ethnic group classification.",
  "Partnership status":                   "Whether an individual is single or partnered.",
  "Population size":                      "Number of people in the simulated population. Averaged across model runs; stratify to see the number in each group.",
  "Population Pyramid":                   "Age structure of the simulated population, split by gender. Each bar shows that age band and gender as a share of the total population (males on the right, females on the left); all bars together add up to 100%.",
  //"Number of children":                   "Count of dependent children in the household.", // temporarily disabled
   "Household Type":                       "Benefit unit composition (e.g., single adult, couple with/without children).", // temporarily disabled — still works as a stratifier
  "Employment status":                    "Current labour market status (e.g., employed, unemployed, retired, student).",
  "Hours worked":                         "Usual number of paid working hours per week.",
  "Income Quintile":                      "Benefit unit position in the population income distribution split into five equal groups (from lowest (1) to highest (5)).",
  "Universal Credit Benefits Flag":       "Whether the benefit unit receives Universal Credit.",
  "Financial distress flag":              "Indicator of reported difficulty in meeting basic financial commitments.",
  "Equivalised yearly disposable income": "Annual income after taxes and transfers, in GBP (£).",
  "Gross personal employment income":     "Earnings from employment before tax and deductions.",
  "Personal private pension income" :     "Gross personal private pension income", 
  "Hourly earnings": "Potential hourly earnings",// temporarily disabled
   "Capital Income":                       "Income from assets such as savings, investments, or property.", // temporarily disabled
  "Amount of benefits received per month":"Monthly monetary value of welfare benefits received, in GBP (£).",
  "Disability Status":                    "Whether the individual reports a limiting long-term illness or disability.",
  // "Self-Rated Health":                 "Individual's own assessment of overall health (from excellent to poor).",
  // "Psychological distress flag":          "Indicator of clinically relevant mental distress.", // temporarily disabled
  "Mental Component Summary (MCS)":       "Mental Component Summary: summary score of mental health-related quality of life (from 0–100).",
  "Physical Component Summary (PCS)":     "Physical Component Summary: summary score of physical health-related quality of life (from 0–100).",
  "Life Satisfaction Score":              "Overall life satisfaction measure (from 0–10).",
  "Psychological distress score":         "Subjective wellbeing (GHQ): Scale 0 (the least distressed) to 12 (the most distressed)",
  "Subjective wellbeing (GHQ)":           "Self-reported wellbeing measure summing values from the General Health Questionnaire from 0 (indicating the least amount of distress) to 36 (indicating the greatest amount of distress).",
  "Provided care":                        "Whether someone in the benefit unit provides social care to someone else.",
  "Received care":                        "Whether the individual receives social care whether informal (e.g. from family or friends), formal (paid) care, or mixed.",
};

/** Adds a small ⓘ after the first "benefit unit" in a description; hovering
 *  (or focusing) it shows what a benefit unit is. */
function withBenefitUnitInfo(text) {
  const m = /benefit unit/i.exec(text || "");
  if (!m) return text;
  const end = m.index + m[0].length;
  return (<>
    {text.slice(0, end)}
    <span tabIndex={0} role="note" title={`Benefit unit: ${BENEFIT_UNIT_DEFINITION}`} aria-label={`Benefit unit: ${BENEFIT_UNIT_DEFINITION}`}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, margin: "0 2px 0 4px", borderRadius: "50%", border: "1px solid #14687c", color: "#14687c", fontSize: 10, fontStyle: "normal", fontWeight: 700, cursor: "help", verticalAlign: "1px" }}>i</span>
    {text.slice(end)}
  </>);
}

/**
 * Top-level page component. See the file header above for what it owns vs.
 * delegates. Renders either a "screen too small" notice (below MIN_WIDTH),
 * or the full page: header banner → intro card → sidebar + DashboardSection
 * → closing banner.
 */
function App() {
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
    const url = `${process.env.PUBLIC_URL}/SimPaths_All_Aggregated_Outputs.csv`;
    setDefaultLoadFailed(false);
    setIsLoadingDefault(true);
    setStatusMessage("Loading default dataset…");
    d3.text(url)
      .then(text => csvParse(text, parseCsvRow))
      .then(rows => {
        if (!rows.length) throw new Error("File was found but contained no rows — check it's the actual CSV and not an HTML/error page being served at that URL.");
        setParsedCache(rows);
        setIsUsingDefault(true);
        setDefaultLoadFailed(false);
        setStatusMessage("");
      })
      .catch(err => {
        console.warn("Could not load the default dataset.", err);
        setIsUsingDefault(true);
        setDefaultLoadFailed(true);
        setParsedCache([]);
        setStatusMessage(
          `Could not load the default dataset from "${url}" (${err.message || "fetch failed"}). ` +
          `Check that SimPaths_All_Aggregated_Outputs.csv exists at exactly that path in your deployment's public folder — or select a simulation directory below.`
        );
      })
      .finally(() => setIsLoadingDefault(false));
  }, []);

  // Fetch the bundled default dataset once on mount.
  useEffect(() => {
    loadDefaultDataset();
  }, [loadDefaultDataset]);

  // Tracks window width for the mobile/tablet responsive breakpoints above.
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  /**
   * "Visualise Your Own Data" handler — opens the native folder picker.
   */
  const handleSelectFolder = async () => {
    try {
      const directoryHandle = await window.showDirectoryPicker();
      setIsProcessing(true);
      setStatusMessage("Reading local folder hierarchy...");
      const freshlyAggregated = await parseLocalFolder(directoryHandle, msg => setStatusMessage(msg));
      if (!Array.isArray(freshlyAggregated)) throw new Error("Aggregation returned no data.");
      setParsedCache(freshlyAggregated);
      setIsUsingDefault(false);
      setDefaultLoadFailed(false);
      setIsProcessing(false);
      setStatusMessage("");
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
      setStatusMessage(
        err.name === "AbortError" ? "" : `Aggregation Error: ${err.message || "Check folder tree construction."}`
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
  const BG       = "#f7f3ed";
  const BG_DARK  = "#fcfaf5";
  const BG_PANEL = "#f7f3ed";
  const TEAL     = "#14687c";
  const AQUA = "#0f93a1";
  const CORAL    = "#ff6e51";
  const INDIGO   = "#5975f8";
  const DOMAIN_COLORS = { "Demographics": TEAL, "Activity status": AQUA, "Income": CORAL, "Health": INDIGO };
  const TEXT_DARK = "#1e293b";
  const TEXT_MID  = "#475569";
  const linkBtnStyle = { color: AQUA, textDecoration: "none", fontSize: "14px", padding: "10px 14px", background: `${AQUA}10`, borderRadius: "6px", border: `1px solid ${AQUA}30`, transition: "all 0.2s", display: "inline-flex", alignItems: "center", fontWeight: 500 };
  // Compact pill variant used inline next to the "Explore changes across..." text
  const smallLinkStyle = { color: AQUA, textDecoration: "none", fontSize: "12px", padding: "5px 10px", background: `${AQUA}10`, borderRadius: "6px", border: `1px solid ${AQUA}30`, transition: "all 0.2s", display: "inline-flex", alignItems: "center", fontWeight: 500, whiteSpace: "nowrap" };
  // Home page drop-down sections (both start closed).
  const [homeOpen, setHomeOpen] = useState({ scenario: false, limits: false });
  const toggleHomeSection = key => setHomeOpen(o => ({ ...o, [key]: !o[key] }));
  /** "The default view: education policy scenario" drop-down, in the intro
   *  card on the Home page. */
  const renderDefaultViewSection = key => (<>
  <button type="button" onClick={() => toggleHomeSection(key)} aria-expanded={!!homeOpen[key]} aria-controls={`home-${key}`}
    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${BG_PANEL}`, padding: "8px 2px", margin: "2px 0 6px", cursor: "pointer", fontFamily: "inherit" }}>
    <span style={{ fontSize: 13, color: TEAL, display: "inline-block", transition: "transform 0.2s", transform: homeOpen[key] ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
    <span style={{ fontSize: "clamp(18px, 2.4vw, 21px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.2px" }}>The default view: education policy scenario</span>
    <span style={{ marginLeft: "auto", fontSize: 12.5, color: TEXT_MID, fontWeight: 500 }}>{homeOpen[key] ? "Hide" : "Show"}</span>
  </button>
  {homeOpen[key] && (<div id={`home-${key}`}>
  <div style={{ background: `${AQUA}08`, border: `1px solid ${AQUA}20`, borderRadius: "8px", padding: isMobile ? "16px" : "18px", marginBottom: "18px", borderLeft: `4px solid ${AQUA}` }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "18px", alignItems: "flex-start", marginBottom: "10px" }}>
  
  {/* Left column: both paragraphs */}
  <div style={{ flex: "1 1 320px", minWidth: 0 }}>
    <p style={{ margin: 0, lineHeight: 1.6, color: TEXT_MID, fontSize: "15.5px" }}>
      The default view displays a pre-aggregated dataset showing a simulated education policy intervention applied to 16–29 year olds from 2025, compared against a <strong>Baseline</strong> with no policy change. The <strong>Moderate Education Scenario</strong> increases the proportion of 16–29 year olds in education by 5%.
    </p>
    <p style={{ margin: "16px 0 0", lineHeight: 1.6, color: TEXT_MID, fontSize: "15.5px" }}>
      To use your own data, SimPaths outputs must be organised into <strong>Baseline</strong> and <strong>Scenario</strong> folders, each containing the runs from your model output. Use "Visualise Your Own Data" to select the parent folder that your <strong>Baseline</strong> and <strong>Scenario</strong> folders sit within.
      <br /><br />
      This tool is entirely JavaScript-based — all aggregation happens locally in your browser, and no data you upload is ever stored or sent anywhere.
    </p>
  </div>

  {/* Right column: graphic */}
  <div style={{ flex: "1 1 340px", minWidth: 0 }}>
    <ScenarioGraphic isMobile={isMobile || windowWidth < 1200} />
  </div>

</div>
  </div>
  </div>)}
  </>);


  // Fewest runs in any scenario (Baseline included) of the loaded data. Each
  // scenario's run count is the largest n_runs among its rows (the Overall
  // rows exist in every run). Drives the low-run warning above the charts.
  const runsByScenario = useMemo(() => {
    const m = new Map();
    for (const r of parsedCache) {
      if (r.n_runs > (m.get(r.scenario) ?? 0)) m.set(r.scenario, r.n_runs);
    }
    return m;
  }, [parsedCache]);
  const fewestRuns = runsByScenario.size ? Math.min(...runsByScenario.values()) : null;
  if (windowWidth < MIN_WIDTH) {
    return (
      <div style={{
        fontFamily: "Work Sans, sans-serif",
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
          boxShadow: "0 4px 6px rgba(0,0,0,0.1)"
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
    <div style={{ fontFamily: "Work Sans, sans-serif", minHeight: "100vh", background: BG, color: TEXT_DARK, display: "flex", flexDirection: "column", gap: 30 }}>
      
     {/* Header + Title Banner */}
<div
  style={{
    background: BG_DARK,          // header: light background, coral title (tabs below are coral)
    padding: isMobile ? "12px 16px" : "12px 48px",
    display: "flex",
    alignItems: "center",
    gap: isMobile ? 14 : 24,
  }}
>
  {/* Main title */}
  <p
    style={{
      color: CORAL,
      margin: 0,
      fontSize: "clamp(20px, 4.5vw, 36px)",
      fontWeight: 600,
      lineHeight: 1.2,
      flex: 1,
    }}
  >
    SimPaths Policy Impacts Visualiser
  </p>

      {/* Logos + SimPaths branding */}
      <div
        style={{
          background: "#fff",
          borderRadius: "10px",
          padding: isMobile ? "6px 8px" : "7px 12px",
          display: "flex",
          alignItems: "center",
          gap: isMobile ? "8px" : "12px",
          flexShrink: 0,
          boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
        }}
      >
        {/* Partner logo */}
        <img
          src={`${process.env.PUBLIC_URL}/SimPaths-logo-transparent.png`}
          alt="SimPaths logo"
          style={{
            width: isMobile ? "55px" : "75px",
            maxWidth: "75px",
            maxHeight: "45px",
            height: "auto",
            display: "block",
            objectFit: "contain",
          }}
        />

        {/* SimPaths text */}
        <div
          style={{
            fontFamily: "Arial, Helvetica, sans-serif",
            textAlign: "left",
            lineHeight: 1.05,
          }}
        >
          <div
            style={{
              fontSize: isMobile ? "16px" : "20px",
              fontWeight: 700,
              color: "#333",
            }}
          >
            SimPaths
          </div>

          <div
            style={{
              fontSize: isMobile ? "6px" : "8px",
              fontWeight: 600,
              letterSpacing: "0.6px",
              color: "#666",
              marginTop: "3px",
              whiteSpace: "nowrap",
            }}
          >
            LIFE COURSE MICROSIMULATION
          </div>
        </div>
      </div>
    </div>

      {/* ── Top navigation tabs ─────────────────────────────────────────── */}
      <nav aria-label="Site sections" style={{ background: CORAL, marginTop: -30 }}>
        <div role="tablist" style={{ display: "flex", alignItems: "center", gap: isMobile ? 2 : 6, padding: isMobile ? "7px 8px" : "7px 40px", overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "thin" }}>
          {TABS.map(t => {
            const active = tab === t.id;
            return (
              <a key={t.id} role="tab" aria-selected={active} aria-current={active ? "page" : undefined}
                href={`#/${t.id}`}
                onClick={e => { e.preventDefault(); navigate(t.id); }}
                style={{ display: "inline-block", padding: isMobile ? "6px 11px" : "6px 15px", borderRadius: 999, fontSize: isMobile ? 13 : 14, fontWeight: active ? 700 : 500, color: active ? CORAL : "rgba(255,255,255,0.92)", background: active ? "#fff" : "transparent", textDecoration: "none" }}>
                {t.label}
              </a>
            );
          })}
        </div>
      </nav>

      {/* Main Content Container */}
      <div style={{ padding: isMobile ? "10px 16px" : "10px 48px", display: "flex", flexDirection: "column", gap: isMobile ? 20 : 30 }}>
        
       {tab === "home" && (<>
       {/* Intro Card */}
<div style={{ background: BG_DARK, border: `0.5px solid ${BG_PANEL}`, borderRadius: "12px", padding: isMobile ? "22px 20px 10px" : "32px 40px 14px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>

  {/* Two-column row: text left, links right */}
  <div style={{ display: "flex", gap: "40px", alignItems: "flex-start", flexWrap: windowWidth < 900 ? "wrap" : "nowrap", marginBottom: "24px" }}>

    {/* Left: tagline + description */}
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{ margin: "0 0 14px", fontSize: "clamp(18px, 2.6vw, 24px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.3px", lineHeight: 1.3 }}>
        Explore how different policies could shape outcomes across the UK.
      </p>
      <p style={{ margin: "0 0 10px", fontSize: "clamp(14px, 2vw, 16px)", color: TEXT_DARK, lineHeight: 1.6 }}>
        Visualise the projected impact of a policy scenario on a simulated UK population, broken down by variable, year, and population subgroup. 
              </p>
      <p style={{ margin: "0 0 14px", lineHeight: 1.8, color: TEXT_DARK, fontSize: "clamp(14px, 2vw, 16px)" }}>
        This tool visualises outputs from <a href="https://simpaths.org/" target="_blank" rel="noopener noreferrer" style={{ color: AQUA, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "2px", transition: "opacity 0.2s" }}>SimPaths</a>, an open-source, dynamic microsimulation model developed by the Centre for Microsimulation and Policy Analysis (<a href="https://www.microsimulation.ac.uk/" target="_blank" rel="noopener noreferrer" style={{ color: AQUA, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "2px", transition: "opacity 0.2s" }}>CeMPA</a>) at the University of Essex. The Policy Impacts Visualiser was built by researchers at the University of Glasgow as part of the <a href="https://www.phiuk.org/policy-modelling-for-health" target="_blank" rel="noopener noreferrer" style={{ color: AQUA, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "2px", transition: "opacity 0.2s" }}>Policy Modelling for Health</a> (funded by UKRI) research group.
      </p>
      <p style={{ margin: 0, lineHeight: 1.8, color: TEXT_DARK, fontSize: "clamp(14px, 2vw, 16px)" }}>
      SimPaths simulates the life-course trajectories of a population — how demographics, employment, income, wealth, health, and other variables change over time — and how those trajectories may change under a simulated a policy scenario (e.g., an increase in the minimum wage). 
      This visualiser lets you explore those simulated outcomes interactively: pick a variable, stratify it by age, gender, region and more, and compare Baseline data against Scenario data over time, at a single point in time, or as the difference between the two. 
      For the example shown here, if you had simulated an increase in the proportion of young people in education, you could ask: how does mental health change by 2050 for this scenario vs a baseline simulation, and are the effects different across age groups? 
      To explore this, select Mental Component Summary score as the variable, stratify the results by age and compare the Baseline and Scenario over time.
      
      </p>
    </div>


  </div>

  {/* Default view (education scenario) — drop-down section */}
  {renderDefaultViewSection("scenario")}
    

  {/* Limitations — drop-down section */}
  <button type="button" onClick={() => toggleHomeSection("limits")} aria-expanded={!!homeOpen.limits} aria-controls="home-limits"
    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${BG_PANEL}`, padding: "8px 2px", margin: "2px 0 6px", cursor: "pointer", fontFamily: "inherit" }}>
    <span style={{ fontSize: 13, color: TEAL, display: "inline-block", transition: "transform 0.2s", transform: homeOpen.limits ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
    <span style={{ fontSize: "clamp(18px, 2.4vw, 21px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.2px" }}>Limitations &amp; interpretation</span>
    <span style={{ marginLeft: "auto", fontSize: 12.5, color: TEXT_MID, fontWeight: 500 }}>{homeOpen.limits ? "Hide" : "Show"}</span>
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
            Row 1: heading + "Visualise Your Own Data" button + what's loaded.
            Row 2: folder instructions and privacy note. */}
        <div ref={connectDataRef} style={{ background: BG_DARK, border: `1px solid ${BG_PANEL}`, padding: isMobile ? 16 : "18px 24px", borderRadius: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.04)", scrollMarginTop: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: isMobile ? "10px 14px" : "10px 20px", marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: "clamp(17px, 2.2vw, 20px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.2px", borderBottom: `3px solid ${CORAL}`, paddingBottom: 3 }}>
              Connect Data
            </h3>
            <button onClick={handleSelectFolder} disabled={isProcessing} style={{ padding: "8px 18px", borderRadius: 6, border: `1px solid ${AQUA}`, background: AQUA, color: BG_DARK, fontWeight: 600, fontSize: 15, cursor: isProcessing ? "default" : "pointer", width: isMobile ? "100%" : "auto" }}>
              {isProcessing ? "Aggregating data..." : "Visualise Your Own Data"}
            </button>
            <div style={{
              fontSize: 12,
              color: defaultLoadFailed ? "#b91c1c" : isUsingDefault ? TEXT_MID : "#166534",
              padding: defaultLoadFailed || !isUsingDefault ? "3px 8px" : 0,
              borderRadius: 4,
              background: defaultLoadFailed ? "#fee2e2" : isUsingDefault ? "transparent" : "#dcfce7",
              fontWeight: 500,
              display: "inline-flex", alignItems: "center", gap: 10,
            }}>
              {defaultLoadFailed
                ? "Preloaded data failed to load"
                : isUsingDefault ? "Currently displaying: preloaded data" : "Currently displaying: user uploaded data"}
              {defaultLoadFailed && (
                <span style={{ cursor: "pointer", color: TEAL, fontWeight: "bold", textDecoration: "underline" }} onClick={loadDefaultDataset}>↻ Retry</span>
              )}
              {!isUsingDefault && (
                <span title="Go back to the preloaded data" style={{ cursor: "pointer", color: "#b91c1c", fontWeight: "bold" }} onClick={loadDefaultDataset}>✕</span>
              )}
            </div>
          </div>

          <p style={{ margin: "0 0 4px", fontSize: 13, color: TEXT_DARK }}>
            Select parent folder with runs organised into <strong>Baseline</strong> and <strong>Scenario</strong> subfolders.{" "}
            <FolderStructureHelp />
          </p>
          <p style={{ margin: 0, fontSize: 11, color: TEAL, lineHeight: 1.5, fontStyle: "italic" }}>
            Nothing you select is uploaded or stored anywhere — all aggregation happens locally, in your browser.
          </p>
          {statusMessage && <p style={{ fontSize: 11, color: "#c2410c", margin: "6px 0 0", fontStyle: "italic", lineHeight: 1.4 }}>{statusMessage}</p>}
        </div>

        {/* Workspace Operations */}
        <div style={{ display: "flex", gap: 30, alignItems: "flex-start", flexWrap: windowWidth < 1200 ? "wrap" : "nowrap" }}>
          
          {/* Left Sidebar */}
          <div style={{ width: "300px", flexShrink: 0, display: "flex", flexDirection: "column", gap: 20, minWidth: windowWidth < 1200 ? "100%" : "300px" }}>
            
            {/* Explore Variables Card */}
            <div style={{ background: BG_DARK, border: `1px solid ${BG_PANEL}`, padding: "16px 20px", borderRadius: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
              <div style={{ background: CORAL, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, textTransform: "uppercase", letterSpacing: "0.05em", color: "#fff", fontWeight: 700 }}>Explore Variables</h3>
              </div>
              {Object.entries(DOMAIN_SECTIONS).map(([domain, vars]) => {
                const isOpen = !!openDomains[domain];
                return (
                  <div key={domain} style={{ marginBottom: 6 }}>
                    <button onClick={() => toggleDomain(domain)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: isOpen ? `${TEAL}18` : "transparent", border: "none", borderRadius: 6, padding: "7px 10px", cursor: "pointer", marginBottom: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: isOpen ? TEAL : "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>{domain}</span>
                      <span style={{ fontSize: 10, color: isOpen ? TEAL : "#94a3b8", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", display: "inline-block" }}>▼</span>
                    </button>

                    {isOpen && (
                      <div style={{ paddingLeft: 4, marginBottom: 6 }}>
                        {vars.map(v => (
                          <button key={v} onClick={() => setActiveVariable(v)} style={{ display: "block", width: "100%", textAlign: "left", background: activeVariable === v ? `${CORAL}18` : "transparent", border: "none", fontSize: 13, padding: "6px 10px", borderRadius: 6, cursor: "pointer", marginBottom: 2, color: activeVariable === v ? CORAL : TEXT_MID, fontWeight: activeVariable === v ? 600 : 400, outline: "none" }}>
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
          <div ref={mainVizRef} style={{ flex: 1, background: BG_DARK, border: `1px solid ${BG_PANEL}`, borderRadius: 12, padding: isMobile ? "16px" : "30px", boxShadow: "0 1px 2px rgba(0,0,0,0.04)", minWidth: windowWidth < 1200 ? "100%" : "auto" }}>
            <div style={{ background: CORAL, borderRadius: 8, padding: isMobile ? "10px 14px" : "12px 20px", marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: "clamp(18px, 2.8vw, 22px)", color: "#fff", fontWeight: 800, letterSpacing: "-0.2px" }}>{titleCase(activeVariable)}</h2>
            </div>
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
            <p style={{ margin: "0 0 20px", fontSize: "clamp(12px, 1.5vw, 13px)", color: "#64748b" }}>
              Side-by-side comparative graphics between the <strong>Baseline</strong> and the chosen <strong>Policy Scenario</strong> outputs.
            </p>
            {fewestRuns != null && fewestRuns < MIN_RUNS_WARN && !isLoadingDefault && (
              <div role="alert" style={{ margin: "0 0 16px", padding: "10px 14px", background: "#fffbeb", border: "1px solid #fcd34d", borderLeft: "4px solid #d97706", borderRadius: 8, fontSize: 13, color: "#92400e", lineHeight: 1.5 }}>
                <strong>⚠ Low number of model runs.</strong>{" "}
                {[...runsByScenario].filter(([, n]) => n < MIN_RUNS_WARN).map(([sc, n]) => `${scenarioLabel(sc)}: ${n} run${n === 1 ? "" : "s"}`).join(" · ")}.
                {" "}With fewer than {MIN_RUNS_WARN} runs, the 95% uncertainty intervals (and Baseline → Scenario differences) are unreliable{fewestRuns === 1 ? " — with a single run there is no measure of uncertainty at all" : ""}. Interpret results with caution.
              </div>
            )}
            <hr style={{ border: "none", borderTop: `1px solid ${BG_PANEL}`, marginBottom: 20 }} />
            {isLoadingDefault
              ? <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:320,gap:20,padding:"40px 20px"}}>
                  <p style={{margin:0,fontSize:15,color:TEAL,fontWeight:600}}>Loading dataset…</p>
                  <div style={{width:"min(420px,90%)",background:BG_PANEL,borderRadius:8,overflow:"hidden",height:10}}>
                    <div style={{height:"100%",background:TEAL,borderRadius:8,animation:"loadbar 1.8s ease-in-out infinite"}}/>
                  </div>
                  <p style={{margin:0,fontSize:12.5,color:TEXT_MID}}>Fetching and parsing the pre-aggregated dataset — this may take a few moments.</p>
                  <style>{`@keyframes loadbar{0%{width:0%;margin-left:0}60%{width:80%;margin-left:0}100%{width:0%;margin-left:100%}}`}</style>
                </div>
              : <DashboardSection parsedCache={parsedCache} targetVariable={activeVariable} bgBase={BG} bgDark={BG_DARK} bgPanel={BG_PANEL} />
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

      {/* Closing Banner */}
      <div style={{ background: CORAL, padding: isMobile ? "24px 20px" : "28px 48px" }}>
        <div style={{ display: "flex", gap: "40px", alignItems: "flex-start", flexWrap: windowWidth < 1024 ? "wrap" : "nowrap" }}>

          {/* LEFT: Credit Text */}
          <div style={{ flex: 1, minWidth: "260px" }}>
            <p style={{ color: "#fdfdfd", margin: "0 0 14px", fontSize: "clamp(15px, 2.2vw, 18px)", fontWeight: 500, letterSpacing: "-0.2px", opacity: 0.95 }}>
              Credit &amp; Citation
            </p>

            {/* Citation Box */}
            <div id="citation" style={{ background: "rgba(255, 255, 255, 0.12)", border: "1px solid rgba(255, 255, 255, 0.2)", borderRadius: "8px", padding: "12px 14px", marginBottom: "14px" }}>
              <p style={{ fontSize: "11px", color: "rgba(255, 255, 255, 0.75)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 500 }}>
                Cite this dashboard:
              </p>
              <a href="https://doi.org/ADD-DOI" target="_blank" rel="noopener noreferrer" style={{ color: "#fdfdfd", fontSize: "14px", fontWeight: 500, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "6px", borderBottom: "1.5px solid rgba(255, 255, 255, 0.3)", paddingBottom: "2px" }}>
                DOI ↗
              </a>
            </div>

            {/* Description */}
            <p style={{ color: "#fdfdfd", margin: "0 0 10px", fontSize: "13px", lineHeight: "1.6", opacity: 0.9, fontWeight: 400 }}>
              This tool visualises outputs from the SimPaths microsimulation model using data from Understanding Society: the UK Household Longitudinal Study.
            </p>

            <p style={{ color: "#fdfdfd", margin: "0 0 14px", fontSize: "11px", lineHeight: "1.6", opacity: 0.8, fontWeight: 400 }}>
              We acknowledge the contributions of researchers, data providers, and funders supporting this work. Results are modelled estimates and should not be interpreted as forecasts or official statistics.
            </p>

            <p style={{ color: "#fdfdfd", margin: "0 0 14px", fontSize: "11px", lineHeight: "1.6", opacity: 0.8, fontWeight: 400 }}>
              The SimPaths Policy Impacts Visualiser is open-source software, licensed under the European Union Public Licence v. 1.2 (EUPL-1.2).
            </p>

            {/* Links */}
            <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
              <a href="https://github.com/simpaths/SimPaths/blob/main/license.txt" target="_blank" rel="noopener noreferrer" style={{ color: "#fdfdfd", fontSize: "12px", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", borderBottom: "1px solid rgba(255, 255, 255, 0.35)", paddingBottom: "2px", fontWeight: 400, opacity: 0.9 }}>
                License (EUPL-1.2)
              </a>
            </div>
          </div>

          {/* RIGHT: Feedback — prominent, replaces the old logo slot */}
          <div style={{ width: windowWidth < 1024 ? "100%" : "300px", boxSizing: "border-box", flexShrink: 0, background: "rgba(255, 255, 255, 0.14)", border: "1px solid rgba(255, 255, 255, 0.25)", borderRadius: "10px", padding: "18px 20px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: "#fdfdfd" }}>Feedback</h3>
            <p style={{ margin: "0 0 14px", fontSize: "13px", lineHeight: 1.5, color: "#fdfdfd", opacity: 0.9 }}>
              We're happy to receive feedback about the dashboard — let us know what's working, what isn't, or what you'd like to see.
            </p>
            <a href="mailto:healthmod@glasgow.ac.uk?subject=SimPaths%20Data%20Visualiser" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", width: "100%", boxSizing: "border-box", padding: "10px 16px", borderRadius: "6px", background: "#fdfdfd", color: CORAL, fontWeight: 700, fontSize: "14px", textDecoration: "none" }}>
              Send Feedback
            </a>
          </div>

          
        </div>
      </div>
    </div>
  );
}

export default App;