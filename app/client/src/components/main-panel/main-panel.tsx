import { useUIStore } from '@/stores/ui-store'
import { useEffectiveEvents } from '@/hooks/use-effective-events'
import { useAgents } from '@/hooks/use-agents'
import { useSessions } from '@/hooks/use-sessions'
import { EventProcessingProvider } from '@/agents/event-processing-context'
import { SessionBreadcrumb } from './session-breadcrumb'
import { ScopeBar } from './scope-bar'
import { EventFilterBar } from './event-filter-bar'
import { ActivityTimeline } from '@/components/timeline/activity-timeline'
import { EventStream } from '@/components/event-stream/event-stream'
import { CommsGraph } from '@/components/comms-graph/comms-graph'
import { HomePage } from './home-page'
import { ProjectPage } from './project-page'
import { useRegionShortcuts } from '@/hooks/use-region-shortcuts'

export function MainPanel() {
  const { selectedProjectId, selectedProjectSlug, selectedSessionId, routeError } = useUIStore()

  // A session route renders as soon as we know the session id — even with no
  // resolved (or no existing) project. Unassigned sessions have no project at
  // all, and skill deep-links (/observe view, /observe stats) plus direct
  // `#/_/<sessionId>` URLs must ALWAYS land on the session, never a blank panel.
  // SessionView keys its data off the session id; the project is optional.
  if (selectedSessionId) {
    // useRouteSync flags an id that resolved to no row, so a dead deep link
    // shows a clear message instead of an empty event stream.
    if (routeError === selectedSessionId) return <RouteNotFound target={selectedSessionId} />
    return <SessionView sessionId={selectedSessionId} projectId={selectedProjectId} />
  }

  // No session in the route. A bare project slug from the URL still needs its
  // id resolved asynchronously by `useRouteSync` (via /api/projects). Render
  // nothing during that window rather than flashing HomePage — which would
  // fire /api/sessions/recent and other home queries that get torn down a
  // tick later.
  if (!selectedProjectId && selectedProjectSlug) {
    if (routeError === selectedProjectSlug) return <RouteNotFound target={selectedProjectSlug} />
    return <div className="flex-1" />
  }

  if (!selectedProjectId) {
    return <HomePage />
  }

  return <ProjectPage />
}

// Shown when a URL references a session id / project slug that no longer
// exists (e.g. a stale bookmark or a deleted session). Clicking returns home.
function RouteNotFound({ target }: { target: string }) {
  const setSelectedProject = useUIStore((s) => s.setSelectedProject)
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <p className="text-sm">
        Nothing found for <span className="font-mono text-foreground">{target}</span>.
      </p>
      <button
        className="text-sm text-foreground underline underline-offset-4 hover:opacity-80 cursor-pointer"
        onClick={() => setSelectedProject(null)}
      >
        Back to dashboard
      </button>
    </div>
  )
}

// Timeline / Graph switch for the session body. Timeline is the default.
function ViewToggle() {
  const mode = useUIStore((s) => s.sessionViewMode)
  const setMode = useUIStore((s) => s.setSessionViewMode)
  const options: Array<['timeline' | 'graph', string]> = [
    ['timeline', 'Timeline'],
    ['graph', 'Graph'],
  ]
  return (
    <div className="flex items-center gap-1 px-3 py-1 border-b border-border" role="tablist">
      {options.map(([value, label]) => (
        <button
          key={value}
          role="tab"
          aria-selected={mode === value}
          onClick={() => setMode(value)}
          className={`px-2 py-0.5 text-xs rounded cursor-pointer ${
            mode === value
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function SessionView({ sessionId, projectId }: { sessionId: string; projectId: number | null }) {
  useRegionShortcuts()
  const { data: sessions } = useSessions(projectId)
  const effectiveSessionId = sessionId || sessions?.[0]?.id || null
  const eventsQuery = useEffectiveEvents(effectiveSessionId)
  const rawEvents = eventsQuery.data
  const agents = useAgents(effectiveSessionId, rawEvents)
  const viewMode = useUIStore((s) => s.sessionViewMode)

  return (
    <EventProcessingProvider rawEvents={rawEvents} agents={agents}>
      <div className="flex-1 flex flex-col overflow-hidden">
        <SessionBreadcrumb />
        <ScopeBar />
        <EventFilterBar />
        <ViewToggle />
        {viewMode === 'graph' ? (
          <CommsGraph events={rawEvents} agents={agents} />
        ) : (
          <>
            <ActivityTimeline />
            <EventStream key={sessionId} />
          </>
        )}
      </div>
    </EventProcessingProvider>
  )
}
