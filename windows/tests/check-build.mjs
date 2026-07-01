#!/usr/bin/env node
/**
 * 构建门禁脚本 (Build Gate)
 * 在 tauri build/dev 之前自动运行，拦截以下问题：
 * 1. JS 语法错误（重复声明、语法格式错误等）
 * 2. ES Module import/export 不一致（导入了不存在的函数）
 * 3. import 语句顺序违规（import 必须在文件最顶部）
 *
 * 用法: node tests/check-build.mjs
 */

import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { parse } from 'acorn';

const SRC_DIR = resolve(import.meta.dirname, '..', 'src');
let errors = 0;
let warnings = 0;

function fail(msg) {
    console.error(`  ❌ ${msg}`);
    errors++;
}

function warn(msg) {
    console.warn(`  ⚠️  ${msg}`);
    warnings++;
}

function pass(msg) {
    console.log(`  ✅ ${msg}`);
}

// ====== 检查 1: JS 语法检查 (node --check) ======
console.log('\n🔍 检查 1: JavaScript 语法检查');

const jsFiles = readdirSync(SRC_DIR).filter(f => f.endsWith('.js') && f !== 'Sortable.min.js');

for (const file of jsFiles) {
    const filePath = join(SRC_DIR, file);
    try {
        execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
        pass(`${file} 语法正确`);
    } catch (e) {
        const stderr = e.stderr?.toString() || '';
        fail(`${file} 语法错误:\n${stderr.split('\n').slice(0, 5).join('\n')}`);
    }
}

// ====== 检查 2: ES Module import/export 一致性 ======
console.log('\n🔍 检查 2: ES Module import/export 一致性');

/**
 * 从文件中提取所有 export 的函数/变量名
 */
function extractExports(filePath) {
    const code = readFileSync(filePath, 'utf-8');
    const exports = new Set();
    try {
        const ast = parse(code, { ecmaVersion: 2022, sourceType: 'module' });
        for (const node of ast.body) {
            if (node.type === 'ExportNamedDeclaration') {
                if (node.declaration) {
                    if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
                        exports.add(node.declaration.id.name);
                    } else if (node.declaration.type === 'VariableDeclaration') {
                        for (const decl of node.declaration.declarations) {
                            if (decl.id && decl.id.name) exports.add(decl.id.name);
                        }
                    }
                }
                if (node.specifiers) {
                    for (const spec of node.specifiers) {
                        exports.add(spec.exported.name);
                    }
                }
            }
        }
    } catch (e) {
        fail(`解析 ${filePath} 失败: ${e.message}`);
    }
    return exports;
}

/**
 * 从文件中提取所有 import { name } from './xxx.js' 的信息
 */
function extractImports(filePath) {
    const code = readFileSync(filePath, 'utf-8');
    const imports = []; // { name, source, line }
    try {
        const ast = parse(code, { ecmaVersion: 2022, sourceType: 'module' });
        for (const node of ast.body) {
            if (node.type === 'ImportDeclaration') {
                const source = node.source.value;
                for (const spec of node.specifiers) {
                    if (spec.type === 'ImportSpecifier') {
                        imports.push({
                            name: spec.imported.name,
                            source: source,
                            line: node.loc?.start?.line || '?'
                        });
                    }
                }
            }
        }
    } catch (e) {
        fail(`解析 ${filePath} 失败: ${e.message}`);
    }
    return imports;
}

// 构建每个 JS 文件的 exports 表
const exportsMap = {};
for (const file of jsFiles) {
    exportsMap[`./${file}`] = extractExports(join(SRC_DIR, file));
}

// 检查每个文件的 import 是否都能在目标文件中找到对应的 export
for (const file of jsFiles) {
    const filePath = join(SRC_DIR, file);
    const imports = extractImports(filePath);

    for (const imp of imports) {
        const targetExports = exportsMap[imp.source];
        if (!targetExports) {
            // 跳过外部模块（非 ./ 开头的）
            if (imp.source.startsWith('./') || imp.source.startsWith('../')) {
                fail(`${file}: 导入的模块 '${imp.source}' 不存在于 src 目录`);
            }
            continue;
        }
        if (!targetExports.has(imp.name)) {
            fail(`${file}: 导入了 '${imp.name}' (来自 ${imp.source})，但该模块并未导出此名称！`);
        }
    }
}

if (errors === 0) {
    pass('所有 import/export 一致性检查通过');
}

// ====== 检查 3: import 语句位置检查 ======
console.log('\n🔍 检查 3: import 语句位置检查（必须在文件最顶部）');

for (const file of jsFiles) {
    const filePath = join(SRC_DIR, file);
    const code = readFileSync(filePath, 'utf-8');
    try {
        const ast = parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true });
        let foundNonImport = false;
        for (const node of ast.body) {
            if (node.type === 'ImportDeclaration') {
                if (foundNonImport) {
                    fail(`${file} 第 ${node.loc.start.line} 行: import 语句出现在非 import 代码之后！import 必须在文件最顶部`);
                }
            } else {
                foundNonImport = true;
            }
        }
    } catch (e) {
        // 语法错误已在检查 1 中报告
    }
}

if (errors === 0) {
    pass('所有 import 语句位置正确');
}

// ====== 检查 4: HTML 中引用的 JS 文件存在性检查 ======
console.log('\n🔍 检查 4: HTML 引用完整性检查');

const indexHtml = readFileSync(join(SRC_DIR, 'index.html'), 'utf-8');
const scriptRefs = [...indexHtml.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
const allSrcFiles = readdirSync(SRC_DIR);

for (const ref of scriptRefs) {
    const refFile = ref.startsWith('/') ? ref.substring(1) : ref;
    const exists = allSrcFiles.includes(refFile);
    if (exists) {
        pass(`index.html 引用的 ${ref} 存在`);
    } else {
        fail(`index.html 引用了 ${ref}，但该文件不存在于 src 目录`);
    }
}

// ====== 检查 5: JSON Schema 文件可用性 ======
console.log('\n🔍 检查 5: 数据契约文件检查');

const schemaPath = resolve(SRC_DIR, '..', '..', 'todo_data.schema.json');
try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    if (schema.properties && schema.properties.todos) {
        pass('todo_data.schema.json 格式正确');
    } else {
        fail('todo_data.schema.json 缺少 todos 属性定义');
    }
} catch (e) {
    fail(`todo_data.schema.json 解析失败: ${e.message}`);
}

// ====== 结果汇总 ======
console.log('\n' + '='.repeat(50));
if (errors > 0) {
    console.error(`\n💀 构建门禁未通过！发现 ${errors} 个错误，${warnings} 个警告。`);
    console.error('请修复以上问题后再执行 tauri build。\n');
    process.exit(1);
} else {
    console.log(`\n🎉 构建门禁全部通过！${warnings > 0 ? `(${warnings} 个警告)` : ''}`);
    console.log('可以安全执行 tauri build。\n');
    process.exit(0);
}
