import { describe, expect, it } from 'vitest';

import {
  buildEmptyQuantitativeItemScoreMap,
  buildQuantitativeSnapshot,
  buildXlsxPreviewSrcDoc,
  canPreviewAsText,
  decodeAttachmentBlobText,
  extractCharsetFromContentType,
  extractXmlDeclaredEncoding,
  findFirstMissingReviewField,
  isPdfContent,
  resolveAttachmentPreviewExt,
} from '../JudgeReviewPage.jsx';

const rubricDimensions = [
  {
    code: 'A',
    name: '问题意识',
    weight: 20,
    items: [
      {
        code: 'A1',
        name: '问题明确性',
        max_score: 7,
      },
      {
        code: 'A2',
        name: '问题可回答性',
        max_score: 7,
      },
    ],
  },
];

const rubricConfig = {
  grade_thresholds: [
    { grade: 'A', min_score: 90, max_score: 100 },
    { grade: 'B', min_score: 75, max_score: 89 },
    { grade: 'C', min_score: 60, max_score: 74 },
    { grade: 'D', min_score: 45, max_score: 59 },
    { grade: 'E', min_score: 0, max_score: 44 },
  ],
};

describe('buildQuantitativeSnapshot', () => {
  it('keeps cap hits empty before any quantitative score is entered', () => {
    const snapshot = buildQuantitativeSnapshot(
      rubricDimensions,
      rubricConfig,
      { A1: '' },
      [],
    );

    expect(snapshot.hasAnyInput).toBe(false);
    expect(snapshot.capHits).toEqual([]);
    expect(snapshot.capTriggered).toBe(false);
  });

  it('marks cap hits only after the relevant score is filled', () => {
    const snapshot = buildQuantitativeSnapshot(
      rubricDimensions,
      rubricConfig,
      { A1: '1' },
      [],
    );

    expect(snapshot.hasAnyInput).toBe(true);
    expect(snapshot.capHits).toEqual(['cap_no_question']);
    expect(snapshot.capTriggered).toBe(true);
  });
});

describe('findFirstMissingReviewField', () => {
  it('points to the first missing quantitative field in rubric order', () => {
    const validation = findFirstMissingReviewField({
      scoringMode: 'history_paper_quantitative',
      rubricDimensions,
      quantitativeItemScores: { A1: '1', A2: '' },
    });

    expect(validation.ok).toBe(false);
    expect(validation.fieldType).toBe('quantitative');
    expect(validation.code).toBe('A2');
    expect(validation.message).toContain('A2');
  });

  it('rejects an empty single score before submit', () => {
    const validation = findFirstMissingReviewField({
      scoringMode: 'single_score',
      scoreInput: '',
    });

    expect(validation.ok).toBe(false);
    expect(validation.fieldType).toBe('single_score');
    expect(validation.code).toBe('single_score');
    expect(validation.message).toContain('请先填写评分');
  });

  it('allows missing quantitative fields when a fatal hit is selected', () => {
    const validation = findFirstMissingReviewField({
      scoringMode: 'history_paper_quantitative',
      rubricDimensions,
      quantitativeItemScores: { A1: '', A2: '' },
      fatalHits: ['fatal_plagiarism'],
    });

    expect(validation.ok).toBe(true);
  });
});

describe('buildEmptyQuantitativeItemScoreMap', () => {
  it('resets every quantitative item score to empty string', () => {
    expect(buildEmptyQuantitativeItemScoreMap(rubricDimensions)).toEqual({
      A1: '',
      A2: '',
    });
  });
});

describe('xml text preview encoding', () => {
  it('does not treat xlsx as plain text', () => {
    expect(canPreviewAsText('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false);
    expect(canPreviewAsText('xml', 'application/xml')).toBe(true);
  });

  it('normalizes charset hints from headers and xml declarations', () => {
    expect(extractCharsetFromContentType('application/xml; charset=gbk')).toBe('gb18030');
    expect(extractXmlDeclaredEncoding('<?xml version="1.0" encoding="GB18030"?><root />')).toBe('gb18030');
  });

  it('decodes gb18030 xml text for preview', async () => {
    const bytes = new Uint8Array([
      0x3c, 0x72, 0x6f, 0x6f, 0x74, 0x3e,
      0xd6, 0xd0, 0xce, 0xc4,
      0x3c, 0x2f, 0x72, 0x6f, 0x6f, 0x74, 0x3e,
    ]);
    const blob = {
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder('utf-8').decode(bytes),
    };

    const text = await decodeAttachmentBlobText(blob, {
      contentType: 'application/xml; charset=gb18030',
      fileName: 'sample.xml',
    });

    expect(text).toContain('中文');
  });
});

describe('pdf preview detection', () => {
  it('treats backend converted docx blobs as pdf when content-type is pdf', () => {
    expect(isPdfContent('application/pdf', 'paper.docx')).toBe(true);
    expect(isPdfContent('application/pdf', 'paper.pdf')).toBe(true);
  });

  it('prefers backend preview format and falls back docx to pdf', () => {
    expect(resolveAttachmentPreviewExt({ activeExt: 'docx' })).toBe('pdf');
    expect(resolveAttachmentPreviewExt({ activeExt: 'docx', previewFormat: 'pdf' })).toBe('pdf');
    expect(resolveAttachmentPreviewExt({ activeExt: 'xlsx' })).toBe('xlsx');
  });
});

describe('xlsx preview shell', () => {
  it('renders workbook sheet tabs', () => {
    const html = buildXlsxPreviewSrcDoc('sample.xlsx', [
      { name: 'Sheet1', html: '<table><tr><td>A</td></tr></table>' },
      { name: 'Sheet2', html: '<table><tr><td>B</td></tr></table>' },
    ]);

    expect(html).toContain('当前为 Excel 在线预览');
    expect(html).toContain('Sheet2');
    expect(html).toContain('sheet-tab');
  });
});
