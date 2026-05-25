// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import AIReviewProgressDialog from '../AIReviewProgressDialog.jsx';

const createRequestIdMock = vi.fn(() => 'req_progress_test');
const createCompetitionAIReviewJobsMock = vi.fn(async () => ({
  data: {
    items: [{ id: 1, submission_id: 921 }],
    pagination: { limit: 1, offset: 0, total: 1 },
  },
  requestId: 'req_progress_test',
}));
const recoverCompetitionAIReviewStuckTargetsMock = vi.fn(async () => ({
  data: {
    items: [],
    pagination: { limit: 0, offset: 0, total: 0 },
  },
  requestId: 'req_progress_test',
}));
const getCompetitionAIReviewSettingsMock = vi.fn(async () => ({
  data: {
    settings: {
      review_run_state: 'running',
    },
  },
  requestId: 'req_progress_test',
}));
const getCompetitionAIReviewProgressMock = vi.fn(async () => ({
  data: {
    competition_id: 24,
    submitted_total: 1,
    completed_total: 0,
    running_total: 0,
    pending_total: 0,
    failed_total: 1,
    status: 'running',
    review_started: true,
    updated_at: null,
    models: [
      {
        model_key: 'm_fail',
        model_name: '失败模型',
        success_target_per_submission: 5,
        target_submission_total: 1,
        started_submission_total: 1,
        pending_submission_total: 0,
        running_submission_total: 0,
        completed_submission_total: 0,
        failed_submission_total: 1,
        run_count_total: 4,
        success_count_total: 2,
        failure_count_total: 2,
        latency_ms_total: 1000,
        targets: [
          {
            submission_id: 921,
            submission_submit_version: 1,
            model_key: 'm_fail',
            title: '作品A',
            job_id: 101,
            job_status: 'failed',
            model_status: 'failed',
            target_success_count: 5,
            run_count: 4,
            success_count: 2,
            failure_count: 2,
            latency_ms: 1000,
            updated_at: null,
          },
        ],
      },
      {
        model_key: 'm_done',
        model_name: '完成模型',
        success_target_per_submission: 5,
        target_submission_total: 1,
        started_submission_total: 1,
        pending_submission_total: 0,
        running_submission_total: 0,
        completed_submission_total: 1,
        failed_submission_total: 0,
        run_count_total: 5,
        success_count_total: 5,
        failure_count_total: 0,
        latency_ms_total: 1200,
        targets: [
          {
            submission_id: 921,
            submission_submit_version: 1,
            model_key: 'm_done',
            title: '作品A',
            job_id: 101,
            job_status: 'failed',
            model_status: 'completed',
            target_success_count: 5,
            run_count: 5,
            success_count: 5,
            failure_count: 0,
            model_score: 88.8,
            latency_ms: 1200,
            updated_at: null,
          },
        ],
      },
    ],
  },
  requestId: 'req_progress_test',
}));
const getCompetitionAIReviewSubmissionDisplayMock = vi.fn(async () => ({ data: null, requestId: 'req_progress_test' }));

vi.mock('../../../../api', () => ({
  createRequestId: (...args) => createRequestIdMock(...args),
  createCompetitionAIReviewJobs: (...args) => createCompetitionAIReviewJobsMock(...args),
  recoverCompetitionAIReviewStuckTargets: (...args) => recoverCompetitionAIReviewStuckTargetsMock(...args),
  getCompetitionAIReviewSettings: (...args) => getCompetitionAIReviewSettingsMock(...args),
  getCompetitionAIReviewProgress: (...args) => getCompetitionAIReviewProgressMock(...args),
  getCompetitionAIReviewSubmissionDisplay: (...args) => getCompetitionAIReviewSubmissionDisplayMock(...args),
}));

describe('AIReviewProgressDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('retries only selected failed model-target and does not include completed model target', async () => {
    const setMessage = vi.fn();

    render(
      <AIReviewProgressDialog
        open
        competition={{ id: 24, name: '历史学比赛' }}
        currentUserEmail="owner@example.com"
        onClose={vi.fn()}
        setMessage={setMessage}
      />
    );

    expect(await screen.findByText('AI评审进度（比赛：历史学比赛）')).toBeTruthy();

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /选择作品921/ });
    const enabledRowCheckbox = rowCheckboxes.find((item) => !item.hasAttribute('disabled'));
    expect(enabledRowCheckbox).toBeTruthy();
    fireEvent.click(enabledRowCheckbox);

    const headerCheckboxes = screen.getAllByRole('checkbox', { name: '全选作品' });
    expect(headerCheckboxes.length).toBeGreaterThanOrEqual(2);
    expect(headerCheckboxes[0].checked).toBe(true);
    expect(headerCheckboxes[1].checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '恢复失败作品' }));

    await waitFor(() => {
      expect(createCompetitionAIReviewJobsMock).toHaveBeenCalledTimes(1);
    });

    const [, payload] = createCompetitionAIReviewJobsMock.mock.calls[0];
    expect(payload).toMatchObject({
      trigger_source: 'retry',
      submission_ids: [921],
      retry_targets: [{ submission_id: 921, model_key: 'm_fail' }],
    });
    expect(payload.retry_targets).toHaveLength(1);
  });

  it('recovers only selected stuck model-target without requiring reauth', async () => {
    getCompetitionAIReviewProgressMock.mockImplementation(async () => ({
      data: {
        competition_id: 24,
        submitted_total: 1,
        completed_total: 0,
        running_total: 1,
        pending_total: 0,
        failed_total: 0,
        status: 'running',
        review_started: true,
        updated_at: null,
        models: [
          {
            model_key: 'm_stuck',
            model_name: '卡住模型',
            success_target_per_submission: 5,
            target_submission_total: 1,
            started_submission_total: 1,
            pending_submission_total: 0,
            running_submission_total: 1,
            completed_submission_total: 0,
            failed_submission_total: 0,
            run_count_total: 2,
            success_count_total: 1,
            failure_count_total: 1,
            latency_ms_total: 2000,
            targets: [
              {
                submission_id: 931,
                submission_submit_version: 1,
                model_key: 'm_stuck',
                title: '卡住作品',
                job_id: 201,
                job_status: 'running',
                model_status: 'running',
                target_success_count: 5,
                run_count: 2,
                success_count: 1,
                failure_count: 1,
                is_running: true,
                is_stuck: true,
                stuck_seconds: 360,
                stuck_reason: 'no_progress',
                latency_ms: 2000,
                updated_at: null,
              },
            ],
          },
        ],
      },
      requestId: 'req_progress_test',
    }));

    render(
      <AIReviewProgressDialog
        open
        competition={{ id: 24, name: '历史学比赛' }}
        currentUserEmail="owner@example.com"
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    expect(await screen.findByText('AI评审进度（比赛：历史学比赛）')).toBeTruthy();
    const selectableBoxes = screen.getAllByRole('checkbox', { name: /选择作品/ }).filter((item) => !item.hasAttribute('disabled'));
    expect(selectableBoxes.length).toBeGreaterThan(0);
    fireEvent.click(selectableBoxes[0]);

    const unlockBtn = screen.getByRole('button', { name: '解锁选中卡住项' });
    expect(unlockBtn).toBeTruthy();
    fireEvent.click(unlockBtn);

    await waitFor(() => {
      expect(recoverCompetitionAIReviewStuckTargetsMock).toHaveBeenCalledTimes(1);
    });
    const [, payload] = recoverCompetitionAIReviewStuckTargetsMock.mock.calls[0];
    expect(payload).toMatchObject({
      targets: [{ submission_id: 931, model_key: 'm_stuck' }],
    });
    expect(createCompetitionAIReviewJobsMock).not.toHaveBeenCalled();
  });

  it('shows non-conflicting status labels when paused but progress is unfinished', async () => {
    getCompetitionAIReviewSettingsMock.mockImplementation(async () => ({
      data: {
        settings: {
          review_run_state: 'paused',
        },
      },
      requestId: 'req_progress_test',
    }));

    getCompetitionAIReviewProgressMock.mockImplementation(async () => ({
      data: {
        competition_id: 24,
        submitted_total: 2,
        completed_total: 0,
        running_total: 1,
        pending_total: 1,
        failed_total: 0,
        status: 'running',
        review_started: true,
        updated_at: null,
        models: [],
      },
      requestId: 'req_progress_test',
    }));

    render(
      <AIReviewProgressDialog
        open
        competition={{ id: 24, name: '历史学比赛' }}
        currentUserEmail="owner@example.com"
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    expect(await screen.findByText('AI评审进度（比赛：历史学比赛）')).toBeTruthy();
    expect(await screen.findByText('已暂停')).toBeTruthy();
  });

  it('shows pending overall status when no running job is active', async () => {
    getCompetitionAIReviewSettingsMock.mockImplementation(async () => ({
      data: {
        settings: {
          review_run_state: 'running',
        },
        running_job_count: 0,
        pending_job_count: 1,
      },
      requestId: 'req_progress_test',
    }));

    getCompetitionAIReviewProgressMock.mockImplementation(async () => ({
      data: {
        competition_id: 24,
        submitted_total: 1,
        completed_total: 0,
        running_total: 0,
        pending_total: 1,
        failed_total: 0,
        status: 'running',
        review_started: true,
        updated_at: null,
        models: [],
      },
      requestId: 'req_progress_test',
    }));

    render(
      <AIReviewProgressDialog
        open
        competition={{ id: 24, name: '历史学比赛' }}
        currentUserEmail="owner@example.com"
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    expect(await screen.findByText('AI评审进度（比赛：历史学比赛）')).toBeTruthy();
    expect(await screen.findByText('待评审')).toBeTruthy();
  });

  it('orders targets by status for clearer progress display', async () => {
    getCompetitionAIReviewSettingsMock.mockImplementation(async () => ({
      data: {
        settings: {
          review_run_state: 'running',
        },
      },
      requestId: 'req_progress_test',
    }));

    getCompetitionAIReviewProgressMock.mockImplementation(async () => ({
      data: {
        competition_id: 24,
        submitted_total: 3,
        completed_total: 1,
        running_total: 1,
        pending_total: 1,
        failed_total: 0,
        status: 'running',
        review_started: true,
        updated_at: null,
        models: [
          {
            model_key: 'm_sort',
            model_name: '排序模型',
            success_target_per_submission: 5,
            target_submission_total: 3,
            started_submission_total: 2,
            pending_submission_total: 1,
            running_submission_total: 1,
            completed_submission_total: 1,
            failed_submission_total: 0,
            run_count_total: 7,
            success_count_total: 6,
            failure_count_total: 1,
            latency_ms_total: 1500,
            targets: [
              {
                submission_id: 1003,
                submission_submit_version: 1,
                model_key: 'm_sort',
                title: '待评作品',
                job_id: 501,
                job_status: 'pending',
                model_status: 'pending',
                target_success_count: 5,
                run_count: 0,
                success_count: 0,
                failure_count: 0,
                latency_ms: 0,
                updated_at: null,
              },
              {
                submission_id: 1001,
                submission_submit_version: 1,
                model_key: 'm_sort',
                title: '成功作品',
                job_id: 502,
                job_status: 'completed',
                model_status: 'completed',
                target_success_count: 5,
                run_count: 5,
                success_count: 5,
                failure_count: 0,
                model_score: 90,
                latency_ms: 900,
                updated_at: null,
              },
              {
                submission_id: 1002,
                submission_submit_version: 1,
                model_key: 'm_sort',
                title: '运行作品',
                job_id: 503,
                job_status: 'running',
                model_status: 'running',
                target_success_count: 5,
                run_count: 2,
                success_count: 1,
                failure_count: 1,
                latency_ms: 600,
                updated_at: null,
              },
            ],
          },
        ],
      },
      requestId: 'req_progress_test',
    }));

    render(
      <AIReviewProgressDialog
        open
        competition={{ id: 24, name: '历史学比赛' }}
        currentUserEmail="owner@example.com"
        onClose={vi.fn()}
        setMessage={vi.fn()}
      />
    );

    expect(await screen.findByText('AI评审进度（比赛：历史学比赛）')).toBeTruthy();
    const successCell = await screen.findByText('成功作品');
    const runningCell = await screen.findByText('运行作品');
    const pendingCell = await screen.findByText('待评作品');
    expect(successCell.compareDocumentPosition(runningCell) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(runningCell.compareDocumentPosition(pendingCell) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

});
