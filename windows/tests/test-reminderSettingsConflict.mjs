import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReminderSettingsEdit, chooseReminderSettings, normalizeReminderSettings } from '../src/reminderSettingsConflict.js';

test('提醒已知字段默认值补齐，未知规则字段与数组原序保留', () => {
    const original = { global_rules: [{ id: 'legacy', time: '8:30', extension: { keep: true } }, { id: 'second', time: '20:00' }] };
    const normalized = normalizeReminderSettings(original);
    assert.deepEqual(normalized, { updated_at: null, enabled: true, privacy_mode: false, global_rules: [
        { id: 'legacy', time: '8:30', extension: { keep: true }, enabled: true, condition: 'unconditional', task_scope: 'all', title: '', body: '' },
        { id: 'second', time: '20:00', enabled: true, condition: 'unconditional', task_scope: 'all', title: '', body: '' }
    ] });
    assert.equal(original.enabled, undefined);
    assert.equal(original.global_rules[0].enabled, undefined);
});

test('提醒选择较新完整设置，不把另一端的隐私与规则拼接过来', () => {
    const local = { reminder_settings: { updated_at: '2026-11-07T02:01:00Z', enabled: false, privacy_mode: false } };
    const cloud = { reminder_settings: { updated_at: '2026-11-07T02:00:00Z', enabled: true, privacy_mode: true,
        global_rules: [{ id: 'legacy', time: '09:00' }] } };
    assert.deepEqual(chooseReminderSettings(local, cloud), { updated_at: '2026-11-07T02:01:00Z', enabled: false, privacy_mode: false, global_rules: [] });
});

test('提醒不把坏类型静默当成缺省，扩展 JSON 与 Unicode 一并校验', () => {
    for (const raw of [null, [], { enabled: 1 }, { privacy_mode: 'true' }, { updated_at: 0 }, { global_rules: null },
        { global_rules: [{ id: 'x' }] }, { global_rules: [{ id: 'x', time: '09:00', enabled: null }] }]) {
        assert.throws(() => normalizeReminderSettings(raw), /INVALID_REMINDER_SETTINGS/);
    }
    assert.throws(() => normalizeReminderSettings({ future: Infinity }), /INVALID_JSON_VALUE/);
    assert.throws(() => normalizeReminderSettings({ global_rules: [{ id: 'x', time: '09:00', future: '\ud800' }] }), /INVALID_UNICODE/);
    assert.equal(normalizeReminderSettings({ updated_at: 'bad-clock' }).updated_at, 'bad-clock');
});

test('编辑规则按ID保留当前扩展并遵循显式删除与顺序，不复活已删除规则', () => {
    const previous = { updated_at: '2026-11-07T02:00:00Z', future: { keep: true }, global_rules: [
        { id: 'a', time: '09:00', extension: 'a' }, { id: 'b', time: '10:00', extension: 'b' }
    ] };
    const edited = applyReminderSettingsEdit(previous, { global_rules: [{ id: 'b', time: '11:00' }] });
    assert.deepEqual(edited.future, { keep: true });
    assert.equal(edited.global_rules.length, 1);
    assert.equal(edited.global_rules[0].extension, 'b');
    assert.equal(edited.global_rules[0].time, '11:00');
    assert.deepEqual(applyReminderSettingsEdit(previous, { global_rules: [] }).global_rules, []);
});
