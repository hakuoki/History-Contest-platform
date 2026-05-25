import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  default as JudgeReviewPage,
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
  resolveJudgeReviewAttachmentRequestPlan,
} from '../JudgeReviewPage.jsx';

const createRequestIdMock = vi.fn(() => 'req_test');
const getAssignedSubmissionAttachmentBlobMock = vi.fn(async () => null);
const getAssignedSubmissionReviewContextMock = vi.fn(async () => ({ data: null, requestId: 'req_test' }));
const getCompetitionByIdMock = vi.fn(async () => ({
  data: {
    id: 1,
    name: '第4届历史论文评审赛',
    review_start: '2026-05-11T00:00:00',
    review_end: '2026-05-12T00:00:00',
    submission_end: '2026-05-10T00:00:00',
  },
  requestId: 'req_test',
}));
const listMyAssignedSubmissionsPagedMock = vi.fn(async () => ({
  items: [],
  total: 0,
  offset: 0,
  requestId: 'req_test',
}));
const submitAssignedSubmissionReviewMock = vi.fn(async () => ({ data: null, requestId: 'req_test' }));

vi.mock('../../../../api', () => ({
  createRequestId: (...args) => createRequestIdMock(...args),
  getAssignedSubmissionAttachmentBlob: (...args) => getAssignedSubmissionAttachmentBlobMock(...args),
  getAssignedSubmissionReviewContext: (...args) => getAssignedSubmissionReviewContextMock(...args),
  getCompetitionById: (...args) => getCompetitionByIdMock(...args),
  listMyAssignedSubmissionsPaged: (...args) => listMyAssignedSubmissionsPagedMock(...args),
  submitAssignedSubmissionReview: (...args) => submitAssignedSubmissionReviewMock(...args),
}));

const rubricDimensions = [
  {
    code: 'A',
    name: '问题意识',
    weight: 20,
  },
  {
    code: 'B',
    name: '文献对话',
    weight: 15,
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
      { A: '', B: '' },
      [],
    );

    expect(snapshot.hasAnyInput).toBe(false);
    expect(snapshot.capHits).toEqual([]);
    expect(snapshot.capTriggered).toBe(false);
  });

  it('sums dimension scores directly without cap hits', () => {
    const snapshot = buildQuantitativeSnapshot(
      rubricDimensions,
      rubricConfig,
      { A: '18', B: '12' },
      [],
    );

    expect(snapshot.hasAnyInput).toBe(true);
    expect(snapshot.rawTotalScore).toBe(30);
    expect(snapshot.finalScore).toBe(30);
    expect(snapshot.capHits).toEqual([]);
    expect(snapshot.capTriggered).toBe(false);
  });
});

describe('judge review header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the competition name above the review workspace', async () => {
    render(<JudgeReviewPage competitionId={1} setMessage={vi.fn()} />);

    expect(await screen.findByText('比赛：第4届历史论文评审赛')).toBeTruthy();
  });

  it('shows a submitted work description in the review workspace', async () => {
    listMyAssignedSubmissionsPagedMock.mockResolvedValueOnce({
      items: [
        {
          assignment_id: 12,
          submission_id: 101,
          review_code: 'R-101',
          title: '城墙记忆与地方社会',
          work_description: '本作品聚焦城墙空间如何改变地方社会记忆，并说明材料来源与研究路径。',
          attachment_name: 'paper.pdf',
          attachment_ext: 'pdf',
          submit_version: 1,
          last_submitted_at: '2026-05-10T08:30:00',
          reviewed: false,
          my_score: null,
        },
      ],
      total: 1,
      offset: 0,
      requestId: 'req_test',
    });
    getAssignedSubmissionReviewContextMock.mockResolvedValueOnce({
      data: {
        competition_id: 1,
        competition_name: '第4届历史论文评审赛',
        submission_id: 101,
        submission_title: '城墙记忆与地方社会',
        submission_work_description: '本作品聚焦城墙空间如何改变地方社会记忆，并说明材料来源与研究路径。',
        review_code: 'R-101',
        judge_user_id: 1,
        judge_status: 'active',
        assignment_id: 12,
        competition_scoring_settings: {
          settings: { mode_key: 'single_score' },
          rubric_version: null,
          rubric_config: null,
          locked: false,
          can_edit: true,
        },
        review: null,
        attachments: [
          {
            attachment_key: 'main-pdf',
            attachment_name: 'paper.pdf',
            attachment_ext: 'pdf',
            is_primary: true,
          },
        ],
        can_edit: true,
        review_window: { can_score: true, message: '' },
      },
      requestId: 'req_test',
    });

    render(<JudgeReviewPage competitionId={1} setMessage={vi.fn()} />);

    fireEvent.click(await screen.findByText('作品简介'));

    expect(await screen.findByText('当前内容：作品简介')).toBeTruthy();
    expect(await screen.findByText(/本作品聚焦城墙空间如何改变地方社会记忆/)).toBeTruthy();
  });
});

describe('findFirstMissingReviewField', () => {
  it('points to the first missing quantitative field in rubric order', () => {
    const validation = findFirstMissingReviewField({
      scoringMode: 'history_paper_quantitative',
      rubricDimensions,
      quantitativeItemScores: { A: '1', B: '' },
    });

    expect(validation.ok).toBe(false);
    expect(validation.fieldType).toBe('quantitative');
    expect(validation.code).toBe('B');
    expect(validation.message).toContain('B');
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
      quantitativeItemScores: { A: '', B: '' },
      fatalHits: ['fatal_plagiarism'],
    });

    expect(validation.ok).toBe(true);
  });
});

describe('buildEmptyQuantitativeItemScoreMap', () => {
  it('resets every quantitative item score to empty string', () => {
    expect(buildEmptyQuantitativeItemScoreMap(rubricDimensions)).toEqual({
      A: '',
      B: '',
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
    expect(resolveAttachmentPreviewExt({ activeExt: 'word' })).toBe('pdf');
    expect(resolveAttachmentPreviewExt({ activeExt: 'xlsx' })).toBe('xlsx');
  });
});

describe('judge review attachment fetch plan', () => {
  it('downloads the original docx while previewing the converted pdf', () => {
    expect(resolveJudgeReviewAttachmentRequestPlan('word')).toEqual({
      activeExt: 'docx',
      previewAttachmentExt: 'pdf',
      downloadAttachmentExt: 'docx',
      previewDisposition: 'inline',
      downloadDisposition: 'attachment',
      needsSeparatePreviewRequest: true,
    });
  });

  it('downloads the original xlsx and previews the workbook directly', () => {
    expect(resolveJudgeReviewAttachmentRequestPlan('xlsx')).toEqual({
      activeExt: 'xlsx',
      previewAttachmentExt: 'xlsx',
      downloadAttachmentExt: 'xlsx',
      previewDisposition: 'attachment',
      downloadDisposition: 'attachment',
      needsSeparatePreviewRequest: false,
    });
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
