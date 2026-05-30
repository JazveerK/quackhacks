import CameraFeed from './CameraFeed'
import RepCounter from './RepCounter'
import DepthGauge from './DepthGauge'
import TempoDisplay from './TempoDisplay'
import TrackingSource from './TrackingSource'
import RepBars from './RepBars'
import FormCueBanner from './FormCueBanner'
import SetupHint from './SetupHint'

export default function LiveSession({ state, frame, profile, onEndSet, onStartNext }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 grid grid-cols-[1fr_280px_170px] gap-3 p-3 min-h-0">
        {/* Camera column (60%) */}
        <CameraFeed frame={frame} state={state} />

        {/* Metrics column (25%) */}
        <div className="flex flex-col gap-3 min-h-0 overflow-y-auto">
          <RepCounter state={state} />
          <DepthGauge state={state} profile={profile} />
          <TempoDisplay state={state} />
          <RepBars depths={state?.rep_depths} targetDeg={profile?.depth_deg} />
          <SetupHint state={state} />
        </div>

        {/* Sidebar column (15%) */}
        <div className="flex flex-col gap-3 min-h-0">
          <TrackingSource state={state} />

          {/* Controls */}
          <div className="mt-auto flex flex-col gap-2">
            <button
              onClick={onEndSet}
              className="w-full text-xs border border-border rounded-lg px-3 py-2 text-secondary-text hover:bg-surface transition-colors"
            >
              End set
            </button>
            <button
              onClick={onStartNext}
              className="w-full text-xs bg-info text-white rounded-lg px-3 py-2 font-medium hover:opacity-90 transition-opacity"
            >
              Next set
            </button>
          </div>
        </div>
      </div>

      <FormCueBanner state={state} />
    </div>
  )
}
