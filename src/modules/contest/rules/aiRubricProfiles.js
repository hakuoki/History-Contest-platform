export const AIRubricKey = Object.freeze({
  HISTORY_PAPER_QUANTITATIVE: 'history_paper_quantitative',
});

const HISTORY_PAPER_QUANTITATIVE_PROFILE = Object.freeze({
  key: AIRubricKey.HISTORY_PAPER_QUANTITATIVE,
  use_fatal_hit_section: true,
  strict_minimums: Object.freeze({
    enabled: true,
    min_selected_model_count: 3,
    min_runs_per_model: 3,
    rule_display_name: '历史学量化评分规则',
  }),
  dimension_labels: Object.freeze({
    A: '问题意识',
    B: '文献对话',
    C: '论证严密性',
    D: '史料运用',
    E: '原创贡献',
    F: '结构与表达',
    G: '学科规范',
  }),
  dimension_max_scores: Object.freeze({
    A: 20,
    B: 15,
    C: 20,
    D: 15,
    E: 15,
    F: 10,
    G: 5,
  }),
  fatal_criteria_labels: Object.freeze({
    fatal_plagiarism: '抄袭或其他严重学术不端',
    fatal_forgery: '伪造、篡改史料或数据',
    fatal_distortion: '故意误引、断章取义',
    fatal_source_fabrication: '捏造档案或来源',
  }),
  hit_code_labels: Object.freeze({
    fatal_plagiarism: '抄袭',
    fatal_forgery: '伪造',
    fatal_distortion: '故意误引',
    fatal_source_fabrication: '捏造档案',
    cap_no_research_question: '无研究问题',
    cap_no_evidence_support: '核心论断无证据支撑',
    cap_key_fact_error: '关键史料或关键事实严重失实',
    cap_poor_literature_dialogue: '文献对话或研究定位严重不足',
    cap_structure_broken: '结构严重失衡',
  }),
});

const DEFAULT_AI_RUBRIC_PROFILE = Object.freeze({
  key: '',
  use_fatal_hit_section: false,
  strict_minimums: Object.freeze({
    enabled: false,
    min_selected_model_count: 1,
    min_runs_per_model: 1,
    rule_display_name: '当前规则',
  }),
  dimension_labels: Object.freeze({}),
  dimension_max_scores: Object.freeze({}),
  fatal_criteria_labels: Object.freeze({}),
  hit_code_labels: Object.freeze({}),
});

const AI_RUBRIC_PROFILE_REGISTRY = Object.freeze({
  [AIRubricKey.HISTORY_PAPER_QUANTITATIVE]: HISTORY_PAPER_QUANTITATIVE_PROFILE,
});

export function normalizeAIRubricKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function getAIRubricProfile(rubricKey) {
  const normalizedKey = normalizeAIRubricKey(rubricKey);
  return AI_RUBRIC_PROFILE_REGISTRY[normalizedKey] || DEFAULT_AI_RUBRIC_PROFILE;
}

export function getAIRubricMinimumPolicy(rubricKey) {
  return getAIRubricProfile(rubricKey).strict_minimums || DEFAULT_AI_RUBRIC_PROFILE.strict_minimums;
}

export function requiresStrictAIRunMinimums(rubricKey) {
  return Boolean(getAIRubricMinimumPolicy(rubricKey).enabled);
}

export function shouldUseAIFatalHitSection(rubricKey) {
  return Boolean(getAIRubricProfile(rubricKey).use_fatal_hit_section);
}

export function getAIFatalCriteriaLabel(code, rubricKey) {
  const token = String(code || '').trim();
  if (!token) return '';
  const profile = getAIRubricProfile(rubricKey);
  return profile.fatal_criteria_labels[token] || token;
}

export function getAIHitCodeLabel(code, rubricKey) {
  const token = String(code || '').trim();
  if (!token) return '';
  const profile = getAIRubricProfile(rubricKey);
  return profile.hit_code_labels[token] || token;
}

export function mapAIDimensionScoresForDisplay(rawDimensionScores, rubricKey = '') {
  const dimensionScores = Array.isArray(rawDimensionScores) ? rawDimensionScores : [];
  const profile = getAIRubricProfile(rubricKey);
  const dimensionLabels = profile.dimension_labels || {};
  const dimensionMaxScores = profile.dimension_max_scores || {};
  const isRuleMapped = Object.keys(dimensionLabels).length > 0;
  const labelCodeMap = Object.fromEntries(
    Object.entries(dimensionLabels).map(([code, label]) => [label, code])
  );

  return dimensionScores.map((dim, dimIndex) => {
    const code = String(dim?.code || '').trim().toUpperCase();
    const rawName = String(dim?.name || '').trim();
    if (!isRuleMapped) {
      return {
        ...dim,
        display_name: rawName || code || `维度${dimIndex + 1}`,
        display_max_score: (
          dim?.max_score !== null && dim?.max_score !== undefined
            ? dim.max_score
            : '-'
        ),
      };
    }

    const mappedName = dimensionLabels[code] || '';
    const displayName = (rawName && rawName !== code)
      ? rawName
      : (mappedName || rawName || code || `维度${dimIndex + 1}`);
    const mappedCode = code || labelCodeMap[displayName] || '';
    const displayMaxScore = (
      dim?.max_score !== null && dim?.max_score !== undefined
        ? dim.max_score
        : (dimensionMaxScores[mappedCode] ?? '-')
    );

    return {
      ...dim,
      display_name: displayName,
      display_max_score: displayMaxScore,
    };
  });
}
