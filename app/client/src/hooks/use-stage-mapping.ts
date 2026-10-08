import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'

/** Stage mapping from GET /api/stages. Static config: fetched once, cached for the page lifetime. */
export function useStageMapping() {
  return useQuery({
    queryKey: ['stages'],
    queryFn: api.getStages,
    staleTime: Infinity,
    retry: false,
  })
}
