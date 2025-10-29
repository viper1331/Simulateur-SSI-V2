import { z } from 'zod';

export const scoringEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  type: z.enum(['DM_LATCHED', 'PROCESS_ACK', 'MANUAL_EVAC_START', 'MANUAL_EVAC_STOP', 'RESET']),
  payload: z.record(z.any()).optional(),
});

export type ScoringEvent = z.infer<typeof scoringEventSchema>;

export interface ScoringRule {
  id: string;
  description: string;
  weight: number;
  evaluate(events: ScoringEvent[]): number;
}

export function evaluateScore(events: ScoringEvent[], rules: ScoringRule[]) {
  const validated = events.map((event) => scoringEventSchema.parse(event));
  const totalWeight = rules.reduce((acc, rule) => acc + rule.weight, 0) || 1;
  const rawScore = rules.reduce((acc, rule) => acc + rule.evaluate(validated) * rule.weight, 0);
  return rawScore / totalWeight;
}

export const defaultRules: ScoringRule[] = [
  {
    id: 'ack-before-deadline',
    description: 'Process acknowledgement provided before deadline',
    weight: 2,
    evaluate(events) {
      return events.some((event) => event.type === 'PROCESS_ACK') ? 1 : 0;
    },
  },
  {
    id: 'manual-evac-stopped',
    description: 'Manual evacuation stopped correctly',
    weight: 1,
    evaluate(events) {
      return events.some((event) => event.type === 'MANUAL_EVAC_STOP') ? 1 : 0;
    },
  },
];
