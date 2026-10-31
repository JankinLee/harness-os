const baseUrl = process.env.DEMO_SERVER_BASE_URL ?? 'http://localhost:3222';
const args = process.argv.slice(2);
const scenarioIndex = args.indexOf('--scenario');
const scenario = scenarioIndex >= 0
  ? args[scenarioIndex + 1]
  : args[0] ?? 'normal';
const modeByScenario: Record<string, string> = {
  normal: 'none',
  slow: 'slow',
  'error-spike': 'error-spike',
  'repeated-error': 'repeated-error',
  'db-down': 'db-down',
};

const mode = modeByScenario[scenario];
if (!mode) {
  console.error(`未知场景：${scenario}`);
  console.error('可用场景：normal、slow、error-spike、repeated-error、db-down');
  process.exit(1);
}

await fetch(`${baseUrl}/__faults`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode }),
});
console.log(`[demo-server] 故障模式：${scenario}`);

const orderIds = ['1', '2', '3'];
const requestCount = scenario === 'slow' ? 5 : 20;
for (let index = 0; index < requestCount; index += 1) {
  const path = index % 5 === 0
    ? '/api/orders'
    : `/api/orders/${orderIds[index % orderIds.length]}`;
  try {
    await fetch(`${baseUrl}${path}`);
  } catch (error) {
    console.warn(
      `[demo-server] 请求失败 ${path}: ${(error as Error).message}`,
    );
  }
}

console.log('[demo-server] 流量已生成，巡检内容在日志文件里：');
console.log('  demo-server/logs/app.log');
