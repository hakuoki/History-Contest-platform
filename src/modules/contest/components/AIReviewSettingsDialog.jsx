import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';
import {
  createCompetitionAIReviewJobs,
  createRequestId,
  getCompetitionAIReviewSettings,
  listCompetitionSubmissionsPaged,
  previewCompetitionAIReview,
  updateCompetitionAIReviewSettings,
} from '../../../api';
import { getUserFriendlyErrorText } from '../../../utils/errorText';

const DEFAULT_MODEL_KEY = 'qwen3_max';
const REVIEWABLE_SUBMISSION_STATUSES = new Set(['submitted', 'resubmitted', 'locked']);
const SERVICE_UNAVAILABLE_TEXT = '服务暂时不可用，请稍后重试';
const SUPPORTED_PARSE_FORMATS = ['pdf', 'docx', 'xlsx'];
const FORMAT_LABEL_MAP = {
  pdf: 'PDF',
  docx: 'DOCX',
  xlsx: 'XLSX',
};
const FORMAT_ACCEPT_MAP = {
  pdf: ['.pdf'],
  docx: ['.doc', '.docx'],
  xlsx: ['.xls', '.xlsx'],
};
const HIT_CODE_LABEL_MAP = {
  fatal_plagiarism: '抄袭',
  fatal_forgery: '伪造',
  fatal_distortion: '故意误引',
  fatal_source_fabrication: '捏造档案',
  cap_no_research_question: '无研究问题',
  cap_no_evidence_support: '核心论断无证据支撑',
  cap_key_fact_error: '关键史料或关键事实严重失实',
  cap_poor_literature_dialogue: '文献对话或研究定位严重不足',
  cap_structure_broken: '结构严重失衡',
};
const OPTIONAL_PARSE_NONE_TOKEN = '__none__';
const PREVIEW_ATTACHMENT_THEME = {
  border: '#c6afe8',
  bg: '#f2e8ff',
  shadow: '0 1px 2px rgba(89, 43, 150, 0.12)',
  hoverBorder: '#ab88dd',
  hoverBg: '#eadbff',
  hoverShadow: '0 2px 6px rgba(89, 43, 150, 0.18)',
  iconBoxBg: '#e1d0fb',
  iconBoxBorder: '#ccb4ef',
  iconColor: '#6f42ad',
  text: '#4c2d7d',
  subText: '#7755ab',
  clearBorder: '#d8caeb',
  clearHoverBg: '#f7f2ff',
};

function canonicalFormatToken(raw) {
  const token = String(raw || '').trim().toLowerCase().replace(/^\./, '');
  if (['doc', 'docx', 'word'].includes(token)) return 'docx';
  if (['xls', 'xlsx', 'excel'].includes(token)) return 'xlsx';
  return token;
}

function normalizeFormatList(rawValue, fallback = []) {
  let source = [];
  if (Array.isArray(rawValue)) {
    source = rawValue;
  } else if (typeof rawValue === 'string') {
    const text = rawValue.trim();
    if (text.startsWith('[') && text.endsWith(']')) {
      try {
        const parsed = JSON.parse(text);
        source = Array.isArray(parsed) ? parsed : [text];
      } catch {
        source = [text];
      }
    } else if (text.includes(',')) {
      source = text.split(',').map((item) => item.trim());
    } else if (text) {
      source = [text];
    }
  }

  const normalized = [];
  source.forEach((item) => {
    const token = canonicalFormatToken(item);
    if (!SUPPORTED_PARSE_FORMATS.includes(token)) return;
    if (!normalized.includes(token)) normalized.push(token);
  });
  return normalized.length ? normalized : [...fallback];
}

function resolveCompetitionFormatBuckets(competition) {
  const row = competition && typeof competition === 'object' ? competition : {};
  const mode = String(row?.submission_rule_mode || '').trim().toLowerCase();
  if (mode === 'required_optional') {
    const required = normalizeFormatList(row?.required_formats, []);
    const optional = normalizeFormatList(row?.optional_formats, []).filter((fmt) => !required.includes(fmt));
    if (required.length || optional.length) return { required, optional };
    return { required: [], optional: normalizeFormatList(row?.allowed_formats, ['pdf']) };
  }

  const attachmentMode = String(row?.attachment_mode || '').trim().toLowerCase();
  const allowed = normalizeFormatList(row?.allowed_formats, ['pdf']);
  if (attachmentMode === 'multiple') return { required: allowed, optional: [] };
  return { required: [], optional: allowed };
}

function normalizeParseSelection(selectedRaw, bucketFormats, enabled = true, fallbackWhenEmpty = true) {
  if (!enabled) return [];
  const bucket = normalizeFormatList(bucketFormats, []);
  const bucketSet = new Set(bucket);
  const selected = normalizeFormatList(selectedRaw, []).filter((fmt) => bucketSet.has(fmt));
  if (selected.length) return selected;
  return fallbackWhenEmpty ? [...bucket] : [];
}

function formatLabel(token) {
  return FORMAT_LABEL_MAP[canonicalFormatToken(token)] || String(token || '').toUpperCase();
}

function renderFormatValue(selected) {
  const values = Array.isArray(selected) ? selected : [];
  return values.map((item) => formatLabel(item)).join(', ');
}

function renderOptionalParseValue(selected) {
  const text = renderFormatValue(selected);
  return text || '无';
}

function normalizeSelectedModelKeys(modelCatalog, selectedModelKeys) {
  const catalog = Array.isArray(modelCatalog) ? modelCatalog : [];
  const catalogMap = new Map(catalog.map((item) => [String(item?.key || ''), item]));
  const selected = [];

  (Array.isArray(selectedModelKeys) ? selectedModelKeys : []).forEach((key) => {
    const token = String(key || '').trim();
    if (!token || !catalogMap.has(token)) return;
    const item = catalogMap.get(token);
    if (item && item.enabled === false && !item.mandatory) return;
    if (!selected.includes(token)) selected.push(token);
  });

  catalog.forEach((item) => {
    if (!item?.key) return;
    if (item.mandatory && !selected.includes(item.key)) {
      selected.unshift(item.key);
    }
  });

  if (!selected.includes(DEFAULT_MODEL_KEY) && catalogMap.has(DEFAULT_MODEL_KEY)) {
    selected.unshift(DEFAULT_MODEL_KEY);
  }

  return [...new Set(selected)];
}

function normalizeSelectedRubricKey(rubricCatalog, selectedRubricKey) {
  const catalog = Array.isArray(rubricCatalog) ? rubricCatalog : [];
  const catalogMap = new Map(catalog.map((item) => [String(item?.key || ''), item]));
  const token = String(selectedRubricKey || '').trim();
  if (token && catalogMap.has(token)) {
    return token;
  }

  const fallbackItem = catalog.find((item) => item?.default) || catalog.find((item) => item?.enabled !== false) || catalog[0];
  return String(fallbackItem?.key || '').trim();
}

function buildAISettingsSnapshot({
  modelCatalog,
  rubricCatalog,
  selectedModelKeys,
  selectedRubricKey,
  runsPerModel,
  maxInputChars,
  requiredParseFormats,
  optionalParseFormats,
  failOnEmptyText,
  timeoutSeconds,
  retryCount,
  temperature,
  maxOutputTokens,
}) {
  const normalizedModels = normalizeSelectedModelKeys(modelCatalog, selectedModelKeys);
  const rubricKey = normalizeSelectedRubricKey(rubricCatalog, selectedRubricKey);
  const requiredFormats = [...normalizeFormatList(requiredParseFormats, [])].sort();
  const optionalFormats = [...normalizeFormatList(optionalParseFormats, [])].sort();
  return {
    selected_model_keys: normalizedModels,
    rubric_key: rubricKey,
    runs_per_model: Math.max(1, Number(runsPerModel || 1)),
    max_input_chars: Math.max(1000, Number(maxInputChars || 40000)),
    required_parse_formats: requiredFormats,
    optional_parse_formats: optionalFormats,
    fail_on_empty_text: Boolean(failOnEmptyText),
    timeout_seconds: Math.max(1, Number(timeoutSeconds || 180)),
    retry_count: Math.max(0, Number(retryCount || 0)),
    temperature: Number(temperature ?? 0.2),
    max_output_tokens: Math.max(256, Number(maxOutputTokens || 8000)),
  };
}

function buildAISettingsSignature(snapshot) {
  try {
    return JSON.stringify(snapshot || {});
  } catch {
    return '';
  }
}

function NumberField({ label, value, onChange, min, max, step = 1, helperText, disabled }) {
  return (
    <TextField
      fullWidth
      size="small"
      type="number"
      label={label}
      value={value}
      disabled={disabled}
      inputProps={{ min, max, step }}
      helperText={helperText}
      onChange={(event) => onChange(Number(event.target.value || 0))}
    />
  );
}

function toBoolFlag(value) {
  if (typeof value === 'boolean') return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric !== 0;
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  if (['true', 'yes', 'on'].includes(text)) return true;
  if (['false', 'no', 'off'].includes(text)) return false;
  return Boolean(value);
}

function toDateMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(raw) ? raw : null;
}

function isManualReviewWindowOpen(competition) {
  const submissionEnd = toDateMs(competition?.submission_end);
  const reviewStart = toDateMs(competition?.review_start);
  const reviewEnd = toDateMs(competition?.review_end);
  if (submissionEnd === null || reviewStart === null) return false;
  const now = Date.now();
  if (now <= submissionEnd) return false;
  if (now < reviewStart) return false;
  if (reviewEnd !== null && now > reviewEnd) return false;
  return true;
}

async function loadReviewableSubmissionIds(competitionId) {
  const ids = [];
  const limit = 100;
  let offset = 0;
  let total = 0;
  let pageCount = 0;

  while (pageCount < 20) {
    const { items, total: currentTotal } = await listCompetitionSubmissionsPaged(competitionId, limit, offset, '', {
      fields: 'summary',
      requestId: createRequestId(),
    });
    const rows = Array.isArray(items) ? items : [];
    rows.forEach((item) => {
      const submissionId = Number(item?.id || 0);
      const status = String(item?.status || '').trim().toLowerCase();
      if (submissionId > 0 && REVIEWABLE_SUBMISSION_STATUSES.has(status)) {
        ids.push(submissionId);
      }
    });
    total = Number(currentTotal || 0);
    offset += rows.length;
    pageCount += 1;
    if (!rows.length || offset >= total) break;
  }

  return [...new Set(ids)];
}

function formatPreviewJson(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatPreviewHitText(hit) {
  const source = (hit && typeof hit === 'object')
    ? hit
    : { code: String(hit || '').trim() };
  const code = String(source?.code || '').trim();
  const codeLabel = HIT_CODE_LABEL_MAP[code] || code;
  const comment = String(source?.comment || '').trim();
  if (codeLabel && comment && comment !== code && comment !== codeLabel) return `${codeLabel}（${comment}）`;
  return codeLabel || comment;
}

function AIReviewPreviewDialog({
  open,
  competition,
  rubricCatalog,
  modelCatalog,
  selectedRubricKey,
  selectedModelKeys,
  selectedParseFormats,
  onClose,
  setMessage,
}) {
  const competitionId = Number(competition?.id || 0);
  const competitionName = competition?.name || competition?.title || competitionId || '-';
  const availableModelKeys = useMemo(
    () => normalizeSelectedModelKeys(modelCatalog, selectedModelKeys),
    [modelCatalog, selectedModelKeys]
  );
  const availableModelMap = useMemo(
    () => new Map((Array.isArray(modelCatalog) ? modelCatalog : []).map((item) => [String(item?.key || ''), item])),
    [modelCatalog]
  );
  const rubricMap = useMemo(
    () => new Map((Array.isArray(rubricCatalog) ? rubricCatalog : []).map((item) => [String(item?.key || ''), item])),
    [rubricCatalog]
  );
  const selectedRubricName = rubricMap.get(String(selectedRubricKey || '').trim())?.name || selectedRubricKey || '-';
  const allowedPreviewFormats = useMemo(
    () => normalizeFormatList(selectedParseFormats, []),
    [selectedParseFormats]
  );
  const [previewModelKey, setPreviewModelKey] = useState('');
  const [previewFilesByFormat, setPreviewFilesByFormat] = useState({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErrorText, setPreviewErrorText] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  const selectedPreviewFileEntries = useMemo(
    () => allowedPreviewFormats
      .map((fmt) => {
        const file = previewFilesByFormat[fmt] || null;
        return file ? { format: fmt, file } : null;
      })
      .filter(Boolean),
    [allowedPreviewFormats, previewFilesByFormat]
  );
  const selectedPreviewFiles = useMemo(
    () => selectedPreviewFileEntries.map((item) => item.file),
    [selectedPreviewFileEntries]
  );

  useEffect(() => {
    if (!open) return;
    setPreviewModelKey(availableModelKeys[0] || '');
    setPreviewFilesByFormat({});
    setPreviewLoading(false);
    setPreviewErrorText('');
    setPreviewResult(null);
  }, [allowedPreviewFormats, availableModelKeys, open]);

  useEffect(() => {
    if (!open || !previewModelKey) return;
    if (!availableModelKeys.includes(previewModelKey)) {
      setPreviewModelKey(availableModelKeys[0] || '');
    }
  }, [availableModelKeys, open, previewModelKey]);

  useEffect(() => {
    if (!open) return;
    setPreviewFilesByFormat((prev) => {
      const next = {};
      allowedPreviewFormats.forEach((fmt) => {
        if (prev[fmt]) next[fmt] = prev[fmt];
      });
      return next;
    });
  }, [allowedPreviewFormats, open]);

  const handleFileChange = (formatToken, event) => {
    const nextFile = event.target.files?.[0] || null;
    const fileInput = event?.target;
    if (!nextFile) {
      setPreviewFilesByFormat((prev) => ({ ...prev, [formatToken]: null }));
      setPreviewErrorText('');
      setPreviewResult(null);
      if (fileInput) fileInput.value = '';
      return;
    }
    const ext = canonicalFormatToken(nextFile?.name?.split('.').pop() || '');
    const canonicalSlotFormat = canonicalFormatToken(formatToken);
    if (ext !== canonicalSlotFormat) {
      setPreviewFilesByFormat((prev) => ({ ...prev, [canonicalSlotFormat]: null }));
      setPreviewResult(null);
      setPreviewErrorText(
        `当前槽位为 ${formatLabel(canonicalSlotFormat)}，请上传对应文件`
      );
      if (fileInput) fileInput.value = '';
      return;
    }
    setPreviewFilesByFormat((prev) => ({ ...prev, [canonicalSlotFormat]: nextFile }));
    setPreviewErrorText('');
    setPreviewResult(null);
    if (fileInput) fileInput.value = '';
  };

  const clearPreviewFile = (formatToken) => {
    const canonicalSlotFormat = canonicalFormatToken(formatToken);
    setPreviewFilesByFormat((prev) => ({ ...prev, [canonicalSlotFormat]: null }));
    setPreviewErrorText('');
    setPreviewResult(null);
  };

  const runPreview = async () => {
    if (!competitionId || previewLoading || !previewModelKey || !selectedRubricKey || !allowedPreviewFormats.length) return;
    if (!selectedPreviewFiles.length) {
      setPreviewErrorText('请至少选择一个预览附件');
      return;
    }
    setPreviewLoading(true);
    setPreviewErrorText('');
    try {
      const { data } = await previewCompetitionAIReview(
        competitionId,
        {
          rubric_key: selectedRubricKey,
          model_key: previewModelKey,
          files: selectedPreviewFiles,
        },
        { requestId: createRequestId() }
      );
      setPreviewResult(data);
      if (typeof setMessage === 'function') {
        setMessage({ type: 'success', text: 'AI 评审预览已完成' });
      }
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '预览 AI 评审失败');
      setPreviewErrorText(text);
      if (typeof setMessage === 'function') {
        setMessage({ type: 'error', text });
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  const previewRun = previewResult?.run || {};
  const selectedModelName = availableModelMap.get(previewModelKey)?.name || previewModelKey || '-';
  const parsedResult = (previewRun?.parsed_json && typeof previewRun.parsed_json === 'object') ? previewRun.parsed_json : {};
  const fatalHits = Array.isArray(parsedResult?.fatal_hits) ? parsedResult.fatal_hits : [];
  const capHits = Array.isArray(parsedResult?.cap_hits) ? parsedResult.cap_hits : [];
  const fatalHitText = fatalHits.map(formatPreviewHitText).filter(Boolean).join('；');
  const capHitText = capHits.map(formatPreviewHitText).filter(Boolean).join('；');
  const finalSummaryText = [
    `总分：${previewRun.score ?? '-'}`,
    `等级：${previewRun.final_grade || '-'}`,
    `是否触发致命否决项：${previewRun.fatal_flag ? '是' : '否'}`,
    `是否触发总评上限项：${previewRun.cap_flag ? '是' : '否'}`,
    `致命命中项目：${previewRun.fatal_flag ? (fatalHitText || '已触发，但模型未返回命中条目详情') : '-'}`,
    `上限命中项目：${previewRun.cap_flag ? (capHitText || '已触发，但模型未返回命中条目详情') : '-'}`,
  ].join('\n');

  return (
    <Dialog
      open={open}
      onClose={(_, reason) => {
        if (previewLoading || reason === 'backdropClick') return;
        onClose?.();
      }}
      fullWidth
      maxWidth="lg"
    >
      <DialogTitle>
        AI 评审预览（比赛：{competitionName || '-'}）
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info">
            这里会使用已保存配置中的规则与模型，对上传文件执行一次真实 AI 评审，便于查看 prompt、原始输出和结果。
          </Alert>
          {previewErrorText && <Alert severity="error">{previewErrorText}</Alert>}

          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', md: 'center' }}>
              <TextField
                select
                fullWidth
                size="small"
                label="预览模型"
                value={previewModelKey}
                disabled={previewLoading || availableModelKeys.length === 0}
                onChange={(event) => setPreviewModelKey(String(event.target.value || ''))}
                helperText="仅对当前已选模型进行单次预览。"
              >
                {availableModelKeys.length > 0 ? (
                  availableModelKeys.map((key) => {
                    const item = availableModelMap.get(key);
                    return (
                      <MenuItem key={key} value={key}>
                        {item?.name || key}
                      </MenuItem>
                    );
                  })
                ) : (
                  <MenuItem value="">
                    暂无可用模型
                  </MenuItem>
                )}
              </TextField>
            </Stack>
            <FormHelperText sx={{ m: 0 }}>
              与作品提交一致，按格式选择对应文件；必交材料并入正文，选交材料作为辅助材料（不作为正文）。
            </FormHelperText>
            <Stack spacing={1}>
              {allowedPreviewFormats.length > 0 ? (
                allowedPreviewFormats.map((fmt) => {
                  const currentFile = previewFilesByFormat[fmt] || null;
                  return (
                    <Stack key={`preview_file_slot_${fmt}`} direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <Button
                        component="label"
                        variant="outlined"
                        disabled={previewLoading}
                      >
                        {`选择${formatLabel(fmt)}附件`}
                        <input
                          hidden
                          type="file"
                          accept={(FORMAT_ACCEPT_MAP[fmt] || []).join(',') || '.pdf'}
                          aria-label={`预览文件_${formatLabel(fmt)}`}
                          onChange={(event) => handleFileChange(fmt, event)}
                        />
                      </Button>
                      {currentFile ? (
                        <Box sx={{ position: 'relative', width: 268, maxWidth: '72vw', height: 50 }}>
                          <ButtonBase
                            sx={{
                              width: '100%',
                              height: '100%',
                              border: `1px solid ${PREVIEW_ATTACHMENT_THEME.border}`,
                              borderRadius: 2,
                              bgcolor: PREVIEW_ATTACHMENT_THEME.bg,
                              boxShadow: PREVIEW_ATTACHMENT_THEME.shadow,
                              display: 'flex',
                              justifyContent: 'flex-start',
                              alignItems: 'center',
                              px: 1.25,
                              transition: 'all .2s ease',
                              '&:hover': {
                                borderColor: PREVIEW_ATTACHMENT_THEME.hoverBorder,
                                bgcolor: PREVIEW_ATTACHMENT_THEME.hoverBg,
                                boxShadow: PREVIEW_ATTACHMENT_THEME.hoverShadow,
                              },
                            }}
                          >
                            <Box
                              sx={{
                                width: 26,
                                height: 26,
                                borderRadius: 1.5,
                                bgcolor: PREVIEW_ATTACHMENT_THEME.iconBoxBg,
                                border: `1px solid ${PREVIEW_ATTACHMENT_THEME.iconBoxBorder}`,
                                display: 'grid',
                                placeItems: 'center',
                                mr: 1,
                                flexShrink: 0,
                              }}
                            >
                              <InsertDriveFileRoundedIcon sx={{ fontSize: 17, color: PREVIEW_ATTACHMENT_THEME.iconColor }} />
                            </Box>
                            <Box sx={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                              <Typography
                                variant="body2"
                                sx={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  color: PREVIEW_ATTACHMENT_THEME.text,
                                  fontWeight: 700,
                                  lineHeight: 1.15,
                                }}
                              >
                                {currentFile.name}
                              </Typography>
                              <Typography
                                variant="caption"
                                sx={{
                                  color: PREVIEW_ATTACHMENT_THEME.subText,
                                  display: 'block',
                                  mt: 0.1,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                已选择，点击“运行预览”开始评审
                              </Typography>
                            </Box>
                          </ButtonBase>
                          <IconButton
                            size="small"
                            onClick={(event) => {
                              event.stopPropagation();
                              clearPreviewFile(fmt);
                            }}
                            sx={{
                              position: 'absolute',
                              top: -9,
                              right: -9,
                              width: 22,
                              height: 22,
                              bgcolor: '#fff',
                              border: `1px solid ${PREVIEW_ATTACHMENT_THEME.clearBorder}`,
                              '&:hover': { bgcolor: PREVIEW_ATTACHMENT_THEME.clearHoverBg },
                            }}
                          >
                            <CloseRoundedIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Box>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          未选择
                        </Typography>
                      )}
                    </Stack>
                  );
                })
              ) : (
                <Typography variant="body2" color="text.secondary">无可预览格式</Typography>
              )}
            </Stack>
          </Stack>

          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <Chip size="small" label={`规则：${selectedRubricName || '-'}`} />
            <Chip size="small" label={`模型：${selectedModelName || '-'}`} />
            <Chip size="small" label={`已选模型：${availableModelKeys.length}`} />
            <Chip
              size="small"
              label={`可预览格式：${allowedPreviewFormats.length ? allowedPreviewFormats.map((fmt) => formatLabel(fmt)).join('、') : '无'}`}
            />
            <Chip size="small" label={`已选附件：${selectedPreviewFiles.length}`} />
          </Stack>

          {previewLoading && (
            <Stack alignItems="center" spacing={1} sx={{ py: 3 }}>
              <CircularProgress size={24} />
              <Typography variant="body2" color="text.secondary">AI 正在评审，请稍候...</Typography>
            </Stack>
          )}

          {previewResult && (
            <Stack spacing={2}>
              <Alert severity="success">
                预览完成，等级 {previewRun.final_grade || '-'}，得分 {previewRun.score ?? '-'}。
              </Alert>

              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                <Chip size="small" color="primary" label={`原始分 ${previewRun.raw_total_score ?? '-'}`} />
                <Chip size="small" label={`耗时 ${previewRun.latency_ms ?? 0} ms`} />
                <Chip size="small" label={`成本 ${previewRun.estimated_cost ?? 0}`} />
                {previewRun.fatal_flag && <Chip size="small" color="error" label="致命命中" />}
                {previewRun.cap_flag && <Chip size="small" color="warning" label="上限命中" />}
              </Stack>

              <TextField
                fullWidth
                size="small"
                label="文件与抽取摘要"
                value={formatPreviewJson({
                  file_name: previewResult.file_name,
                  file_ext: previewResult.file_ext,
                  file_size: previewResult.file_size,
                  original_char_count: previewResult.original_char_count,
                  truncated: previewResult.truncated,
                  source_summary: previewResult.source_summary,
                })}
                multiline
                minRows={7}
                InputProps={{
                  readOnly: true,
                  sx: { fontFamily: 'monospace', alignItems: 'flex-start' },
                }}
              />

              <TextField
                fullWidth
                size="small"
                label="最终结论摘要"
                value={finalSummaryText}
                multiline
                minRows={6}
                InputProps={{
                  readOnly: true,
                  sx: { fontFamily: 'monospace', alignItems: 'flex-start' },
                }}
              />

              {(Array.isArray(previewResult.prompt_messages) ? previewResult.prompt_messages : []).map((message) => (
                <TextField
                  key={message.role}
                  fullWidth
                  size="small"
                  label={`Prompt - ${message.role === 'system' ? 'System' : 'User'}`}
                  value={message.content || ''}
                  multiline
                  minRows={message.role === 'system' ? 8 : 12}
                  InputProps={{
                    readOnly: true,
                    sx: { fontFamily: 'monospace', alignItems: 'flex-start' },
                  }}
                />
              ))}

              <TextField
                fullWidth
                size="small"
                label="模型原始输出"
                value={previewRun.raw_response_text || ''}
                multiline
                minRows={8}
                InputProps={{
                  readOnly: true,
                  sx: { fontFamily: 'monospace', alignItems: 'flex-start' },
                }}
              />
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          onClick={runPreview}
          disabled={previewLoading || selectedPreviewFiles.length === 0 || !previewModelKey || !selectedRubricKey || !allowedPreviewFormats.length}
          sx={{ minWidth: 140, whiteSpace: 'nowrap' }}
        >
          {previewLoading ? '预览中...' : '运行预览'}
        </Button>
        <Button onClick={onClose} disabled={previewLoading}>
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function AIReviewSettingsDialog({
  open,
  competition,
  onClose,
  setMessage,
}) {
  const competitionId = Number(competition?.id || 0);
  const competitionName = competition?.name || competition?.title || competitionId || '-';
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [modelCatalog, setModelCatalog] = useState([]);
  const [rubricCatalog, setRubricCatalog] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [selectedModelKeys, setSelectedModelKeys] = useState([]);
  const [selectedRubricKey, setSelectedRubricKey] = useState('');
  const [runsPerModel, setRunsPerModel] = useState(5);
  const [maxInputChars, setMaxInputChars] = useState(40000);
  const [requiredParseFormats, setRequiredParseFormats] = useState([]);
  const [optionalParseFormats, setOptionalParseFormats] = useState([]);
  const [failOnEmptyText, setFailOnEmptyText] = useState(true);
  const [locked, setLocked] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [savedSettingsSignature, setSavedSettingsSignature] = useState('');
  const [requestPolicySnapshot, setRequestPolicySnapshot] = useState({
    timeout_seconds: 180,
    retry_count: 2,
    temperature: 0.2,
    max_output_tokens: 8000,
  });
  const [startConfirmOpen, setStartConfirmOpen] = useState(false);
  const [startConfirmSnapshot, setStartConfirmSnapshot] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const selectedModelKeySet = useMemo(() => new Set(selectedModelKeys), [selectedModelKeys]);
  const mandatoryModelKeys = useMemo(
    () => modelCatalog.filter((item) => item?.mandatory).map((item) => item.key),
    [modelCatalog]
  );
  const formatBuckets = useMemo(() => resolveCompetitionFormatBuckets(competition), [competition]);
  const requiredFormatOptions = useMemo(
    () => normalizeFormatList(formatBuckets.required, []),
    [formatBuckets.required]
  );
  const optionalFormatOptions = useMemo(
    () => normalizeFormatList(formatBuckets.optional, []),
    [formatBuckets.optional]
  );
  const selectedParseFormats = useMemo(
    () => [...new Set([...requiredParseFormats, ...optionalParseFormats])],
    [requiredParseFormats, optionalParseFormats]
  );
  const parseFormatsConfigError = !requiredParseFormats.length && !optionalParseFormats.length
    ? '请至少选择一种解析格式'
    : '';
  const currentSettingsSignature = useMemo(
    () => buildAISettingsSignature(buildAISettingsSnapshot({
      modelCatalog,
      rubricCatalog,
      selectedModelKeys,
      selectedRubricKey,
      runsPerModel,
      maxInputChars,
      requiredParseFormats,
      optionalParseFormats,
      failOnEmptyText,
      timeoutSeconds: requestPolicySnapshot.timeout_seconds,
      retryCount: requestPolicySnapshot.retry_count,
      temperature: requestPolicySnapshot.temperature,
      maxOutputTokens: requestPolicySnapshot.max_output_tokens,
    })),
    [
      modelCatalog,
      rubricCatalog,
      selectedModelKeys,
      selectedRubricKey,
      runsPerModel,
      maxInputChars,
      requiredParseFormats,
      optionalParseFormats,
      failOnEmptyText,
      requestPolicySnapshot.timeout_seconds,
      requestPolicySnapshot.retry_count,
      requestPolicySnapshot.temperature,
      requestPolicySnapshot.max_output_tokens,
    ]
  );
  const hasUnsavedChanges = Boolean(savedSettingsSignature && currentSettingsSignature && savedSettingsSignature !== currentSettingsSignature);
  const reviewWindowOpen = isManualReviewWindowOpen(competition);
  const hideWindowClosedServiceError = !reviewWindowOpen && errorText === SERVICE_UNAVAILABLE_TEXT;
  const shouldSuppressWindowClosedServiceError = (text) => (
    !reviewWindowOpen && String(text || '').trim() === SERVICE_UNAVAILABLE_TEXT
  );

  const syncStateFromSettings = (data) => {
    const nextSettings = data?.settings || null;
    const nextCatalog = Array.isArray(data?.model_catalog) ? data.model_catalog : [];
    const nextRubricCatalog = Array.isArray(data?.rubric_catalog) ? data.rubric_catalog : [];
    const runCandidates = [
      Number(nextSettings?.runs_per_model_min),
      Number(nextSettings?.runs_per_model_max),
    ].filter((value) => Number.isFinite(value) && value > 0);
    const nextRunsPerModel = runCandidates.length > 0 ? Math.max(...runCandidates) : 5;
    const nextRequiredParseFormats = normalizeParseSelection(
      nextSettings?.required_parse_formats,
      requiredFormatOptions,
      toBoolFlag(nextSettings?.parse_required_formats ?? true),
      true
    );
    const nextOptionalParseFormats = normalizeParseSelection(
      nextSettings?.optional_parse_formats,
      optionalFormatOptions,
      toBoolFlag(nextSettings?.parse_optional_formats ?? false),
      false
    );
    const nextRequestPolicySnapshot = {
      timeout_seconds: Math.max(1, Number(nextSettings?.timeout_seconds || 180)),
      retry_count: Math.max(0, Number(nextSettings?.retry_count || 2)),
      temperature: Number(nextSettings?.temperature ?? 0.2),
      max_output_tokens: Math.max(256, Number(nextSettings?.max_output_tokens || 8000)),
    };
    setModelCatalog(nextCatalog);
    setRubricCatalog(nextRubricCatalog);
    setEnabled(toBoolFlag(nextSettings?.enabled));
    setSelectedModelKeys(
      normalizeSelectedModelKeys(nextCatalog, nextSettings?.selected_model_keys || [])
    );
    setSelectedRubricKey(
      normalizeSelectedRubricKey(nextRubricCatalog, nextSettings?.rubric_key)
    );
    setRunsPerModel(Number(nextRunsPerModel));
    setMaxInputChars(Number(Math.max(1000, Number(nextSettings?.max_input_chars || 40000))));
    setRequiredParseFormats(nextRequiredParseFormats);
    setOptionalParseFormats(nextOptionalParseFormats);
    setFailOnEmptyText(toBoolFlag(nextSettings?.fail_on_empty_text ?? true));
    setRequestPolicySnapshot(nextRequestPolicySnapshot);
    setLocked(toBoolFlag(data?.locked) || nextSettings?.status === 'locked');
    setCanEdit(toBoolFlag(data?.can_edit));
    setSettingsEditing(false);
    const nextSignature = buildAISettingsSignature(buildAISettingsSnapshot({
      modelCatalog: nextCatalog,
      rubricCatalog: nextRubricCatalog,
      selectedModelKeys: nextSettings?.selected_model_keys || [],
      selectedRubricKey: nextSettings?.rubric_key,
      runsPerModel: nextRunsPerModel,
      maxInputChars: Math.max(1000, Number(nextSettings?.max_input_chars || 40000)),
      requiredParseFormats: nextRequiredParseFormats,
      optionalParseFormats: nextOptionalParseFormats,
      failOnEmptyText: toBoolFlag(nextSettings?.fail_on_empty_text ?? true),
      timeoutSeconds: nextRequestPolicySnapshot.timeout_seconds,
      retryCount: nextRequestPolicySnapshot.retry_count,
      temperature: nextRequestPolicySnapshot.temperature,
      maxOutputTokens: nextRequestPolicySnapshot.max_output_tokens,
    }));
    setSavedSettingsSignature(nextSignature);
  };

  useEffect(() => {
    setRequiredParseFormats((prev) => normalizeParseSelection(prev, requiredFormatOptions, prev.length > 0, true));
    setOptionalParseFormats((prev) => normalizeParseSelection(prev, optionalFormatOptions, prev.length > 0, false));
  }, [requiredFormatOptions, optionalFormatOptions]);

  useEffect(() => {
    if (!open || !competitionId) return undefined;

    let cancelled = false;
    setLoading(true);
    setErrorText('');

    (async () => {
      try {
        const { data } = await getCompetitionAIReviewSettings(competitionId, {
          requestId: createRequestId(),
        });
        if (cancelled) return;
        syncStateFromSettings(data);
      } catch (error) {
        if (cancelled) return;
        const text = getUserFriendlyErrorText(error, '加载 AI 评审配置失败');
        setErrorText(text);
        if (typeof setMessage === 'function' && !shouldSuppressWindowClosedServiceError(text)) {
          setMessage({ type: 'error', text });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [competitionId, open, setMessage]);

  useEffect(() => {
    if (!open || reviewWindowOpen) return;
    if (errorText === SERVICE_UNAVAILABLE_TEXT) {
      setErrorText('');
    }
  }, [errorText, open, reviewWindowOpen]);

  useEffect(() => {
    if (!open) {
      setStartConfirmOpen(false);
      setStartConfirmSnapshot(null);
      setPreviewOpen(false);
      setSavedSettingsSignature('');
      setSettingsEditing(false);
    }
  }, [open]);

  const toggleModel = (item) => {
    if (!canEdit || locked) return;
    if (!item?.key || item.mandatory || item.enabled === false) return;
    setSelectedModelKeys((prev) => {
      const next = prev.includes(item.key)
        ? prev.filter((key) => key !== item.key)
        : [...prev, item.key];
      return normalizeSelectedModelKeys(modelCatalog, next);
    });
  };

  const persistSettings = async () => {
    if (!competitionId) return null;

    const requiredSelected = normalizeFormatList(requiredParseFormats, []).filter((fmt) => requiredFormatOptions.includes(fmt));
    const optionalSelected = normalizeFormatList(optionalParseFormats, []).filter((fmt) => optionalFormatOptions.includes(fmt));
    if (!requiredSelected.length && !optionalSelected.length) {
      throw new Error('请至少选择一种要解析的提交格式');
    }

    const payload = {
      selected_model_keys: normalizeSelectedModelKeys(modelCatalog, selectedModelKeys),
      rubric_key: normalizeSelectedRubricKey(rubricCatalog, selectedRubricKey),
      runs_per_model_min: runsPerModel,
      runs_per_model_max: runsPerModel,
      timeout_seconds: Math.max(1, Number(requestPolicySnapshot.timeout_seconds || 180)),
      retry_count: Math.max(0, Number(requestPolicySnapshot.retry_count || 2)),
      temperature: Number(requestPolicySnapshot.temperature ?? 0.2),
      max_input_chars: Math.max(1000, Number(maxInputChars || 40000)),
      max_output_tokens: Math.max(256, Number(requestPolicySnapshot.max_output_tokens || 8000)),
      parse_required_formats: requiredSelected.length > 0,
      parse_optional_formats: optionalSelected.length > 0,
      required_parse_formats: requiredSelected,
      optional_parse_formats: optionalSelected,
      fail_on_empty_text: failOnEmptyText,
    };
    const { data } = await updateCompetitionAIReviewSettings(
      competitionId,
      payload,
      { requestId: createRequestId() }
    );
    syncStateFromSettings(data);
    return data;
  };

  const buildStartConfirmSnapshot = (data) => {
    const settings = data?.settings || {};
    const catalog = Array.isArray(data?.model_catalog) ? data.model_catalog : [];
    const rubricCatalogData = Array.isArray(data?.rubric_catalog) ? data.rubric_catalog : [];
    const normalizedKeys = normalizeSelectedModelKeys(catalog, settings?.selected_model_keys || []);
    const catalogMap = new Map(catalog.map((item) => [String(item?.key || ''), item]));
    const rubricKey = normalizeSelectedRubricKey(rubricCatalogData, settings?.rubric_key);
    const rubricCatalogMap = new Map(rubricCatalogData.map((item) => [String(item?.key || ''), item]));
    const runsMin = Number(settings?.runs_per_model_min || 0);
    const runsMax = Number(settings?.runs_per_model_max || 0);
    const requiredSelected = normalizeParseSelection(
      settings?.required_parse_formats,
      requiredFormatOptions,
      toBoolFlag(settings?.parse_required_formats ?? true),
      true
    );
    const optionalSelected = normalizeParseSelection(
      settings?.optional_parse_formats,
      optionalFormatOptions,
      toBoolFlag(settings?.parse_optional_formats ?? false),
      false
    );
    return {
      runsMin,
      runsMax,
      rubricKey,
      rubricName: rubricCatalogMap.get(rubricKey)?.name || rubricKey,
      requiredParseFormats: requiredSelected,
      optionalParseFormats: optionalSelected,
      selectedModels: normalizedKeys.map((key) => ({
        key,
        name: catalogMap.get(key)?.name || key,
      })),
    };
  };

  const saveSettings = async () => {
    if (!competitionId) return;

    setSaving(true);
    setErrorText('');
    try {
      await persistSettings();
      setSettingsEditing(false);
      const successText = 'AI 评审配置已保存';
      if (typeof setMessage === 'function') {
        setMessage({ type: 'success', text: successText });
      }
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '保存 AI 评审配置失败');
      setErrorText(text);
      if (typeof setMessage === 'function' && !shouldSuppressWindowClosedServiceError(text)) {
        setMessage({ type: 'error', text });
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmStartReview = async () => {
    if (!competitionId || loading || saving || locked || !canEdit || !enabled) return;
    if (!reviewWindowOpen) {
      return;
    }

    setSaving(true);
    setErrorText('');
    try {
      const submissionIds = await loadReviewableSubmissionIds(competitionId);
      if (!submissionIds.length) {
        const text = '当前比赛暂无可评审作品';
        if (typeof setMessage === 'function') {
          setMessage({ type: 'warning', text });
        }
        return;
      }

      const { data } = await createCompetitionAIReviewJobs(
        competitionId,
        {
          submission_ids: submissionIds,
          force: false,
          trigger_source: 'manual',
        },
        { requestId: createRequestId() }
      );
      const jobCount = Array.isArray(data?.items) ? data.items.length : Number(data?.pagination?.total || 0);
      const successText = jobCount > 0
        ? `已开始评审，已提交 ${jobCount} 个任务`
        : '已提交评审请求';
      if (typeof setMessage === 'function') {
        setMessage({ type: 'success', text: successText });
      }
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '开始 AI 评审失败');
      setErrorText(text);
      if (typeof setMessage === 'function' && !shouldSuppressWindowClosedServiceError(text)) {
        setMessage({ type: 'error', text });
      }
    } finally {
      setSaving(false);
    }
  };

  const startReview = async () => {
    if (!competitionId || loading || saving || locked || !canEdit || !enabled || !reviewWindowOpen) return;
    if (settingsEditing || hasUnsavedChanges) {
      const text = '请先保存参数后再开始评审';
      setMessage?.({ type: 'warning', text });
      return;
    }
    setSaving(true);
    setErrorText('');
    try {
      const data = await persistSettings();
      const snapshot = buildStartConfirmSnapshot(data);
      setStartConfirmSnapshot(snapshot);
      setStartConfirmOpen(true);
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '保存 AI 评审配置失败');
      setErrorText(text);
      if (typeof setMessage === 'function' && !shouldSuppressWindowClosedServiceError(text)) {
        setMessage({ type: 'error', text });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={(event, reason) => {
          if (loading || saving || reason === 'backdropClick') return;
          onClose?.();
        }}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          AI评审配置（比赛：{competitionName || '-'}）
        </DialogTitle>
        <DialogContent dividers>
          {loading ? (
            <Stack alignItems="center" spacing={1.2} sx={{ py: 5 }}>
              <CircularProgress size={24} />
              <Typography variant="body2" color="text.secondary">加载 AI 评审配置中...</Typography>
            </Stack>
          ) : (
            <Stack spacing={2}>
              <Alert severity="info">
                “预览评审”和“开始评审”都会基于已保存配置执行；修改参数后请先保存。
              </Alert>
              {canEdit && !locked && !settingsEditing && (
                <Alert severity="info">
                  当前为已保存配置。点击“修改配置”后才可编辑，修改完成后请再次保存。
                </Alert>
              )}
              {!reviewWindowOpen && (
                <Alert severity="warning">
                  仅在评审期内可以开始评审。
                </Alert>
              )}
              {locked && (
                <Alert severity="warning">
                  当前 AI 评审配置已锁定，仅支持查看。
                </Alert>
              )}
              {errorText && !hideWindowClosedServiceError && <Alert severity="error">{errorText}</Alert>}
              {hasUnsavedChanges && (
                <Alert severity="warning">
                  当前参数有未保存修改，请先点击“保存配置”后再执行“预览评审”或“开始评审”。
                </Alert>
              )}

              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography variant="subtitle2">AI 评审状态</Typography>
                <Chip
                  size="small"
                  color={enabled ? 'success' : 'default'}
                  label={enabled ? '已启用' : '已停用'}
                />
              </Stack>
              {!enabled && (
                <Alert severity="warning">
                  AI 评审已停用，开始评审不可用。
                </Alert>
              )}
              <NumberField
                label="同一个模型评审次数"
                value={runsPerModel}
                onChange={setRunsPerModel}
                min={1}
                max={10}
                disabled={!canEdit || locked || saving || !settingsEditing}
                helperText="这里填成功评审次数；后端会自动预留更多尝试次数，尽量把每个模型跑满。"
              />
              <NumberField
                label="评审文本上限字符数"
                value={maxInputChars}
                onChange={setMaxInputChars}
                min={1000}
                max={500000}
                step={1000}
                disabled={!canEdit || locked || saving || !settingsEditing}
                helperText="作品正文与可解析附件拼接后，超过该值会截断。"
              />
              <FormControl fullWidth error={Boolean(parseFormatsConfigError)}>
                <InputLabel>解析“必选格式”附件内容（可多选）</InputLabel>
                <Select
                  multiple
                  label="解析“必选格式”附件内容（可多选）"
                  value={requiredParseFormats}
                  disabled={!canEdit || locked || saving || !settingsEditing || !requiredFormatOptions.length}
                  onChange={(event) => {
                    const next = normalizeFormatList(event.target.value, [])
                      .filter((fmt) => requiredFormatOptions.includes(fmt));
                    setRequiredParseFormats(next);
                  }}
                  renderValue={(selected) => renderFormatValue(selected)}
                >
                  {requiredFormatOptions.map((fmt) => (
                    <MenuItem key={`required_parse_${fmt}`} value={fmt}>
                      <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Box sx={{ fontWeight: requiredParseFormats.includes(fmt) ? 700 : 500 }}>{formatLabel(fmt)}</Box>
                        <CheckCircleRoundedIcon
                          fontSize="small"
                          sx={{
                            color: 'success.main',
                            opacity: requiredParseFormats.includes(fmt) ? 1 : 0,
                          }}
                        />
                      </Box>
                    </MenuItem>
                  ))}
                </Select>
                {requiredFormatOptions.length ? (
                  <FormHelperText>{parseFormatsConfigError || '可只勾选你希望送给 AI 的必选格式。'}</FormHelperText>
                ) : (
                  <FormHelperText>当前比赛没有可选的必选格式。</FormHelperText>
                )}
              </FormControl>
              <FormControl fullWidth error={Boolean(parseFormatsConfigError)}>
                <InputLabel shrink>解析“选交格式”附件内容（可多选）</InputLabel>
                <Select
                  multiple
                  displayEmpty
                  label="解析“选交格式”附件内容（可多选）"
                  value={optionalParseFormats}
                  disabled={!canEdit || locked || saving || !settingsEditing || !optionalFormatOptions.length}
                  onChange={(event) => {
                    const rawValues = Array.isArray(event.target.value)
                      ? event.target.value
                      : [event.target.value];
                    if (rawValues.map((item) => String(item)).includes(OPTIONAL_PARSE_NONE_TOKEN)) {
                      setOptionalParseFormats([]);
                      return;
                    }
                    const next = normalizeFormatList(event.target.value, [])
                      .filter((fmt) => optionalFormatOptions.includes(fmt));
                    setOptionalParseFormats(next);
                  }}
                  renderValue={(selected) => renderOptionalParseValue(selected)}
                >
                  <MenuItem key="optional_parse_none" value={OPTIONAL_PARSE_NONE_TOKEN}>
                    <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Box sx={{ fontWeight: optionalParseFormats.length === 0 ? 700 : 500 }}>无（不解析选交材料）</Box>
                      <CheckCircleRoundedIcon
                        fontSize="small"
                        sx={{
                          color: 'success.main',
                          opacity: optionalParseFormats.length === 0 ? 1 : 0,
                        }}
                      />
                    </Box>
                  </MenuItem>
                  {optionalFormatOptions.map((fmt) => (
                    <MenuItem key={`optional_parse_${fmt}`} value={fmt}>
                      <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Box sx={{ fontWeight: optionalParseFormats.includes(fmt) ? 700 : 500 }}>{formatLabel(fmt)}</Box>
                        <CheckCircleRoundedIcon
                          fontSize="small"
                          sx={{
                            color: 'success.main',
                            opacity: optionalParseFormats.includes(fmt) ? 1 : 0,
                          }}
                        />
                      </Box>
                    </MenuItem>
                  ))}
                </Select>
                {optionalFormatOptions.length ? (
                  <FormHelperText>{parseFormatsConfigError || '选交格式可按需勾选，避免重复文本进入模型。'}</FormHelperText>
                ) : (
                  <FormHelperText>当前比赛没有可选的选交格式。</FormHelperText>
                )}
              </FormControl>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={failOnEmptyText}
                    disabled={!canEdit || locked || saving || !settingsEditing}
                    onChange={(event) => setFailOnEmptyText(event.target.checked)}
                  />
                )}
                label="无可解析正文时终止评审（推荐）"
              />
              <TextField
                select
                fullWidth
                size="small"
                label="AI评审规则"
                value={selectedRubricKey}
                disabled={!canEdit || locked || saving || !settingsEditing || rubricCatalog.length === 0}
                helperText="后续新增的评审规则会在这里出现，比赛创办者可自行切换。"
                onChange={(event) => setSelectedRubricKey(String(event.target.value || ''))}
              >
                {rubricCatalog.length > 0 ? (
                  rubricCatalog.map((item) => {
                    const optionDisabled = item.enabled === false && String(item.key || '') !== String(selectedRubricKey || '');
                    return (
                      <MenuItem key={item.key} value={item.key} disabled={optionDisabled}>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>
                              {item.name || item.key}
                            </Typography>
                          </Box>
                          {item.default && <Chip size="small" color="primary" label="默认" />}
                          {item.enabled === false && <Chip size="small" label="已停用" />}
                        </Stack>
                      </MenuItem>
                    );
                  })
                ) : (
                  <MenuItem value="">
                    暂无可用规则
                  </MenuItem>
                )}
              </TextField>

              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="subtitle2">AI 评委模型</Typography>
                  <Chip size="small" label={`已选 ${selectedModelKeys.length} 个`} />
                  {mandatoryModelKeys.includes(DEFAULT_MODEL_KEY) && (
                    <Chip size="small" color="primary" label="默认模型" />
                  )}
                </Stack>
                <Stack spacing={1}>
                  {modelCatalog.map((item) => {
                    const checked = selectedModelKeySet.has(item.key);
                    const disabled = !canEdit || locked || saving || !settingsEditing || item.mandatory || item.enabled === false;
                    return (
                      <Box
                        key={item.key}
                        sx={{
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 2,
                          px: 1.5,
                          py: 1,
                        }}
                      >
                        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                          <Checkbox
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleModel(item)}
                          />
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>
                              {item.name || item.key}
                            </Typography>
                          </Box>
                          {item.key === DEFAULT_MODEL_KEY && <Chip size="small" color="primary" label="默认" />}
                          {item.mandatory && item.key !== DEFAULT_MODEL_KEY && <Chip size="small" color="primary" label="必选" />}
                          {item.enabled === false && <Chip size="small" label="已停用" />}
                        </Stack>
                      </Box>
                    );
                  })}
                </Stack>
              </Stack>

            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={onClose}
            disabled={loading || saving}
          >
            关闭
          </Button>
          <Button
            variant="outlined"
            color="info"
            onClick={() => {
              if (settingsEditing || hasUnsavedChanges) {
                setMessage?.({ type: 'warning', text: '请先保存参数后再运行预览' });
                return;
              }
              setPreviewOpen(true);
            }}
            disabled={loading || saving || modelCatalog.length === 0 || rubricCatalog.length === 0}
          >
            预览评审
          </Button>
          <Button
            variant="outlined"
            color="success"
            onClick={startReview}
            disabled={loading || saving || locked || !canEdit || !enabled || !reviewWindowOpen}
          >
            {saving ? '处理中...' : '开始评审'}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              if (!canEdit || locked || loading || saving) return;
              if (!settingsEditing) {
                setSettingsEditing(true);
                return;
              }
              saveSettings();
            }}
            disabled={loading || saving || locked || !canEdit}
          >
            {settingsEditing ? (saving ? '保存中...' : '保存配置') : '修改配置'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={startConfirmOpen}
        onClose={(_, reason) => {
          if (saving || reason === 'backdropClick') return;
          setStartConfirmOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>确认开始评审</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.2}>
            <Alert severity="warning">
              以下配置已保存到后端，请再次确认后开始评审。
            </Alert>
            <Typography variant="body2">比赛：{competitionName || '-'}</Typography>
            <Typography variant="body2">
              同一个模型评审次数：
              {startConfirmSnapshot?.runsMin === startConfirmSnapshot?.runsMax
                ? String(startConfirmSnapshot?.runsMax || 0)
                : `${startConfirmSnapshot?.runsMin || 0} ~ ${startConfirmSnapshot?.runsMax || 0}`}
            </Typography>
            <Typography variant="body2">评审规则：{startConfirmSnapshot?.rubricName || '-'}</Typography>
            <Typography variant="body2">
              解析格式：
              {`必选[${(startConfirmSnapshot?.requiredParseFormats || []).map((fmt) => formatLabel(fmt)).join('、') || '无'}]；选交[${(startConfirmSnapshot?.optionalParseFormats || []).map((fmt) => formatLabel(fmt)).join('、') || '无'}]`}
            </Typography>
            <Typography variant="body2">
              已选模型：{Array.isArray(startConfirmSnapshot?.selectedModels) ? startConfirmSnapshot.selectedModels.length : 0} 个
            </Typography>
            {!!startConfirmSnapshot?.rubricKey && (
              <Typography variant="body2">规则键：{startConfirmSnapshot.rubricKey}</Typography>
            )}
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              {(Array.isArray(startConfirmSnapshot?.selectedModels) ? startConfirmSnapshot.selectedModels : []).map((item) => (
                <Chip key={item.key} label={item.name} size="small" />
              ))}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setStartConfirmOpen(false);
              setStartConfirmSnapshot(null);
            }}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            variant="contained"
            color="success"
            onClick={() => {
              setStartConfirmOpen(false);
              setStartConfirmSnapshot(null);
              confirmStartReview();
            }}
            disabled={saving}
          >
            {saving ? '处理中...' : '确认并开始'}
          </Button>
        </DialogActions>
      </Dialog>

      <AIReviewPreviewDialog
        open={previewOpen}
        competition={competition}
        rubricCatalog={rubricCatalog}
        modelCatalog={modelCatalog}
        selectedRubricKey={selectedRubricKey}
        selectedModelKeys={selectedModelKeys}
        selectedParseFormats={selectedParseFormats}
        onClose={() => setPreviewOpen(false)}
        setMessage={setMessage}
      />
    </>
  );
}
