import { AlertTriangle, CheckCircle2, CircleDot, XCircle } from 'lucide-react'
import type { Stage, StageKind } from '@/lib/stage'

// Status colour sits on the icon and a faint tint; the label stays in text
// ink so it is readable in both themes and never relies on colour alone.
const STYLE: Record<StageKind, { icon: typeof CircleDot; tone: string; box: string }> = {
  base: { icon: CircleDot, tone: 'text-primary', box: 'border-primary/40 bg-primary/10' },
  'needs-input': {
    icon: AlertTriangle,
    tone: 'text-status-warning',
    box: 'border-status-warning/50 bg-status-warning/15',
  },
  done: { icon: CheckCircle2, tone: 'text-status-good', box: 'border-border bg-muted' },
  failed: {
    icon: XCircle,
    tone: 'text-status-critical',
    box: 'border-status-critical/50 bg-status-critical/15',
  },
}

export function StageBadge({ stage, className = '' }: { stage: Stage; className?: string }) {
  const s = STYLE[stage.kind]
  const Icon = s.icon
  return (
    <span
      className={`inline-flex items-center gap-1 h-4 px-1.5 rounded-sm border text-[10px] font-medium leading-none text-foreground whitespace-nowrap ${s.box} ${className}`}
    >
      <Icon className={`h-2.5 w-2.5 shrink-0 ${s.tone}`} aria-hidden="true" />
      {stage.label}
    </span>
  )
}
