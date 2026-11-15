import { writeFile } from 'node:fs/promises';
import { createMemoryTransport } from './transport.mjs';
import { runScenario, runProcessCrashScenarios, createScratch, removeScratch } from './scenarios.mjs';

const directory = await createScratch();
try {
    const report = await runScenario({ transport: createMemoryTransport(), directory });
    report.processCrashChecks = await runProcessCrashScenarios(directory);
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
} finally { await removeScratch(directory); }
