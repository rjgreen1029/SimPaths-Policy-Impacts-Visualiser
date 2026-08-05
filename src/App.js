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
import { useState, useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";
import DashboardSection from "./DashboardSection";
import { parseCsvRow } from "./useAggregatedData";
import { parseLocalFolder } from "./localFolderParser";

/** Which variables appear under each of the four topic-chip domains in the intro card, and their display order within that domain. */
const DOMAIN_SECTIONS = {
  "Demographics": [
    "Highest Level of Education", "Ethnicity", "Partnership status",
   // "Number of children", 
   // "Household Type"
  ],
  "Activity status": ["Employment status", "Hours worked"],
  "Income": [
    "Income Quintile", "UC Benefits Flag", "Financial distress flag",
    "Equivalised yearly disposable income", 
    //"Gross personal employment income",
    "Capital Income", "Amount of benefits received per month"
  ],
  "Health": [
    "Self-Rated Health",  "Disability Status", 
    "Psychological distress score", "Mental Component Summary (MCS)", "Physical Component Summary (PCS)", "Life Satisfaction Score",
    "Subjective wellbeing (GHQ)", "Need of social care", 
    //"Provided social care"
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
  "Highest Level of Education":           "Highest qualification attained (e.g., high, medium, low or in education).",
  "Ethnicity":                            "Self-identified ethnic group classification.",
  "Partnership status":                   "Whether an individual is single or partnered.",
  //"Number of children":                   "Count of dependent children in the household.",
 // "Household Type":                       "Benefit unit composition (e.g., single adult, couple with/without children).",
  "Employment status":                    "Current labour market status (e.g., employed, unemployed, retired, student).",
  "Hours worked":                         "Usual number of paid working hours per week.",
  "Income Quintile":                      "Benefit unit position in the population income distribution split into five equal groups (from lowest (1) to highest (5)).",
  "UC Benefits Flag":                     "Whether the benefit unit receives Universal Credit.",
  "Financial distress flag":              "Indicator of reported difficulty in meeting basic financial commitments.",
  "Equivalised yearly disposable income": "Annual income after taxes and transfers.",
  //"Gross personal employment income":     "Earnings from employment before tax and deductions.",
  "Capital Income":                       "Income from assets such as savings, investments, or property.",
  "Amount of benefits received per month":"Monthly monetary value of welfare benefits received.",
  "Disability Status":                    "Whether the individual reports a limiting long-term illness or disability.",
  "Self-Rated Health":                    "Individual's own assessment of overall health (from excellent to poor).",
  "Psychological distress score":         "Continuous score measuring mental distress severity (from 0–12).",
  "Mental Component Summary (MCS)":       "Mental Component Summary: summary score of mental health-related quality of life (from 0–100).",
  "Physical Component Summary (PCS)":     "Physical Component Summary: summary score of physical health-related quality of life (from 0–100).",
  "Life Satisfaction Score":              "Overall life satisfaction measure (from 0–10).",
  "Subjective wellbeing (GHQ)":           "Self-reported wellbeing measure summing values from the General Health Questionnaire (from 0–36).",
  "Need of social care":                  "Whether an individual has assessed needs for assistance with daily living due to health or disability.",
 // "Provided social care":                 "Whether an individual provides informal care to others.",
};

/**
 * Top-level page component. See the file header above for what it owns vs.
 * delegates. Renders either a "screen too small" notice (below MIN_WIDTH),
 * or the full page: header banner → intro card → sidebar + DashboardSection
 * → closing banner.
 */
function App() {
  const [activeVariable, setActiveVariable]   = useState("Highest Level of Education");
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
  const loadDefaultDataset = useCallback(() => {
    const url = `${process.env.PUBLIC_URL}/SimPaths_All_Aggregated_Outputs.csv`;
    setDefaultLoadFailed(false);
    setStatusMessage("Fetching default package snapshot matrix...");
    d3.csv(url, parseCsvRow)
      .then(rows => {
        if (!rows.length) {
          // A 0-row result usually means the URL resolved to something that
          // isn't the CSV at all (e.g. a host serving its SPA fallback
          // index.html with a 200 status for any unmatched path) rather
          // than a genuine network failure, so it needs its own message.
          throw new Error("File was found but contained no rows — check it's the actual CSV and not an HTML/error page being served at that URL.");
        }
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
      });
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
   * "Visualise Your Own Data" handler — opens the native folder picker,
   * hands the selected directory to parseLocalFolder() (see
   * localFolderParser.js), and swaps parsedCache over to the result on
   * success. An AbortError (user closed the picker without choosing
   * anything) is treated as a silent no-op rather than an error.
   */
  const handleSelectFolder = async () => {
    try {
      const directoryHandle = await window.showDirectoryPicker();
      setIsProcessing(true);
      setStatusMessage("Reading local folder hierarchy...");
      const freshlyAggregated = await parseLocalFolder(directoryHandle, msg => setStatusMessage(msg));
      setParsedCache(freshlyAggregated);
      setIsUsingDefault(false);
      setDefaultLoadFailed(false);
      setIsProcessing(false);
      setStatusMessage("");
    } catch (err) {
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
  const BG       = "#f3ede3";
  const BG_DARK  = "#faf7ef";
  const BG_PANEL = "#f3ede3";
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
      
      {/* Header + Title Banner — logo sits directly in the coral bar */}
      <div style={{ background: CORAL, padding: isMobile ? "14px 16px" : "16px 48px", display: "flex", alignItems: "center", gap: isMobile ? 14 : 24, flexWrap: "wrap" }}>
        <div style={{ background: "#faf7ef", borderRadius: "10px", padding: isMobile ? "5px 8px" : "6px 12px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 1px 3px rgba(0,0,0,0.12)" }}>
          <img src={`${process.env.PUBLIC_URL}/pmh_logo.png`} alt="Logo" style={{ width: isMobile ? "130px" : "200px", maxWidth: "200px", height: "auto", display: "block", objectFit: "contain" }} />
        </div>
        <p style={{ color: "#faf7ef", margin: "0", fontSize: "clamp(20px, 4.5vw, 36px)", fontWeight: 600, lineHeight: 1.2, flex: 1, minWidth: "180px" }}>
          SimPaths Policy Impacts Visualiser
        </p>
      </div>

      {/* Main Content Container */}
      <div style={{ padding: isMobile ? "10px 16px" : "10px 48px", display: "flex", flexDirection: "column", gap: isMobile ? 20 : 30 }}>
        
       {/* Intro Card */}
<div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap" }}>
  <div style={{ background: BG_DARK, border: `0.5px solid ${BG_PANEL}`, borderRadius: "12px", padding: isMobile ? "22px 20px" : "32px 40px", maxWidth: "2000px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", flex: 1, minWidth: windowWidth < 1280 ? "100%" : "auto" }}>

    {/* Tagline */}
    <p style={{ margin: "0 0 6px", fontSize: "clamp(18px, 2.6vw, 24px)", fontWeight: 700, color: TEAL, letterSpacing: "-0.3px", lineHeight: 1.3 }}>
      See how a policy may play out in the UK — before it happens.
    </p>

    {/* Row: all body text (left) + Learn More / Resources sidebar (right) — sidebar top aligns with the "Explore changes" text since the Tagline sits above this row */}
    <div style={{ display: "flex", gap: "32px", alignItems: "flex-start", flexWrap: windowWidth < 900 ? "wrap" : "nowrap" }}>

      {/* Left: all the card's text content */}
      <div style={{ flex: 1.7, minWidth: windowWidth < 900 ? "100%" : "320px" }}>

        <p style={{ margin: "0 0 10px", fontSize: "14px", color: TEXT_MID, lineHeight: 1.6 }}>
          Explore changes across a simulated population under a policy <strong>scenario</strong> against a <strong>baseline</strong> with no change — across variables like income, health, work and family life.
        </p>

        {/* Main description */}
        <div style={{ marginBottom: "18px" }}>
          <p style={{ margin: "0 0 14px", lineHeight: 1.8, color: TEXT_DARK, fontSize: "clamp(14px, 2vw, 16px)" }}>
            This dashboard visualises outputs from <a href="https://simpaths.org/" target="_blank" rel="noopener noreferrer" style={{ color: AQUA, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "2px", transition: "opacity 0.2s" }}>SimPaths</a>, a dynamic microsimulation model developed by the Centre for Microsimulation and Policy Analysis (<a href="https://www.microsimulation.ac.uk/" target="_blank" rel="noopener noreferrer" style={{ color: AQUA, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "2px", transition: "opacity 0.2s" }}>CeMPA</a>) at the University of Essex. It was built by researchers at the University of Glasgow as part of the <a href="https://www.phiuk.org/policy-modelling-for-health" target="_blank" rel="noopener noreferrer" style={{ color: AQUA, textDecoration: "none", borderBottom: `2px solid ${AQUA}`, paddingBottom: "2px", transition: "opacity 0.2s" }}>Policy Modelling for Health</a> research group.
          </p>
          <p style={{ margin: 0, lineHeight: 1.8, color: TEXT_DARK, fontSize: "clamp(14px, 2vw, 16px)" }}>
            SimPaths simulates the life-course trajectories of a population — how demographics, employment, income, wealth and health change over time — and how those trajectories may change during a simulated a policy <strong> scenario</strong> (e.g., ). This dashboard lets you explore those simulated outcomes interactively: pick a variable, stratify it by age, gender, region and more, and compare Baseline data against Scenario data over time, at a single point in time, or as the difference between the two.
          </p>
        </div>

        {/* Getting Started — sits under the main description, above Limitations */}
        <div style={{ background: `${AQUA}08`, border: `1px solid ${AQUA}20`, borderRadius: "8px", padding: isMobile ? "16px" : "18px", marginBottom: "18px", borderLeft: `4px solid ${AQUA}` }}>
          <h4 style={{ margin: "0 0 10px", fontSize: "13px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, color: TEAL }}>Getting Started</h4>
          <p style={{ margin: "0 0 10px", lineHeight: 1.6, color: TEXT_MID, fontSize: "13.5px" }}>
            The default view displays a pre-aggregated dataset. To visualise your own simulation, select your parent folder in the Connect Data panel (data must be organised into "Baseline" and "Scenario" subfolders).
          </p>
          <p style={{ margin: 0, lineHeight: 1.6, color: TEXT_MID, fontSize: "13.5px" }}>
            This tool is entirely JavaScript-based — all aggregation happens locally in your browser, and no data you upload is ever stored or sent anywhere.
          </p>
        </div>

        {/* Limitations & Interpretation */}
        <div id="interpreting-results" style={{ background: "#fee8e2", border: `1px solid #fed7ca`, borderRadius: "8px", padding: isMobile ? "14px 16px" : "16px 20px", borderLeft: `4px solid ${CORAL}` }}>
          <h4 style={{ margin: "0 0 8px", fontSize: "13px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, color: "#c2410c" }}>Limitations &amp; Interpretation</h4>
          <p style={{ margin: "0 0 8px", fontSize: "13px", color: "#e34f32", lineHeight: 1.6 }}>
            The outputs presented here are based on simulated data and are intended for research purposes only — they should not be interpreted as forecasts or official statistics.
          </p>
          <p style={{ margin: 0, fontSize: "13px", color: "#e34f32", lineHeight: 1.6 }}>
            Every figure is an average across multiple model runs, shown with a 95% confidence interval; where the underlying sample within a run is too small to be reliable, that estimate is suppressed rather than shown. Differences between Baseline and Scenario reflect the modelled effect of the policy change being tested, not an observed real-world outcome.
          </p>
        </div>
      </div>

      {/* Right: topic chips (jump to a domain) sit above Learn More / Resources */}
      <div style={{ flex: 1, minWidth: windowWidth < 900 ? "100%" : "220px", maxWidth: windowWidth < 900 ? "none" : "260px" }}>

        {/* Topic teaser chips — jump straight into a domain */}
        <p style={{ margin: "0 0 8px", fontSize: "11px", fontWeight: 700, color: TEAL, textTransform: "uppercase", letterSpacing: "0.05em" }}>Explore by topic</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "20px" }}>
          {Object.entries(DOMAIN_SECTIONS).map(([domain, vars]) => {
            const color = DOMAIN_COLORS[domain] || TEAL;
            return (
              <button key={domain} onClick={() => jumpToDomain(domain)} style={{ display: "flex", flexDirection: "column", gap: "2px", textAlign: "left", width: "100%", boxSizing: "border-box", background: `${color}10`, border: `1px solid ${color}35`, borderRadius: "10px", padding: "9px 14px", cursor: "pointer" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color }}>{domain} →</span>
                <span style={{ fontSize: "11px", color: TEXT_MID }}>{DOMAIN_BLURBS[domain]}</span>
              </button>
            );
          })}
        </div>

        {/* Learn More */}
        <div style={{ marginBottom: "20px" }}>
          <p style={{ margin: "0 0 8px", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, color: TEAL }}>Learn More</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <a href="https://simpaths.org/getting-started/data/" target="_blank" rel="noopener noreferrer" style={smallLinkStyle}>About the Dataset</a>
            <a href={`${process.env.PUBLIC_URL}/interpreting-results.html`} target="_blank" rel="noopener noreferrer" style={smallLinkStyle}>Interpreting the Results</a>
            <a href={`${process.env.PUBLIC_URL}/citation.html`} target="_blank" rel="noopener noreferrer" style={smallLinkStyle}>How Do I Cite This?</a>
          </div>
        </div>

        {/* More Resources */}
        <div>
          <p style={{ margin: "0 0 8px", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, color: TEAL }}>More Resources</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <a href="https://simpaths.org/" target="_blank" rel="noopener noreferrer" style={smallLinkStyle}>Documentation</a>
            <a href="https://github.com/simpaths/SimPaths" target="_blank" rel="noopener noreferrer" style={smallLinkStyle}>GitHub Repository</a>
            <a href="https://www.phiuk.org/policy-modelling-for-health" target="_blank" rel="noopener noreferrer" style={smallLinkStyle}>Policy Modelling for Health</a>
            <a href="https://youtu.be/fqfNmjTWUEA" target="_blank" rel="noopener noreferrer" style={smallLinkStyle}>SimPaths Webinar</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

        {/* Workspace Operations */}
        <div style={{ display: "flex", gap: 30, alignItems: "flex-start", flexWrap: windowWidth < 1200 ? "wrap" : "nowrap" }}>
          
          {/* Left Sidebar */}
          <div style={{ width: "300px", flexShrink: 0, display: "flex", flexDirection: "column", gap: 20, minWidth: windowWidth < 1200 ? "100%" : "300px" }}>
            
            {/* Connect Data Card */}
            <div style={{ background: BG_DARK, border: `1px solid ${BG_PANEL}`, padding: 20, borderRadius: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
                            <div style={{ background: CORAL, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, textTransform: "uppercase", letterSpacing: "0.05em", color: "#fff", fontWeight: 700 }}>Connect Data</h3>
              </div>
              <p style = {{margin: "0 0 8px", fontSize: 12, color: TEXT_DARK}}> Select parent folder with runs organised into "Baseline" and "Scenario" subfolders</p>
              <p style={{ margin: "0 0 16px", fontSize: 11, color: TEAL, lineHeight: 1.5, fontStyle: "italic" }}>
                Nothing you select is uploaded or stored anywhere — all aggregation happens locally, in your browser.
              </p>
              
              <button onClick={handleSelectFolder} disabled={isProcessing} style={{margin: "0 0 10px", width: "100%", padding: "10px", borderRadius: 6, border: `1px solid ${AQUA}`, background: AQUA, color: BG_DARK, fontWeight: 600, fontSize: 16, textAlign: "center", cursor: "pointer" }}>
                {isProcessing ? "Aggregating data..." : "Visualise Your Own Data"}
              </button>
            
              {statusMessage && <p style={{ fontSize: 11, color: "#c2410c", margin: "8px 0 0", fontStyle: "italic", lineHeight: 1.4 }}>{statusMessage}</p>}
              <div style={{
                fontSize: 12,
                color: defaultLoadFailed ? "#b91c1c" : isUsingDefault ? TEXT_MID : "#166534",
                marginBottom: 0, padding: "2px 2px",
                background: defaultLoadFailed ? "#fee2e2" : isUsingDefault ? BG_DARK : "#dcfce7",
                borderRadius: 0, fontWeight: 500,
              }}>
                {defaultLoadFailed
                  ? "Preloaded data failed to load"
                  : isUsingDefault ? "Currently displaying: preloaded data" : "Currently displaying: user uploaded data"}
                {defaultLoadFailed && (
                  <span style={{ cursor: "pointer", float: "right", color: TEAL, fontWeight: "bold", textDecoration: "underline" }} onClick={loadDefaultDataset}>↻ Retry</span>
                )}
                {!isUsingDefault && (
                  <span style={{ cursor: "pointer", float: "right", color: "#b91c1c", fontWeight: "bold" }} onClick={loadDefaultDataset}>✕</span>
                )}
              </div>
            </div>

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
                            {v}
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
              <h2 style={{ margin: 0, fontSize: "clamp(18px, 2.8vw, 22px)", color: "#fff", fontWeight: 800, letterSpacing: "-0.2px" }}>{activeVariable}</h2>
            </div>
            {VARIABLE_DESCRIPTIONS[activeVariable] && (
              <p style={{ margin: "0 0 6px", fontSize: "clamp(12px, 1.5vw, 13px)", color: TEXT_MID, fontStyle: "italic", lineHeight: 1.5 }}>
                {VARIABLE_DESCRIPTIONS[activeVariable]}
              </p>
            )}
            <p style={{ margin: "0 0 20px", fontSize: "clamp(12px, 1.5vw, 13px)", color: "#64748b" }}>
              Side-by-side comparative graphics between the <strong>Baseline</strong> and the chosen <strong>Policy Scenario</strong> outputs.
            </p>
            <hr style={{ border: "none", borderTop: `1px solid ${BG_PANEL}`, marginBottom: 20 }} />
            <DashboardSection parsedCache={parsedCache} targetVariable={activeVariable} bgBase={BG} bgDark={BG_DARK} bgPanel={BG_PANEL} />
          </div>
        </div>
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

            {/* Links */}
            <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
              <a href="https://github.com/simpaths/SimPaths/blob/main/license.txt" target="_blank" rel="noopener noreferrer" style={{ color: "#fdfdfd", fontSize: "12px", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px", borderBottom: "1px solid rgba(255, 255, 255, 0.35)", paddingBottom: "2px", fontWeight: 400, opacity: 0.9 }}>
                SimPaths License
              </a>
            </div>
          </div>

          {/* RIGHT: Feedback — prominent, replaces the old logo slot */}
          <div style={{ width: windowWidth < 1024 ? "100%" : "300px", flexShrink: 0, background: "rgba(255, 255, 255, 0.14)", border: "1px solid rgba(255, 255, 255, 0.25)", borderRadius: "10px", padding: "18px 20px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: "#fdfdfd" }}>Feedback</h3>
            <p style={{ margin: "0 0 14px", fontSize: "13px", lineHeight: 1.5, color: "#fdfdfd", opacity: 0.9 }}>
              We're happy to receive feedback about the dashboard — let us know what's working, what isn't, or what you'd like to see.
            </p>
            <a href="mailto:healthmod@glasgow.ac.uk?subject=SimPaths%20Data%20Visualiser" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", width: "100%", boxSizing: "border-box", padding: "10px 16px", borderRadius: "6px", background: "#fdfdfd", color: CORAL, fontWeight: 700, fontSize: "14px", textDecoration: "none" }}>
              Send Feedback
            </a>
          </div>

          {/* FAR RIGHT: PNG slot — e.g. funder/partner logos. Drop the image at
              public/bottom_banner_image.png; the slot stays invisible until it exists. */}
          <div style={{ width: windowWidth < 1024 ? "100%" : "200px", flexShrink: 0, background: "rgba(255, 255, 255, 0.14)", border: "1px solid rgba(255, 255, 255, 0.25)", borderRadius: "10px", padding: "14px", minHeight: "80px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <img
              src={`${process.env.PUBLIC_URL}/UKRILogo.png`}
              alt="UKRI funder logo"
              style={{ maxWidth: "100%", maxHeight: "90px", objectFit: "contain", display: "block" }}
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;