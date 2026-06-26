import type {
  FinalEvaluation,
  FinalEvaluationConfig,
  InterviewConfig,
  InterviewSession,
} from "../types.js";

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: Required<FinalEvaluationConfig> = {
  strong_threshold: 0.8,
  consider_threshold: 0.6,
  weak_threshold: 0.4,
};

function resolveThresholds(config?: FinalEvaluationConfig): Required<FinalEvaluationConfig> {
  return {
    strong_threshold: config?.strong_threshold ?? DEFAULT_THRESHOLDS.strong_threshold,
    consider_threshold: config?.consider_threshold ?? DEFAULT_THRESHOLDS.consider_threshold,
    weak_threshold: config?.weak_threshold ?? DEFAULT_THRESHOLDS.weak_threshold,
  };
}

// ── Score aggregation helpers ──────────────────────────────────────────────

interface AggregatedCategoryScore {
  /** The category key from the config */
  categoryKey: string;
  /** Weighted sum of normalized state scores across all states that reference this category */
  weightedScore: number;
  /** Total weight contributed by all states for this category */
  totalWeight: number;
  /** The category's max score from the config */
  maxScore: number;
}

/**
 * Compute category-level aggregated scores.
 *
 * For each scoring category, look across all states that reference it via
 * `score_weights`. For each such state, we compute the maximum possible
 * score contribution of that category in that state — this is:
 *   categoryMaxScore * categoryWeight
 *
 * The state's raw score for the category is `session.scores[categoryKey]`
 * (which may be 0 if unset). The normalized score for that category in that
 * state is clamped [0, 1] × categoryMaxScore.
 *
 * We compute a weighted average across all states that contributed to this
 * category.
 */
function aggregateCategoryScores(
  session: InterviewSession,
  config: InterviewConfig,
): AggregatedCategoryScore[] {
  const categories = config.scoring_categories;
  const scores = session.scores ?? {};

  const catKeys = Object.keys(categories);
  const results: AggregatedCategoryScore[] = [];

  for (const catKey of catKeys) {
    const cat = categories[catKey]!;

    // Collect all states that reference this category
    const statesForCategory = config.states.filter(
      (s) => s.score_weights[catKey] !== undefined && s.score_weights[catKey] !== 0,
    );

    if (statesForCategory.length === 0) {
      // Category is never scored — use 0
      results.push({
        categoryKey: catKey,
        weightedScore: 0,
        totalWeight: 0,
        maxScore: cat.max_score,
      });
      continue;
    }

    // Compute the maximum possible score for this category given all
    // contributing states. The max a state can contribute for this
    // category is: categoryMaxScore * categoryWeight
    // We also track the total possible weight for normalization.
    let totalWeightedNormalized = 0;
    let totalPossibleWeight = 0;

    for (const state of statesForCategory) {
      const weight = state.score_weights[catKey]!;

      // The max possible score a state can contribute to this category:
      // cat.max_score * weight. But the raw score from session.scores
      // may have contributions from grading (e.g., audio grader scoring
      // at maxScore * weight). We'll interpret the stored score as
      // already at the category's max_score scale, so we need to figure
      // out what proportion of the max was achieved.

      // Approach: treat each state's contribution as independent.
      // The stored score for this category is an accumulation across
      // all states. We can't disentangle per-state contributions from
      // the flat scores map alone (as currently structured). So we
      // treat the flat score as already aggregated — we simply take the
      // stored score, clamp it to [0, cat.max_score], and scale by
      // the individual weight proportion.

      // For the weighted average approach, we compute:
      // - The raw stored score (may be from multiple states accumulated)
      // - Normalize: raw / maxScore → [0,1]
      // - Weight by this state's contribution of the total weight
      // This gives a proper weighted average across all contributing states.

      // The total weight across all states for this category
      totalPossibleWeight += Math.abs(weight);
    }

    // The raw stored score (accumulated across all grading runs for this category)
    const rawScore = Math.max(0, Math.min(cat.max_score, scores[catKey] ?? 0));

    // Normalize to [0, 1]
    const normalizedScore = cat.max_score > 0 ? rawScore / cat.max_score : 0;

    // For each state, the category contributes proportionally to its weight
    // We take a weighted average across states
    for (const state of statesForCategory) {
      const weight = state.score_weights[catKey]!;
      const weightFraction = totalPossibleWeight > 0
        ? Math.abs(weight) / totalPossibleWeight
        : 0;
      totalWeightedNormalized += normalizedScore * weightFraction;
    }

    // Total weight against which we normalize is just sum of absolute weights
    const effectiveWeightNormalized = totalPossibleWeight > 0 ? 1 : 0;

    const finalNormalizedScore = effectiveWeightNormalized > 0
      ? totalWeightedNormalized
      : 0;

    // Scale to the category's max_score range
    const weightedScore = finalNormalizedScore * cat.max_score;

    results.push({
      categoryKey: catKey,
      weightedScore,
      totalWeight: totalPossibleWeight,
      maxScore: cat.max_score,
    });
  }

  return results;
}

/**
 * Compute overall score as a value in [0, 1] representing the weighted
 * average across all categories.
 */
function computeOverallNormalizedScore(
  categoryScores: AggregatedCategoryScore[],
  config: InterviewConfig,
): number {
  const categories = config.scoring_categories;

  let totalWeightedScore = 0;
  let totalCategoryMax = 0;

  for (const cs of categoryScores) {
    const cat = categories[cs.categoryKey]!;
    totalWeightedScore += cs.weightedScore;
    totalCategoryMax += cat.max_score;
  }

  if (totalCategoryMax <= 0) {
    return 0;
  }

  return totalWeightedScore / totalCategoryMax;
}

/**
 * Map a normalized score [0, 1] to a recommendation string using
 * the configured thresholds and recommendation_levels.
 */
function mapScoreToRecommendation(
  normalizedScore: number,
  config: InterviewConfig,
): string {
  const thresholds = resolveThresholds(config.final_evaluation);
  const levels = config.recommendation_levels;

  if (levels.length === 0) {
    return "no_recommendation";
  }

  if (normalizedScore >= thresholds.strong_threshold) {
    return levels[0] ?? levels[levels.length - 1]!;
  }
  if (normalizedScore >= thresholds.consider_threshold) {
    if (levels.length >= 2) {
      return levels[1]!;
    }
    return levels[levels.length - 1]!;
  }
  if (normalizedScore >= thresholds.weak_threshold) {
    if (levels.length >= 3) {
      return levels[2]!;
    }
    return levels[levels.length - 1]!;
  }
  return levels[levels.length - 1]!;
}

/**
 * Generate deterministic strengths from the top-scoring categories.
 * Returns categories that scored >= 70% of their max.
 */
function generateStrengths(
  categoryScores: AggregatedCategoryScore[],
  config: InterviewConfig,
): string[] {
  const categories = config.scoring_categories;
  const strengths: string[] = [];

  for (const cs of categoryScores) {
    const cat = categories[cs.categoryKey];
    if (!cat || cs.maxScore <= 0) {
      continue;
    }
    const pct = cs.weightedScore / cs.maxScore;
    if (pct >= 0.7) {
      const label = cat.label;
      const pctDisplay = Math.round(pct * 100);
      strengths.push(`${label} (${pctDisplay}%)`);
    }
  }

  if (strengths.length === 0) {
    // No category reached 70%; pick the top one if any
    const sorted = [...categoryScores]
      .filter((cs) => cs.maxScore > 0)
      .sort((a, b) => (b.weightedScore / b.maxScore) - (a.weightedScore / a.maxScore));
    if (sorted.length > 0) {
      const best = sorted[0]!;
      const cat = categories[best.categoryKey];
      if (cat) {
        strengths.push(`${cat.label} (${Math.round((best.weightedScore / best.maxScore) * 100)}%)`);
      }
    }
  }

  return strengths;
}

/**
 * Generate deterministic risks from the bottom-scoring categories.
 * Returns categories that scored < 50% of their max.
 */
function generateRisks(
  categoryScores: AggregatedCategoryScore[],
  config: InterviewConfig,
): string[] {
  const categories = config.scoring_categories;
  const risks: string[] = [];

  for (const cs of categoryScores) {
    const cat = categories[cs.categoryKey];
    if (!cat || cs.maxScore <= 0) {
      continue;
    }
    const pct = cs.weightedScore / cs.maxScore;
    if (pct < 0.5) {
      const label = cat.label;
      const pctDisplay = Math.round(pct * 100);
      risks.push(`${label} (${pctDisplay}%)`);
    }
  }

  if (risks.length === 0 && categoryScores.length > 0) {
    // No category below 50%; pick the lowest one
    const sorted = [...categoryScores]
      .filter((cs) => cs.maxScore > 0)
      .sort((a, b) => (a.weightedScore / a.maxScore) - (b.weightedScore / b.maxScore));
    if (sorted.length > 0) {
      const worst = sorted[0]!;
      const cat = categories[worst.categoryKey];
      if (cat) {
        risks.push(`${cat.label} (${Math.round((worst.weightedScore / worst.maxScore) * 100)}%)`);
      }
    }
  }

  return risks;
}

/**
 * Build a human-readable summary string.
 */
function buildSummary(
  categoryScores: AggregatedCategoryScore[],
  normalizedScore: number,
  recommendation: string,
  strengths: string[],
  risks: string[],
  config: InterviewConfig,
): string {
  const categories = config.scoring_categories;
  const totalMax = Object.values(categories).reduce((sum, c) => sum + c.max_score, 0);
  const totalScore = categoryScores.reduce((sum, cs) => sum + cs.weightedScore, 0);
  const pct = Math.round(normalizedScore * 100);

  let summary = `Candidate scored ${Math.round(totalScore)}/${totalMax} overall (${pct}%). Recommendation: ${recommendation}.`;

  if (strengths.length > 0) {
    summary += ` Strengths: ${strengths.join(", ")}.`;
  }
  if (risks.length > 0) {
    summary += ` Risks: ${risks.join(", ")}.`;
  }

  return summary;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Compute a deterministic final evaluation for an interview session.
 *
 * Aggregates all category scores across states, computes overall score,
 * maps to a recommendation level, and generates strengths/risks.
 */
export function computeFinalEvaluation(
  session: InterviewSession,
  config: InterviewConfig,
): FinalEvaluation {
  const categoryScores = aggregateCategoryScores(session, config);
  const normalizedScore = computeOverallNormalizedScore(categoryScores, config);
  const recommendation = mapScoreToRecommendation(normalizedScore, config);
  const strengths = generateStrengths(categoryScores, config);
  const risks = generateRisks(categoryScores, config);
  const summary = buildSummary(
    categoryScores,
    normalizedScore,
    recommendation,
    strengths,
    risks,
    config,
  );

  // Build per-category scores for the final evaluation
  const finalScores: Record<string, number> = {};
  for (const cs of categoryScores) {
    finalScores[cs.categoryKey] = Math.round(cs.weightedScore * 100) / 100;
  }

  return {
    recommendation,
    scores: finalScores,
    strengths,
    risks,
    summary,
  };
}
