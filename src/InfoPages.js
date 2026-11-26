/**
 * InfoPages.js — the "Dataset" and "More Resources" tabs. Styled to match the
 * standalone pages in public/ (interpreting-results.html etc.) that the other
 * information tabs show.
 */
const TEAL = "#14687c", AQUA = "#0f93a1", TEXT_DARK = "#1e293b", TEXT_MID = "#475569", BG_DARK = "#fcfaf5";

const S = {
  container: { width: "100%", boxSizing: "border-box", maxWidth: 880, margin: "0 auto", padding: "40px 24px 56px", display: "flex", flexDirection: "column", gap: 22 },
  eyebrow: { fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: AQUA, margin: "0 0 8px" },
  h1: { fontSize: "clamp(26px,4.2vw,36px)", fontWeight: 700, color: TEAL, margin: "0 0 12px", letterSpacing: "-0.4px" },
  lede: { fontSize: 16, color: TEXT_MID, lineHeight: 1.7, margin: 0, maxWidth: 680 },
  card: { background: BG_DARK, borderRadius: 12, padding: "28px 32px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" },
  h2: { fontSize: 19, fontWeight: 700, color: TEXT_DARK, margin: "0 0 12px", letterSpacing: "-0.2px" },
  p: { fontSize: 15, color: TEXT_DARK, lineHeight: 1.8, margin: "0 0 14px" },
  pLast: { fontSize: 15, color: TEXT_DARK, lineHeight: 1.8, margin: 0 },
  linkBtn: { color: AQUA, textDecoration: "none", fontSize: 13, padding: "8px 14px", background: "rgba(15,147,161,0.06)", borderRadius: 6, border: "1px solid rgba(15,147,161,0.22)", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 6 },
  linkRow: { display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6 },
};

const ext = { target: "_blank", rel: "noopener noreferrer" };

/** Plain-English definition of a benefit unit, shared by the Dataset tab's
 *  "Key terms" and the ⓘ hover in variable descriptions (App.js). */
export const BENEFIT_UNIT_DEFINITION = "A single adult or a couple, together with any dependent children they are responsible for. It is the unit used to assess benefit entitlement, and can be smaller than a household — for example, an adult living with their parents is a separate benefit unit.";

/** "Dataset" tab: what data the visualiser shows and how to use your own. */
export function DatasetPage({ onNavigate }) {
  return (
    <div style={S.container}>
      <div>
        <p style={S.eyebrow}>About the data</p>
        <h1 style={S.h1}>Dataset</h1>
        <p style={S.lede}>The visualiser shows outputs from SimPaths, a dynamic microsimulation model that simulates the life courses of a representative UK population.</p>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>Where the data comes from</h2>
        <p style={S.p}>SimPaths starts from a representative sample of the UK population drawn from <strong>Understanding Society: the UK Household Longitudinal Study</strong>, and simulates how each person's demographics, employment, income and health change year by year.</p>
        <p style={S.pLast}>Every figure in the visualiser is an average across several model runs. Estimates based on fewer than 20 people in any single run are suppressed, and missing values (coded −9 in SimPaths) are left out rather than treated as zero.</p>
        <div style={S.linkRow}>
          <a style={S.linkBtn} href="https://simpaths.org/getting-started/data/" {...ext}>SimPaths data documentation ↗</a>
          <a style={S.linkBtn} href="#/interpreting-results" onClick={e => { e.preventDefault(); onNavigate("interpreting-results"); }}>Interpreting the results →</a>
        </div>
      </div>

      <div style={S.card} id="key-terms">
        <h2 style={S.h2}>Key terms</h2>
        <p style={S.pLast}><strong>Benefit unit</strong> — {BENEFIT_UNIT_DEFINITION} Some variables are measured for the benefit unit rather than the individual (household type, income quintile, benefits received, equivalised income, region and provided care); every person in a benefit unit gets that unit's value.</p>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>The preloaded dataset</h2>
        <p style={S.pLast}>By default the visualiser shows a simulated education policy scenario applied to 16–29 year olds from 2025, compared with a <strong>Baseline</strong> with no policy change. The <strong>Increased Education Scenario</strong> increases the proportion of 16–29 year olds in education by 5%.</p>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>Using your own SimPaths output</h2>
        <p style={S.p}>On the Visualiser tab, choose <strong>Visualise Your Own Data</strong> and select a folder containing a <strong>Baseline</strong> folder and one or more scenario folders, each holding the run folders from your SimPaths output. Runs are matched between Baseline and scenarios by the seed number in the run folder's name.</p>
        <pre style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 8, padding: "12px 16px", fontSize: 12.5, lineHeight: 1.5, margin: "0 0 14px", overflowX: "auto" }}>
{`Your Data Folder/
├── Baseline/
│   ├── Run 1/
│   └── Run 2/
└── Scenario/
    ├── Run 1/
    └── Run 2/`}
        </pre>
        <p style={S.pLast}>Everything is processed in your browser: nothing you select is uploaded or stored. This needs a Chromium-based browser such as Chrome or Edge.</p>
        <div style={S.linkRow}>
          <a style={S.linkBtn} href="#/visualiser" onClick={e => { e.preventDefault(); onNavigate("visualiser"); }}>Go to the Visualiser →</a>
        </div>
      </div>
    </div>
  );
}

const RESOURCES = [
  { title: "SimPaths documentation", href: "https://simpaths.org/", text: "How the SimPaths model works: its modules, data and assumptions." },
  { title: "SimPaths webinar", href: "https://youtu.be/fqfNmjTWUEA", text: "A recorded introduction to SimPaths and what it can be used for." },
  { title: "Policy Modelling for Health", href: "https://www.phiuk.org/policy-modelling-for-health", text: "The PHI UK research group (funded by UKRI) that built this visualiser." },
  { title: "GitHub repository", href: "https://github.com/rjgreen1029/SimPaths-Policy-Impacts-Visualiser", text: "Source code for the visualiser, including how the data is aggregated." },
];

/** "More Resources" tab: the external links that used to sit in the intro card. */
export function ResourcesPage() {
  return (
    <div style={S.container}>
      <div>
        <p style={S.eyebrow}>Find out more</p>
        <h1 style={S.h1}>More resources</h1>
        <p style={S.lede}>Further reading on SimPaths and the team behind this visualiser.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        {RESOURCES.map(r => (
          <a key={r.href} href={r.href} {...ext} style={{ ...S.card, padding: "22px 24px", textDecoration: "none", display: "block", border: "1px solid transparent" }}>
            <h2 style={{ ...S.h2, fontSize: 17, color: TEAL, marginBottom: 8 }}>{r.title} ↗</h2>
            <p style={{ ...S.pLast, fontSize: 14, color: TEXT_MID, lineHeight: 1.6 }}>{r.text}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
