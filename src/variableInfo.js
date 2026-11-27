/**
 * variableInfo.js — plain-English descriptions of the variables, shared by the
 * dashboard (App.js, InfoPages.js) and the About sheet of the .xlsx downloads
 * (datasetExport.js). Plain text only, so any module can use it.
 */

/** Plain-English definition of a benefit unit, shared by the Dataset tab's
 *  "Key terms" and the ⓘ hover in variable descriptions (App.js) and the About sheet of the .xlsx downloads. */
export const BENEFIT_UNIT_DEFINITION = "A single adult or a couple, together with any dependent children they are responsible for. It is the unit used to assess benefit entitlement, and can be smaller than a household — for example, an adult living with their parents is a separate benefit unit.";


/** Tooltip/help text shown alongside each variable in the sidebar variable picker. Also used for the About sheet of the .xlsx downloads. */
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
  "Self-Rated Health":                    "Individual's own assessment of overall health (from excellent to poor).",
  // "Psychological distress flag":          "Indicator of clinically relevant mental distress.", // temporarily disabled
  "Mental Component Summary (MCS)":       "Mental Component Summary: summary score of mental health-related quality of life (from 0–100).",
  "Physical Component Summary (PCS)":     "Physical Component Summary: summary score of physical health-related quality of life (from 0–100).",
  "Life Satisfaction Score":              "Overall life satisfaction measure (from 0–10).",
  "Psychological distress score":         "Subjective wellbeing (GHQ): Scale 0 (the least distressed) to 12 (the most distressed)",
  "Subjective wellbeing (GHQ)":           "Self-reported wellbeing measure summing values from the General Health Questionnaire from 0 (indicating the least amount of distress) to 36 (indicating the greatest amount of distress).",
  "Provided care":                        "Whether someone in the benefit unit provides social care to someone else.",
  "Received care":                        "Whether the individual receives social care whether informal (e.g. from family or friends), formal (paid) care, or mixed.",
};

/** What the groups used to split the population mean (other stratifiers are
 *  variables too, and use VARIABLE_DESCRIPTIONS). */
export const STRATIFIER_DESCRIPTIONS = {
  "Age": "Age in years (grouped into bands when used to split the population; single years in the population pyramid).",
  "Gender": "Male or female.",
  "Region": "UK nation, or region of England, where the person lives.",
};

/** Variables measured for the benefit unit rather than the person. Each person
 *  is given their benefit unit's value, so results count people, not benefit
 *  units — a short, variable-specific note says what that means. */
export const BENEFIT_UNIT_NOTES = {
  "Income Quintile":
    "Shares are of people, not benefit units: everyone takes their benefit unit's quintile, so a three-person benefit unit in quintile 3 counts three times. This is why the five groups are not 20% each.",
  "Household Type":
    "Shares are of people, not benefit units: everyone takes their benefit unit's type, so a couple with two children counts four times.",
  "Equivalised yearly disposable income":
    "Averaged over people, not benefit units: everyone takes their benefit unit's equivalised income, so larger benefit units count more.",
  "Amount of benefits received per month":
    "This is the benefit unit's total, averaged over people: everyone takes their benefit unit's amount, so larger benefit units count more.",
  "Provided care":
    "Shares are of people, not benefit units: everyone in a benefit unit where someone provides care is counted, so a three-person benefit unit counts three times.",
};
