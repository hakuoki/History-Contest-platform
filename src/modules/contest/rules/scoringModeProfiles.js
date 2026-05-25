export const ScoringModeKey = Object.freeze({
  SINGLE_SCORE: 'single_score',
  HISTORY_PAPER_QUANTITATIVE: 'history_paper_quantitative',
});

export const ScoringRubricKey = Object.freeze({
  HISTORY_PAPER_QUANTITATIVE: 'history_paper_quantitative',
});

export const DEFAULT_SCORING_MODE_KEY = ScoringModeKey.SINGLE_SCORE;
export const DEFAULT_SCORING_RUBRIC_KEY = ScoringRubricKey.HISTORY_PAPER_QUANTITATIVE;

const SINGLE_SCORE_PROFILE = Object.freeze({
  key: ScoringModeKey.SINGLE_SCORE,
  label: '单分模式（总分+评语）',
  quantitative: false,
  requires_rubric_version: false,
  default_rubric_key: '',
  review_panel_title: '评分与评语',
  review_mode_chip_label: '单分模式',
  review_mode_chip_color: 'default',
  review_stack_top_padding: 1.4,
  comment_min_rows: 6,
  comment_max_rows: 10,
});

const HISTORY_PAPER_QUANTITATIVE_PROFILE = Object.freeze({
  key: ScoringModeKey.HISTORY_PAPER_QUANTITATIVE,
  label: '历史论文量化评分（7维度）',
  quantitative: true,
  requires_rubric_version: true,
  default_rubric_key: ScoringRubricKey.HISTORY_PAPER_QUANTITATIVE,
  review_panel_title: '维度评分表',
  review_mode_chip_label: '维度评分模式',
  review_mode_chip_color: 'warning',
  review_stack_top_padding: 0.2,
  comment_min_rows: 4,
  comment_max_rows: 8,
});

const DEFAULT_SCORING_MODE_PROFILE = Object.freeze({
  key: '',
  label: '单分模式（总分+评语）',
  quantitative: false,
  requires_rubric_version: false,
  default_rubric_key: '',
  review_panel_title: '评分与评语',
  review_mode_chip_label: '单分模式',
  review_mode_chip_color: 'default',
  review_stack_top_padding: 1.4,
  comment_min_rows: 6,
  comment_max_rows: 10,
});

const SCORING_MODE_PROFILE_REGISTRY = Object.freeze({
  [ScoringModeKey.SINGLE_SCORE]: SINGLE_SCORE_PROFILE,
  [ScoringModeKey.HISTORY_PAPER_QUANTITATIVE]: HISTORY_PAPER_QUANTITATIVE_PROFILE,
});

const RUBRIC_EXPECTED_DIMENSION_CODES = Object.freeze({
  [ScoringRubricKey.HISTORY_PAPER_QUANTITATIVE]: Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G']),
});

export const SCORING_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: ScoringModeKey.SINGLE_SCORE, label: SINGLE_SCORE_PROFILE.label }),
  Object.freeze({ value: ScoringModeKey.HISTORY_PAPER_QUANTITATIVE, label: HISTORY_PAPER_QUANTITATIVE_PROFILE.label }),
]);

export function normalizeScoringModeKey(value) {
  return String(value || '').trim().toLowerCase() || DEFAULT_SCORING_MODE_KEY;
}

export function normalizeScoringRubricKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function getScoringModeProfile(modeKey) {
  const normalizedKey = normalizeScoringModeKey(modeKey);
  return SCORING_MODE_PROFILE_REGISTRY[normalizedKey] || DEFAULT_SCORING_MODE_PROFILE;
}

export function isQuantitativeScoringMode(modeKey) {
  return Boolean(getScoringModeProfile(modeKey).quantitative);
}

export function requiresScoringRubricVersion(modeKey) {
  return Boolean(getScoringModeProfile(modeKey).requires_rubric_version);
}

export function getDefaultRubricKeyForScoringMode(modeKey) {
  return String(getScoringModeProfile(modeKey).default_rubric_key || '').trim();
}

export function getExpectedDimensionCodesForScoringRubric(rubricKey, fallbackCodes = []) {
  const normalizedRubricKey = normalizeScoringRubricKey(rubricKey);
  const configuredCodes = RUBRIC_EXPECTED_DIMENSION_CODES[normalizedRubricKey];
  if (Array.isArray(configuredCodes) && configuredCodes.length) return [...configuredCodes];
  return Array.isArray(fallbackCodes) ? [...fallbackCodes] : [];
}
