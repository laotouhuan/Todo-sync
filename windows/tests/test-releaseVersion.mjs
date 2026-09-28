import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('../../scripts/check-release-version.mjs', import.meta.url));
const version = '1.2.3';

function createProject(t) {
    const root = mkdtempSync(join(tmpdir(), 'todo-release-version-'));
    const output = join(root, 'github-output.txt');
    t.after(() => rmSync(root, { recursive: true, force: true }));

    mkdirSync(join(root, 'windows/src-tauri'), { recursive: true });
    mkdirSync(join(root, 'android/app'), { recursive: true });
    writeFileSync(join(root, 'windows/package.json'), JSON.stringify({ version }, null, 2));
    writeFileSync(join(root, 'windows/src-tauri/tauri.conf.json'), JSON.stringify({ version }, null, 2));
    writeFileSync(join(root, 'windows/src-tauri/Cargo.toml'), `[package]\nname = "todo"\nversion = "${version}"\n\n[dependencies]\nexample = { version = "9.9.9" }\n`);
    writeFileSync(join(root, 'android/app/build.gradle.kts'), `android {\n    defaultConfig {\n        versionName = "${version}"\n    }\n    buildTypes {\n        release { versionName = "9.9.9" }\n    }\n}\n`);
    writeFileSync(output, '');
    return { root, output };
}

function runChecker({ root, output, refType = 'branch', refName = 'manual-run' }) {
    return spawnSync(process.execPath, [scriptPath, root], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GITHUB_REF_TYPE: refType,
            GITHUB_REF_NAME: refName,
            GITHUB_OUTPUT: output
        }
    });
}

function replaceFile(project, relativePath, transform) {
    const path = join(project.root, relativePath);
    const contents = readFileSync(path, 'utf8');
    writeFileSync(path, transform(contents));
}

test('版本一致时通过并写出 workflow 输出', t => {
    const project = createProject(t);
    const result = runChecker(project);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已验证四处应用版本一致：1\.2\.3/);
    assert.equal(readFileSync(project.output, 'utf8'), 'version=1.2.3\n');
});

test('四处应用版本分别不一致时均失败', async t => {
    const mismatches = [
        ['windows/package.json', text => text.replace('1.2.3', '2.0.0')],
        ['windows/src-tauri/Cargo.toml', text => text.replace('version = "1.2.3"', 'version = "2.0.0"')],
        ['windows/src-tauri/tauri.conf.json', text => text.replace('1.2.3', '2.0.0')],
        ['android/app/build.gradle.kts', text => text.replace('versionName = "1.2.3"', 'versionName = "2.0.0"')]
    ];

    for (const [file, mutate] of mismatches) {
        await t.test(file, child => {
            const project = createProject(child);
            replaceFile(project, file, mutate);
            const result = runChecker(project);

            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /应用版本不一致/);
            assert.equal(readFileSync(project.output, 'utf8'), '');
        });
    }
});

test('缺失或空版本字段失败', async t => {
    const invalidValues = [
        ['package version missing', 'windows/package.json', text => JSON.stringify({})],
        ['Tauri version empty', 'windows/src-tauri/tauri.conf.json', text => text.replace('1.2.3', '   ')],
        ['Cargo package version missing', 'windows/src-tauri/Cargo.toml', text => text.replace('version = "1.2.3"\n', '')],
        ['Gradle versionName empty', 'android/app/build.gradle.kts', text => text.replace('versionName = "1.2.3"', 'versionName = ""')]
    ];

    for (const [name, file, mutate] of invalidValues) {
        await t.test(name, child => {
            const project = createProject(child);
            replaceFile(project, file, mutate);
            const result = runChecker(project);

            assert.notEqual(result.status, 0);
            assert.equal(readFileSync(project.output, 'utf8'), '');
        });
    }
});

test('Cargo 与 Gradle 目标区段重复定义版本时失败', async t => {
    const cases = [
        ['Cargo package', 'windows/src-tauri/Cargo.toml', text => text.replace('[dependencies]', 'version = "2.0.0"\n\n[dependencies]')],
        ['Gradle defaultConfig', 'android/app/build.gradle.kts', text => text.replace('    buildTypes {', '    defaultConfig { versionName = "2.0.0" }\n    buildTypes {')]
    ];

    for (const [name, file, mutate] of cases) {
        await t.test(name, child => {
            const project = createProject(child);
            replaceFile(project, file, mutate);
            const result = runChecker(project);

            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /缺失或存在歧义/);
        });
    }
});

test('其他 Cargo 与 Gradle 区段的同名字段不影响版本读取', t => {
    const project = createProject(t);
    const result = runChecker(project);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(project.output, 'utf8'), 'version=1.2.3\n');
});

test('标签触发时要求版本匹配，手动分支触发不要求标签匹配', async t => {
    await t.test('匹配标签通过', child => {
        const project = createProject(child);
        assert.equal(runChecker({ ...project, refType: 'tag', refName: 'v1.2.3' }).status, 0);
    });

    await t.test('不匹配标签失败', child => {
        const project = createProject(child);
        const result = runChecker({ ...project, refType: 'tag', refName: 'v9.9.9' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /与应用版本 v1\.2\.3 不一致/);
    });

    await t.test('手动分支触发通过', child => {
        const project = createProject(child);
        assert.equal(runChecker({ ...project, refType: 'branch', refName: 'v9.9.9' }).status, 0);
    });
});
