// 候选数据直到本地持久化成功才发布，后续修改始终基于已提交版本。
export function createDataCoordinator({ getData, install, persist }) {
    let queue = Promise.resolve(), generation = 0, revision = 0, target = null;
    function enqueue(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    function ticket() { return { generation, target }; }
    function current(stamp) { return stamp.generation === generation && stamp.target === target; }
    function activate(nextTarget, data) {
        target = nextTarget; generation++; revision++; install(data);
    }
    async function commitNow(change, options = {}) {
        const previous = getData();
        const draft = structuredClone(previous);
        const next = change(draft) || draft;
        if (!Array.isArray(next.todos)) throw new Error('提交必须保留完整的任务数据');
        if (!options.force && JSON.stringify(previous) === JSON.stringify(next)) return false;
        await persist(next, options);
        revision++; install(next); return true;
    }
    function commit(change, options = {}) {
        const stamp = options.ticket || ticket();
        return enqueue(() => {
            if (!target || !current(stamp)) throw new Error('数据来源已切换或尚未加载，请重新打开后重试');
            return commitNow(change, options);
        });
    }
    return { commit, activate, ticket, current, enqueue, commitNow,
        get revision() { return revision; }, get idle() { return queue; } };
}
