import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'

const RANGES = [7, 30, 90] as const
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function CostsTab() {
  const [days, setDays] = useState<number>(30)
  const { data, error, isLoading } = useQuery({
    queryKey: ['daily-costs', days],
    queryFn: () => api.getDailyCosts(days),
    staleTime: 60_000,
  })
  const max = Math.max(1, ...(data?.days.map((d) => d.costCents) ?? []))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setDays(r)}
            className={`rounded px-2 py-1 text-sm ${days === r ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
          >
            {r}d
          </button>
        ))}
        {data && (
          <span className="ml-auto text-sm text-muted-foreground">
            Total {usd(data.totalCents)} (UTC days, by prompt start)
          </span>
        )}
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">Parsing transcripts…</p>}
      {error && (
        <p className="text-sm text-destructive">
          Cost data unavailable: {(error as Error).message}. Transcript stats must be enabled.
        </p>
      )}
      {data && (
        <>
          <div className="flex h-40 items-end gap-px" role="img" aria-label="Daily cost">
            {data.days.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${usd(d.costCents)}, ${d.prompts} prompts, ${d.sessions} sessions`}
                className="flex-1 rounded-t bg-primary"
                style={{ height: `${(d.costCents / max) * 100}%`, minHeight: d.costCents ? 2 : 0 }}
              />
            ))}
          </div>
          {(data.unpricedPrompts > 0 || data.skippedSessions > 0) && (
            <p className="text-xs text-muted-foreground">
              {data.unpricedPrompts} prompts have no pricing and {data.skippedSessions} sessions had
              no readable transcript; both are excluded.
            </p>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th>Date</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Prompts</th>
                <th className="text-right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {[...data.days]
                .reverse()
                .filter((d) => d.prompts > 0)
                .map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className="text-right">{usd(d.costCents)}</td>
                    <td className="text-right">{d.prompts}</td>
                    <td className="text-right">{d.sessions}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
