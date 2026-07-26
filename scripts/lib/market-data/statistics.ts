export interface WeightedObservation {
  id?: string;
  value: number;
  weight: number;
}

interface NormalizedWeightedObservation extends WeightedObservation {
  id: string;
}

function sortedObservations(observations: readonly WeightedObservation[]): NormalizedWeightedObservation[] {
  if (observations.length === 0) throw new RangeError('At least one weighted observation is required');

  return observations.map((observation, index) => {
    if (!Number.isFinite(observation.value)) throw new RangeError('Weighted observation value must be finite');
    if (!Number.isFinite(observation.weight) || observation.weight <= 0) {
      throw new RangeError('Weighted observation requires a positive finite weight');
    }
    return { ...observation, id: observation.id ?? String(index).padStart(12, '0') };
  }).sort((left, right) => left.value - right.value || left.id.localeCompare(right.id));
}

/** Returns a deterministic weighted quantile using centered cumulative weights. */
export function weightedQuantile(observations: readonly WeightedObservation[], quantile: number): number {
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError('Weighted quantile must be between 0 and 1');
  }

  const sorted = sortedObservations(observations);
  const totalWeight = sorted.reduce((total, observation) => total + observation.weight, 0);
  if (quantile === 0) return sorted[0]!.value;
  if (quantile === 1) return sorted.at(-1)!.value;

  const targetWeight = totalWeight * quantile;
  let cumulativeWeight = 0;
  let previousPosition = 0;
  let previousValue = sorted[0]!.value;
  for (const observation of sorted) {
    cumulativeWeight += observation.weight;
    const position = cumulativeWeight - observation.weight / 2;
    if (targetWeight <= position) {
      if (position === previousPosition) return observation.value;
      const fraction = (targetWeight - previousPosition) / (position - previousPosition);
      return previousValue + (observation.value - previousValue) * fraction;
    }
    previousPosition = position;
    previousValue = observation.value;
  }
  return sorted.at(-1)!.value;
}

/**
 * Identifies extreme observations using the weighted median absolute deviation.
 * A baseline of five observations is required so small comparable sets retain
 * all of their evidence for agent review.
 */
export function weightedMadOutliers(
  observations: readonly WeightedObservation[],
  modifiedZScoreThreshold = 3.5,
): NormalizedWeightedObservation[] {
  if (!Number.isFinite(modifiedZScoreThreshold) || modifiedZScoreThreshold <= 0) {
    throw new RangeError('Modified Z-score threshold must be positive and finite');
  }
  if (observations.length < 5) return [];

  const sorted = sortedObservations(observations);
  const median = weightedQuantile(sorted, 0.5);
  const deviations = sorted.map((observation) => ({
    id: observation.id,
    value: Math.abs(observation.value - median),
    weight: observation.weight,
  }));
  const mad = weightedQuantile(deviations, 0.5);

  if (mad === 0) return sorted.filter((observation) => observation.value !== median);
  return sorted.filter((observation) =>
    (0.6745 * Math.abs(observation.value - median)) / mad > modifiedZScoreThreshold,
  );
}
