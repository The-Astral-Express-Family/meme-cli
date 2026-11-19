/** triage 分流：归纳成本经济学。词梗占新梗的多数但几乎不花钱——分流本身是成本控制主力。 */
import type { Candidate } from '../models.ts'
import type { InductionConfig } from '../config.ts'

export interface TriagePlan {
  path: 'zero_word' | 'card_small' | 'derived' | 'flagship'
  model_tier: 'small' | 'flagship'
}

export function triage(target: Candidate | string, kindGuess?: string | null): TriagePlan {
  const kind = kindGuess ?? (typeof target === 'string' ? 'word' : target.kind_guess)
  if (kind === 'word') return { path: 'zero_word', model_tier: 'small' }
  if (kind === 'event') return { path: 'card_small', model_tier: 'small' }
  if (kind === 'derived') return { path: 'derived', model_tier: 'small' }
  return { path: 'flagship', model_tier: 'flagship' } // formula / format / interaction
}

export function modelFor(plan: TriagePlan, cfg: InductionConfig): string {
  return plan.model_tier === 'small' ? cfg.small_model : cfg.model
}
