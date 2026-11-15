import { openCollaborationBoundaryLab } from './collaboration-boundary.mjs';
import { PERSONAL_SERIES_WORKFLOW_V2_PROFILE } from './series-workflow-profile.mjs';
import { PERSONAL_SERIES_PROFILE } from './series-record-profile.mjs';
import { collaborationCreateType, translateCollaborationRecords, validateCollaborationCreate } from '../../windows/src/recordCollaboration.js';
import { CAUSAL_SERIES_OPERATION_SET, LEGACY_SERIES_OPERATION_SET, replaySeriesWorkflows } from '../../windows/src/recordSeriesWorkflows.js';

export { collaborationTodoCreate } from '../../windows/src/recordCollaboration.js';

export const COLLABORATION_RECORD_PROFILE = Object.freeze({
    id: LEGACY_SERIES_OPERATION_SET,
    validateBaseline: PERSONAL_SERIES_WORKFLOW_V2_PROFILE.validateBaseline,
    validateOperation(operation) {
        if (operation?.type === collaborationCreateType) validateCollaborationCreate(operation);
        else PERSONAL_SERIES_WORKFLOW_V2_PROFILE.validateOperation(operation);
    },
    project(baseline, orderedRecords) {
        return PERSONAL_SERIES_WORKFLOW_V2_PROFILE.project(baseline, translateCollaborationRecords(baseline, orderedRecords));
    }
});

export const COLLABORATION_CAUSAL_SERIES_PROFILE = Object.freeze({
    ...COLLABORATION_RECORD_PROFILE,
    id: CAUSAL_SERIES_OPERATION_SET,
    project(baseline, orderedRecords) {
        return replaySeriesWorkflows(baseline, translateCollaborationRecords(baseline, orderedRecords),
            PERSONAL_SERIES_PROFILE.project, { causalSeries: true });
    }
});

export function openCollaborationRecordLab({ operationSet = LEGACY_SERIES_OPERATION_SET, ...options }) {
    const profile = operationSet === CAUSAL_SERIES_OPERATION_SET ? COLLABORATION_CAUSAL_SERIES_PROFILE : COLLABORATION_RECORD_PROFILE;
    if (profile.id !== operationSet) throw new Error('UNSUPPORTED_RECORD_OPERATION_SET');
    return openCollaborationBoundaryLab({ ...options, profile,
        createType: collaborationCreateType, validateCreateOperation: validateCollaborationCreate });
}
