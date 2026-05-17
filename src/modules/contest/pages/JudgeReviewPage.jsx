import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControlLabel,
  Checkbox,
  List,
  ListItemButton,
  Slider,
  Paper,
  Stack,
  TextField,
  Typography,
  Button,
} from '@mui/material';
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';
import dayjs from 'dayjs';
import {
  createRequestId,
  getAssignedSubmissionAttachmentBlob,
  getAssignedSubmissionReviewContext,
  getCompetitionById,
  listMyAssignedSubmissionsPaged,
  submitAssignedSubmissionReview,
} from '../../../api';
import { getUserFriendlyErrorText } from '../../../utils/errorText';

const PAGE_SIZE = 200;
const PREVIEW_MIN_HEIGHT_DESKTOP = 'max(1020px, calc(100vh - 150px))';
const PREVIEW_PANEL_MIN_HEIGHT_DESKTOP = 'max(1080px, calc(100vh - 100px))';
const LIST_HEIGHT_DESKTOP = PREVIEW_MIN_HEIGHT_DESKTOP;
const WORK_DESCRIPTION_NODE_KEY = '__work_description__';
const FATAL_GRADE_BASELINE_SCORE = 44;
const FATAL_ITEM_PENALTY = 11;

function formatRangeNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  if (Number.isInteger(numeric)) return String(numeric);
  return String(numeric).replace(/\.?0+$/, '');
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function scoreToGrade(score, thresholds = []) {
  const numericScore = Number(score || 0);
  const rows = (Array.isArray(thresholds) ? thresholds : [])
    .map((item) => ({
      grade: String(item?.grade || '').trim().toUpperCase(),
      min: Number(item?.min_score ?? 0),
      max: Number(item?.max_score ?? 0),
    }))
    .filter((item) => item.grade && Number.isFinite(item.min) && Number.isFinite(item.max))
    .sort((a, b) => b.min - a.min);

  for (const item of rows) {
    if (numericScore >= item.min && numericScore <= item.max + 0.0001) return item.grade;
  }
  return 'E';
}

function listQuantitativeReviewItems(rubricDimensions = []) {
  const items = [];
  for (const dimension of (Array.isArray(rubricDimensions) ? rubricDimensions : [])) {
    const dimensionCode = String(dimension?.code || '').trim().toUpperCase();
    const dimensionName = String(dimension?.name || '').trim();
    const dimensionItems = Array.isArray(dimension?.items) ? dimension.items : [];
    if (!dimensionItems.length) {
      if (!dimensionCode) continue;
      items.push({
        code: dimensionCode,
        label: `${dimensionCode}${dimensionName ? ` ${dimensionName}` : ''}`,
        maxScore: Number(dimension?.weight || 0),
        dimensionCode,
        dimensionName,
        isDimensionTotal: true,
      });
      continue;
    }
    for (const item of dimensionItems) {
      const code = String(item?.code || '').trim().toUpperCase();
      if (!code) continue;
      items.push({
        code,
        label: `${code}${item?.name ? ` ${String(item.name).trim()}` : ''}`,
        maxScore: Number(item?.max_score || 0),
        dimensionCode,
        dimensionName,
        isDimensionTotal: false,
      });
    }
  }
  return items;
}

function normalizeQuantitativeItemScoreMap(scoreMap = {}) {
  const normalized = {};
  if (!scoreMap || typeof scoreMap !== 'object') return normalized;
  for (const [key, value] of Object.entries(scoreMap)) {
    const code = String(key || '').trim().toUpperCase();
    if (!code) continue;
    normalized[code] = String(value ?? '');
  }
  return normalized;
}

export function buildEmptyQuantitativeItemScoreMap(rubricDimensions = []) {
  const emptyScores = {};
  for (const item of listQuantitativeReviewItems(rubricDimensions)) {
    emptyScores[item.code] = '';
  }
  return emptyScores;
}

export function findFirstMissingReviewField({
  scoringMode = 'single_score',
  rubricDimensions = [],
  quantitativeItemScores = {},
  scoreInput = '',
  fatalHits = [],
} = {}) {
  const mode = String(scoringMode || '').trim().toLowerCase() || 'single_score';
  if (mode === 'history_paper_quantitative') {
    const hasFatalHit = Array.isArray(fatalHits)
      && fatalHits.some((item) => String(item || '').trim());
    for (const item of listQuantitativeReviewItems(rubricDimensions)) {
      const raw = String(quantitativeItemScores?.[item.code] ?? '').trim();
      if (!raw) {
        if (hasFatalHit) continue;
        return {
          ok: false,
          fieldType: 'quantitative',
          code: item.code,
          message: `${item.label} 尚未评分，请先填写后再提交。`,
        };
      }
      const normalized = normalizeItemScore(raw, item.maxScore);
      if (!normalized.ok) {
        return {
          ok: false,
          fieldType: 'quantitative',
          code: item.code,
          message: `${item.label}：${normalized.message}`,
        };
      }
    }
    return { ok: true, fieldType: 'quantitative', code: '', message: '' };
  }

  const text = String(scoreInput ?? '').trim();
  if (!text) {
    return {
      ok: false,
      fieldType: 'single_score',
      code: 'single_score',
      message: '请先填写评分后再提交。',
    };
  }
  const normalized = normalizeScore(text);
  if (!normalized.ok) {
    return {
      ok: false,
      fieldType: 'single_score',
      code: 'single_score',
      message: normalized.message,
    };
  }
  return { ok: true, fieldType: 'single_score', code: '', message: '' };
}

export function buildQuantitativeSnapshot(rubricDimensions = [], rubricConfig = null, itemScoreInput = {}, fatalHits = []) {
  const itemScoreMap = {};
  let rawTotalScore = 0;
  let hasAnyItemInput = false;
  for (const dimension of (Array.isArray(rubricDimensions) ? rubricDimensions : [])) {
    const dimensionCode = String(dimension?.code || '').trim().toUpperCase();
    const dimWeight = Number(dimension?.weight || 0);
    const items = Array.isArray(dimension?.items) ? dimension.items : [];
    if (!items.length) {
      if (!dimensionCode) continue;
      const raw = String(itemScoreInput?.[dimensionCode] ?? '').trim();
      if (raw) hasAnyItemInput = true;
      const parsed = Number(raw);
      const normalized = Number.isFinite(parsed)
        ? Math.max(0, Math.min(parsed, dimWeight))
        : 0;
      const fixedScore = round2(normalized);
      itemScoreMap[dimensionCode] = fixedScore;
      rawTotalScore += fixedScore;
      continue;
    }
    let dimensionTotal = 0;
    for (const item of items) {
      const code = String(item?.code || '').trim().toUpperCase();
      if (!code) continue;
      const maxScore = Number(item?.max_score || 0);
      const raw = String(itemScoreInput?.[code] ?? '').trim();
      if (raw) hasAnyItemInput = true;
      const parsed = Number(raw);
      const normalized = Number.isFinite(parsed)
        ? Math.max(0, Math.min(parsed, maxScore))
        : 0;
      const fixedScore = round2(normalized);
      itemScoreMap[code] = fixedScore;
      dimensionTotal += fixedScore;
    }
    rawTotalScore += dimensionTotal;
  }
  rawTotalScore = round2(rawTotalScore);

  const normalizedFatalHits = [...new Set(
    (Array.isArray(fatalHits) ? fatalHits : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  )];

  const rawGrade = scoreToGrade(rawTotalScore, rubricConfig?.grade_thresholds || []);
  let finalScore = rawTotalScore;
  let finalGrade = rawGrade;
  let fatalTriggered = false;

  if (normalizedFatalHits.length > 0) {
    fatalTriggered = true;
    finalScore = Math.max(0, FATAL_GRADE_BASELINE_SCORE - (normalizedFatalHits.length * FATAL_ITEM_PENALTY));
    finalScore = round2(finalScore);
    finalGrade = 'E';
  }

  return {
    itemScoreMap,
    rawTotalScore,
    rawGrade,
    finalScore,
    finalGrade,
    fatalHits: normalizedFatalHits,
    capHits: [],
    fatalTriggered,
    capTriggered: false,
    hasAnyItemInput,
    hasAnyInput: hasAnyItemInput || normalizedFatalHits.length > 0,
  };
}

function formatTime(value) {
  if (!value) return '-';
  const dt = dayjs(value);
  if (!dt.isValid()) return '-';
  return dt.format('YYYY-MM-DD HH:mm');
}

function normalizeWorkDescription(value = '') {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function canonicalAttachmentExt(value = '') {
  const token = String(value || '').trim().toLowerCase().replace(/^\./, '');
  if (token === 'doc' || token === 'docx' || token === 'word') return 'docx';
  if (token === 'xls' || token === 'xlsx' || token === 'excel') return 'xlsx';
  return token;
}

function buildOfficePreviewFailureMessage(ext = '') {
  const normalizedExt = canonicalAttachmentExt(ext);
  if (normalizedExt === 'xlsx') {
    return 'Excel 转 PDF 失败，请点击“下载原件”下载原文件。';
  }
  if (normalizedExt === 'docx') {
    return 'Word 转 PDF 失败，请点击“下载原件”下载原文件。';
  }
  return 'Office 转 PDF 失败，请点击“下载原件”下载原文件。';
}

export function resolveJudgeReviewAttachmentRequestPlan(activeExt = '') {
  const normalizedActiveExt = canonicalAttachmentExt(activeExt) || 'pdf';
  return {
    activeExt: normalizedActiveExt,
    previewAttachmentExt: normalizedActiveExt === 'docx' ? 'pdf' : normalizedActiveExt,
    downloadAttachmentExt: normalizedActiveExt,
    previewDisposition: normalizedActiveExt === 'xlsx' ? 'attachment' : 'inline',
    downloadDisposition: 'attachment',
    needsSeparatePreviewRequest: normalizedActiveExt === 'docx',
  };
}

export function isPdfContent(contentType = '', fileName = '') {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('application/pdf')) return true;
  return String(fileName || '').toLowerCase().endsWith('.pdf');
}

export function resolveAttachmentPreviewExt({
  activeExt = '',
  contentType = '',
  fileName = '',
  previewFormat = '',
} = {}) {
  const hinted = canonicalAttachmentExt(previewFormat);
  if (hinted) return hinted;
  const normalizedActiveExt = canonicalAttachmentExt(activeExt);
  if (normalizedActiveExt === 'docx') return 'pdf';
  if (isPdfContent(contentType, fileName)) return 'pdf';
  return normalizedActiveExt || 'pdf';
}

function normalizeScore(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: '请先填写评分' };
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { ok: false, message: '评分必须是数字' };
  if (parsed < 0 || parsed > 100) return { ok: false, message: '评分范围应为 0 到 100' };
  const scoreMatch = text.match(/^(\d+)(?:\.(\d*))?$/);
  if (!scoreMatch || String(scoreMatch[2] ?? '').length > 1) {
    return { ok: false, message: '评分最多保留 1 位小数' };
  }
  return { ok: true, value: Math.round(parsed * 10) / 10 };
}

function normalizeItemScore(raw, maxScore) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: 0 };
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { ok: false, message: '评分必须是数字' };
  if (parsed < 0 || parsed > Number(maxScore || 0)) {
    return { ok: false, message: `评分范围应为 0 到 ${Number(maxScore || 0)}` };
  }
  const itemScoreMatch = text.match(/^(\d+)(?:\.(\d*))?$/);
  if (!itemScoreMatch || String(itemScoreMatch[2] ?? '').length > 1) {
    return { ok: false, message: '评分最多保留 1 位小数' };
  }
  return { ok: true, value: Math.round(parsed * 10) / 10 };
}

function sanitizeScoreInput(raw, maxScore) {
  const text = String(raw ?? '').replace(/\s+/g, '');
  if (!text) return '';

  let cleaned = text.replace(/[^\d.]/g, '');
  if (!cleaned) return '';

  const dotIndex = cleaned.indexOf('.');
  if (dotIndex >= 0) {
    const intPart = cleaned.slice(0, dotIndex).replace(/\./g, '');
    const fracPart = cleaned.slice(dotIndex + 1).replace(/\./g, '').slice(0, 1);
    cleaned = `${intPart || '0'}${fracPart ? `.${fracPart}` : '.'}`;
  } else {
    cleaned = cleaned.replace(/\./g, '');
  }
  if (cleaned === '.') cleaned = '0.';

  const trailingDot = cleaned.endsWith('.');
  const numericPart = trailingDot ? cleaned.slice(0, -1) : cleaned;
  if (!numericPart) return '0.';

  const parsed = Number(numericPart);
  if (!Number.isFinite(parsed)) return '';
  const clamped = Math.min(Number(maxScore || 0), Math.max(0, parsed));
  const rounded = Math.round(clamped * 10) / 10;

  if (trailingDot && Number.isInteger(parsed) && parsed === clamped) {
    return `${formatRangeNumber(rounded)}.`;
  }
  return formatRangeNumber(rounded);
}

function pickDefaultAttachment(attachments = []) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (!items.length) return null;
  return (
    items.find((item) => Boolean(item?.is_primary) && String(item?.attachment_key || '').trim())
    || items.find((item) => String(item?.attachment_key || '').trim())
    || items[0]
  );
}

function normalizeTextEncoding(value = '') {
  const encoding = String(value || '').trim().toLowerCase();
  if (!encoding) return '';
  const aliases = {
    utf8: 'utf-8',
    utf16: 'utf-16le',
    'utf-16': 'utf-16le',
    utf16le: 'utf-16le',
    utf16be: 'utf-16be',
    gb2312: 'gb18030',
    gbk: 'gb18030',
    x_gbk: 'gb18030',
    'x-gbk': 'gb18030',
    cp936: 'gb18030',
    windows_936: 'gb18030',
    'windows-936': 'gb18030',
  };
  return aliases[encoding] || encoding;
}

function clampPreviewZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 100;
  return Math.min(200, Math.max(50, Math.round(numeric / 10) * 10));
}

export function extractCharsetFromContentType(contentType = '') {
  const match = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return normalizeTextEncoding(match?.[1] || '');
}

export function extractXmlDeclaredEncoding(prefix = '') {
  const match = String(prefix || '').match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
  return normalizeTextEncoding(match?.[1] || '');
}

function detectBomEncoding(bytes = new Uint8Array()) {
  if (!bytes || bytes.length < 2) return '';
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
  return '';
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isXmlPreview(contentType = '', fileName = '') {
  const normalizedExt = String(fileName || '').trim().toLowerCase().replace(/^\./, '').split('.').pop() || '';
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  return normalizedExt === 'xml'
    || normalizedContentType === 'application/xml'
    || normalizedContentType === 'text/xml'
    || normalizedContentType.endsWith('+xml');
}

export function canPreviewAsText(ext = '', contentType = '') {
  const normalizedExt = String(ext || '').trim().toLowerCase().replace(/^\./, '');
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  if (['xml', 'txt', 'md', 'json', 'csv', 'log', 'yaml', 'yml'].includes(normalizedExt)) return true;
  return normalizedContentType.startsWith('text/')
    || normalizedContentType === 'application/xml'
    || normalizedContentType === 'text/xml'
    || normalizedContentType.endsWith('+xml')
    || normalizedContentType === 'application/json'
    || normalizedContentType === 'text/json';
}

function isSpreadsheetPreview(ext = '', contentType = '') {
  const normalizedExt = String(ext || '').trim().toLowerCase().replace(/^\./, '');
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  if (['xls', 'xlsx', 'xlsm'].includes(normalizedExt)) return true;
  return normalizedContentType === 'application/vnd.ms-excel'
    || normalizedContentType === 'application/vnd.ms-excel.sheet.macroenabled.12'
    || normalizedContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || normalizedContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.template'
    || normalizedContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedstring+xml'
    || normalizedContentType.startsWith('application/vnd.ms-excel')
    || normalizedContentType.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.');
}

function buildTextPreviewEncodingCandidates(arrayBuffer, { contentType = '', fileName = '' } = {}) {
  const bytes = new Uint8Array(arrayBuffer || new ArrayBuffer(0));
  const prefixBytes = bytes.slice(0, 512);
  let prefix = '';
  for (const byte of prefixBytes) prefix += String.fromCharCode(byte);

  const candidates = [];
  const bomEncoding = detectBomEncoding(bytes);
  if (bomEncoding) candidates.push(bomEncoding);

  if (isXmlPreview(contentType, fileName)) {
    const xmlEncoding = extractXmlDeclaredEncoding(prefix);
    if (xmlEncoding) candidates.push(xmlEncoding);
  }

  const headerEncoding = extractCharsetFromContentType(contentType);
  if (headerEncoding) candidates.push(headerEncoding);

  candidates.push('utf-8', 'gb18030', 'utf-16le', 'utf-16be', 'big5');
  return [...new Set(candidates.map((item) => normalizeTextEncoding(item)).filter(Boolean))];
}

function countReplacementCharacters(text = '') {
  return (String(text || '').match(/\uFFFD/g) || []).length;
}

function decodeTextWithCandidates(arrayBuffer, encodings = []) {
  const bytes = new Uint8Array(arrayBuffer || new ArrayBuffer(0));
  let bestText = '';
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (const encoding of encodings) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: false });
      const text = decoder.decode(bytes);
      const penalty = countReplacementCharacters(text);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestText = text;
      }
      if (penalty === 0) return text;
    } catch {
      // skip unsupported encodings
    }
  }

  return bestText;
}

export async function decodeAttachmentBlobText(blob, { contentType = '', fileName = '' } = {}) {
  const arrayBuffer = await blob.arrayBuffer();
  const encodings = buildTextPreviewEncodingCandidates(arrayBuffer, { contentType, fileName });
  const text = decodeTextWithCandidates(arrayBuffer, encodings);
  if (text) return text;
  try {
    return await blob.text();
  } catch {
    return '';
  }
}

export function buildXlsxPreviewSrcDoc(fileName, sheets = [], zoomScale = 1) {
  const normalizedFontScale = Number.isFinite(Number(zoomScale))
    ? Math.min(2, Math.max(0.5, Number(zoomScale)))
    : 1;
  const safeTitle = escapeHtml(fileName || '表格预览');
  const safeSheets = Array.isArray(sheets) ? sheets : [];
  const tabsHtml = safeSheets.length
    ? safeSheets.map((sheet, index) => {
      const sheetName = escapeHtml(sheet?.name || `Sheet ${index + 1}`);
      return `<button type="button" class="sheet-tab${index === 0 ? ' active' : ''}" data-index="${index}">${sheetName}</button>`;
    }).join('')
    : '<div class="empty">没有可显示的工作表</div>';
  const panelsHtml = safeSheets.length
    ? safeSheets.map((sheet, index) => {
      const sheetName = escapeHtml(sheet?.name || `Sheet ${index + 1}`);
      const sheetHtml = String(sheet?.html || '').trim() || '<div class="empty">该工作表为空</div>';
      return `<section class="sheet-panel${index === 0 ? ' active' : ''}" data-index="${index}">
        <div class="sheet-head">${sheetName}</div>
        <div class="sheet-body">${sheetHtml}</div>
      </section>`;
    }).join('')
    : '<div class="empty-sheet">没有可显示的工作表</div>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    body { margin: 0; padding: 16px; background: #f7f2ff; color: #231637; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; --font-scale: ${normalizedFontScale}; }
    .hint { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; background: #f2ecff; border: 1px solid #dcccf8; color: #4b2b7f; }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .sheet-tab { border: 1px solid #d7c5f4; background: #fff; color: #5a3b88; border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
    .sheet-tab.active { background: #7b4dc2; color: #fff; border-color: #7b4dc2; }
    .sheet-panel { display: none; background: #fff; border: 1px solid #e7dcfa; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(75, 43, 127, 0.08); }
    .sheet-panel.active { display: block; }
    .sheet-head { padding: 10px 12px; font-weight: 700; color: #4b2b7f; border-bottom: 1px solid #f0e7fb; background: linear-gradient(180deg, #fcf9ff 0%, #f7f1ff 100%); }
    .sheet-body { overflow: auto; padding: 12px; font-size: calc(13px * var(--font-scale)); line-height: 1.55; }
    .sheet-body table { border-collapse: collapse; width: max-content; min-width: 100%; }
    .sheet-body td, .sheet-body th { border: 1px solid #d8c6f4; padding: 6px 8px; vertical-align: top; white-space: nowrap; }
    .sheet-body th { background: #f5edff; }
    .empty, .empty-sheet { padding: 18px; color: #7b68a6; }
  </style>
</head>
<body>
  <div class="hint">当前为 Excel 在线预览，可切换工作表并横向滚动查看。</div>
  <div class="tabs">${tabsHtml}</div>
  <div class="panels">${panelsHtml}</div>
  <script>
    (function() {
      const tabs = Array.from(document.querySelectorAll('.sheet-tab'));
      const panels = Array.from(document.querySelectorAll('.sheet-panel'));
      function activate(index) {
        tabs.forEach((tab, tabIndex) => tab.classList.toggle('active', tabIndex === index));
        panels.forEach((panel, panelIndex) => panel.classList.toggle('active', panelIndex === index));
      }
      tabs.forEach((tab) => {
        tab.addEventListener('click', () => activate(Number(tab.dataset.index || 0)));
      });
    })();
  </script>
</body>
</html>`;
}

function getAttachmentNodeKey(item, index = 0) {
  const backendKey = String(item?.attachment_key || '').trim();
  if (backendKey) return backendKey;
  const name = String(item?.attachment_name || '').trim();
  const ext = String(item?.attachment_ext || '').trim().toLowerCase().replace(/^\./, '');
  return `fallback-${index}-${ext}-${name}`;
}

function buildDocxPreviewSrcDoc(fileName, docxHtml, warnings = [], zoomScale = 1) {
  const safeTitle = String(fileName || '文档预览').replace(/[<>]/g, '');
  const warningLines = (Array.isArray(warnings) ? warnings : [])
    .map((msg) => String(msg?.message || msg || '').trim())
    .filter(Boolean)
    .map((line) => `<li>${line.replace(/[<>]/g, '')}</li>`)
    .join('');
  const warningBlock = warningLines
    ? `<div style="margin-bottom:12px;padding:10px 12px;border-radius:10px;background:#fff4e5;border:1px solid #f7cf8f;color:#8a5200;"><strong>转换提示：</strong><ul style="margin:8px 0 0 18px;padding:0;">${warningLines}</ul></div>`
    : '';
  const normalizedFontScale = Number.isFinite(Number(zoomScale))
    ? Math.min(2, Math.max(0.5, Number(zoomScale)))
    : 1;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    body { margin: 0; padding: 18px; background: #faf7ff; color: #231637; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; --font-scale: ${normalizedFontScale}; }
    .hint { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; background: #f2ecff; border: 1px solid #dcccf8; color: #4b2b7f; }
    .content { background: #fff; border: 1px solid #e7dcfa; border-radius: 12px; padding: 18px; line-height: 1.75; word-break: break-word; overflow: auto; font-size: calc(14px * var(--font-scale)); }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; max-width: 100%; }
    td, th { border: 1px solid #d8c6f4; padding: 6px 8px; }
  </style>
</head>
<body>
  <div class="hint">当前为 docx 在线预览，格式与原文件可能存在差异。</div>
  ${warningBlock}
  <div class="content">${String(docxHtml || '').trim() || '<div style="color:#666;">文档内容为空</div>'}</div>
</body>
</html>`;
}

async function convertDocxBlobToHtml(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const mammothModule = await import('mammoth');
  const mammothLib = (
    mammothModule && typeof mammothModule.convertToHtml === 'function'
  ) ? mammothModule : mammothModule.default;
  if (!mammothLib || typeof mammothLib.convertToHtml !== 'function') {
    throw new Error('docx_preview_not_supported');
  }
  const result = await Promise.race([
    mammothLib.convertToHtml({ arrayBuffer }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('docx_preview_timeout')), 15000);
    }),
  ]);
  return {
    html: String(result?.value || ''),
    warnings: Array.isArray(result?.messages) ? result.messages : [],
  };
}

async function convertSpreadsheetBlobToSheets(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const xlsxModule = await import('xlsx');
  const xlsxLib = (
    xlsxModule?.default && typeof xlsxModule.default.read === 'function'
  ) ? xlsxModule.default : xlsxModule;
  const utils = xlsxLib?.utils;
  const read = xlsxLib?.read;
  if (!utils || typeof read !== 'function' || typeof utils.sheet_to_html !== 'function') {
    throw new Error('xlsx_preview_not_supported');
  }
  const workbook = read(arrayBuffer, { type: 'array', cellDates: true });
  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  return sheetNames.map((sheetName, index) => {
    const sheet = workbook?.Sheets?.[sheetName];
    const html = sheet ? utils.sheet_to_html(sheet, { id: `sheet_${index}` }) : '';
    return { name: sheetName, html };
  });
}

export default function JudgeReviewPage({
  competitionId,
  setMessage,
}) {
  const normalizedCompetitionId = Number(competitionId || 0);
  const [competition, setCompetition] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState(0);
  const [expandedSubmissionId, setExpandedSubmissionId] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewName, setPreviewName] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewDocxHtml, setPreviewDocxHtml] = useState('');
  const [previewDocxWarnings, setPreviewDocxWarnings] = useState([]);
  const [previewXlsxSheets, setPreviewXlsxSheets] = useState([]);
  const [previewTextContent, setPreviewTextContent] = useState('');
  const [previewDownloadUrl, setPreviewDownloadUrl] = useState('');
  const [previewDownloadName, setPreviewDownloadName] = useState('');
  const [selectedAttachmentKey, setSelectedAttachmentKey] = useState('');
  const [previewZoom, setPreviewZoom] = useState(100);
  const [reviewContext, setReviewContext] = useState(null);
  const [quantitativeItemScores, setQuantitativeItemScores] = useState({});
  const [quantitativeFatalHits, setQuantitativeFatalHits] = useState([]);
  const [scoreInput, setScoreInput] = useState('');
  const [commentInput, setCommentInput] = useState('');
  const [reviewFieldError, setReviewFieldError] = useState(null);
  const [editingReviewed, setEditingReviewed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const singleScoreInputRef = useRef(null);
  const quantitativeInputRefs = useRef({});

  const selectedRow = useMemo(
    () => rows.find((item) => Number(item.submission_id) === Number(selectedSubmissionId)) || null,
    [rows, selectedSubmissionId]
  );
  const selectedWorkDescription = useMemo(
    () => (
      normalizeWorkDescription(selectedRow?.work_description)
      || normalizeWorkDescription(reviewContext?.submission_work_description)
    ),
    [selectedRow?.work_description, reviewContext?.submission_work_description]
  );
  const selectedReviewed = Boolean(selectedRow?.reviewed || reviewContext?.review);
  const scoringMode = String(reviewContext?.competition_scoring_settings?.settings?.mode_key || 'single_score')
    .trim()
    .toLowerCase() || 'single_score';
  const competitionDisplayName = useMemo(() => {
    const name = String(competition?.name || '').trim();
    if (name) return name;
    return normalizedCompetitionId ? `比赛 #${normalizedCompetitionId}` : '比赛';
  }, [competition?.name, normalizedCompetitionId]);
  const rubricConfig = reviewContext?.competition_scoring_settings?.rubric_config || null;
  const rubricDimensions = Array.isArray(rubricConfig?.dimensions) ? rubricConfig.dimensions : [];
  const rubricFatalCriteria = Array.isArray(rubricConfig?.fatal_criteria) ? rubricConfig.fatal_criteria : [];
  const quantitativeReviewItems = useMemo(
    () => listQuantitativeReviewItems(rubricDimensions),
    [rubricDimensions]
  );
  const attachmentItems = Array.isArray(reviewContext?.attachments) ? reviewContext.attachments : [];
  const attachmentNodes = useMemo(
    () => attachmentItems.map((item, index) => ({ ...item, __node_key: getAttachmentNodeKey(item, index) })),
    [attachmentItems]
  );
  const selectedAttachmentNode = useMemo(
    () => attachmentNodes.find((item) => String(item?.__node_key || '').trim() === String(selectedAttachmentKey || '').trim()) || null,
    [attachmentNodes, selectedAttachmentKey]
  );
  const selectedWorkDescriptionNode = String(selectedAttachmentKey || '').trim() === WORK_DESCRIPTION_NODE_KEY;
  const selectedReviewedScore = reviewContext?.review?.score;
  const selectedReviewedGrade = reviewContext?.review?.final_grade;
  const reviewContextCanEdit = Boolean(reviewContext?.can_edit);
  const previewZoomPercent = useMemo(() => clampPreviewZoom(previewZoom), [previewZoom]);
  const previewZoomScale = useMemo(() => previewZoomPercent / 100, [previewZoomPercent]);
  const pdfPreviewSrc = useMemo(() => {
    if (!previewUrl) return '';
    // 尽量按页宽展示，并关闭导航面板以减少左右无效留白（不同浏览器支持度不同）。
    return `${previewUrl}#page=1&zoom=${previewZoomPercent}&navpanes=0&pagemode=none`;
  }, [previewUrl, previewZoomPercent]);
  const previewDocxSrcDoc = useMemo(() => {
    if (!previewDocxHtml) return '';
    return buildDocxPreviewSrcDoc(
      previewName || 'submission-docx-preview',
      previewDocxHtml,
      previewDocxWarnings,
      previewZoomScale
    );
  }, [previewDocxHtml, previewDocxWarnings, previewName, previewZoomScale]);
  const previewXlsxSrcDoc = useMemo(() => {
    if (!Array.isArray(previewXlsxSheets) || !previewXlsxSheets.length) return '';
    return buildXlsxPreviewSrcDoc(
      previewName || 'submission-xlsx-preview',
      previewXlsxSheets,
      previewZoomScale
    );
  }, [previewXlsxSheets, previewName, previewZoomScale]);
  const previewTextFontSize = useMemo(() => Math.max(11, Math.min(20, Math.round(13 * previewZoomScale))), [previewZoomScale]);
  const reviewPermission = useMemo(() => {
    const contextWindow = reviewContext?.review_window || null;
    if (contextWindow && typeof contextWindow === 'object') {
      return {
        canScore: Boolean(contextWindow.can_score),
        message: String(contextWindow.message || '').trim(),
      };
    }
    const now = dayjs();
    const submissionEnd = competition?.submission_end ? dayjs(competition.submission_end) : null;
    const reviewStart = competition?.review_start ? dayjs(competition.review_start) : null;
    const reviewEnd = competition?.review_end ? dayjs(competition.review_end) : null;
    const nonReviewMessage = '当前为非评审阶段，不能点评';
    if (submissionEnd && submissionEnd.isValid() && (now.isBefore(submissionEnd) || now.isSame(submissionEnd))) {
      return { canScore: false, message: nonReviewMessage };
    }
    if (!reviewStart || !reviewStart.isValid() || now.isBefore(reviewStart)) {
      return { canScore: false, message: '当前为非评审阶段，不能点评' };
    }
    if (reviewEnd && reviewEnd.isValid() && now.isAfter(reviewEnd)) {
      return { canScore: false, message: nonReviewMessage };
    }
    return { canScore: true, message: '' };
  }, [reviewContext?.review_window, competition?.submission_end, competition?.review_start, competition?.review_end]);
  const canEditReviewFields = Boolean(
    selectedRow
    && reviewPermission.canScore
    && reviewContextCanEdit
    && !saving
    && !draftSaving
    && (!selectedReviewed || editingReviewed)
  );
  const quantitativeScoreInputsLockedByFatal = quantitativeFatalHits.length > 0;
  const quantitativeSnapshot = useMemo(
    () => buildQuantitativeSnapshot(
      rubricDimensions,
      rubricConfig,
      quantitativeItemScores,
      quantitativeFatalHits
    ),
    [rubricDimensions, rubricConfig, quantitativeItemScores, quantitativeFatalHits]
  );
  const quantitativeHasInput = quantitativeSnapshot.hasAnyInput;
  const quantitativeDisplayTotalScore = quantitativeSnapshot.fatalTriggered
    ? quantitativeSnapshot.finalScore
    : quantitativeSnapshot.rawTotalScore;
  const rubricDimensionCodes = useMemo(
    () => (
      rubricDimensions
        .map((dimension) => String(dimension?.code || '').trim().toUpperCase())
        .filter(Boolean)
    ),
    [rubricDimensions]
  );
  const expectedDimensionCodes = useMemo(() => {
    const rubricKey = String(rubricConfig?.rubric_key || '').trim().toLowerCase();
    if (rubricKey === 'history_paper_quantitative') {
      return ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    }
    return rubricDimensionCodes;
  }, [rubricConfig?.rubric_key, rubricDimensionCodes]);
  const missingExpectedDimensionCodes = useMemo(
    () => expectedDimensionCodes.filter((code) => !rubricDimensionCodes.includes(code)),
    [expectedDimensionCodes, rubricDimensionCodes]
  );

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
    };
  }, [previewDownloadUrl, previewUrl]);

  useEffect(() => {
    setEditingReviewed(false);
  }, [selectedSubmissionId]);

  useEffect(() => {
    setPreviewZoom(100);
  }, [selectedSubmissionId]);

  useEffect(() => {
    setReviewFieldError(null);
  }, [selectedSubmissionId]);

  useEffect(() => {
    if (!reviewFieldError) return;
    if (reviewFieldError.fieldType !== 'quantitative') return;
    if (quantitativeFatalHits.length === 0) return;
    setReviewFieldError(null);
  }, [quantitativeFatalHits, reviewFieldError]);

  useEffect(() => {
    if (!normalizedCompetitionId) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await getCompetitionById(normalizedCompetitionId, { requestId: createRequestId() });
        if (cancelled) return;
        setCompetition(detail?.data || null);
      } catch {
        if (!cancelled) setCompetition(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [normalizedCompetitionId]);

  useEffect(() => {
    if (!normalizedCompetitionId) return;
    let cancelled = false;
    (async () => {
      setListLoading(true);
      try {
        const mergedItems = [];
        let offset = 0;
        let guard = 0;
        while (guard < 100) {
          const result = await listMyAssignedSubmissionsPaged(
            normalizedCompetitionId,
            PAGE_SIZE,
            offset,
            '',
            { requestId: createRequestId() }
          );
          const pageItems = Array.isArray(result?.items) ? result.items : [];
          if (pageItems.length) mergedItems.push(...pageItems);

          const total = Number(result?.total || 0);
          const resolvedOffset = Number(result?.offset || offset);
          const nextOffset = resolvedOffset + pageItems.length;
          const hasMore = total > 0 ? nextOffset < total : pageItems.length >= PAGE_SIZE;
          if (!hasMore || pageItems.length === 0) break;

          offset = nextOffset;
          guard += 1;
        }
        if (cancelled) return;
        setRows(mergedItems);
        if (!mergedItems.length) {
          setSelectedSubmissionId(0);
          setExpandedSubmissionId(0);
        } else {
          const currentSelectedSubmissionId = Number(selectedSubmissionId || 0);
          const hasCurrentSelection = mergedItems.some((item) => Number(item.submission_id) === currentSelectedSubmissionId);
          const nextSelectedSubmissionId = hasCurrentSelection
            ? currentSelectedSubmissionId
            : Number(mergedItems[0].submission_id || 0);
          setSelectedSubmissionId(nextSelectedSubmissionId);
          setExpandedSubmissionId(nextSelectedSubmissionId);
        }
      } catch (error) {
        if (!cancelled) {
          setRows([]);
          setSelectedSubmissionId(0);
          setExpandedSubmissionId(0);
          setMessage?.({ type: 'error', text: getUserFriendlyErrorText(error, '加载分配作品失败') });
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [normalizedCompetitionId, setMessage]);

  useEffect(() => {
    if (!normalizedCompetitionId || !selectedSubmissionId) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
      setPreviewUrl('');
      setPreviewName('');
      setPreviewDownloadName('');
      setPreviewError('');
      setPreviewDocxHtml('');
      setPreviewDocxWarnings([]);
      setPreviewXlsxSheets([]);
      setPreviewTextContent('');
      setPreviewDownloadUrl('');
      setSelectedAttachmentKey('');
      setExpandedSubmissionId(0);
      setReviewContext(null);
      setQuantitativeItemScores({});
      setQuantitativeFatalHits([]);
      setScoreInput('');
      setCommentInput('');
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
    setPreviewUrl('');
    setPreviewName('');
    setPreviewDownloadName('');
    setPreviewError('');
    setPreviewDocxHtml('');
    setPreviewDocxWarnings([]);
    setPreviewXlsxSheets([]);
    setPreviewTextContent('');
    setPreviewDownloadUrl('');
    setSelectedAttachmentKey('');
    setReviewContext(null);

    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      try {
        const contextResult = await getAssignedSubmissionReviewContext(
          normalizedCompetitionId,
          selectedSubmissionId,
          { requestId: createRequestId() }
        );
        const contextData = contextResult?.data || null;
        if (!contextData) throw new Error('missing_review_context');
        if (cancelled) return;

        const review = contextData?.review || null;
        const detailJson = review?.detail_json || {};
        const contextRubricConfig = contextData?.competition_scoring_settings?.rubric_config || null;
        const contextRubricDimensions = Array.isArray(contextRubricConfig?.dimensions) ? contextRubricConfig.dimensions : [];
        const initialItemScores = {};
        const detailDimensionScores = Array.isArray(detailJson?.dimension_totals) ? detailJson.dimension_totals : [];
        if (detailDimensionScores.length) {
          detailDimensionScores.forEach((item) => {
            const code = String(item?.code || '').trim();
            if (!code) return;
            initialItemScores[code.toUpperCase()] = item?.score !== undefined && item?.score !== null ? String(item.score) : '';
          });
        } else {
          const bucketedScores = {};
          (Array.isArray(detailJson?.item_scores) ? detailJson.item_scores : []).forEach((item) => {
            const code = String(item?.code || '').trim().toUpperCase();
            if (!code) return;
            const dimensionCode = code.charAt(0);
            if (!dimensionCode) return;
            const parsed = Number(item?.score ?? 0);
            if (!Number.isFinite(parsed)) return;
            bucketedScores[dimensionCode] = round2((bucketedScores[dimensionCode] || 0) + parsed);
          });
          contextRubricDimensions.forEach((dimension) => {
            const dimensionCode = String(dimension?.code || '').trim().toUpperCase();
            if (!dimensionCode) return;
            if (Object.prototype.hasOwnProperty.call(bucketedScores, dimensionCode)) {
              initialItemScores[dimensionCode] = String(bucketedScores[dimensionCode]);
            }
          });
          if (!Object.keys(initialItemScores).length) {
            (Array.isArray(detailJson?.item_scores) ? detailJson.item_scores : []).forEach((item) => {
              const code = String(item?.code || '').trim();
              if (!code) return;
              initialItemScores[code.toUpperCase()] = item?.score !== undefined && item?.score !== null ? String(item.score) : '';
            });
          }
        }
        setReviewContext(contextData);
        setScoreInput(review?.score !== undefined && review?.score !== null ? String(review.score) : '');
        setCommentInput(String(review?.comment || ''));
        setQuantitativeItemScores(initialItemScores);
        setQuantitativeFatalHits(
          Array.isArray(detailJson?.fatal_hits)
            ? detailJson.fatal_hits.map((item) => String(item || '').trim()).filter(Boolean)
            : []
        );

        try {
          const contextMode = String(
            contextData?.competition_scoring_settings?.settings?.mode_key || 'single_score'
          ).trim().toLowerCase();
          const draftRaw = window.localStorage.getItem(
            `contest_judge_review_draft_${normalizedCompetitionId}_${selectedSubmissionId}`
          );
          if (draftRaw) {
            const draft = JSON.parse(draftRaw);
            if (draft && typeof draft === 'object') {
              const draftMode = String(draft.scoring_mode || '').trim().toLowerCase();
              if (!draftMode || draftMode === contextMode) {
                setScoreInput(String(draft.score_input ?? review?.score ?? ''));
                setCommentInput(String(draft.comment_input ?? review?.comment ?? ''));
                setQuantitativeItemScores(
                  draft.quantitative_item_scores && typeof draft.quantitative_item_scores === 'object'
                    ? normalizeQuantitativeItemScoreMap(draft.quantitative_item_scores)
                    : initialItemScores
                );
                setQuantitativeFatalHits(
                  Array.isArray(draft.quantitative_fatal_hits)
                    ? draft.quantitative_fatal_hits.map((item) => String(item || '').trim()).filter(Boolean)
                    : (Array.isArray(detailJson?.fatal_hits)
                      ? detailJson.fatal_hits.map((item) => String(item || '').trim()).filter(Boolean)
                      : [])
                );
              }
            }
          }
        } catch {
          // ignore local draft parse error
        }
        const contextAttachments = Array.isArray(contextData?.attachments) ? contextData.attachments : [];
        const defaultAttachment = pickDefaultAttachment(contextAttachments);
        const contextWorkDescription = normalizeWorkDescription(contextData?.submission_work_description);
        setSelectedAttachmentKey(
          defaultAttachment
            ? getAttachmentNodeKey(defaultAttachment, 0)
            : (contextWorkDescription ? WORK_DESCRIPTION_NODE_KEY : '')
        );
      } catch (error) {
        if (!cancelled) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          if (previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
          setPreviewUrl('');
          setPreviewName('');
          setPreviewError(getUserFriendlyErrorText(error, '加载作品详情失败'));
          setPreviewDocxHtml('');
          setPreviewDocxWarnings([]);
          setPreviewXlsxSheets([]);
          setPreviewTextContent('');
          setPreviewDownloadUrl('');
          setSelectedAttachmentKey('');
          setReviewContext(null);
          setQuantitativeItemScores({});
          setQuantitativeFatalHits([]);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [normalizedCompetitionId, selectedSubmissionId]);

  useEffect(() => {
    if (!normalizedCompetitionId || !selectedSubmissionId) return;

    const normalizedSelectedAttachmentKey = String(selectedAttachmentKey || '').trim();
    if (normalizedSelectedAttachmentKey === WORK_DESCRIPTION_NODE_KEY) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
      setPreviewUrl('');
      setPreviewName('作品简介');
      setPreviewDownloadName('');
      setPreviewDocxHtml('');
      setPreviewDocxWarnings([]);
      setPreviewXlsxSheets([]);
      setPreviewTextContent('');
      setPreviewDownloadUrl('');
      setPreviewError('');
      setDetailLoading(false);
      return;
    }

    if (!attachmentNodes.length) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
      setPreviewUrl('');
      setPreviewName(selectedWorkDescription ? '作品简介' : '');
      setPreviewDownloadName('');
      setPreviewDocxHtml('');
      setPreviewDocxWarnings([]);
      setPreviewXlsxSheets([]);
      setPreviewTextContent('');
      setPreviewDownloadUrl('');
      if (selectedWorkDescription) {
        setPreviewError('');
        setSelectedAttachmentKey(WORK_DESCRIPTION_NODE_KEY);
        setDetailLoading(false);
      } else {
        setPreviewError('该作品未提供可在线预览附件');
      }
      return;
    }

    const activeAttachment = attachmentNodes.find((item) => String(item?.__node_key || '').trim() === normalizedSelectedAttachmentKey) || null;
    if (!activeAttachment) {
      const defaultAttachment = pickDefaultAttachment(attachmentNodes);
      const fallbackKey = defaultAttachment
        ? String(defaultAttachment.__node_key || '').trim()
        : (selectedWorkDescription ? WORK_DESCRIPTION_NODE_KEY : '');
      if (!fallbackKey) return;
      if (fallbackKey !== normalizedSelectedAttachmentKey) {
        setSelectedAttachmentKey(fallbackKey);
      }
      return;
    }

    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      setPreviewError('');
      let downloadResult = null;
      let previewResult = null;
      let downloadFailure = null;
      let previewFailure = null;
      let downloadUrlCreated = false;
      try {
        const activeExt = canonicalAttachmentExt(activeAttachment?.attachment_ext || '') || 'pdf';
        const attachmentPlan = resolveJudgeReviewAttachmentRequestPlan(activeExt);
        const attachmentKey = String(activeAttachment?.attachment_key || '').trim();

        const downloadRequest = getAssignedSubmissionAttachmentBlob(
          normalizedCompetitionId,
          selectedSubmissionId,
          {
            requestId: createRequestId(),
            disposition: attachmentPlan.downloadDisposition,
            attachmentExt: attachmentPlan.downloadAttachmentExt,
            attachmentKey,
          }
        );
        const previewRequest = attachmentPlan.needsSeparatePreviewRequest
          ? getAssignedSubmissionAttachmentBlob(
              normalizedCompetitionId,
              selectedSubmissionId,
              {
                requestId: createRequestId(),
                disposition: attachmentPlan.previewDisposition,
                attachmentExt: attachmentPlan.previewAttachmentExt,
                attachmentKey,
              }
            )
          : Promise.resolve(null);

        const [downloadSettled, previewSettled] = await Promise.allSettled([downloadRequest, previewRequest]);

        if (cancelled) return;
        downloadResult = downloadSettled.status === 'fulfilled' ? downloadSettled.value : null;
        previewResult = previewSettled.status === 'fulfilled' ? previewSettled.value : null;
        downloadFailure = downloadSettled.status === 'rejected' ? downloadSettled.reason : null;
        previewFailure = previewSettled.status === 'rejected' ? previewSettled.reason : null;

        if (previewUrl) URL.revokeObjectURL(previewUrl);
        if (previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
        setPreviewUrl('');
        setPreviewDocxHtml('');
        setPreviewDocxWarnings([]);
        setPreviewXlsxSheets([]);
        setPreviewTextContent('');
        setPreviewDownloadUrl('');
        setPreviewDownloadName('');

        const downloadFileName = downloadResult?.fileName || activeAttachment?.attachment_name || `submission_${selectedSubmissionId}.${activeExt}`;
        const previewSourceResult = attachmentPlan.needsSeparatePreviewRequest ? previewResult : downloadResult;
        const previewFileName = previewSourceResult?.fileName || downloadFileName;
        if (downloadResult?.blob) {
          const downloadUrl = URL.createObjectURL(downloadResult.blob);
          downloadUrlCreated = true;
          setPreviewDownloadUrl(downloadUrl);
          setPreviewDownloadName(downloadFileName);
        }

        const blob = previewSourceResult?.blob || null;
        const contentType = previewSourceResult?.contentType || '';
        const previewFormat = String(previewSourceResult?.previewFormat || '').trim().toLowerCase().replace(/^\./, '');
        const renderExt = resolveAttachmentPreviewExt({
          activeExt,
          contentType,
          fileName: previewFileName,
          previewFormat,
        });
        if (!blob) {
          setPreviewName(previewFileName);
          if (attachmentPlan.needsSeparatePreviewRequest && downloadResult?.blob) {
            setPreviewError(buildOfficePreviewFailureMessage(activeExt));
          } else {
            setPreviewError(getUserFriendlyErrorText(downloadFailure || previewFailure, '加载作品附件失败'));
          }
          return;
        }

        if (renderExt === 'pdf') {
          if (!isPdfContent(contentType, previewFileName)) {
            setPreviewName(previewFileName);
            setPreviewError('该作品未提供可在线预览的 PDF，请点击“下载原件”查看。');
            return;
          }
          const url = URL.createObjectURL(blob);
          setPreviewUrl(url);
          setPreviewName(previewFileName);
          setPreviewError('');
          return;
        }

        if (renderExt === 'docx') {
          const { html, warnings } = await convertDocxBlobToHtml(blob);
          if (cancelled) return;
          setPreviewName(previewFileName);
          setPreviewDocxHtml(html);
          setPreviewDocxWarnings(warnings);
          setPreviewXlsxSheets([]);
          setPreviewError('');
          return;
        }

        if (isSpreadsheetPreview(renderExt, contentType)) {
          const sheets = await convertSpreadsheetBlobToSheets(blob);
          if (cancelled) return;
          setPreviewName(previewFileName);
          setPreviewXlsxSheets(sheets);
          setPreviewDocxHtml('');
          setPreviewDocxWarnings([]);
          setPreviewTextContent('');
          setPreviewError('');
          return;
        }

        if (canPreviewAsText(renderExt, contentType)) {
          const text = await decodeAttachmentBlobText(blob, { contentType, fileName });
          if (cancelled) return;
          setPreviewName(previewFileName);
          setPreviewXlsxSheets([]);
          setPreviewTextContent(text || '');
          setPreviewError('');
          return;
        }

        setPreviewName(previewFileName);
        setPreviewXlsxSheets([]);
        if (activeExt === 'xlsx') {
          setPreviewError('该作品为 Excel 附件，暂不支持在线预览，请点击“下载原件”查看。');
        } else {
          setPreviewError('该附件暂不支持在线预览，请点击“下载原件”查看。');
        }
      } catch (error) {
        if (!cancelled) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          if (!downloadUrlCreated && previewDownloadUrl) URL.revokeObjectURL(previewDownloadUrl);
          setPreviewUrl('');
          setPreviewName('');
          setPreviewError(downloadUrlCreated
            ? '预览加载失败，请点击“下载原件”下载原文件。'
            : getUserFriendlyErrorText(error, '加载作品附件失败'));
          setPreviewDocxHtml('');
          setPreviewDocxWarnings([]);
          setPreviewXlsxSheets([]);
          setPreviewTextContent('');
          if (!downloadUrlCreated) {
            setPreviewDownloadUrl('');
            setPreviewDownloadName('');
          }
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [normalizedCompetitionId, selectedSubmissionId, attachmentNodes, selectedAttachmentKey, selectedWorkDescription]);

  const handleDownloadPreviewAttachment = () => {
    if (!previewDownloadUrl) return;
    const link = document.createElement('a');
    link.href = previewDownloadUrl;
    link.download = previewDownloadName || previewName || selectedAttachmentNode?.attachment_name || 'submission';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleToggleSubmissionExpansion = (submissionId) => {
    const nextSubmissionId = Number(submissionId || 0);
    if (!nextSubmissionId) return;
    setSelectedSubmissionId(nextSubmissionId);
    setExpandedSubmissionId((prev) => (Number(prev) === nextSubmissionId ? 0 : nextSubmissionId));
  };

  const focusReviewField = (fieldType, code) => {
    const inputNode = fieldType === 'quantitative'
      ? quantitativeInputRefs.current[String(code || '').trim().toUpperCase()]
      : singleScoreInputRef.current;
    if (!inputNode) return;
    if (typeof inputNode.scrollIntoView === 'function') {
      inputNode.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
    if (typeof inputNode.focus === 'function') {
      inputNode.focus({ preventScroll: true });
    }
  };

  const buildDraftKey = () => `contest_judge_review_draft_${normalizedCompetitionId}_${selectedSubmissionId}`;

  const saveDraft = async () => {
    if (!normalizedCompetitionId || !selectedSubmissionId) return;
    if (!selectedRow) return;
    const isQuantitativeMode = scoringMode === 'history_paper_quantitative';
    if (isQuantitativeMode) {
      for (const item of quantitativeReviewItems) {
        const code = String(item?.code || '').trim().toUpperCase();
        if (!code) continue;
        const maxScore = Number(item?.maxScore || 0);
        const normalized = normalizeItemScore(quantitativeItemScores[code], maxScore);
        if (!normalized.ok) {
          setMessage?.({ type: 'warning', text: `${code}：${normalized.message}` });
          return;
        }
      }
    } else {
      const text = String(scoreInput ?? '').trim();
      if (text) {
        const normalized = normalizeScore(text);
        if (!normalized.ok) {
          setMessage?.({ type: 'warning', text: normalized.message });
          return;
        }
      }
    }

    setDraftSaving(true);
    try {
      const payload = {
        scoring_mode: scoringMode,
        score_input: String(scoreInput ?? ''),
        comment_input: String(commentInput ?? ''),
        quantitative_item_scores: quantitativeItemScores,
        quantitative_fatal_hits: quantitativeFatalHits,
        updated_at: new Date().toISOString(),
      };
      window.localStorage.setItem(buildDraftKey(), JSON.stringify(payload));
      setMessage?.({ type: 'success', text: '草稿已保存（本地）' });
    } catch {
      setMessage?.({ type: 'error', text: '草稿保存失败，请稍后重试' });
    } finally {
      setDraftSaving(false);
    }
  };

  const saveReview = async () => {
    if (!normalizedCompetitionId || !selectedSubmissionId) return;
    if (!reviewPermission.canScore) {
      setMessage?.({ type: 'warning', text: reviewPermission.message || '当前为非评审阶段，不能点评' });
      return;
    }

    const validation = findFirstMissingReviewField({
      scoringMode,
      rubricDimensions,
      quantitativeItemScores,
      scoreInput,
      fatalHits: quantitativeFatalHits,
    });
    if (!validation.ok) {
      setReviewFieldError(validation);
      setMessage?.({ type: 'warning', text: validation.message });
      focusReviewField(validation.fieldType, validation.code);
      return;
    }

    const isQuantitativeMode = scoringMode === 'history_paper_quantitative';
    let payload = {
      comment: String(commentInput || '').trim(),
    };
    let finalScoreForList = null;
    if (isQuantitativeMode) {
      const itemScores = [];
      const allowPartialByFatal = quantitativeFatalHits.length > 0;
      for (const item of quantitativeReviewItems) {
        const code = String(item?.code || '').trim().toUpperCase();
        if (!code) continue;
        const maxScore = Number(item?.maxScore || 0);
        const rawScore = String(quantitativeItemScores[code] ?? '').trim();
        if (!rawScore) {
          if (allowPartialByFatal) continue;
          const validationError = {
            ok: false,
            fieldType: 'quantitative',
            code,
            message: `${code} 尚未评分，请先填写后再提交。`,
          };
          setReviewFieldError(validationError);
          setMessage?.({ type: 'warning', text: validationError.message });
          focusReviewField(validationError.fieldType, validationError.code);
          return;
        }
        const normalized = normalizeItemScore(rawScore, maxScore);
        if (!normalized.ok) {
          const validationError = {
            ok: false,
            fieldType: 'quantitative',
            code,
            message: `${code}：${normalized.message}`,
          };
          setReviewFieldError(validationError);
          setMessage?.({ type: 'warning', text: validationError.message });
          focusReviewField(validationError.fieldType, validationError.code);
          return;
        }
        itemScores.push({ code, score: normalized.value });
      }
      payload = {
        ...payload,
        detail_json: {
          item_scores: itemScores,
          fatal_hits: quantitativeFatalHits,
        },
      };
    } else {
      const normalized = normalizeScore(scoreInput);
      if (!normalized.ok) {
        const validationError = {
          ok: false,
          fieldType: 'single_score',
          code: 'single_score',
          message: normalized.message,
        };
        setReviewFieldError(validationError);
        setMessage?.({ type: 'warning', text: normalized.message });
        focusReviewField(validationError.fieldType, validationError.code);
        return;
      }
      payload = { ...payload, score: normalized.value };
      finalScoreForList = normalized.value;
    }

    setSaving(true);
    try {
      const currentId = Number(selectedSubmissionId);
      const currentIndex = rows.findIndex((item) => Number(item.submission_id) === currentId);
      const nextRow = currentIndex >= 0 ? rows[currentIndex + 1] : null;

      const result = await submitAssignedSubmissionReview(
        normalizedCompetitionId,
        selectedSubmissionId,
        payload,
        { requestId: createRequestId() }
      );
      const savedReview = result?.data || null;
      if (savedReview?.score !== undefined && savedReview?.score !== null) {
        finalScoreForList = Number(savedReview.score);
      }
      setReviewFieldError(null);
      setReviewContext((prev) => {
        if (!prev || typeof prev !== 'object') return prev;
        return { ...prev, review: savedReview || prev.review };
      });
      setMessage?.({ type: 'success', text: '评分已保存' });
      setRows((prev) => prev.map((item) => (
        Number(item.submission_id) === Number(selectedSubmissionId)
          ? { ...item, reviewed: true, my_score: finalScoreForList }
          : item
      )));
      setEditingReviewed(false);
      try {
        window.localStorage.removeItem(buildDraftKey());
      } catch {
        // ignore localStorage cleanup failure
      }
      if (nextRow && Number(nextRow.submission_id || 0) > 0) {
        setSelectedSubmissionId(Number(nextRow.submission_id));
        setExpandedSubmissionId(Number(nextRow.submission_id));
        setMessage?.({ type: 'success', text: '评分已保存，已切换到下一个作品' });
      } else {
        setMessage?.({ type: 'success', text: '评分已保存' });
      }
    } catch (error) {
      setMessage?.({ type: 'error', text: getUserFriendlyErrorText(error, '保存评分失败') });
    } finally {
      setSaving(false);
    }
  };

  if (!normalizedCompetitionId || Number.isNaN(normalizedCompetitionId)) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">无效的比赛参数</Alert>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        pt: 0,
        px: { xs: 0.5, md: 0.8 },
        pb: { xs: 0.8, md: 1.2 },
        background: 'linear-gradient(150deg, #f6f0ff 0%, #ebe0ff 45%, #f8f4ff 100%)',
      }}
    >
      <Paper
        elevation={0}
        sx={{
          borderRadius: 3,
          border: '1px solid #ddcff2',
          overflow: 'hidden',
          background: 'linear-gradient(165deg, #ffffff 0%, #f7f1ff 100%)',
        }}
      >
        <Box
          sx={{
            px: { xs: 1.4, md: 2.2 },
            py: 1.1,
            borderBottom: '1px solid #e9def8',
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'auto minmax(0, 1fr) auto' },
            alignItems: 'center',
            rowGap: { xs: 0.75, md: 0 },
            columnGap: 1,
            background: 'linear-gradient(90deg, #ffffff 0%, #f4ecff 100%)',
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 700, color: '#3f2467' }}>
              数智文献处理平台比赛 评审工作台
            </Typography>
          </Stack>
          <Box sx={{ minWidth: 0, display: 'flex', justifyContent: { xs: 'flex-start', md: 'center' } }}>
            <Typography
              variant="subtitle1"
              sx={{
                fontWeight: 800,
                color: '#7b4ec1',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '100%',
              }}
            >
              比赛：{competitionDisplayName}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.8} sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', md: 'flex-end' } }}>
            <Chip
              size="small"
              color="secondary"
              variant="outlined"
              label={`评审时间：${formatTime(competition?.review_start)} ~ ${formatTime(competition?.review_end)}`}
            />
            <Chip
              size="small"
              color={scoringMode === 'history_paper_quantitative' ? 'warning' : 'default'}
              variant="outlined"
              label={scoringMode === 'history_paper_quantitative' ? '维度评分模式' : '单分模式'}
            />
          </Stack>
        </Box>
        <Box
          sx={{
            p: { xs: 0.9, md: 1.2 },
            display: 'grid',
            gap: 1.2,
            width: '100%',
            maxWidth: { md: 1680 },
            mx: 'auto',
            pr: { md: 0.6 },
          }}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateAreas: {
                xs: '"list" "preview" "review"',
                md: '"list preview" "review review"',
                xl: '"list preview review"',
              },
              gridTemplateColumns: {
                xs: '1fr',
                md: '300px minmax(0, 1fr)',
                xl: '300px minmax(0, 1fr) minmax(380px, 460px)',
              },
              gap: 1.6,
              minHeight: { xs: 540, md: PREVIEW_PANEL_MIN_HEIGHT_DESKTOP },
              alignItems: 'start',
              justifyContent: 'center',
            }}
          >
            <Box sx={{ gridArea: 'list' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#553383', mb: 1 }}>
                作品列表
              </Typography>
              <Paper
                variant="outlined"
                sx={{
                  borderRadius: 2,
                  borderColor: '#ddcff2',
                  overflow: 'hidden',
                  background: '#fff',
                  boxShadow: '0 8px 24px rgba(90, 50, 145, 0.08)',
                }}
              >
                {listLoading ? (
                  <Stack alignItems="center" justifyContent="center" sx={{ height: { xs: 240, md: LIST_HEIGHT_DESKTOP } }} spacing={1}>
                    <CircularProgress size={26} />
                    <Typography variant="body2" color="text.secondary">加载中...</Typography>
                  </Stack>
                ) : !rows.length ? (
                  <Box sx={{ p: 2, minHeight: { xs: 240, md: LIST_HEIGHT_DESKTOP } }}>
                    <Alert severity="info">当前比赛暂无分配给你的作品</Alert>
                  </Box>
                ) : (
                  <List
                    disablePadding
                    sx={{
                      height: { xs: 240, md: LIST_HEIGHT_DESKTOP },
                      overflowY: 'scroll',
                      scrollbarGutter: 'stable',
                      scrollbarWidth: 'auto',
                      scrollbarColor: '#c8c8d2 #f3f3f8',
                      p: 1,
                      '&::-webkit-scrollbar': { width: 14 },
                      '&::-webkit-scrollbar-thumb': {
                        backgroundColor: '#ffffff',
                        backgroundImage: 'repeating-linear-gradient(180deg, rgba(186, 186, 194, 0.95) 0px, rgba(186, 186, 194, 0.95) 1px, rgba(255, 255, 255, 0.95) 1px, rgba(255, 255, 255, 0.95) 4px)',
                        borderRadius: 999,
                        border: '1px solid #b8b8c4',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(210,210,220,0.95), 0 2px 5px rgba(0,0,0,0.2)',
                      },
                      '&::-webkit-scrollbar-thumb:hover': {
                        borderColor: '#a8a8b6',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(196,196,209,0.95), 0 3px 6px rgba(0,0,0,0.24)',
                      },
                      '&::-webkit-scrollbar-track': {
                        background: 'linear-gradient(180deg, #ffffff 0%, #f7f7fb 100%)',
                        borderRadius: 999,
                        boxShadow: 'inset 0 0 0 1px rgba(208,208,220,0.95)',
                      },
                    }}
                  >
                    {rows.map((row, index) => {
                      const submissionId = Number(row.submission_id || 0);
                      const selected = Number(selectedSubmissionId) === submissionId;
                      const expanded = Number(expandedSubmissionId) === submissionId;
                      const listNo = index + 1;
                      const workDescription = normalizeWorkDescription(row.work_description);
                      const descriptionNodeSelected = selected && selectedWorkDescriptionNode;
                      return (
                        <Box
                          key={row.assignment_id || row.submission_id}
                          sx={{
                            mb: 0.7,
                            borderRadius: 1.5,
                            border: selected ? '1px solid #8d63cf' : '1px solid #dfd1f4',
                            background: selected ? 'linear-gradient(120deg, #f6efff 0%, #ffffff 100%)' : '#fff',
                            boxShadow: selected ? '0 8px 20px rgba(85, 49, 134, 0.14)' : '0 4px 12px rgba(90, 50, 145, 0.06)',
                            overflow: 'hidden',
                          }}
                        >
                          <ListItemButton
                            selected={selected}
                            onClick={() => handleToggleSubmissionExpansion(submissionId)}
                            sx={{
                              width: '100%',
                              py: 0.95,
                              px: 1.1,
                              alignItems: 'flex-start',
                              borderRadius: 0,
                              '&.Mui-selected': {
                                bgcolor: 'transparent',
                              },
                              '&:hover': {
                                backgroundColor: 'rgba(145, 110, 211, 0.05)',
                              },
                            }}
                          >
                            <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ width: '100%' }}>
                              <Box
                                sx={{
                                  width: 9,
                                  height: 9,
                                  mt: 0.55,
                                  borderRadius: '50%',
                                  flexShrink: 0,
                                  backgroundColor: row.reviewed ? '#2e7d32' : '#9e9e9e',
                                  boxShadow: row.reviewed ? '0 0 0 2px rgba(46, 125, 50, 0.16)' : '0 0 0 2px rgba(158, 158, 158, 0.16)',
                                }}
                              />
                              <Box sx={{ minWidth: 0, flex: 1 }}>
                                <Typography
                                  variant="body2"
                                  sx={{
                                    fontWeight: selected ? 700 : 600,
                                    color: selected ? '#43266f' : '#5a3b88',
                                    lineHeight: 1.35,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {`${listNo}. ${row.title || '-'}`}
                                </Typography>
                              </Box>
                              <Box
                                aria-hidden="true"
                                sx={{
                                  flexShrink: 0,
                                  mt: 0.1,
                                  color: '#7b4dc2',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                }}
                              >
                                {expanded ? <ExpandLessRoundedIcon fontSize="small" /> : <ExpandMoreRoundedIcon fontSize="small" />}
                              </Box>
                            </Stack>
                            </ListItemButton>
                            <Collapse in={expanded} timeout="auto" unmountOnExit>
                              <Box
                                sx={{
                                  px: 0.9,
                                  py: 0.8,
                                  background: 'linear-gradient(180deg, #fcfaff 0%, #f8f2ff 100%)',
                                  borderTop: '1px solid #ece0fb',
                                }}
                              >
                                {detailLoading && selected && Number(selectedSubmissionId) === submissionId ? (
                                  <Stack alignItems="center" justifyContent="center" spacing={0.8} sx={{ py: 1.5 }}>
                                    <CircularProgress size={18} />
                                    <Typography variant="caption" color="text.secondary">加载节点中...</Typography>
                                  </Stack>
                                ) : (workDescription || attachmentNodes.length) ? (
                                  <Stack spacing={0.45}>
                                    {workDescription ? (
                                      <ListItemButton
                                        selected={descriptionNodeSelected}
                                        onClick={() => {
                                          setSelectedSubmissionId(submissionId);
                                          setExpandedSubmissionId(submissionId);
                                          setSelectedAttachmentKey(WORK_DESCRIPTION_NODE_KEY);
                                        }}
                                        sx={{
                                          borderRadius: 1.1,
                                          pl: 1.1,
                                          pr: 1,
                                          py: 0.85,
                                          border: descriptionNodeSelected ? '1px solid #8d63cf' : '1px solid #eee4fb',
                                          background: descriptionNodeSelected ? '#f4ecff' : '#fff',
                                          '&.Mui-selected': {
                                            bgcolor: '#f4ecff',
                                          },
                                          '&:hover': {
                                            backgroundColor: descriptionNodeSelected ? '#f0e6ff' : '#faf7ff',
                                          },
                                        }}
                                      >
                                        <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', minWidth: 0 }}>
                                          <DescriptionRoundedIcon sx={{ fontSize: 18, color: descriptionNodeSelected ? '#7b4dc2' : '#a28bcf', flexShrink: 0 }} />
                                          <Box sx={{ minWidth: 0 }}>
                                            <Typography variant="body2" sx={{ color: '#4e2f7f', fontWeight: 700 }}>
                                              作品简介
                                            </Typography>
                                          </Box>
                                        </Stack>
                                      </ListItemButton>
                                    ) : null}
                                    {attachmentNodes.map((item, attachmentIndex) => {
                                      const key = String(item?.__node_key || '').trim();
                                      const extLabel = String(item?.attachment_ext || '').trim().toUpperCase();
                                      const nodeSelected = String(selectedAttachmentKey || '').trim() === key;
                                      return (
                                        <ListItemButton
                                          key={key}
                                          selected={nodeSelected}
                                          onClick={() => {
                                            setSelectedSubmissionId(submissionId);
                                            setExpandedSubmissionId(submissionId);
                                            setSelectedAttachmentKey(key);
                                          }}
                                          sx={{
                                            borderRadius: 1.1,
                                            pl: 1.1,
                                            pr: 1,
                                            py: 0.7,
                                            border: nodeSelected ? '1px solid #8d63cf' : '1px solid #eee4fb',
                                            background: nodeSelected ? '#f4ecff' : '#fff',
                                            '&.Mui-selected': {
                                              bgcolor: '#f4ecff',
                                            },
                                            '&:hover': {
                                              backgroundColor: nodeSelected ? '#f0e6ff' : '#faf7ff',
                                            },
                                          }}
                                        >
                                          <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', minWidth: 0 }}>
                                            <DescriptionRoundedIcon sx={{ fontSize: 18, color: nodeSelected ? '#7b4dc2' : '#a28bcf', flexShrink: 0 }} />
                                            <Typography
                                              variant="body2"
                                              sx={{
                                                color: '#4e2f7f',
                                                whiteSpace: 'nowrap',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                              }}
                                            >
                                              {`${attachmentIndex + 1}. ${item?.attachment_name || '未命名附件'}${extLabel ? `（${extLabel}）` : ''}`}
                                            </Typography>
                                          </Stack>
                                        </ListItemButton>
                                      );
                                    })}
                                  </Stack>
                                ) : (
                                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 0.5, py: 0.4 }}>
                                    该作品暂无简介或附件节点
                                  </Typography>
                                )}
                            </Box>
                          </Collapse>
                        </Box>
                      );
                    })}
                  </List>
                )}
              </Paper>
            </Box>
            <Paper
              variant="outlined"
              sx={{
                gridArea: 'preview',
                width: '100%',
                justifySelf: 'center',
                borderRadius: 2,
                borderColor: '#dbcaf5',
                p: 1.2,
                display: 'grid',
                gridTemplateRows: 'auto 1fr',
                minHeight: { xs: 480, md: PREVIEW_PANEL_MIN_HEIGHT_DESKTOP },
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ px: 0.5, pb: 1 }} spacing={1}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" sx={{ color: '#4e2f7f', fontWeight: 700 }}>
                      {selectedRow ? `作品：${selectedRow.title || `#${selectedRow.submission_id}`}` : '请选择作品'}
                    </Typography>
                    {selectedRow ? (
                      <Typography variant="caption" sx={{ display: 'block', mt: 0.2, color: '#7b68a6' }}>
                        {selectedWorkDescriptionNode
                          ? '当前内容：作品简介'
                          : (previewName || selectedAttachmentNode?.attachment_name ? `当前附件：${previewName || selectedAttachmentNode?.attachment_name}` : '当前附件：-')}
                      </Typography>
                    ) : null}
                  </Box>
                  {!selectedWorkDescriptionNode ? (
                    <Stack direction="row" alignItems="center" spacing={1} sx={{ flexShrink: 0 }}>
                      <Typography variant="caption" sx={{ color: '#7b68a6', minWidth: 40, textAlign: 'right' }}>
                        {previewZoomPercent}%
                      </Typography>
                      <Slider
                        size="small"
                        value={previewZoomPercent}
                        min={50}
                        max={200}
                        step={10}
                        onChange={(_, value) => {
                          const nextValue = Array.isArray(value) ? value[0] : value;
                          setPreviewZoom(clampPreviewZoom(nextValue));
                        }}
                        sx={{ width: 96 }}
                        aria-label="附件预览缩放"
                      />
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => setPreviewZoom((prev) => clampPreviewZoom(prev - 10))}
                        sx={{ minWidth: 34, px: 1 }}
                      >
                        A-
                      </Button>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => setPreviewZoom((prev) => clampPreviewZoom(prev + 10))}
                        sx={{ minWidth: 34, px: 1 }}
                      >
                        A+
                      </Button>
                      {previewDownloadUrl ? (
                        <Button size="small" variant="outlined" onClick={handleDownloadPreviewAttachment}>
                          下载原件
                        </Button>
                      ) : null}
                    </Stack>
                  ) : null}
              </Stack>
              <Box
                sx={{
                  border: '1px solid #e9def8',
                  borderRadius: 1.5,
                  overflow: 'hidden',
                  background: '#fff',
                  minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP },
                }}
              >
                  {detailLoading ? (
                    <Stack alignItems="center" justifyContent="center" sx={{ minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP } }} spacing={1}>
                      <CircularProgress size={26} />
                      <Typography variant="body2" color="text.secondary">加载作品中...</Typography>
                    </Stack>
                  ) : selectedWorkDescriptionNode ? (
                    <Box
                      sx={{
                        width: '100%',
                        minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP },
                        maxHeight: { xs: 'none', md: PREVIEW_MIN_HEIGHT_DESKTOP },
                        overflow: 'auto',
                        background: 'linear-gradient(180deg, #f7f3ff 0%, #fdfbff 100%)',
                        p: { xs: 1.6, md: 3.2 },
                      }}
                    >
                      <Paper
                        elevation={0}
                        sx={{
                          maxWidth: 860,
                          mx: 'auto',
                          minHeight: { xs: 360, md: 'calc(100% - 8px)' },
                          p: { xs: 2.2, md: 4 },
                          borderRadius: 2,
                          border: '1px solid #e1d4f7',
                          background: '#fff',
                          boxShadow: '0 12px 30px rgba(90, 50, 145, 0.10)',
                        }}
                      >
                        <Typography variant="overline" sx={{ color: '#7b4dc2', fontWeight: 900, letterSpacing: 1.2 }}>
                          作品简介
                        </Typography>
                        <Typography variant="h6" sx={{ mt: 0.2, color: '#3f2467', fontWeight: 800 }}>
                          {selectedRow?.title || '未命名作品'}
                        </Typography>
                        <Divider sx={{ my: 2.2, borderColor: '#eadffc' }} />
                        {selectedWorkDescription ? (
                          <Typography
                            sx={{
                              color: '#2f263d',
                              fontSize: { xs: 16, md: 18 },
                              lineHeight: 1.95,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {selectedWorkDescription}
                          </Typography>
                        ) : (
                          <Alert severity="info">该作品未填写作品简介。</Alert>
                        )}
                      </Paper>
                    </Box>
                  ) : previewError ? (
                    <Box sx={{ p: 2.2 }}>
                      <Alert severity="warning">{previewError}</Alert>
                    </Box>
                  ) : previewUrl ? (
                  <Box
                    sx={{
                      width: '100%',
                      minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP },
                      height: 'auto',
                      background: '#f7f7fa',
                      display: 'flex',
                      justifyContent: 'flex-start',
                    }}
                  >
                    <Box sx={{ width: '100%' }}>
                      <iframe
                        title={previewName || 'submission-preview'}
                        src={pdfPreviewSrc || previewUrl}
                        style={{ width: '100%', height: PREVIEW_MIN_HEIGHT_DESKTOP, minHeight: PREVIEW_MIN_HEIGHT_DESKTOP, border: 'none' }}
                      />
                    </Box>
                  </Box>
                ) : previewDocxSrcDoc ? (
                  <Box
                    sx={{
                      width: '100%',
                      minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP },
                      height: 'auto',
                      background: '#f7f7fa',
                      display: 'flex',
                      justifyContent: 'flex-start',
                    }}
                  >
                    <Box sx={{ width: '100%' }}>
                      <iframe
                        title={previewName || 'submission-docx-preview'}
                        srcDoc={previewDocxSrcDoc}
                        style={{ width: '100%', height: PREVIEW_MIN_HEIGHT_DESKTOP, minHeight: PREVIEW_MIN_HEIGHT_DESKTOP, border: 'none' }}
                      />
                    </Box>
                  </Box>
                ) : previewXlsxSrcDoc ? (
                  <Box
                    sx={{
                      width: '100%',
                      minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP },
                      height: 'auto',
                      background: '#f7f7fa',
                      display: 'flex',
                      justifyContent: 'flex-start',
                    }}
                  >
                    <Box sx={{ width: '100%' }}>
                      <iframe
                        title={previewName || 'submission-xlsx-preview'}
                        srcDoc={previewXlsxSrcDoc}
                        style={{ width: '100%', height: PREVIEW_MIN_HEIGHT_DESKTOP, minHeight: PREVIEW_MIN_HEIGHT_DESKTOP, border: 'none' }}
                      />
                    </Box>
                  </Box>
                ) : previewTextContent ? (
                  <Box
                    sx={{
                      width: '100%',
                      minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP },
                      maxHeight: { xs: 'none', md: PREVIEW_MIN_HEIGHT_DESKTOP },
                      overflow: 'auto',
                      background: '#f8f7fb',
                      p: 1.5,
                    }}
                  >
                    <Typography
                      component="pre"
                      sx={{
                        m: 0,
                        color: '#2e2342',
                        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
                        fontSize: previewTextFontSize,
                        lineHeight: 1.55,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {previewTextContent}
                    </Typography>
                  </Box>
                ) : (
                  <Stack alignItems="center" justifyContent="center" sx={{ minHeight: { xs: 420, md: PREVIEW_MIN_HEIGHT_DESKTOP } }}>
                    <Typography variant="body2" color="text.secondary">请选择左侧附件节点开始查看</Typography>
                  </Stack>
                )}
              </Box>
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                gridArea: 'review',
                borderRadius: 2,
                borderColor: '#dbcaf5',
                p: { xs: 1.2, md: 1.6 },
                alignSelf: { xs: 'stretch', md: 'start' },
                mt: 0,
                justifySelf: 'stretch',
                minHeight: { xs: 'auto', xl: PREVIEW_PANEL_MIN_HEIGHT_DESKTOP },
                maxHeight: { xs: 'none', xl: PREVIEW_PANEL_MIN_HEIGHT_DESKTOP },
                height: { xs: 'auto', xl: PREVIEW_PANEL_MIN_HEIGHT_DESKTOP },
                overflow: 'hidden',
                display: 'flex',
              }}
            >
              <Stack sx={{ width: '100%', height: '100%', minHeight: 0 }} spacing={0}>
                <Box
                  sx={{
                    flex: '0 0 auto',
                    pb: 0.75,
                    mb: 0.8,
                    borderBottom: '1px solid #ece2fb',
                  }}
                >
                  <Typography variant="subtitle2" sx={{ color: '#4e2f7f', fontWeight: 700 }}>
                    {scoringMode === 'history_paper_quantitative' ? '维度评分表' : '评分与评语'}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'scroll',
                    WebkitOverflowScrolling: 'touch',
                    touchAction: 'pan-y',
                    scrollbarGutter: 'stable',
                    scrollbarWidth: 'auto',
                    scrollbarColor: '#c8c8d2 #f3f3f8',
                    pr: { xs: 0, xl: 0.4 },
                    maxHeight: { xs: '52vh', md: '60vh', xl: 'none' },
                    '&::-webkit-scrollbar': { width: 14 },
                    '&::-webkit-scrollbar-thumb': {
                      backgroundColor: '#ffffff',
                      backgroundImage: 'repeating-linear-gradient(180deg, rgba(186, 186, 194, 0.95) 0px, rgba(186, 186, 194, 0.95) 1px, rgba(255, 255, 255, 0.95) 1px, rgba(255, 255, 255, 0.95) 4px)',
                      borderRadius: 999,
                      border: '1px solid #b8b8c4',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(210,210,220,0.95), 0 2px 5px rgba(0,0,0,0.2)',
                    },
                    '&::-webkit-scrollbar-thumb:hover': {
                      borderColor: '#a8a8b6',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(196,196,209,0.95), 0 3px 6px rgba(0,0,0,0.24)',
                    },
                    '&::-webkit-scrollbar-track': {
                      background: 'linear-gradient(180deg, #ffffff 0%, #f7f7fb 100%)',
                      borderRadius: 999,
                      boxShadow: 'inset 0 0 0 1px rgba(208,208,220,0.95)',
                    },
                  }}
                >
                  <Stack
                    spacing={1.2}
                    sx={{
                      pr: 0.2,
                      pb: 0.2,
                      pt: scoringMode === 'history_paper_quantitative' ? 0.2 : 1.4,
                    }}
                  >
                    {!reviewPermission.canScore && (
                      <Alert severity="warning">{reviewPermission.message}</Alert>
                    )}
                    {!reviewContextCanEdit && (
                      <Alert severity="warning">当前评分设置已锁定，当前作品仅支持查看评分结果。</Alert>
                    )}
                    {reviewFieldError && (
                      <Alert severity="error">{reviewFieldError.message}</Alert>
                    )}
                    {selectedReviewed && (
                      <Alert severity="info">
                        已评审：分数 {selectedReviewedScore ?? '-'}{selectedReviewedGrade ? `，等级 ${selectedReviewedGrade}` : ''}
                      </Alert>
                    )}
                    {scoringMode === 'history_paper_quantitative' ? (
                      <>
                        {!!rubricFatalCriteria.length && (
                          <Paper variant="outlined" sx={{ p: 1.2, borderColor: '#f0cfcc', background: '#fff9f8' }}>
                            <Typography variant="body2" sx={{ fontWeight: 700, color: '#9b3023', mb: 0.6 }}>
                              致命否决项（命中后直接 E 级；每项 -11 分，按 44 分起算）
                            </Typography>
                            <Stack spacing={0.2}>
                              {rubricFatalCriteria.map((item) => {
                                const code = String(item?.code || '').trim();
                                const checked = quantitativeFatalHits.includes(code);
                                return (
                                  <FormControlLabel
                                    key={code}
                                    control={(
                                      <Checkbox
                                        size="small"
                                        checked={checked}
                                        disabled={!canEditReviewFields}
                                        onChange={(event) => {
                                          const nextChecked = Boolean(event.target.checked);
                                          if (nextChecked) {
                                            setQuantitativeItemScores(buildEmptyQuantitativeItemScoreMap(rubricDimensions));
                                          }
                                          setQuantitativeFatalHits((prev) => {
                                            if (nextChecked) return [...new Set([...prev, code])];
                                            return prev.filter((value) => value !== code);
                                          });
                                        }}
                                      />
                                    )}
                                    label={`${item?.name || code}${item?.description ? `：${item.description}` : ''}`}
                                  />
                                );
                              })}
                            </Stack>
                          </Paper>
                        )}
                        {quantitativeScoreInputsLockedByFatal && (
                          <Alert severity="info">
                            已命中致命否决项，维度评分输入已锁定；取消勾选后可继续填写维度分数。
                          </Alert>
                        )}

                        {!!missingExpectedDimensionCodes.length && (
                          <Alert severity="warning">
                            当前评分规则仅加载到 {rubricDimensionCodes.join(' / ')}，缺少 {missingExpectedDimensionCodes.join(' / ')}。
                          </Alert>
                        )}

                        <Stack spacing={1.2}>
                          {rubricDimensions.map((dimension) => {
                            const items = Array.isArray(dimension?.items) ? dimension.items : [];
                            const dimensionCode = String(dimension?.code || '').trim().toUpperCase();
                            const dimensionName = String(dimension?.name || '').trim();
                            const dimensionWeight = Number(dimension?.weight || 0);
                            if (!items.length) {
                              return (
                                <Paper key={dimensionCode || dimension?.name} variant="outlined" sx={{ p: 1.2, borderColor: '#e4d7f6' }}>
                                  <Typography variant="body2" sx={{ fontWeight: 700, color: '#4e2f7f', mb: 0.8 }}>
                                    {`${dimensionCode || ''} ${dimensionName || ''}（满分 ${dimensionWeight ?? '-'}）`}
                                  </Typography>
                                  <TextField
                                    size="small"
                                    type="text"
                                    label={`${dimensionCode || ''} ${dimensionName || ''}（0-${formatRangeNumber(dimensionWeight) || 0}）`}
                                    placeholder={`0-${formatRangeNumber(dimensionWeight) || 0}`}
                                    InputLabelProps={{ shrink: true }}
                                    value={String(quantitativeItemScores[dimensionCode] ?? '')}
                                    onChange={(event) => {
                                      const sanitized = sanitizeScoreInput(event.target.value, dimensionWeight);
                                      setQuantitativeItemScores((prev) => ({ ...prev, [dimensionCode]: sanitized }));
                                      if (
                                        reviewFieldError?.fieldType === 'quantitative'
                                        && reviewFieldError.code === dimensionCode
                                        && String(sanitized || '').trim()
                                      ) {
                                        setReviewFieldError(null);
                                      }
                                    }}
                                    inputRef={(node) => {
                                      if (!dimensionCode) return;
                                      quantitativeInputRefs.current[dimensionCode] = node;
                                    }}
                                    inputProps={{ inputMode: 'decimal', autoComplete: 'off' }}
                                    disabled={!canEditReviewFields || quantitativeScoreInputsLockedByFatal}
                                    fullWidth
                                    error={reviewFieldError?.fieldType === 'quantitative' && reviewFieldError.code === dimensionCode}
                                    helperText={reviewFieldError?.fieldType === 'quantitative' && reviewFieldError.code === dimensionCode ? reviewFieldError.message : ''}
                                  />
                                </Paper>
                              );
                            }
                            return (
                              <Paper key={dimension?.code || dimension?.name} variant="outlined" sx={{ p: 1.2, borderColor: '#e4d7f6' }}>
                                <Typography variant="body2" sx={{ fontWeight: 700, color: '#4e2f7f', mb: 0.8 }}>
                                  {`${dimension?.code || ''} ${dimension?.name || ''}（满分 ${dimension?.weight ?? '-'}）`}
                                </Typography>
                                <Stack spacing={0.8}>
                                  {items.map((item) => (
                                    <TextField
                                      key={item?.code || item?.name}
                                      size="small"
                                      type="text"
                                      label={`${item?.code || ''} ${item?.name || ''}（0-${item?.max_score ?? 0}）`}
                                      placeholder={`0-${formatRangeNumber(item?.max_score ?? 0)}`}
                                      InputLabelProps={{ shrink: true }}
                                      value={String(quantitativeItemScores[String(item?.code || '').trim().toUpperCase()] ?? '')}
                                      onChange={(event) => {
                                        const code = String(item?.code || '').trim();
                                        const normalizedCode = code.toUpperCase();
                                        const maxScore = Number(item?.max_score || 0);
                                        const sanitized = sanitizeScoreInput(event.target.value, maxScore);
                                        setQuantitativeItemScores((prev) => ({ ...prev, [normalizedCode]: sanitized }));
                                        if (
                                          reviewFieldError?.fieldType === 'quantitative'
                                          && reviewFieldError.code === normalizedCode
                                          && String(sanitized || '').trim()
                                        ) {
                                          setReviewFieldError(null);
                                        }
                                      }}
                                      inputRef={(node) => {
                                        const code = String(item?.code || '').trim().toUpperCase();
                                        if (!code) return;
                                        quantitativeInputRefs.current[code] = node;
                                      }}
                                      inputProps={{ inputMode: 'decimal', autoComplete: 'off' }}
                                      disabled={!canEditReviewFields || quantitativeScoreInputsLockedByFatal}
                                      fullWidth
                                      error={reviewFieldError?.fieldType === 'quantitative' && reviewFieldError.code === String(item?.code || '').trim().toUpperCase()}
                                      helperText={reviewFieldError?.fieldType === 'quantitative' && reviewFieldError.code === String(item?.code || '').trim().toUpperCase() ? reviewFieldError.message : ''}
                                    />
                                  ))}
                                </Stack>
                              </Paper>
                            );
                          })}
                        </Stack>

                    </>
                  ) : (
                    <TextField
                      label="评分（0-100）"
                      type="text"
                      placeholder="0-100"
                      sx={{
                        mt: 0,
                        '& .MuiInputLabel-root.MuiInputLabel-shrink': {
                          px: 0.5,
                          lineHeight: 1.2,
                          backgroundColor: '#fff',
                          zIndex: 1,
                        },
                      }}
                      InputLabelProps={{ shrink: true }}
                      value={scoreInput}
                      onChange={(e) => {
                        const sanitized = sanitizeScoreInput(e.target.value, 100);
                        setScoreInput(sanitized);
                        if (reviewFieldError?.fieldType === 'single_score' && String(sanitized || '').trim()) {
                          setReviewFieldError(null);
                        }
                      }}
                      inputRef={singleScoreInputRef}
                      inputProps={{ inputMode: 'decimal', autoComplete: 'off' }}
                      disabled={!canEditReviewFields}
                      fullWidth
                      error={reviewFieldError?.fieldType === 'single_score'}
                      helperText={reviewFieldError?.fieldType === 'single_score' ? reviewFieldError.message : ''}
                    />
                    )}
                  </Stack>
                </Box>

                <Box
                  sx={{
                    mt: 1,
                    pt: 1,
                    px: 0.2,
                    pb: 0.4,
                    bgcolor: 'rgba(255, 252, 246, 0.98)',
                    borderTop: '1px solid rgba(229, 214, 179, 0.9)',
                    boxShadow: '0 -10px 18px rgba(140, 91, 18, 0.08)',
                    flex: '0 0 auto',
                  }}
                >
                  <TextField
                    label="评语（可选）"
                    value={commentInput}
                    onChange={(e) => setCommentInput(e.target.value)}
                    disabled={!canEditReviewFields}
                    multiline
                    minRows={scoringMode === 'history_paper_quantitative' ? 4 : 6}
                    maxRows={scoringMode === 'history_paper_quantitative' ? 8 : 10}
                    fullWidth
                    helperText="最多 2000 字"
                    sx={{
                      mb: 1,
                      '& .MuiInputBase-inputMultiline': {
                        overflowY: 'auto !important',
                      },
                    }}
                  />

                  <Stack spacing={0.45}>
                    {scoringMode === 'history_paper_quantitative' ? (
                      <>
                        <Typography variant="body2">
                          当前总分：{quantitativeHasInput ? `${quantitativeDisplayTotalScore} / 100` : '未评分'}
                        </Typography>
                        <Typography variant="body2">原始等级：{quantitativeHasInput ? (quantitativeSnapshot.rawGrade || '-') : '-'}</Typography>
                        <Typography variant="body2">最终等级：{quantitativeHasInput ? (quantitativeSnapshot.finalGrade || '-') : '-'}</Typography>
                        <Typography variant="body2">
                          否决项：{quantitativeSnapshot.fatalTriggered ? `已触发（${quantitativeSnapshot.fatalHits.length} 项）` : '未触发'}
                        </Typography>
                        <Typography variant="body2">
                          上限项：{quantitativeSnapshot.capTriggered ? `已触发（${quantitativeSnapshot.capHits.length} 项）` : '未触发'}
                        </Typography>
                      </>
                    ) : (
                      <Typography variant="body2" color="text.secondary">当前模式为单分评分，直接填写分数后提交。</Typography>
                    )}
                  </Stack>

                  <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1.1 }}>
                    {selectedReviewed && !editingReviewed && (
                      <Button
                        variant="contained"
                        disabled={!selectedRow || saving || draftSaving || !reviewPermission.canScore || !reviewContextCanEdit}
                        onClick={() => setEditingReviewed(true)}
                        sx={{ minWidth: 132 }}
                      >
                        修改评分
                      </Button>
                    )}
                    {(!selectedReviewed || editingReviewed) && (
                      <>
                        <Button
                          variant="outlined"
                          disabled={!canEditReviewFields}
                          onClick={saveDraft}
                          sx={{ minWidth: 124 }}
                        >
                          {draftSaving ? '保存中...' : '保存草稿'}
                        </Button>
                        <Button
                          variant="contained"
                          startIcon={<SaveRoundedIcon />}
                          disabled={!canEditReviewFields}
                          onClick={saveReview}
                          sx={{ minWidth: 132 }}
                        >
                          {saving ? '提交中...' : '提交评分'}
                        </Button>
                      </>
                    )}
                  </Stack>
                </Box>

              </Stack>
            </Paper>
          </Box>
        </Box>
      </Paper>
    </Box>
  );
}
