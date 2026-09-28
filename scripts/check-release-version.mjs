import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());

function read(relativePath) {
    try {
        return readFileSync(resolve(root, relativePath), 'utf8');
    } catch (error) {
        throw new Error(`无法读取 ${relativePath}: ${error.message}`);
    }
}

function requireVersion(value, file, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${file} 的 ${field} 缺失或为空`);
    }
    return value.trim();
}

function extractCargoPackageVersion(source) {
    const headers = [...source.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)];
    const packageHeaders = headers.filter(match => match[1].trim() === 'package');
    if (packageHeaders.length !== 1) {
        throw new Error(`windows/src-tauri/Cargo.toml 的 [package] 区段缺失或存在歧义`);
    }

    const header = packageHeaders[0];
    const contentStart = header.index + header[0].length;
    const nextHeader = headers.find(match => match.index > header.index);
    const packageSection = source.slice(contentStart, nextHeader?.index ?? source.length);
    const versions = [...packageSection.matchAll(/^\s*version\s*=\s*"([^"]*)"\s*(?:#.*)?$/gm)];
    if (versions.length !== 1) {
        throw new Error(`windows/src-tauri/Cargo.toml 的 [package].version 缺失或存在歧义`);
    }
    return requireVersion(versions[0][1], 'windows/src-tauri/Cargo.toml', '[package].version');
}

function extractDefaultConfigVersionName(source) {
    const blocks = [...source.matchAll(/\bdefaultConfig\s*\{/g)];
    if (blocks.length !== 1) {
        throw new Error(`android/app/build.gradle.kts 的 defaultConfig 区段缺失或存在歧义`);
    }

    const openBrace = source.indexOf('{', blocks[0].index);
    let depth = 0;
    let closeBrace = -1;
    for (let index = openBrace; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) {
            closeBrace = index;
            break;
        }
    }
    if (closeBrace < 0) {
        throw new Error(`android/app/build.gradle.kts 的 defaultConfig 区段未闭合`);
    }

    const block = source.slice(openBrace + 1, closeBrace);
    const versions = [...block.matchAll(/^\s*versionName\s*=\s*"([^"]*)"\s*(?:\/\/.*)?$/gm)];
    if (versions.length !== 1) {
        throw new Error(`android/app/build.gradle.kts 的 defaultConfig.versionName 缺失或存在歧义`);
    }
    return requireVersion(versions[0][1], 'android/app/build.gradle.kts', 'defaultConfig.versionName');
}

const packageJson = JSON.parse(read('windows/package.json'));
const tauriConfig = JSON.parse(read('windows/src-tauri/tauri.conf.json'));
const versions = [
    ['windows/package.json', requireVersion(packageJson.version, 'windows/package.json', 'version')],
    ['windows/src-tauri/Cargo.toml', extractCargoPackageVersion(read('windows/src-tauri/Cargo.toml'))],
    ['windows/src-tauri/tauri.conf.json', requireVersion(tauriConfig.version, 'windows/src-tauri/tauri.conf.json', 'version')],
    ['android/app/build.gradle.kts', extractDefaultConfigVersionName(read('android/app/build.gradle.kts'))]
];

const uniqueVersions = new Set(versions.map(([, version]) => version));
if (uniqueVersions.size !== 1) {
    throw new Error(`应用版本不一致：${versions.map(([file, version]) => `${file}=${version}`).join(', ')}`);
}

const version = versions[0][1];
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`发布标签 ${process.env.GITHUB_REF_NAME ?? '(空)'} 与应用版本 v${version} 不一致`);
}

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(`已验证四处应用版本一致：${version}`);
