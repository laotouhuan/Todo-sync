import { PERSONAL_PERIOD_PROFILE } from './period-record-profile.mjs';
import { baselineSeries, prepareSeriesRecords, validateSeriesOperation } from '../../windows/src/recordSeries.js';

export { seriesOperation } from '../../windows/src/recordSeries.js';

export const PERSONAL_SERIES_PROFILE = Object.freeze({
    id: 'lab-personal-series/1',
    validateBaseline(data) {
        PERSONAL_PERIOD_PROFILE.validateBaseline(data);
        baselineSeries(data);
    },
    validateOperation(operation) {
        if (!validateSeriesOperation(operation)) PERSONAL_PERIOD_PROFILE.validateOperation(operation);
    },
    project(baseline, orderedRecords) {
        const { records, applyTo } = prepareSeriesRecords(baseline, orderedRecords);
        const data = PERSONAL_PERIOD_PROFILE.project(baseline, records);
        applyTo(data);
        return data;
    }
});
