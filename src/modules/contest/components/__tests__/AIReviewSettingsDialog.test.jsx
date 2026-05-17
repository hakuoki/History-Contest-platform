// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

import AIReviewSettingsDialog from '../AIReviewSettingsDialog.jsx';

function getSelectByInputLabel(labelText) {
  const inputLabel = screen.getByText(labelText, { selector: 'label' });
  const formControl = inputLabel?.closest('.MuiFormControl-root');
  if (!formControl) throw new Error(`未找到 ${labelText} 对应的表单容器`);
  return within(formControl).getByRole('combobox');
}

const createRequestIdMock = vi.fn(() => 'req_test');
const buildCompetition = (overrides = {}) => ({
  id: 7,
  name: '测试赛',
  submission_rule_mode: 'required_optional',
  required_formats: ['pdf', 'docx'],
  optional_formats: ['xlsx'],
  submission_end: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  review_start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  review_end: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  ...overrides,
});

const getCompetitionAIReviewSettingsMock = vi.fn(async () => ({
  data: {
    settings: {
      enabled: true,
      selected_model_keys: ['qwen35_plus', 'qwen35_flash'],
      runs_per_model_min: 3,
      runs_per_model_max: 5,
      rubric_key: 'history_paper_quantitative',
      status: 'published',
    },
    model_catalog: [
      { key: 'qwen35_plus', name: '通义千问 3.5 Plus', mandatory: true, enabled: true },
      { key: 'qwen35_flash', name: '通义千问 3.5 Flash', mandatory: false, enabled: true },
      { key: 'gemini3_flash_preview', name: 'Gemini 3 Flash Preview', mandatory: false, enabled: true },
    ],
    rubric_catalog: [
      { key: 'history_paper_quantitative', name: '历史论文量化评审', default: true, enabled: true },
      { key: 'history_paper_comparative', name: '历史论文对比评审', default: false, enabled: true },
    ],
    locked: false,
    can_edit: true,
  },
  requestId: 'req_test',
}));
const updateCompetitionAIReviewSettingsMock = vi.fn(async (_competitionId, payload) => ({
  data: {
    settings: {
      enabled: payload?.enabled === undefined ? true : Boolean(payload?.enabled),
      selected_model_keys: ['qwen35_plus', 'qwen35_flash'],
      runs_per_model_min: Number(payload?.runs_per_model_min || 0),
      runs_per_model_max: Number(payload?.runs_per_model_max || 0),
      rubric_key: String(payload?.rubric_key || 'history_paper_quantitative'),
      status: 'published',
    },
    model_catalog: [
      { key: 'qwen35_plus', name: '通义千问 3.5 Plus', mandatory: true, enabled: true },
      { key: 'qwen35_flash', name: '通义千问 3.5 Flash', mandatory: false, enabled: true },
      { key: 'gemini3_flash_preview', name: 'Gemini 3 Flash Preview', mandatory: false, enabled: true },
    ],
    rubric_catalog: [
      { key: 'history_paper_quantitative', name: '历史论文量化评审', default: true, enabled: true },
      { key: 'history_paper_comparative', name: '历史论文对比评审', default: false, enabled: true },
    ],
    locked: false,
    can_edit: true,
  },
  requestId: 'req_test',
}));
const listCompetitionSubmissionsPagedMock = vi.fn(async () => ({
  items: [
    { id: 101, status: 'submitted' },
    { id: 102, status: 'resubmitted' },
    { id: 103, status: 'draft' },
  ],
  total: 3,
  limit: 100,
  offset: 0,
  requestId: 'req_test',
}));
const createCompetitionAIReviewJobsMock = vi.fn(async () => ({
  data: {
    items: [
      { id: 201, submission_id: 101 },
      { id: 202, submission_id: 102 },
    ],
    pagination: { limit: 2, offset: 0, total: 2 },
  },
  requestId: 'req_test',
}));
const previewCompetitionAIReviewMock = vi.fn(async (_competitionId, payload) => ({
  data: {
    competition_id: 7,
    competition_name: '测试赛',
    rubric_key: String(payload?.rubric_key || 'history_paper_quantitative'),
    rubric_name: '历史论文量化评审',
    prompt_version: 'history_paper_ai_v1',
    rubric_version_key: 'history-paper-evaluation-4',
    rubric_hash: 'preview_hash',
    model_key: String(payload?.model_key || 'qwen35_plus'),
    model_name: '通义千问 3.5 Plus',
    settings_snapshot: {
      timeout_seconds: 180,
      retry_count: 2,
      temperature: 0.2,
      max_input_chars: 40000,
      max_output_tokens: 8000,
    },
    file_name: payload?.files?.[0]?.name || payload?.file?.name || 'preview.pdf',
    file_ext: 'pdf',
    file_size: 12,
    file_count: Array.isArray(payload?.files) ? payload.files.length : 1,
    total_file_size: 12,
    preview_files: [
      {
        file_name: payload?.files?.[0]?.name || payload?.file?.name || 'preview.pdf',
        file_ext: 'pdf',
        file_size: 12,
      },
    ],
    original_char_count: 12,
    truncated: false,
    source_summary: [
      {
        source_type: 'preview_file',
        attachment_name: payload?.files?.[0]?.name || payload?.file?.name || 'preview.pdf',
        attachment_ext: 'pdf',
        attachment_size: 12,
        extracted_chars: 12,
        truncated: false,
      },
    ],
    submission_text: '这是一个预览文件。',
    prompt_messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ],
    run: {
      model_key: String(payload?.model_key || 'qwen35_plus'),
      model_name: '通义千问 3.5 Plus',
      status: 'succeeded',
      score: 88,
      raw_total_score: 91,
      final_grade: 'A',
      fatal_flag: false,
      cap_flag: false,
      cap_grade: null,
      token_prompt: 100,
      token_completion: 80,
      token_total: 180,
      estimated_cost: 0.12,
      latency_ms: 456,
      comment: 'ok',
      parsed_json: { comment: 'ok' },
      raw_response_json: { choices: [] },
      raw_response_text: '{"comment":"ok"}',
    },
  },
  requestId: 'req_test',
}));

vi.mock('../../../../api', () => ({
  createRequestId: (...args) => createRequestIdMock(...args),
  createCompetitionAIReviewJobs: (...args) => createCompetitionAIReviewJobsMock(...args),
  getCompetitionAIReviewSettings: (...args) => getCompetitionAIReviewSettingsMock(...args),
  previewCompetitionAIReview: (...args) => previewCompetitionAIReviewMock(...args),
  listCompetitionSubmissionsPaged: (...args) => listCompetitionSubmissionsPagedMock(...args),
  updateCompetitionAIReviewSettings: (...args) => updateCompetitionAIReviewSettingsMock(...args),
}));

describe('AIReviewSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the simplified controls and saves without trigger_mode', async () => {
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    expect(await screen.findByText('AI评审配置（比赛：测试赛）')).toBeTruthy();
    expect(screen.getByText('AI 评审状态')).toBeTruthy();
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.queryByText('启用 AI 评审')).toBeNull();
    expect(screen.getByRole('spinbutton', { name: '同一个模型评审次数' })).toBeTruthy();
    expect(screen.getByText('通义千问 3.5 Plus')).toBeTruthy();
    expect(screen.getByText('通义千问 3.5 Flash')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始评审' })).toBeTruthy();
    expect(screen.queryByText('触发模式')).toBeNull();
    expect(screen.queryByText('采样温度')).toBeNull();
    expect(screen.getByRole('spinbutton', { name: '评审文本上限字符数' })).toBeTruthy();
    expect(getSelectByInputLabel('解析“必选格式”附件内容（可多选）')).toBeTruthy();
    expect(getSelectByInputLabel('解析“选交格式”附件内容（可多选）')).toBeTruthy();
    expect(getSelectByInputLabel('解析“选交格式”附件内容（可多选）').textContent).toContain('无');
    expect(screen.queryByText('提示词版本')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '修改配置' }));
    fireEvent.change(screen.getByLabelText('同一个模型评审次数'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(updateCompetitionAIReviewSettingsMock).toHaveBeenCalled();
    });

    const [competitionId, payload] = updateCompetitionAIReviewSettingsMock.mock.calls[0];
    expect(competitionId).toBe(7);
    expect(payload).toMatchObject({
      selected_model_keys: ['qwen35_plus', 'qwen35_flash'],
      runs_per_model_min: 4,
      runs_per_model_max: 4,
    });
    expect(payload.enabled).toBeUndefined();
    expect(payload.trigger_mode).toBeUndefined();
    expect(payload.timeout_seconds).toBe(180);
    expect(payload.retry_count).toBe(2);
    expect(payload.temperature).toBe(0.2);
    expect(payload.max_input_chars).toBe(40000);
    expect(payload.parse_required_formats).toBe(true);
    expect(payload.parse_optional_formats).toBe(false);
    expect(payload.required_parse_formats).toEqual(['pdf', 'docx']);
    expect(payload.optional_parse_formats).toEqual([]);
    expect(payload.fail_on_empty_text).toBe(true);
    expect(payload.max_output_tokens).toBe(8000);
    expect(payload.prompt_version).toBeUndefined();
    expect(payload.rubric_version_key).toBeUndefined();
  });

  it('keeps runs per model value from backend when it is lower than 5', async () => {
    getCompetitionAIReviewSettingsMock.mockResolvedValueOnce({
      data: {
        settings: {
          enabled: true,
          selected_model_keys: ['qwen35_plus'],
          runs_per_model_min: 1,
          runs_per_model_max: 1,
          rubric_key: 'history_paper_quantitative',
          status: 'published',
        },
        model_catalog: [
          { key: 'qwen35_plus', name: '通义千问 3.5 Plus', mandatory: true, enabled: true },
        ],
        rubric_catalog: [
          { key: 'history_paper_quantitative', name: '历史论文量化评审', default: true, enabled: true },
        ],
        locked: false,
        can_edit: true,
      },
      requestId: 'req_test',
    });

    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    expect(screen.getByRole('spinbutton', { name: '同一个模型评审次数' }).value).toBe('1');
  });

  it('submits customized text and parsing flags exactly as configured in UI', async () => {
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');

    fireEvent.click(screen.getByRole('button', { name: '修改配置' }));
    fireEvent.change(screen.getByLabelText('评审文本上限字符数'), { target: { value: '56000' } });
    fireEvent.mouseDown(getSelectByInputLabel('解析“选交格式”附件内容（可多选）'));
    fireEvent.click(await screen.findByRole('option', { name: 'XLSX' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('无可解析正文时终止评审（推荐）'));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(updateCompetitionAIReviewSettingsMock).toHaveBeenCalled();
    });

    const [, payload] = updateCompetitionAIReviewSettingsMock.mock.calls[0];
    expect(payload.max_input_chars).toBe(56000);
    expect(payload.parse_required_formats).toBe(true);
    expect(payload.parse_optional_formats).toBe(true);
    expect(payload.required_parse_formats).toEqual(['pdf', 'docx']);
    expect(payload.optional_parse_formats).toEqual(['xlsx']);
    expect(payload.fail_on_empty_text).toBe(false);
  });

  it('supports selecting none for optional parse formats', async () => {
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    fireEvent.click(screen.getByRole('button', { name: '修改配置' }));
    fireEvent.mouseDown(getSelectByInputLabel('解析“选交格式”附件内容（可多选）'));
    fireEvent.click(await screen.findByRole('option', { name: '无（不解析选交材料）' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(updateCompetitionAIReviewSettingsMock).toHaveBeenCalled();
    });

    const [, payload] = updateCompetitionAIReviewSettingsMock.mock.calls[0];
    expect(payload.parse_optional_formats).toBe(false);
    expect(payload.optional_parse_formats).toEqual([]);
  });

  it('starts manual review for all reviewable submissions', async () => {
    const setMessage = vi.fn();
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={setMessage}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    fireEvent.click(screen.getByRole('button', { name: '修改配置' }));
    fireEvent.change(screen.getByLabelText('同一个模型评审次数'), { target: { value: '4' } });
    fireEvent.mouseDown(screen.getByLabelText('AI评审规则'));
    fireEvent.click(await screen.findByRole('option', { name: '历史论文对比评审' }));
    fireEvent.click(screen.getByRole('button', { name: '开始评审' }));

    expect(updateCompetitionAIReviewSettingsMock).not.toHaveBeenCalled();
    expect(setMessage).toHaveBeenCalledWith({
      type: 'warning',
      text: '请先保存参数后再开始评审',
    });
    expect(createCompetitionAIReviewJobsMock).not.toHaveBeenCalled();
    expect(listCompetitionSubmissionsPagedMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => {
      expect(updateCompetitionAIReviewSettingsMock).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: '开始评审' }));
    await waitFor(() => {
      expect(updateCompetitionAIReviewSettingsMock).toHaveBeenCalledTimes(2);
    });

    const confirmDialog = await screen.findByRole('dialog', { name: '确认开始评审' });
    expect(within(confirmDialog).getByText('以下配置已保存到后端，请再次确认后开始评审。')).toBeTruthy();
    expect(within(confirmDialog).getByText('同一个模型评审次数：4')).toBeTruthy();
    expect(within(confirmDialog).getByText('评审规则：历史论文对比评审')).toBeTruthy();
    expect(within(confirmDialog).getByText('已选模型：2 个')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));

    await waitFor(() => {
      expect(listCompetitionSubmissionsPagedMock).toHaveBeenCalledTimes(1);
      expect(createCompetitionAIReviewJobsMock).toHaveBeenCalledTimes(1);
    });

    expect(listCompetitionSubmissionsPagedMock).toHaveBeenCalledWith(
      7,
      100,
      0,
      '',
      expect.objectContaining({ fields: 'summary' })
    );

    expect(createCompetitionAIReviewJobsMock).toHaveBeenCalledWith(
      7,
      {
        submission_ids: [101, 102],
        force: false,
        trigger_source: 'manual',
      },
      expect.objectContaining({ requestId: 'req_test' })
    );

    const [savedCompetitionId, savedPayload] = updateCompetitionAIReviewSettingsMock.mock.calls[0];
    expect(savedCompetitionId).toBe(7);
    expect(savedPayload).toMatchObject({
      selected_model_keys: ['qwen35_plus', 'qwen35_flash'],
      runs_per_model_min: 4,
      runs_per_model_max: 4,
      rubric_key: 'history_paper_comparative',
    });
    expect(savedPayload.enabled).toBeUndefined();

    expect(setMessage).toHaveBeenCalledWith({
      type: 'success',
      text: '已开始评审，已提交 2 个任务',
    });
  });

  it('shows only review-window warning when outside review phase', async () => {
    const setMessage = vi.fn();
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition({
          submission_end: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          review_start: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          review_end: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        })}
        onClose={vi.fn()}
        setMessage={setMessage}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    expect(screen.getByText('仅在评审期内可以开始评审。')).toBeTruthy();
    expect(screen.queryByText('服务暂时不可用，请稍后重试')).toBeNull();

    const startButton = screen.getByRole('button', { name: '开始评审' });
    expect(startButton.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(startButton);

    expect(createCompetitionAIReviewJobsMock).not.toHaveBeenCalled();
    expect(listCompetitionSubmissionsPagedMock).not.toHaveBeenCalled();
    expect(setMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: '服务暂时不可用，请稍后重试' })
    );
  });

  it('opens preview dialog and runs a file preview with the current rule and model', async () => {
    const setMessage = vi.fn();
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={setMessage}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    fireEvent.click(screen.getByRole('button', { name: '预览评审' }));

    const previewDialog = await screen.findByRole('dialog', { name: 'AI 评审预览（比赛：测试赛）' });
    expect(within(previewDialog).getByRole('button', { name: '选择PDF附件' })).toBeTruthy();
    const fileInput = within(previewDialog).getByLabelText('预览文件_PDF');
    const file = new File(['%PDF-1.7'], 'preview.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(within(previewDialog).getByText('preview.pdf')).toBeTruthy();
    fireEvent.click(within(previewDialog).getByRole('button', { name: '运行预览' }));

    await waitFor(() => {
      expect(previewCompetitionAIReviewMock).toHaveBeenCalledTimes(1);
    });

    expect(previewCompetitionAIReviewMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        rubric_key: 'history_paper_quantitative',
        model_key: 'qwen35_plus',
        files: [file],
      }),
      expect.objectContaining({ requestId: 'req_test' })
    );

    expect(await within(previewDialog).findByText('预览完成，等级 A，得分 88。')).toBeTruthy();
    expect(within(previewDialog).getByLabelText('模型原始输出')).toBeTruthy();
    expect(setMessage).toHaveBeenCalledWith({
      type: 'success',
      text: 'AI 评审预览已完成',
    });
  });

  it('shows hit items in Chinese labels in final summary', async () => {
    previewCompetitionAIReviewMock.mockResolvedValueOnce({
      data: {
        competition_id: 7,
        competition_name: '测试赛',
        rubric_key: 'history_paper_quantitative',
        rubric_name: '历史论文量化评审',
        prompt_version: 'history_paper_ai_v1',
        rubric_version_key: 'history-paper-evaluation-4',
        rubric_hash: 'preview_hash',
        model_key: 'qwen35_plus',
        model_name: '通义千问 3.5 Plus',
        settings_snapshot: {
          timeout_seconds: 180,
          retry_count: 2,
          temperature: 0.2,
          max_input_chars: 40000,
          max_output_tokens: 8000,
        },
        file_name: 'preview.pdf',
        file_ext: 'pdf',
        file_size: 12,
        file_count: 1,
        total_file_size: 12,
        preview_files: [
          { file_name: 'preview.pdf', file_ext: 'pdf', file_size: 12 },
        ],
        original_char_count: 12,
        truncated: false,
        source_summary: [],
        submission_text: '这是一个预览文件。',
        prompt_messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'user prompt' },
        ],
        run: {
          model_key: 'qwen35_plus',
          model_name: '通义千问 3.5 Plus',
          status: 'succeeded',
          score: 48.5,
          raw_total_score: 62,
          final_grade: 'D',
          fatal_flag: true,
          cap_flag: true,
          cap_grade: 'C',
          token_prompt: 100,
          token_completion: 80,
          token_total: 180,
          estimated_cost: 0.12,
          latency_ms: 456,
          comment: 'ok',
          parsed_json: {
            fatal_hits: [{ code: 'fatal_plagiarism' }],
            cap_hits: [
              { code: 'cap_no_evidence_support' },
              { code: 'cap_key_fact_error' },
            ],
          },
          raw_response_json: { choices: [] },
          raw_response_text: '{"comment":"ok"}',
        },
      },
      requestId: 'req_test',
    });

    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    fireEvent.click(screen.getByRole('button', { name: '预览评审' }));

    const previewDialog = await screen.findByRole('dialog', { name: 'AI 评审预览（比赛：测试赛）' });
    const fileInput = within(previewDialog).getByLabelText('预览文件_PDF');
    const file = new File(['%PDF-1.7'], 'preview.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(within(previewDialog).getByRole('button', { name: '运行预览' }));

    await waitFor(() => {
      expect(previewCompetitionAIReviewMock).toHaveBeenCalledTimes(1);
    });

    const summary = within(previewDialog).getByLabelText('最终结论摘要').value;
    expect(summary).toContain('致命命中项目：抄袭');
    expect(summary).toContain('上限命中项目：核心论断无证据支撑；关键史料或关键事实严重失实');
    expect(summary).not.toContain('fatal_plagiarism');
    expect(summary).not.toContain('cap_no_evidence_support');
  });

  it('submits multiple selected preview files in one run', async () => {
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    fireEvent.click(screen.getByRole('button', { name: '预览评审' }));

    const previewDialog = await screen.findByRole('dialog', { name: 'AI 评审预览（比赛：测试赛）' });
    const pdfFile = new File(['%PDF-1.7'], 'preview.pdf', { type: 'application/pdf' });
    const docxFile = new File(['docx'], 'preview.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    fireEvent.change(within(previewDialog).getByLabelText('预览文件_PDF'), { target: { files: [pdfFile] } });
    fireEvent.change(within(previewDialog).getByLabelText('预览文件_DOCX'), { target: { files: [docxFile] } });
    fireEvent.click(within(previewDialog).getByRole('button', { name: '运行预览' }));

    await waitFor(() => {
      expect(previewCompetitionAIReviewMock).toHaveBeenCalled();
    });

    const [, payload] = previewCompetitionAIReviewMock.mock.calls.at(-1);
    expect(Array.isArray(payload.files)).toBe(true);
    expect(payload.files).toHaveLength(2);
    expect(payload.files[0].name).toBe('preview.pdf');
    expect(payload.files[1].name).toBe('preview.docx');
  });

  it('blocks preview upload when file format is not in selected parse formats', async () => {
    render(
      <AIReviewSettingsDialog
        open
        competition={buildCompetition()}
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    await screen.findByText('AI评审配置（比赛：测试赛）');
    fireEvent.click(screen.getByRole('button', { name: '预览评审' }));

    const previewDialog = await screen.findByRole('dialog', { name: 'AI 评审预览（比赛：测试赛）' });
    const fileInput = within(previewDialog).getByLabelText('预览文件_PDF');
    const file = new File(['plain text'], 'preview.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await within(previewDialog).findByText('当前槽位为 PDF，请上传对应文件')).toBeTruthy();
    expect(previewCompetitionAIReviewMock).not.toHaveBeenCalled();
  });
});
