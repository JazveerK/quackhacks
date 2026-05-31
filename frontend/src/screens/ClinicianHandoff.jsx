import { useState, useEffect } from "react"
import Card from "../components/Card"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"
import Pill from "../components/Pill"

// ── Norm range bar visualization ────────────────────────────────────
function NormBar({ score, low, high, label }) {
  // Scale: 0 to high * 1.6 (gives room on both ends)
  const maxScale = Math.max(high * 1.6, score * 1.3)
  const lowPct = (low / maxScale) * 100
  const highPct = (high / maxScale) * 100
  const scorePct = Math.min((score / maxScale) * 100, 98)

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-10 rounded-lg bg-surface overflow-visible">
        {/* Below-average zone */}
        <div
          className="absolute top-0 bottom-0 rounded-l-lg bg-warn/10"
          style={{ left: 0, width: `${lowPct}%` }}
        />
        {/* Average zone */}
        <div
          className="absolute top-0 bottom-0 bg-ok/15"
          style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }}
        />
        {/* Above-average zone */}
        <div
          className="absolute top-0 bottom-0 rounded-r-lg bg-brand/10"
          style={{ left: `${highPct}%`, right: 0 }}
        />
        {/* Score marker */}
        <div
          className="absolute top-0 bottom-0 w-1 bg-ink rounded-full z-10"
          style={{ left: `${scorePct}%` }}
        />
        <div
          className="absolute -top-6 z-10 text-xs font-semibold text-ink transform -translate-x-1/2"
          style={{ left: `${scorePct}%` }}
        >
          {score}
        </div>
        {/* Range labels */}
        <span
          className="absolute bottom-[-20px] text-[10px] text-ink-faint transform -translate-x-1/2"
          style={{ left: `${lowPct}%` }}
        >
          {low}
        </span>
        <span
          className="absolute bottom-[-20px] text-[10px] text-ink-faint transform -translate-x-1/2"
          style={{ left: `${highPct}%` }}
        >
          {high}
        </span>
      </div>
      <div className="flex justify-between text-[10px] text-ink-faint mt-3">
        <span>Below average</span>
        <span>Average</span>
        <span>Above average</span>
      </div>
      {label && (
        <p className="text-xs text-ink-faint text-center">{label}</p>
      )}
    </div>
  )
}

// ── Fall risk indicator ─────────────────────────────────────────────
function FallRiskBadge({ flag }) {
  if (!flag) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-ok-bg">
        <i className="ti ti-shield-check text-ok text-lg" />
        <span className="text-sm text-ok font-medium">No fall-risk signal</span>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warn-bg">
      <i className="ti ti-alert-triangle text-warn text-lg shrink-0 mt-0.5" />
      <div>
        <span className="text-sm text-warn font-medium block">
          Fall-risk screening signal
        </span>
        <span className="text-xs text-ink-soft">
          Below CDC STEADI threshold for this cohort. Screening signal for
          clinician review — not a clinical conclusion.
        </span>
      </div>
    </div>
  )
}

// ── Clinical flags list ─────────────────────────────────────────────
function ClinicalFlags({ components }) {
  const flags = components.filter(
    (c) => c.code?.coding?.[0]?.code?.startsWith("flag-") && c.valueBoolean
  )
  if (flags.length === 0) {
    return (
      <p className="text-sm text-ink-soft">No clinical flags raised this session.</p>
    )
  }

  const flagLabels = {
    "flag-rom-regression": "ROM regression detected",
    "flag-tempo-guarding": "Tempo guarding pattern",
    "flag-progression-stalled": "Progression stalled",
  }

  return (
    <ul className="flex flex-col gap-2">
      {flags.map((f, i) => {
        const code = f.code.coding[0].code
        return (
          <li key={i} className="flex items-center gap-2 text-sm text-ink-soft">
            <i className="ti ti-alert-circle text-warn text-sm shrink-0" />
            <span>{flagLabels[code] || f.code.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

// ── Measurement quality panel ───────────────────────────────────────
function QualityPanel({ components }) {
  const getComp = (code) =>
    components.find((c) => c.code?.coding?.[0]?.code === code)

  const confidence = getComp("tracking-confidence")
  const gate = getComp("quality-gate")
  const source = getComp("tracking-source")
  const calibration = getComp("calibration-id")

  const confValue = confidence?.valueQuantity?.value
  const gateResult = gate?.valueString
  const sourceValue = source?.valueString
  const passed = gateResult === "pass"

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className={`w-3 h-3 rounded-full ${passed ? "bg-ok" : "bg-warn"}`} />
        <span className={`text-sm font-medium ${passed ? "text-ok" : "text-warn"}`}>
          Quality gate: {gateResult}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-xs text-ink-faint uppercase tracking-wide block">Tracking confidence</span>
          <span className="text-ink font-medium">{confValue != null ? `${(confValue * 100).toFixed(0)}%` : "—"}</span>
        </div>
        <div>
          <span className="text-xs text-ink-faint uppercase tracking-wide block">Tracking source</span>
          <span className="text-ink font-medium">{sourceValue || "—"}</span>
        </div>
        <div>
          <span className="text-xs text-ink-faint uppercase tracking-wide block">Calibration</span>
          <span className="text-ink font-medium">{calibration?.valueString || "—"}</span>
        </div>
      </div>
    </div>
  )
}

// ── FHIR JSON viewer ────────────────────────────────────────────────
function FhirViewer({ obs }) {
  return (
    <div className="relative">
      <pre className="bg-[#1e1e2e] text-[#cdd6f4] text-xs leading-relaxed p-4 rounded-lg overflow-x-auto max-h-[600px] overflow-y-auto">
        {JSON.stringify(obs, null, 2)}
      </pre>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(JSON.stringify(obs, null, 2))}
        className="absolute top-3 right-3 px-2.5 py-1 rounded bg-white/10 text-white/70 text-xs hover:bg-white/20 transition-colors"
      >
        <i className="ti ti-copy mr-1" />
        Copy
      </button>
    </div>
  )
}

// ── Mock EHR launch modal ───────────────────────────────────────────
function EhrMockModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-brand-bg text-brand flex items-center justify-center">
            <i className="ti ti-building-hospital text-xl" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-ink">SMART on FHIR Launch</h3>
            <p className="text-xs text-ink-faint">Mock EHR integration</p>
          </div>
        </div>
        <div className="bg-surface rounded-lg p-4 mb-4">
          <p className="text-sm text-ink-soft leading-relaxed">
            In production, this button would initiate a SMART on FHIR launch
            sequence to route the Observation directly into the patient's chart
            in Epic, Cerner, WebPT, or any FHIR R4-compatible EHR.
          </p>
          <div className="mt-3 flex flex-col gap-1.5 text-xs text-ink-faint">
            <span><i className="ti ti-check text-ok mr-1.5" />OAuth 2.0 authorization</span>
            <span><i className="ti ti-check text-ok mr-1.5" />FHIR R4 Observation POST</span>
            <span><i className="ti ti-check text-ok mr-1.5" />Patient chart context</span>
          </div>
        </div>
        <div className="flex justify-end">
          <GhostButton onClick={onClose}>Close</GhostButton>
        </div>
      </div>
    </div>
  )
}

// ── Insufficient quality state ──────────────────────────────────────
function InsufficientQuality() {
  return (
    <div className="flex flex-col items-center gap-4 py-12">
      <div className="w-16 h-16 rounded-full bg-warn-bg text-warn flex items-center justify-center">
        <i className="ti ti-eye-off text-3xl" />
      </div>
      <h2 className="text-lg font-semibold text-ink">Insufficient tracking quality</h2>
      <p className="text-sm text-ink-soft text-center max-w-sm">
        This session's tracking confidence was below the quality threshold.
        The data is not reliable enough for clinical reporting.
      </p>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN CLINICIAN HANDOFF VIEW
// ══════════════════════════════════════════════════════════════════════
export default function ClinicianHandoff({ sessionId, observation: propObs }) {
  const [obs, setObs] = useState(propObs || null)
  const [loading, setLoading] = useState(!propObs)
  const [error, setError] = useState(null)
  const [showFhir, setShowFhir] = useState(false)
  const [showEhrModal, setShowEhrModal] = useState(false)

  useEffect(() => {
    if (propObs) {
      setObs(propObs)
      setLoading(false)
      return
    }
    if (!sessionId) return
    setLoading(true)
    fetch(`/api/share/${sessionId}`)
      .then((r) => {
        if (!r.ok) throw new Error("not found")
        return r.json()
      })
      .then((data) => {
        setObs(data.observation)
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [sessionId, propObs])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <i className="ti ti-loader-2 text-2xl text-ink-faint animate-spin" />
      </div>
    )
  }

  if (error || !obs) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <i className="ti ti-file-off text-4xl text-ink-faint" />
        <h2 className="text-lg font-semibold text-ink">Session not found</h2>
        <p className="text-sm text-ink-soft">No clinician handoff data available for this session.</p>
      </div>
    )
  }

  // Check if this is a low-quality observation
  const isLowQuality = obs.status === "preliminary"
  if (isLowQuality && obs.dataAbsentReason) {
    return <InsufficientQuality />
  }

  // Extract data from the FHIR Observation
  const score = obs.valueQuantity?.value
  const loinc = obs.code?.coding?.[0]
  const interp = obs.interpretation?.[0]
  const interpCode = interp?.coding?.[0]?.code
  const refRange = obs.referenceRange?.[0]
  const refLow = refRange?.low?.value
  const refHigh = refRange?.high?.value
  const cohortText = refRange?.appliesTo?.[0]?.text || ""
  const components = obs.component || []
  const notes = obs.note || []
  const nonDiagNote = notes[0]?.text || ""
  const hasFallRisk = notes.some((n) => n.text?.includes("fall-risk"))
  const hasNorms = !!interp

  // Band display
  const bandLabels = { L: "Below average", N: "Average", H: "Above average" }
  const bandColors = { L: "warn", N: "ok", H: "brand" }

  // Extract component values
  const getComp = (code) =>
    components.find((c) => c.code?.coding?.[0]?.code === code)

  const concentric = getComp("mean-concentric-s")?.valueQuantity?.value
  const eccentric = getComp("mean-eccentric-s")?.valueQuantity?.value
  const peakFlexion = getComp("peak-knee-flexion-deg")?.valueQuantity?.value
  const romDelta = getComp("rom-delta-vs-baseline-deg")?.valueQuantity?.value
  const painNprs = getComp("pain-nprs")
  const adherence = getComp("adherence")?.valueString

  return (
    <div className="flex flex-col gap-4">
      {/* ── Header strip ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <i className="ti ti-report-medical text-brand text-xl" />
          <h1 className="text-lg font-semibold text-ink">Clinician Handoff</h1>
          <Pill variant="brand">FHIR R4</Pill>
        </div>
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => setShowEhrModal(true)}>
            <i className="ti ti-building-hospital text-base" />
            Route to EHR (mock)
          </GhostButton>
        </div>
      </div>

      {/* ── Patient strip ────────────────────────────────────── */}
      <Card className="flex items-center gap-4">
        <div className="w-11 h-11 rounded-full bg-brand-bg text-brand flex items-center justify-center text-sm font-semibold shrink-0">
          <i className="ti ti-user text-lg" />
        </div>
        <div className="flex-1">
          <h2 className="text-base font-semibold text-ink">
            {obs.subject?.reference || "Patient"}
          </h2>
          <p className="text-xs text-ink-soft mt-0.5">
            {cohortText} &middot; {loinc?.display} &middot; {obs.effectiveDateTime?.split("T")[0]}
          </p>
        </div>
        <Pill variant={bandColors[interpCode] || "brand"}>
          {obs.status}
        </Pill>
      </Card>

      {/* ── Non-diagnostic notice ────────────────────────────── */}
      <div className="flex items-start gap-3 rounded-lg bg-brand-bg p-3">
        <i className="ti ti-info-circle text-brand text-lg shrink-0 mt-0.5" />
        <p className="text-xs text-ink-soft leading-relaxed">
          {nonDiagNote}
        </p>
      </div>

      {/* ── STS Assessment card ──────────────────────────────── */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-sm font-medium text-ink">30-Second Sit-to-Stand Assessment</h3>
          <Pill variant="brand">{loinc?.code}</Pill>
        </div>

        <div className="flex items-start gap-6 mb-6">
          <div className="text-center">
            <span className="text-4xl font-bold tabular-nums text-ink">{score}</span>
            <span className="text-sm text-ink-soft ml-1">reps</span>
            {hasNorms && (
              <div className="mt-1">
                <Pill variant={bandColors[interpCode] || "brand"}>
                  {bandLabels[interpCode] || interpCode}
                </Pill>
              </div>
            )}
          </div>
          {hasNorms && refLow != null && refHigh != null && (
            <div className="flex-1 pt-4">
              <NormBar
                score={score}
                low={refLow}
                high={refHigh}
                label={cohortText}
              />
            </div>
          )}
        </div>

        {!hasNorms && (
          <div className="flex items-start gap-2 bg-surface rounded-lg p-3 mb-4">
            <i className="ti ti-info-circle text-ink-faint shrink-0 mt-0.5" />
            <p className="text-xs text-ink-soft">
              Age is outside the validated range (60-94). Raw rep count is reported
              but norm classification is omitted.
            </p>
          </div>
        )}

        <FallRiskBadge flag={hasFallRisk} />
      </Card>

      {/* ── Two-column: Patterns + Quality ───────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Patterns to discuss */}
        <Card>
          <h3 className="text-sm font-medium text-ink mb-3">
            <i className="ti ti-message-report text-brand mr-1.5" />
            Patterns to discuss
          </h3>
          <ClinicalFlags components={components} />
          {/* Tempo + biomechanics */}
          <div className="mt-4 grid grid-cols-2 gap-3">
            {concentric != null && (
              <div>
                <span className="text-xs text-ink-faint uppercase tracking-wide block">Concentric</span>
                <span className="text-sm font-medium text-ink">{concentric}s</span>
              </div>
            )}
            {eccentric != null && (
              <div>
                <span className="text-xs text-ink-faint uppercase tracking-wide block">Eccentric</span>
                <span className="text-sm font-medium text-ink">{eccentric}s</span>
              </div>
            )}
            {peakFlexion != null && (
              <div>
                <span className="text-xs text-ink-faint uppercase tracking-wide block">Peak flexion</span>
                <span className="text-sm font-medium text-ink">{peakFlexion}°</span>
              </div>
            )}
            {romDelta != null && (
              <div>
                <span className="text-xs text-ink-faint uppercase tracking-wide block">ROM vs baseline</span>
                <span className="text-sm font-medium text-ink">{romDelta > 0 ? "+" : ""}{romDelta}°</span>
              </div>
            )}
            {adherence && (
              <div>
                <span className="text-xs text-ink-faint uppercase tracking-wide block">Adherence</span>
                <span className="text-sm font-medium text-ink">{adherence} sets</span>
              </div>
            )}
            {painNprs && (
              <div>
                <span className="text-xs text-ink-faint uppercase tracking-wide block">Pain (NPRS)</span>
                <span className="text-sm font-medium text-ink">
                  {painNprs.valueQuantity?.value ?? painNprs.valueString ?? "—"}
                </span>
              </div>
            )}
          </div>
        </Card>

        {/* Measurement quality */}
        <Card>
          <h3 className="text-sm font-medium text-ink mb-3">
            <i className="ti ti-shield-check text-brand mr-1.5" />
            Measurement quality
          </h3>
          <QualityPanel components={components} />
        </Card>
      </div>

      {/* ── FHIR toggle ──────────────────────────────────────── */}
      <div className="flex justify-center">
        <GhostButton onClick={() => setShowFhir((v) => !v)}>
          <i className={`ti ti-${showFhir ? "eye-off" : "code"} text-base`} />
          {showFhir ? "Hide FHIR Observation" : "View as FHIR Observation"}
        </GhostButton>
      </div>

      {showFhir && (
        <Card className="!p-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-surface border-b border-hair">
            <span className="text-xs font-medium text-ink-soft">
              FHIR R4 Observation &middot; {obs.resourceType}
            </span>
            <div className="flex items-center gap-2">
              <Pill variant="brand">R4</Pill>
              <Pill variant="brand">LOINC {loinc?.code}</Pill>
            </div>
          </div>
          <FhirViewer obs={obs} />
        </Card>
      )}

      {/* ── EHR mock modal ───────────────────────────────────── */}
      {showEhrModal && <EhrMockModal onClose={() => setShowEhrModal(false)} />}
    </div>
  )
}
