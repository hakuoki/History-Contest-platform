import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import {
  createRequestId,
  createCompetitionAIReviewJobs,
  controlCompetitionAIReviewRunState,
  getCompetitionAIReviewSettings,
  getCompetitionAIReviewProgress,
  getCompetitionAIReviewSubmissionDisplay,
  recoverCompetitionAIReviewStuckTargets,
} from '../../../api';
import { getUserFriendlyErrorText } from '../../../utils/errorText';

const PROGRESS_STATUS_LABEL_MAP = {
  not_started: '未开始',
  running: '进行中',
  completed: '已完成',
  partial_failed: '部分失败',
};

const PROGRESS_STATUS_COLOR_MAP = {
  not_started: 'default',
  running: 'warning',
  completed: 'success',
  partial_failed: 'error',
};

const TARGET_STATUS_LABEL_MAP = {
  not_started: '未开始',
  pending: '待评审',
  running: '评审中',
  completed: '已完成',
  failed: '失败',
};

const TARGET_STATUS_COLOR_MAP = {
  not_started: 'default',
  pending: 'default',
  running: 'warning',
  completed: 'success',
  failed: 'error',
};
const TARGET_DISPLAY_PRIORITY_MAP = {
  completed: 0,
  running: 1,
  failed: 2,
  pending: 3,
  not_started: 3,
};
const STUCK_IDLE_THRESHOLD_SECONDS = 180;
const TARGET_RENDER_LIMIT_PER_MODEL = 120;
const ACTIVE_POLL_MS_SMALL = 4000;
const ACTIVE_POLL_MS_MEDIUM = 8000;
const ACTIVE_POLL_MS_LARGE = 12000;
const ACTIVE_POLL_MEDIUM_TARGETS = 1200;
const ACTIVE_POLL_LARGE_TARGETS = 3000;

function normalizeReviewRunState(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'running' || token === 'paused' || token === 'not_started') return token;
  if (token === 'start' || token === 'resume') return 'running';
  if (token === 'pause') return 'paused';
  return 'not_started';
}

function formatDateTimeText(value) {
  if (!value) return '-';
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return '-';
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function progressStatusLabel(status) {
  const key = String(status || '').trim().toLowerCase();
  return PROGRESS_STATUS_LABEL_MAP[key] || '未开始';
}

function targetStatusLabel(status) {
  const key = String(status || '').trim().toLowerCase();
  return TARGET_STATUS_LABEL_MAP[key] || '待评审';
}

function targetStatusColor(status) {
  const key = String(status || '').trim().toLowerCase();
  return TARGET_STATUS_COLOR_MAP[key] || 'default';
}

function sortTargetsByDisplayPriority(targets) {
  if (!Array.isArray(targets) || targets.length <= 1) return Array.isArray(targets) ? targets : [];
  return targets
    .map((target, index) => {
      const statusKey = String(target?.model_status || '').trim().toLowerCase();
      const priority = Number.isFinite(TARGET_DISPLAY_PRIORITY_MAP[statusKey])
        ? TARGET_DISPLAY_PRIORITY_MAP[statusKey]
        : 4;
      return { target, index, priority };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.index - right.index;
    })
    .map((item) => item.target);
}

function formatScoreText(value) {
  if (value === null || value === undefined || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toFixed(1);
}

function resolveRunComment(run) {
  const parsedComment = String(run?.parsed_json?.comment || '').trim();
  if (parsedComment) return parsedComment;
  const errorMessage = String(run?.error_message || '').trim();
  if (errorMessage) return errorMessage;
  return '-';
}

function _safePrettyJson(value) {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function resolveRunStructuredOutput(run) {
  const parsedPayload = run?.parsed_json;
  if (parsedPayload && typeof parsedPayload === 'object') {
    const text = _safePrettyJson(parsedPayload);
    if (text) return text;
  }
  const rawOutput = String(run?.raw_response_text || '').trim();
  if (!rawOutput) return '';
  try {
    const parsedFromRaw = JSON.parse(rawOutput);
    return _safePrettyJson(parsedFromRaw);
  } catch {
    return '';
  }
}

function buildTargetSelectionKey(modelKey, submissionId) {
  const safeSubmissionId = Number(submissionId || 0);
  const safeModelKey = String(modelKey || '').trim();
  if (!Number.isFinite(safeSubmissionId) || safeSubmissionId <= 0 || !safeModelKey) return '';
  return `${safeSubmissionId}::${safeModelKey}`;
}

function extractSubmissionIdFromSelectionKey(selectionKey) {
  const token = String(selectionKey || '');
  const [submissionIdText] = token.split('::');
  const submissionId = Number(submissionIdText || 0);
  if (!Number.isFinite(submissionId) || submissionId <= 0) return 0;
  return submissionId;
}

function extractModelKeyFromSelectionKey(selectionKey) {
  const token = String(selectionKey || '');
  const [, modelKeyText] = token.split('::');
  const modelKey = String(modelKeyText || '').trim();
  return modelKey || '';
}

export default function AIReviewProgressDialog({
  open,
  competition,
  onClose,
  setMessage,
}) {
  const competitionId = Number(competition?.id || 0);
  const competitionName = competition?.name || competition?.title || competitionId || '-';
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [progressData, setProgressData] = useState(null);
  const [reviewRunState, setReviewRunState] = useState('not_started');
  const [runtimeMeta, setRuntimeMeta] = useState({
    workerAvailable: false,
    workerSchedulerRunning: false,
    workerLastTickAt: null,
    runningJobCount: 0,
    pendingJobCount: 0,
  });
  const [recoverConfirmOpen, setRecoverConfirmOpen] = useState(false);
  const [recoveringStuck, setRecoveringStuck] = useState(false);
  const [recoveringStuckTargets, setRecoveringStuckTargets] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [submittingRetry, setSubmittingRetry] = useState(false);
  const [selectedTargetKeys, setSelectedTargetKeys] = useState([]);
  const [expandedModelKeys, setExpandedModelKeys] = useState([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErrorText, setDetailErrorText] = useState('');
  const [detailData, setDetailData] = useState(null);
  const lastSettingsSyncAtRef = useRef(0);
  const [detailTarget, setDetailTarget] = useState({
    submissionId: 0,
    title: '',
    modelKey: '',
    modelName: '',
    modelStatus: 'pending',
    targetSuccessCount: 0,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    modelScore: null,
  });

  const progressModels = useMemo(
    () => (Array.isArray(progressData?.models) ? progressData.models : []),
    [progressData]
  );
  const totalTargetRows = useMemo(
    () => progressModels.reduce((sum, model) => {
      const total = Number(model?.targets_total);
      if (Number.isFinite(total) && total >= 0) return sum + total;
      const targets = Array.isArray(model?.targets) ? model.targets : [];
      return sum + targets.length;
    }, 0),
    [progressModels]
  );
  const expandedModelKeySet = useMemo(
    () => new Set(expandedModelKeys),
    [expandedModelKeys]
  );
  const progressTargetLimit = expandedModelKeys.length > 0 ? 0 : TARGET_RENDER_LIMIT_PER_MODEL;
  const targetSelectionMetaMap = useMemo(() => {
    const map = new Map();
    progressModels.forEach((model) => {
      const modelKey = String(model?.model_key || '').trim();
      const targets = Array.isArray(model?.targets) ? model.targets : [];
      targets.forEach((target) => {
        const submissionId = Number(target?.submission_id || 0);
        if (!Number.isFinite(submissionId) || submissionId <= 0) return;
        const modelStatus = String(target?.model_status || '').trim().toLowerCase();
        const isFailed = modelStatus === 'failed';
        const isStuck = Boolean(target?.is_stuck);
        if (!isFailed && !isStuck) return;
        const key = buildTargetSelectionKey(target?.model_key || modelKey, submissionId);
        if (!key) return;
        map.set(key, {
          key,
          submissionId,
          modelKey: String(target?.model_key || modelKey || '').trim(),
          isFailed,
          isStuck,
        });
      });
    });
    return map;
  }, [progressModels]);
  const selectableTargets = useMemo(
    () => Array.from(targetSelectionMetaMap.values()),
    [targetSelectionMetaMap]
  );
  const selectableTargetKeys = useMemo(
    () => selectableTargets.map((item) => item.key),
    [selectableTargets]
  );
  const retrySelectableTargetKeys = useMemo(
    () => selectableTargets.filter((item) => item.isFailed).map((item) => item.key),
    [selectableTargets]
  );
  const stuckSelectableTargetKeys = useMemo(
    () => selectableTargets.filter((item) => item.isStuck).map((item) => item.key),
    [selectableTargets]
  );
  const retrySelectableTargetKeySet = useMemo(
    () => new Set(retrySelectableTargetKeys),
    [retrySelectableTargetKeys]
  );
  const stuckSelectableTargetKeySet = useMemo(
    () => new Set(stuckSelectableTargetKeys),
    [stuckSelectableTargetKeys]
  );
  const selectableTargetKeySet = useMemo(
    () => new Set(selectableTargetKeys),
    [selectableTargetKeys]
  );

  const selectedTargetKeySet = useMemo(
    () => new Set(selectedTargetKeys),
    [selectedTargetKeys]
  );
  const selectedSubmissionIds = useMemo(() => {
    const ids = selectedTargetKeys
      .map((item) => extractSubmissionIdFromSelectionKey(item))
      .filter((item) => Number.isFinite(item) && item > 0);
    return Array.from(new Set(ids));
  }, [selectedTargetKeys]);
  const selectedRetryTargetKeys = useMemo(
    () => selectedTargetKeys.filter((item) => retrySelectableTargetKeySet.has(item)),
    [selectedTargetKeys, retrySelectableTargetKeySet]
  );
  const selectedStuckTargetKeys = useMemo(
    () => selectedTargetKeys.filter((item) => stuckSelectableTargetKeySet.has(item)),
    [selectedTargetKeys, stuckSelectableTargetKeySet]
  );
  const selectedRetrySubmissionIds = useMemo(() => {
    const ids = selectedRetryTargetKeys
      .map((item) => extractSubmissionIdFromSelectionKey(item))
      .filter((item) => Number.isFinite(item) && item > 0);
    return Array.from(new Set(ids));
  }, [selectedRetryTargetKeys]);
  const selectedRetryTargets = useMemo(
    () => selectedRetryTargetKeys
      .map((item) => {
        const submissionId = extractSubmissionIdFromSelectionKey(item);
        const modelKey = extractModelKeyFromSelectionKey(item);
        if (!submissionId || !modelKey) return null;
        return { submission_id: submissionId, model_key: modelKey };
      })
      .filter((item) => Boolean(item)),
    [selectedRetryTargetKeys]
  );
  const selectedStuckTargets = useMemo(
    () => selectedStuckTargetKeys
      .map((item) => {
        const submissionId = extractSubmissionIdFromSelectionKey(item);
        const modelKey = extractModelKeyFromSelectionKey(item);
        if (!submissionId || !modelKey) return null;
        return { submission_id: submissionId, model_key: modelKey };
      })
      .filter((item) => Boolean(item)),
    [selectedStuckTargetKeys]
  );
  const normalizedReviewRunState = normalizeReviewRunState(reviewRunState);
  const selectedSubmissionCount = selectedSubmissionIds.length;
  const runningTotal = Number(progressData?.running_total || 0);
  const pendingTotal = Number(progressData?.pending_total || 0);
  const hasUnfinishedWork = (runningTotal + pendingTotal) > 0;
  const latestProgressAtRaw = progressData?.updated_at || runtimeMeta.workerLastTickAt;
  const latestProgressAt = latestProgressAtRaw ? new Date(latestProgressAtRaw) : null;
  const secondsSinceLatestProgress = (() => {
    if (!latestProgressAt) return null;
    const timestamp = latestProgressAt.getTime();
    if (!Number.isFinite(timestamp)) return null;
    return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  })();
  const noEffectiveRunner = runningTotal <= 0 && Number(runtimeMeta.runningJobCount || 0) <= 0;
  const workerUnavailable = !runtimeMeta.workerAvailable || !runtimeMeta.workerSchedulerRunning;
  const likelyStuck = (
    normalizedReviewRunState === 'running'
    && hasUnfinishedWork
    && noEffectiveRunner
    && (
      workerUnavailable
      || (Number.isFinite(secondsSinceLatestProgress) && Number(secondsSinceLatestProgress) >= STUCK_IDLE_THRESHOLD_SECONDS)
    )
  );

  useEffect(() => {
    if (!open || !competitionId) return undefined;
    let cancelled = false;
    let inFlight = false;
    let timerId = null;

    const scheduleNext = (ms) => {
      if (cancelled) return;
      if (timerId) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        void loadProgress({ silent: true });
      }, Math.max(2000, Number(ms || 0)));
    };

    const loadProgress = async ({ silent = false } = {}) => {
      if (cancelled || inFlight) return;
      inFlight = true;
      let nextPollMs = ACTIVE_POLL_MS_SMALL;
      if (!silent) {
        setLoading(true);
        setErrorText('');
      } else {
        setRefreshing(true);
      }
      try {
        const { data } = await getCompetitionAIReviewProgress(competitionId, {
          requestId: createRequestId(),
          targetLimitPerModel: progressTargetLimit,
        });
        if (cancelled) return;
        setProgressData(data || null);
        const runningTotal = Number(data?.running_total || 0);
        const pendingTotal = Number(data?.pending_total || 0);
        const currentTotalTargets = (Array.isArray(data?.models) ? data.models : []).reduce((sum, model) => {
          const total = Number(model?.targets_total);
          if (Number.isFinite(total) && total >= 0) return sum + total;
          const targets = Array.isArray(model?.targets) ? model.targets : [];
          return sum + targets.length;
        }, 0);
        let effectiveRunState = reviewRunState;
        const shouldSyncSettings = !silent || (Date.now() - Number(lastSettingsSyncAtRef.current || 0) >= 15000);
        if (shouldSyncSettings) {
          try {
            const settingsResp = await getCompetitionAIReviewSettings(competitionId, {
              requestId: createRequestId(),
            });
            const settingsData = settingsResp?.data || null;
            const runState = settingsData?.review_run_state ?? settingsData?.settings?.review_run_state;
            effectiveRunState = normalizeReviewRunState(runState);
            setReviewRunState(effectiveRunState);
            setRuntimeMeta({
              workerAvailable: Boolean(settingsData?.worker_available),
              workerSchedulerRunning: Boolean(settingsData?.worker_scheduler_running),
              workerLastTickAt: settingsData?.worker_last_tick_at || null,
              runningJobCount: Number(settingsData?.running_job_count || 0),
              pendingJobCount: Number(settingsData?.pending_job_count || 0),
            });
            lastSettingsSyncAtRef.current = Date.now();
          } catch {
            // 保留上一次运行态，避免 settings 临时失败时把“已暂停”误刷成“未开始”。
          }
        }
        // 仅在仍有任务或处于运行态时保持高频轮询；其余情况降为低频，减少无效 GET 压力。
        const hasActiveWork = effectiveRunState === 'running' || runningTotal > 0 || pendingTotal > 0;
        if (!hasActiveWork) {
          nextPollMs = 45000;
        } else if (currentTotalTargets >= ACTIVE_POLL_LARGE_TARGETS) {
          nextPollMs = ACTIVE_POLL_MS_LARGE;
        } else if (currentTotalTargets >= ACTIVE_POLL_MEDIUM_TARGETS) {
          nextPollMs = ACTIVE_POLL_MS_MEDIUM;
        } else {
          nextPollMs = ACTIVE_POLL_MS_SMALL;
        }
        if (!silent) setErrorText('');
      } catch (error) {
        if (cancelled) return;
        const text = getUserFriendlyErrorText(error, '加载 AI 评审进度失败');
        // 异常时降低频率，避免请求风暴。
        nextPollMs = 15000;
        if (!silent) {
          setErrorText(text);
          if (typeof setMessage === 'function') {
            setMessage({ type: 'error', text });
          }
        }
      } finally {
        if (!cancelled) {
          if (!silent) setLoading(false);
          if (silent) setRefreshing(false);
          scheduleNext(nextPollMs);
        }
        inFlight = false;
      }
    };

    void loadProgress({ silent: false });

    return () => {
      cancelled = true;
      if (timerId) window.clearTimeout(timerId);
    };
  }, [competitionId, open, progressTargetLimit, reviewRunState, setMessage, refreshVersion]);

  const openRecoverConfirmDialog = () => {
    if (!competitionId || !likelyStuck || normalizedReviewRunState === 'paused' || recoveringStuck) return;
    setRecoverConfirmOpen(true);
  };

  const closeRecoverConfirmDialog = () => {
    if (recoveringStuck) return;
    setRecoverConfirmOpen(false);
  };

  const recoverStuck = async () => {
    if (!competitionId || !likelyStuck || normalizedReviewRunState === 'paused') return;
    setRecoveringStuck(true);
    try {
      await controlCompetitionAIReviewRunState(
        competitionId,
        { action: 'resume' },
        { requestId: createRequestId() }
      );
      setMessage?.({ type: 'success', text: '已触发解除卡住，系统将继续评审。' });
      setRecoverConfirmOpen(false);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '解除卡住失败');
      setMessage?.({ type: 'error', text });
    } finally {
      setRecoveringStuck(false);
    }
  };

  const recoverSelectedStuckTargets = async () => {
    if (!competitionId || normalizedReviewRunState === 'paused' || !selectedStuckTargets.length) return;
    setRecoveringStuckTargets(true);
    try {
      const { data } = await recoverCompetitionAIReviewStuckTargets(
        competitionId,
        { targets: selectedStuckTargets },
        { requestId: createRequestId() }
      );
      const createdCount = Number(data?.pagination?.total || data?.items?.length || 0);
      setMessage?.({ type: 'success', text: `已提交卡住项解锁任务：${createdCount} 个作品` });
      const selectedStuckSet = new Set(selectedStuckTargetKeys);
      setSelectedTargetKeys((prev) => prev.filter((item) => !selectedStuckSet.has(item)));
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '提交卡住项解锁失败');
      setMessage?.({ type: 'error', text });
    } finally {
      setRecoveringStuckTargets(false);
    }
  };

  useEffect(() => {
    if (open) return;
    setLoading(false);
    setRefreshing(false);
    setErrorText('');
    setProgressData(null);
    setReviewRunState('not_started');
    setRecoverConfirmOpen(false);
    setRecoveringStuckTargets(false);
    setSubmittingRetry(false);
    setSelectedTargetKeys([]);
    setExpandedModelKeys([]);
    setDetailOpen(false);
    setDetailLoading(false);
    setDetailErrorText('');
    setDetailData(null);
    setDetailTarget({
      submissionId: 0,
      title: '',
      modelKey: '',
      modelName: '',
      modelStatus: 'pending',
      targetSuccessCount: 0,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      modelScore: null,
    });
  }, [open]);

  useEffect(() => {
    if (!selectedTargetKeys.length) return;
    if (!selectableTargetKeys.length) {
      setSelectedTargetKeys([]);
      return;
    }
    const allowed = new Set(selectableTargetKeys);
    setSelectedTargetKeys((prev) => prev.filter((key) => allowed.has(key)));
  }, [selectableTargetKeys, selectedTargetKeys.length]);

  const progressStatusKey = String(progressData?.status || 'not_started').trim().toLowerCase();
  const progressStatusColor = PROGRESS_STATUS_COLOR_MAP[progressStatusKey] || 'default';
  const progressStatusDisplayLabel = (
    normalizedReviewRunState === 'paused' && progressStatusKey === 'running'
  )
    ? '未完成'
    : progressStatusLabel(progressStatusKey);
  const hasTargetRows = progressModels.some((model) => {
    const targets = Array.isArray(model?.targets) ? model.targets : [];
    return targets.length > 0;
  });
  const hasModelRunning = progressModels.some((model) => {
    const targets = Array.isArray(model?.targets) ? model.targets : [];
    return targets.some((target) => String(target?.model_status || '').trim().toLowerCase() === 'running');
  });
  const hasActiveRunning = hasTargetRows
    ? hasModelRunning
    : (runningTotal > 0 || Number(runtimeMeta.runningJobCount || 0) > 0);
  const hasPendingOnly = !hasActiveRunning && pendingTotal > 0;
  const overallStatusLabel = normalizedReviewRunState === 'paused'
    ? '已暂停'
    : (hasActiveRunning ? '运行中' : (hasPendingOnly ? '待评审' : progressStatusDisplayLabel));
  const overallStatusColor = normalizedReviewRunState === 'paused'
    ? 'warning'
    : (hasActiveRunning ? 'warning' : (hasPendingOnly ? 'default' : progressStatusColor));
  const toggleTargetSelection = (targetKey) => {
    const safeKey = String(targetKey || '').trim();
    if (!safeKey || !selectableTargetKeySet.has(safeKey)) return;
    setSelectedTargetKeys((prev) => {
      if (prev.includes(safeKey)) {
        return prev.filter((item) => item !== safeKey);
      }
      return [...prev, safeKey];
    });
  };

  const selectFailedSubmissions = () => {
    setSelectedTargetKeys([...retrySelectableTargetKeys]);
  };

  const selectStuckTargets = () => {
    setSelectedTargetKeys([...stuckSelectableTargetKeys]);
  };

  const submitRetryForSelected = async () => {
    const uniqueSubmissionIds = [...selectedRetrySubmissionIds];
    if (!competitionId || !selectedRetryTargets.length || !uniqueSubmissionIds.length || submittingRetry) return;

    setSubmittingRetry(true);
    try {
      const { data } = await createCompetitionAIReviewJobs(
        competitionId,
        {
          submission_ids: uniqueSubmissionIds,
          retry_targets: selectedRetryTargets,
          trigger_source: 'retry',
        },
        { requestId: createRequestId() }
      );
      const createdCount = Number(data?.pagination?.total || data?.items?.length || 0);
      if (typeof setMessage === 'function') {
        setMessage({
          type: 'success',
          text: `已提交失败作品恢复任务：${createdCount} 个作品（${selectedRetryTargets.length} 个模型项）`,
        });
      }
      const selectedRetrySet = new Set(selectedRetryTargetKeys);
      setSelectedTargetKeys((prev) => prev.filter((item) => !selectedRetrySet.has(item)));
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '提交失败作品恢复任务失败');
      if (typeof setMessage === 'function') {
        setMessage({ type: 'error', text });
      }
    } finally {
      setSubmittingRetry(false);
    }
  };

  const openSubmissionDetail = async (target, model) => {
    const submissionId = Number(target?.submission_id || 0);
    const jobId = Number(target?.job_id || 0);
    const modelKey = String(model?.model_key || '').trim();
    if (!competitionId || !submissionId || detailLoading) return;
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailErrorText('');
    setDetailData(null);
    setDetailTarget({
      submissionId,
      jobId: jobId > 0 ? jobId : null,
      title: String(target?.title || '').trim(),
      modelKey,
      modelName: String(model?.model_name || modelKey || '').trim(),
      modelStatus: String(target?.model_status || '').trim().toLowerCase() || 'pending',
      targetSuccessCount: Number(target?.target_success_count || 0),
      runCount: Number(target?.run_count || 0),
      successCount: Number(target?.success_count || 0),
      failureCount: Number(target?.failure_count || 0),
      modelScore: target?.model_score,
    });
    try {
      const requestOptions = {
        requestId: createRequestId(),
      };
      if (jobId > 0) {
        requestOptions.jobId = jobId;
      }
      if (modelKey) {
        requestOptions.modelKey = modelKey;
      }
      const { data } = await getCompetitionAIReviewSubmissionDisplay(
        competitionId,
        submissionId,
        requestOptions
      );
      setDetailData(data || null);
    } catch (error) {
      const text = getUserFriendlyErrorText(error, '加载作品AI评审详情失败');
      setDetailErrorText(text);
      if (typeof setMessage === 'function') {
        setMessage({ type: 'error', text });
      }
    } finally {
      setDetailLoading(false);
    }
  };

  const closeSubmissionDetail = () => {
    if (detailLoading) return;
    setDetailOpen(false);
  };

  const detailRuns = useMemo(() => {
    const rows = Array.isArray(detailData?.runs) ? detailData.runs : [];
    const modelKey = String(detailTarget?.modelKey || '').trim();
    return [...rows].sort((a, b) => {
      const recordTypeA = String(a?.record_type || '').trim().toLowerCase();
      const recordTypeB = String(b?.record_type || '').trim().toLowerCase();
      if (recordTypeA !== 'run' || recordTypeB !== 'run') {
        if (recordTypeA === 'run' && recordTypeB !== 'run') return -1;
        if (recordTypeA !== 'run' && recordTypeB === 'run') return 1;
      }
      const modelA = String(a?.model_name || a?.model_key || '');
      const modelB = String(b?.model_name || b?.model_key || '');
      if (modelA !== modelB) return modelA.localeCompare(modelB, 'zh-Hans-CN');
      const idxA = Number(a?.run_index || 0);
      const idxB = Number(b?.run_index || 0);
      if (idxA !== idxB) return idxA - idxB;
      return Number(a?.id || 0) - Number(b?.id || 0);
    }).filter((row) => {
      const recordType = String(row?.record_type || '').trim().toLowerCase();
      if (recordType !== 'run') return false;
      const runStatus = String(row?.status || '').trim().toLowerCase();
      if (runStatus !== 'succeeded') return false;
      if (!modelKey) return true;
      return String(row?.model_key || '').trim() === modelKey;
    });
  }, [detailData, detailTarget?.modelKey]);

  return (
    <>
      <Dialog
        open={open}
        onClose={(_, reason) => {
          if (loading || reason === 'backdropClick') return;
          onClose?.();
        }}
        fullWidth
        maxWidth="xl"
        PaperProps={{
          sx: {
            width: '94vw',
            maxWidth: 1680,
            minHeight: '82vh',
            maxHeight: '90vh',
          },
        }}
      >
        <DialogTitle>
          AI评审进度（比赛：{competitionName || '-'}）
        </DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.2 }}>
          {!competitionId ? (
            <Alert severity="warning">比赛信息无效，无法加载评审进度。</Alert>
          ) : (
            <>
            <Alert severity="info">
              这里展示正式 AI 评审的实时进度，口径为“成功次数”，可用于确认是否仍在运行、各模型是否达到目标次数。
            </Alert>
            {normalizedReviewRunState === 'paused' && (
              <Alert severity="warning">
                已暂停评审。系统已停止领取新任务，并中断正在进行中的评审；被中断任务记为失败，不计入成功次数。
              </Alert>
            )}

            {errorText && <Alert severity="error">{errorText}</Alert>}

            {loading && !progressData ? (
              <Stack alignItems="center" spacing={1} sx={{ py: 6 }}>
                <CircularProgress size={24} />
                <Typography variant="body2" color="text.secondary">加载 AI 评审进度中...</Typography>
              </Stack>
            ) : (
              <>
                <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                  <Typography variant="subtitle1">总体状态</Typography>
                  <Chip size="small" color={overallStatusColor} label={overallStatusLabel} />
                  <Chip size="small" color="success" label={progressData?.review_started ? '已启用' : '未启用'} />
                  {refreshing && <CircularProgress size={14} />}
                  <Chip size="small" color="success" label={`最近更新 ${formatDateTimeText(progressData?.updated_at)}`} />
                </Stack>
                {likelyStuck && normalizedReviewRunState !== 'paused' && (
                  <Alert severity="warning">
                    当前评审疑似卡住（长时间无进度且无有效运行任务）。可点击“解除卡住”尝试恢复。
                  </Alert>
                )}

                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <Chip size="small" color="success" label={`提交目标 ${Number(progressData?.submitted_total || 0)}`} />
                  <Chip size="small" color="success" label={`已完成 ${Number(progressData?.completed_total || 0)}`} />
                  <Chip size="small" label={`目标明细 ${totalTargetRows}`} />
                </Stack>

                {!progressModels.length ? (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                    暂无模型进度数据。
                  </Typography>
                ) : (
                  <Stack spacing={1.2} sx={{ minHeight: 0 }}>
                    {progressModels.map((model) => {
                      const modelKey = String(model?.model_key || '').trim();
                      const targets = Array.isArray(model?.targets) ? model.targets : [];
                      const modelTargetsTotal = Number.isFinite(Number(model?.targets_total))
                        ? Number(model?.targets_total || 0)
                        : targets.length;
                      const sortedTargets = sortTargetsByDisplayPriority(targets);
                      const isModelExpanded = expandedModelKeySet.has(modelKey);
                      const displayTargets = isModelExpanded
                        ? sortedTargets
                        : sortedTargets.slice(0, TARGET_RENDER_LIMIT_PER_MODEL);
                      const hiddenTargetCount = Math.max(0, modelTargetsTotal - displayTargets.length);
                      const modelSelectableTargetKeys = targets
                        .map((target) => buildTargetSelectionKey(target?.model_key || modelKey, target?.submission_id))
                        .filter((key) => key && selectableTargetKeySet.has(key));
                      const modelSelectedCount = modelSelectableTargetKeys.filter((key) => selectedTargetKeySet.has(key)).length;
                      const modelAllSelected = modelSelectableTargetKeys.length > 0 && modelSelectedCount === modelSelectableTargetKeys.length;
                      const modelIndeterminate = modelSelectedCount > 0 && !modelAllSelected;
                      const toggleModelSelectAll = () => {
                        if (!modelSelectableTargetKeys.length) return;
                        setSelectedTargetKeys((prev) => {
                          const next = new Set(prev);
                          if (modelAllSelected) {
                            modelSelectableTargetKeys.forEach((key) => next.delete(key));
                          } else {
                            modelSelectableTargetKeys.forEach((key) => next.add(key));
                          }
                          return Array.from(next);
                        });
                      };
                      return (
                        <Box
                          key={`ai_progress_model_${model?.model_key || 'unknown'}`}
                          sx={{
                            border: '1px solid',
                            borderColor: 'divider',
                            borderRadius: 2,
                            p: 1.25,
                          }}
                        >
                          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                              {model?.model_name || model?.model_key || '-'}
                            </Typography>
                            <Chip size="small" label={`目标成功次数 ${Number(model?.success_target_per_submission || 0)}`} />
                            <Chip size="small" label={`总运行 ${Number(model?.run_count_total || 0)}`} />
                            <Chip size="small" color="success" label={`总成功 ${Number(model?.success_count_total || 0)}`} />
                            <Chip size="small" color="error" label={`运行失败次数 ${Number(model?.failure_count_total || 0)}`} />
                          </Stack>

                          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 0.8 }}>
                            <Chip size="small" label={`目标作品数 ${Number(model?.target_submission_total || 0)}`} />
                            <Chip size="small" label={`已开始 ${Number(model?.started_submission_total || 0)}`} />
                            <Chip size="small" label={`待评审 ${Number(model?.pending_submission_total || 0)}`} />
                            <Chip size="small" color="warning" label={`评审中 ${Number(model?.running_submission_total || 0)}`} />
                            <Chip size="small" color="success" label={`已完成 ${Number(model?.completed_submission_total || 0)}`} />
                            <Chip size="small" color="error" label={`最终失败作品数 ${Number(model?.failed_submission_total || 0)}`} />
                          </Stack>

                          <TableContainer
                            sx={{
                              mt: 1,
                              maxHeight: 420,
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1.5,
                            }}
                          >
                            <Table size="small" stickyHeader sx={{ minWidth: 1100 }}>
                              <TableHead>
                                <TableRow>
                                  <TableCell padding="checkbox" sx={{ width: 44 }}>
                                    <Checkbox
                                      size="small"
                                      checked={modelAllSelected}
                                      indeterminate={modelIndeterminate}
                                      onChange={toggleModelSelectAll}
                                      disabled={submittingRetry || recoveringStuckTargets || loading || !modelSelectableTargetKeys.length}
                                      inputProps={{ 'aria-label': '全选作品' }}
                                    />
                                  </TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>序号</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>作品标题</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>状态</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>模型最终评分</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>目标成功次数</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>运行次数</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>成功</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>运行失败次数</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>最近更新时间</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>详情</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {displayTargets.length > 0 ? (
                                  displayTargets.map((target, targetIndex) => {
                                    const submissionId = Number(target?.submission_id || 0);
                                    const targetKey = buildTargetSelectionKey(target?.model_key || modelKey, submissionId);
                                    const selectable = selectableTargetKeySet.has(targetKey);
                                    const isTargetStuck = Boolean(target?.is_stuck);
                                    const stuckSeconds = Number(target?.stuck_seconds || 0);
                                    return (
                                    <TableRow key={`ai_progress_target_${model?.model_key || 'unknown'}_${submissionId || 0}`}>
                                      <TableCell padding="checkbox">
                                        <Checkbox
                                          size="small"
                                          checked={selectedTargetKeySet.has(targetKey)}
                                          onChange={() => toggleTargetSelection(targetKey)}
                                          disabled={submittingRetry || recoveringStuckTargets || loading || !selectable}
                                          inputProps={{ 'aria-label': `选择作品${submissionId}` }}
                                        />
                                      </TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{targetIndex + 1}</TableCell>
                                      <TableCell sx={{ minWidth: 220 }}>{target?.title || '-'}</TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                        <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap">
                                          <Chip size="small" color={targetStatusColor(target?.model_status)} label={targetStatusLabel(target?.model_status)} />
                                          {isTargetStuck && (
                                            <Chip
                                              size="small"
                                              color="error"
                                              variant="outlined"
                                              label={Number.isFinite(stuckSeconds) && stuckSeconds > 0 ? `卡住 ${stuckSeconds}秒` : '卡住'}
                                            />
                                          )}
                                        </Stack>
                                      </TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                        {formatScoreText(
                                          String(target?.model_status || '').trim().toLowerCase() === 'completed'
                                            ? target?.model_score
                                            : null
                                        )}
                                      </TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{Number(target?.target_success_count || 0)}</TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{Number(target?.run_count || 0)}</TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{Number(target?.success_count || 0)}</TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{Number(target?.failure_count || 0)}</TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTimeText(target?.updated_at)}</TableCell>
                                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                        <Button
                                          size="small"
                                          variant="outlined"
                                          onClick={() => openSubmissionDetail(target, model)}
                                          disabled={loading || submittingRetry}
                                        >
                                          详情
                                        </Button>
                                      </TableCell>
                                    </TableRow>
                                    );
                                  })
                                ) : (
                                  <TableRow>
                                    <TableCell align="center" colSpan={11}>暂无目标明细</TableCell>
                                  </TableRow>
                                )}
                              </TableBody>
                            </Table>
                          </TableContainer>
                          {hiddenTargetCount > 0 && (
                            <Stack direction="row" justifyContent="flex-end" sx={{ mt: 0.8 }}>
                              <Button
                                size="small"
                                onClick={() => {
                                  setExpandedModelKeys((prev) => {
                                    const set = new Set(prev);
                                    set.add(modelKey);
                                    return Array.from(set);
                                  });
                                }}
                                disabled={isModelExpanded && Boolean(model?.targets_truncated)}
                              >
                                {isModelExpanded && model?.targets_truncated
                                  ? '正在加载全部明细...'
                                  : `显示全部 ${modelTargetsTotal} 条（当前 ${displayTargets.length} 条）`}
                              </Button>
                            </Stack>
                          )}
                          {hiddenTargetCount <= 0 && isModelExpanded && modelTargetsTotal > TARGET_RENDER_LIMIT_PER_MODEL && (
                            <Stack direction="row" justifyContent="flex-end" sx={{ mt: 0.8 }}>
                              <Button
                                size="small"
                                onClick={() => {
                                  setExpandedModelKeys((prev) => prev.filter((item) => item !== modelKey));
                                }}
                              >
                                收起到前 {TARGET_RENDER_LIMIT_PER_MODEL} 条
                              </Button>
                            </Stack>
                          )}
                        </Box>
                      );
                    })}
                  </Stack>
                )}
              </>
            )}
          </>
        )}
      </DialogContent>
        <DialogActions>
        <Stack direction="row" spacing={1} sx={{ width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              onClick={selectFailedSubmissions}
              disabled={loading || submittingRetry || recoveringStuckTargets || !retrySelectableTargetKeys.length}
            >
              一键选择失败作品
            </Button>
            <Button
              variant="outlined"
              color="error"
              onClick={selectStuckTargets}
              disabled={loading || submittingRetry || recoveringStuckTargets || !stuckSelectableTargetKeys.length}
            >
              一键选择卡住项
            </Button>
            <Button
              variant="outlined"
              onClick={() => setSelectedTargetKeys([])}
              disabled={loading || submittingRetry || recoveringStuckTargets || !selectedTargetKeys.length}
            >
              清空选择
            </Button>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              已选 {selectedSubmissionCount} 个作品（失败模型项 {selectedRetryTargetKeys.length}，卡住项 {selectedStuckTargetKeys.length}）
            </Typography>
            <Button
              variant="contained"
              color="error"
              onClick={recoverSelectedStuckTargets}
              disabled={
                loading
                || submittingRetry
                || recoveringStuck
                || recoveringStuckTargets
                || normalizedReviewRunState === 'paused'
                || !selectedStuckTargetKeys.length
              }
              title={normalizedReviewRunState === 'paused' ? '已暂停状态下不可解锁卡住项，请先继续评审。' : ''}
            >
              {recoveringStuckTargets ? '解锁中...' : '解锁选中卡住项'}
            </Button>
            <Button
              variant="contained"
              color="warning"
              onClick={submitRetryForSelected}
              disabled={loading || submittingRetry || recoveringStuckTargets || !selectedRetryTargetKeys.length}
            >
              {submittingRetry ? '恢复中...' : '恢复失败作品'}
            </Button>
            <Button onClick={onClose} disabled={loading || submittingRetry || recoveringStuckTargets}>关闭</Button>
          </Stack>
        </Stack>
        </DialogActions>
      </Dialog>

      <Dialog
        open={detailOpen}
        onClose={(_, reason) => {
          if (reason === 'backdropClick' || detailLoading) return;
          closeSubmissionDetail();
        }}
        fullWidth
        maxWidth="lg"
      >
        <DialogTitle>
          AI评审详情（{detailTarget?.modelName || detailTarget?.modelKey || '-'} · 作品ID：{Number(detailTarget?.submissionId || 0)}）
          {detailTarget?.title ? ` · ${detailTarget.title}` : ''}
        </DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.2 }}>
          {detailLoading ? (
            <Stack alignItems="center" spacing={1} sx={{ py: 5 }}>
              <CircularProgress size={24} />
              <Typography variant="body2" color="text.secondary">加载详情中...</Typography>
            </Stack>
          ) : (
            <>
              <Alert severity="info">
                仅展示该模型对该作品的成功运行明细（n 次）：每次运行的评语、维度分、结构化输出与原始输出。
              </Alert>
              {detailErrorText && <Alert severity="error">{detailErrorText}</Alert>}

              {!detailData ? (
                <Typography variant="body2" color="text.secondary">暂无可展示的评审详情。</Typography>
              ) : (
                <Stack spacing={1.2}>
                  <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                    <Chip size="small" label={`状态 ${targetStatusLabel(detailTarget?.modelStatus)}`} />
                    <Chip size="small" label={`目标成功次数 ${Number(detailTarget?.targetSuccessCount || 0)}`} />
                    <Chip size="small" label={`运行次数 ${Number(detailTarget?.runCount || 0)}`} />
                    <Chip size="small" color="success" label={`成功 ${Number(detailTarget?.successCount || 0)}`} />
                    <Chip size="small" color="error" label={`运行失败 ${Number(detailTarget?.failureCount || 0)}`} />
                    <Chip size="small" label={`模型最终评分 ${formatScoreText(detailTarget?.modelScore)}`} />
                    <Chip size="small" label={`成功详情数 ${detailRuns.length}`} />
                  </Stack>

                  {!detailRuns.length ? (
                    <Typography variant="body2" color="text.secondary">该模型当前暂无成功运行明细。</Typography>
                  ) : (
                    <Stack spacing={1}>
                      {detailRuns.map((run) => {
                        const dimensionScores = Array.isArray(run?.parsed_json?.dimension_scores)
                          ? run.parsed_json.dimension_scores
                          : [];
                        const structuredOutputText = resolveRunStructuredOutput(run);
                        const rawOutputText = String(run?.raw_response_text || '').trim();
                        return (
                          <Box
                            key={`ai_run_detail_${Number(run?.id || 0)}`}
                            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 1 }}
                          >
                            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 0.8 }}>
                              <Chip size="small" label={`${run?.model_name || run?.model_key || '-'} #${Number(run?.run_index || 0)}`} />
                              <Chip size="small" label={`状态 ${String(run?.status || '-').toUpperCase()}`} />
                              <Chip size="small" label={`分数 ${formatScoreText(run?.score)}`} />
                              <Chip size="small" label={`原始总分 ${formatScoreText(run?.raw_total_score)}`} />
                              <Chip size="small" label={`耗时 ${Number(run?.latency_ms || 0)} ms`} />
                              <Chip size="small" label={`时间 ${formatDateTimeText(run?.reviewed_at || run?.updated_at)}`} />
                            </Stack>
                            <Typography variant="body2" sx={{ mb: 0.8, whiteSpace: 'pre-wrap' }}>
                              评语：{resolveRunComment(run)}
                            </Typography>

                            {dimensionScores.length > 0 && (
                              <Box sx={{ mb: 0.8 }}>
                                <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>维度分</Typography>
                                <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap">
                                  {dimensionScores.map((item, idx) => (
                                    <Chip
                                      key={`dim_${Number(run?.id || 0)}_${idx}`}
                                      size="small"
                                      variant="outlined"
                                      label={`${String(item?.code || '-')}: ${formatScoreText(item?.score)}`}
                                    />
                                  ))}
                                </Stack>
                              </Box>
                            )}

                            <TextField
                              fullWidth
                              size="small"
                              label="结构化输出（parsed_json）"
                              value={structuredOutputText || '（无可结构化内容）'}
                              multiline
                              minRows={6}
                              InputProps={{
                                readOnly: true,
                                sx: { fontFamily: 'monospace', alignItems: 'flex-start' },
                              }}
                            />
                            {rawOutputText ? (
                              <Box
                                component="details"
                                sx={{
                                  mt: 0.8,
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  borderRadius: 1,
                                  p: 0.8,
                                }}
                              >
                                <Box component="summary" sx={{ cursor: 'pointer', fontSize: 13 }}>
                                  查看原始输出（raw_response_text）
                                </Box>
                                <TextField
                                  fullWidth
                                  size="small"
                                  label="模型原始输出（raw_response_text）"
                                  value={rawOutputText}
                                  multiline
                                  minRows={4}
                                  sx={{ mt: 0.8 }}
                                  InputProps={{
                                    readOnly: true,
                                    sx: { fontFamily: 'monospace', alignItems: 'flex-start' },
                                  }}
                                />
                              </Box>
                            ) : null}
                          </Box>
                        );
                      })}
                    </Stack>
                  )}
                </Stack>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSubmissionDetail} disabled={detailLoading}>关闭</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={recoverConfirmOpen}
        onClose={(_, reason) => {
          if (reason === 'backdropClick' || recoveringStuck) return;
          closeRecoverConfirmDialog();
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>确认解除卡住</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.2}>
            <Alert severity="warning">
              将尝试恢复当前评审调度并继续领取任务。请再次确认是否执行“解除卡住”。
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeRecoverConfirmDialog} disabled={recoveringStuck}>取消</Button>
          <Button
            variant="contained"
            color="error"
            onClick={recoverStuck}
            disabled={recoveringStuck || loading || submittingRetry || !likelyStuck || normalizedReviewRunState === 'paused'}
          >
            {recoveringStuck ? '解除中...' : '确定解除'}
          </Button>
        </DialogActions>
      </Dialog>

    </>
  );
}
