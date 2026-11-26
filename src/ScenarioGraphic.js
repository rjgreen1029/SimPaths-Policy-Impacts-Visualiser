/**
 * ScenarioGraphic.js — small schematic of the default dataset's education
 * scenario, shown in the intro card's "Getting Started" box.
 *
 * It is ILLUSTRATIVE, not data: bar lengths are not to scale. It shows who
 * the policy targets (16–29 year olds), when it starts (2025), and how the
 * scenario differs from the Baseline (+5% in education).
 *
 * To change the scenarios shown, edit the SCENARIOS array below.
 */

const TEAL = "#14687c";
const AQUA = "#0f93a1";
const GREY = "#586369";      // matches NUMERIC_BASE_COLOUR in DashboardSection.js
const TEXT_MID = "#475569";

// uplift: extra bar width (%) drawn for the scenario — exaggerated so it is visible
const SCENARIOS = [
  { label: "Baseline",                    note: "No policy change", uplift: 0,  tag: null },
  { label: "Increased Education Scenario", note: "+5% in education", uplift: 15, tag: "+5%" },
];
const BASE_WIDTH = 55;

/** Person icon (head + shoulders), used to show the 16–29 target group. */
function Person({ colour }) {
  return (
    <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true" style={{ display: "block" }}>
      <circle cx="7" cy="4.5" r="3.6" fill={colour} />
      <path d="M0.5 18 C0.5 11.5 3.5 9.5 7 9.5 C10.5 9.5 13.5 11.5 13.5 18 Z" fill={colour} />
    </svg>
  );
}

export default function ScenarioGraphic({ isMobile }) {
  const hatch = `repeating-linear-gradient(45deg, ${AQUA} 0 3px, ${AQUA}55 3px 6px)`;

  return (
    <figure
      aria-label="Diagram of the education scenario: from 2025, the share of 16 to 29 year olds in education rises by 5% in the Increased Education Scenario, compared with a Baseline with no policy change."
      style={{ margin: 0, background: "#ffffff", border: `1px solid ${AQUA}25`, borderRadius: "8px", padding: isMobile ? "12px" : "14px 16px" }}
    >
      {/* Who / when */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px", marginBottom: "14px", paddingBottom: "12px", borderBottom: `1px solid ${AQUA}20` }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ display: "flex", gap: "2px" }}>
            {[0, 1, 2, 3, 4].map(i => <Person key={i} colour={i < 2 ? AQUA : `${TEAL}55`} />)}
          </div>
          <span style={{ fontSize: "12.5px", color: TEXT_MID }}><strong style={{ color: TEAL }}>Who:</strong> 16–29 year olds</span>
        </div>
        <span style={{ fontSize: "12.5px", color: TEXT_MID }}><strong style={{ color: TEAL }}>When:</strong> policy starts in 2025</span>
        <span style={{ fontSize: "12.5px", color: TEXT_MID }}><strong style={{ color: TEAL }}>What:</strong> more young people stay in education</span>
      </div>

      {/* Bars */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {SCENARIOS.map(s => (
          <div key={s.label} style={{ display: "grid", gridTemplateColumns: "1fr", alignItems: "center", gap: "4px" }}>
            <span style={{ fontSize: "12.5px", fontWeight: 600, color: s.uplift ? TEAL : GREY }}>{s.label}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
              <div style={{ flex: 1, display: "flex", height: "16px", background: "#eef2f4", borderRadius: "3px", overflow: "hidden" }}>
                <div style={{ width: `${BASE_WIDTH}%`, background: GREY }} />
                {s.uplift > 0 && <div style={{ width: `${s.uplift}%`, background: hatch, borderLeft: "2px solid #fff" }} />}
              </div>
              <span style={{ fontSize: "12px", color: s.uplift ? AQUA : TEXT_MID, fontWeight: s.uplift ? 700 : 400, whiteSpace: "nowrap", minWidth: "112px" }}>{s.note}</span>
            </div>
          </div>
        ))}
      </div>

      <figcaption style={{ marginTop: "14px", fontSize: "11px", color: TEXT_MID, display: "flex", flexDirection: "column", gap: "5px", alignItems: "flex-start" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "12px", height: "10px", background: GREY, borderRadius: "2px", display: "inline-block" }} /> Share of 16–29s in education (Baseline)
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <span style={{ width: "12px", height: "10px", background: hatch, borderRadius: "2px", display: "inline-block" }} /> Extra share in education under the scenario
        </span>
        <span style={{ fontStyle: "italic" }}>Illustrative only — not to scale.</span>
      </figcaption>
    </figure>
  );
}
