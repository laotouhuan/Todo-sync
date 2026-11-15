const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(code); };

// 默认合成操作保持原有线格式；业务适配器必须由调用方明确选择。
export const NOTE_PROFILE = Object.freeze({
    id: 'lab-note/1',
    validateBaseline(data) {
        if (!object(data)) fail('INVALID_LAB_BASELINE');
    },
    validateOperation(operation) {
        if (!object(operation) || Object.keys(operation).length !== 3 ||
            !['type', 'key', 'value'].every(key => Object.hasOwn(operation, key)) || operation.type !== 'lab.note.set') fail('UNSUPPORTED_OPERATION');
        if (typeof operation.key !== 'string' || !operation.key || typeof operation.value !== 'string') fail('INVALID_LAB_OPERATION');
    },
    project(baselineData, orderedRecords) {
        const data = structuredClone(baselineData), notes = Object.create(null);
        if (data.notes != null && !object(data.notes)) fail('INVALID_LAB_BASELINE');
        Object.assign(notes, data.notes ?? {});
        for (const record of orderedRecords) for (const operation of record.operations) notes[operation.key] = operation.value;
        data.notes = notes;
        return data;
    }
});

// 捕获本地依赖的函数与标识，避免调用方随后改动适配器对象改变已打开实例。
export function captureProfile(profile = NOTE_PROFILE) {
    if (!object(profile) || typeof profile.id !== 'string' || !profile.id ||
        !['validateBaseline', 'validateOperation', 'project'].every(key => typeof profile[key] === 'function')) fail('INVALID_OPERATION_PROFILE');
    return Object.freeze({ id: profile.id, validateBaseline: profile.validateBaseline,
        validateOperation: profile.validateOperation, project: profile.project });
}
