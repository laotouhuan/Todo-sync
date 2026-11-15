import { createDataCoordinator } from '../src/dataCoordinator.js';

// 测试仍执行生产协调器；仅持久化适配器可以注入磁盘失败。
export function mainStoreHarness(state, persist) {
    const store = createDataCoordinator({ getData: () => state.todoData,
        install: data => { state.todoData = data; },
        persist: async (data, options) => {
            if (await persist(data, options) === false) throw new Error('保存失败');
        } });
    store.activate('test', state.todoData);
    return store;
}
