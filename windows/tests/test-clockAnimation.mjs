import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareClockEntry, playClockEntry } from '../src/clockAnimation.js';

function mark() {
    const classes = new Set(), properties = new Map(), attributes = new Map();
    return { classes, properties, attributes, classList: { add: name => classes.add(name) },
        style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) },
        setAttribute: (key, value) => attributes.set(key, value) };
}

test('点与圆弧复用时间延迟，短圆弧和完整圆环均有出场时长', () => {
    const point = mark(), arc = mark(), full = mark();
    prepareClockEntry(point, 540); prepareClockEntry(arc, 540, 540.001); prepareClockEntry(full, 0, 1440);
    assert.equal(point.properties.get('--dot-delay'), arc.properties.get('--dot-delay'));
    assert.ok(point.classes.has('efficiency-dot')); assert.ok(arc.classes.has('efficiency-arc'));
    assert.equal(arc.attributes.get('pathLength'), '1');
    assert.equal(arc.properties.get('--arc-duration'), '0.15s');
    assert.equal(full.properties.get('--arc-duration'), '0.8s');
});

test('快速切换丢弃旧图层动画，保留图层正常播放并清理延迟', t => {
    const frames = [], timers = [], previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = callback => frames.push(callback);
    t.mock.method(globalThis, 'setTimeout', callback => { timers.push(callback); return 1; });
    try {
        const child = mark(); prepareClockEntry(child, 600);
        const group = { ...mark(), isConnected: true, querySelectorAll: () => [child] };
        const old = { ...group, ...mark() };
        playClockEntry(group); playClockEntry(old); old.isConnected = false;
        assert.ok(!group.classes.has('play-animation'));
        while (frames.length) frames.shift()();
        assert.ok(group.classes.has('play-animation')); assert.ok(!old.classes.has('play-animation'));
        assert.equal(timers.length, 1); timers[0]();
        assert.equal(child.properties.has('--dot-delay'), false);
    } finally {
        if (previous === undefined) delete globalThis.requestAnimationFrame;
        else globalThis.requestAnimationFrame = previous;
    }
});
