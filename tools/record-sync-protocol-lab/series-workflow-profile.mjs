import { PERSONAL_SERIES_PROFILE } from './series-record-profile.mjs';
import { replaySeriesWorkflows, validateSeriesWorkflowOperation } from '../../windows/src/recordSeriesWorkflows.js';

export { importSeriesWorkflow, deleteSeriesWorkflow, manualTimerStop } from '../../windows/src/recordSeriesWorkflows.js';

export const PERSONAL_SERIES_WORKFLOW_PROFILE = Object.freeze({
    id: 'lab-personal-series-workflows/1',
    validateBaseline: PERSONAL_SERIES_PROFILE.validateBaseline,
    validateOperation: operation => validateSeriesWorkflowOperation(operation) || PERSONAL_SERIES_PROFILE.validateOperation(operation),
    project: (baseline, records) => replaySeriesWorkflows(baseline, records, PERSONAL_SERIES_PROFILE.project, { preferManualStops: false })
});

export const PERSONAL_SERIES_WORKFLOW_V2_PROFILE = Object.freeze({
    id: 'lab-personal-series-workflows/2',
    validateBaseline: PERSONAL_SERIES_PROFILE.validateBaseline,
    validateOperation: operation => validateSeriesWorkflowOperation(operation, true) || PERSONAL_SERIES_PROFILE.validateOperation(operation),
    project: (baseline, records) => replaySeriesWorkflows(baseline, records, PERSONAL_SERIES_PROFILE.project)
});
