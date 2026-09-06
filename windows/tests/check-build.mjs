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

// 显式断言核心入口文件 main.js 必须被 index.html 引用
const hasMainScript = scriptRefs.some(ref => ref === 'main.js' || ref === '/main.js');
if (hasMainScript) {
    pass('index.html 已包含核心入口逻辑 main.js 的引用');
} else {
    fail('index.html 缺失核心入口代码引用 (<script type="module" src="/main.js"></script>)，会导致应用静默失效！');
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
// ====== 检查 6: 关键函数作用域检查（防止花括号 {} 不匹配导致函数被嵌套吞噬）======
console.log('\n🔍 检查 6: 关键函数作用域检查');

// 这些函数必须在 main.js 的模块顶层作用域，如果它们被意外嵌套到其他函数中，
// 说明某处花括号 {} 不匹配（血泪教训：showCheckinDropdown 曾因缺少 } 吞掉了 initApp）
const CRITICAL_TOP_LEVEL_FUNCTIONS = [
    'initApp',
    'render',
    'loadData',
    'saveData',
    'createTodoItemElement',
    'showCheckinDropdown',
    'onDropdownCheckinUpdate',
    'openEditModal',
    'saveEditModal',
    'createAndAddTodo',
    'scheduleMidnightRefresh',
];

// 单个函数的最大行数阈值，超过此值发出警告（可能是花括号吞噬）
const MAX_FUNCTION_LINES = 800;

const mainJsPath = join(SRC_DIR, 'main.js');
try {
    const mainCode = readFileSync(mainJsPath, 'utf-8');
    const mainAst = parse(mainCode, { ecmaVersion: 2022, sourceType: 'module', locations: true });

    // 收集顶层函数声明
    const topLevelFuncs = new Map();
    for (const node of mainAst.body) {
        if (node.type === 'FunctionDeclaration' && node.id) {
            const startLine = node.loc.start.line;
            const endLine = node.loc.end.line;
            topLevelFuncs.set(node.id.name, { startLine, endLine, lines: endLine - startLine + 1 });
        }
    }

    // 检查关键函数是否都在顶层
    let scopeErrors = 0;
    for (const funcName of CRITICAL_TOP_LEVEL_FUNCTIONS) {
        if (!topLevelFuncs.has(funcName)) {
            fail(`main.js: 关键函数 '${funcName}' 不在模块顶层作用域！可能被其他函数的花括号 {} 意外嵌套吞噬`);
            scopeErrors++;
        }
    }

    if (scopeErrors === 0) {
        pass(`所有 ${CRITICAL_TOP_LEVEL_FUNCTIONS.length} 个关键函数均在模块顶层作用域`);
    }

    // 检查是否有超大函数（花括号吞噬的预警信号）
    for (const [name, info] of topLevelFuncs) {
        if (info.lines > MAX_FUNCTION_LINES) {
            warn(`main.js: 函数 '${name}' 过大（${info.lines} 行，L${info.startLine}-${info.endLine}），超过 ${MAX_FUNCTION_LINES} 行阈值，可能存在花括号不匹配问题`);
        }
    }
} catch (e) {
    // 语法错误已在检查 1 中报告
    if (e.code !== 'ENOENT') {
        fail(`main.js 函数作用域检查失败: ${e.message}`);
    }
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
