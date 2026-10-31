import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { FaultStore } from './faults.js';
import { JsonFileLogger } from './logger.js';

const port = Number(process.env.DEMO_SERVER_PORT ?? 3222);
const logger = new JsonFileLogger(
  resolve(process.env.DEMO_SERVER_LOG_FILE ?? 'logs/app.log'),
);
const faults = new FaultStore();

const orders = [
  { id: '1', customer: '林一', amount: 128 },
  { id: '2', customer: '陈晓', amount: 86 },
  { id: '3', customer: '周舟', amount: 399 },
];

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestId = randomUUID().replaceAll('-', '').slice(0, 12);
  const method = req.method ?? 'GET';
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  try {
    if (method === 'POST' && pathname === '/__faults') {
      const body = await readJson(req);
      const mode = faults.set(body?.mode);
      respond(res, 200, { mode });
      logger.write({
        level: 'info',
        message: '故障模式已切换',
        requestId,
        method,
        path: pathname,
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        mode,
      });
      return;
    }

    if (method === 'GET' && pathname === '/__faults') {
      respond(res, 200, { mode: faults.get() });
      logger.write({
        level: 'info',
        message: '查询故障模式',
        requestId,
        method,
        path: pathname,
        statusCode: 200,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (method === 'POST' && pathname === '/__restart') {
      faults.reset();
      respond(res, 200, { status: 'restarted', mode: faults.get() });
      logger.write({
        level: 'info',
        message: '服务重启完成，故障模式已重置',
        requestId,
        method,
        path: pathname,
        statusCode: 200,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      respond(res, 200, { status: 'ok' });
      logger.write({
        level: 'info',
        message: '健康检查通过',
        requestId,
        method,
        path: pathname,
        statusCode: 200,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/orders') {
      await applyFaultDelay();
      respond(res, 200, { orders });
      const durationMs = Date.now() - startedAt;
      logger.write({
        level: durationMs >= 1_000 ? 'warn' : 'info',
        message: durationMs >= 1_000
          ? '订单列表响应变慢'
          : '订单列表读取成功',
        requestId,
        method,
        path: pathname,
        statusCode: 200,
        durationMs,
        ...(durationMs >= 1_000 ? { errorCode: 'SLOW_REQUEST' } : {}),
      });
      return;
    }

    const orderMatch = /^\/api\/orders\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && orderMatch) {
      const orderId = orderMatch[1];
      const order = orders.find((item) => item.id === orderId);
      const mode = faults.get();

      if (mode === 'db-down') {
        respond(res, 503, { error: '数据库连接失败' });
        logger.write({
          level: 'error',
          message: '数据库连接失败，无法读取订单',
          requestId,
          method,
          path: pathname,
          statusCode: 503,
          durationMs: Date.now() - startedAt,
          errorCode: 'DB_CONNECTION_FAILED',
        });
        return;
      }

      if (mode === 'repeated-error' && orderId === '1') {
        respond(res, 500, { error: '订单服务超时' });
        logger.write({
          level: 'error',
          message: '读取订单超时',
          requestId,
          method,
          path: pathname,
          statusCode: 500,
          durationMs: Date.now() - startedAt,
          errorCode: 'DB_TIMEOUT',
        });
        return;
      }

      if (mode === 'error-spike' && Math.random() < 0.3) {
        respond(res, 500, { error: '订单服务内部错误' });
        logger.write({
          level: 'error',
          message: '读取订单失败',
          requestId,
          method,
          path: pathname,
          statusCode: 500,
          durationMs: Date.now() - startedAt,
          errorCode: 'ORDER_FETCH_FAILED',
        });
        return;
      }

      await applyFaultDelay(mode === 'slow' ? 1_200 : undefined);
      respond(res, 200, { order: order ?? null });
      const durationMs = Date.now() - startedAt;
      logger.write({
        level: durationMs >= 1_000 ? 'warn' : 'info',
        message: durationMs >= 1_000
          ? '慢请求：读取订单耗时过长'
          : '订单读取成功',
        requestId,
        method,
        path: pathname,
        statusCode: 200,
        durationMs,
        ...(durationMs >= 1_000 ? { errorCode: 'SLOW_REQUEST' } : {}),
      });
      return;
    }

    respond(res, 404, { error: '接口不存在' });
    logger.write({
      level: 'warn',
      message: '未知路由',
      requestId,
      method,
      path: pathname,
      statusCode: 404,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    respond(res, 500, { error: (error as Error).message });
    logger.write({
      level: 'error',
      message: '服务内部错误',
      requestId,
      method,
      path: pathname,
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      errorCode: 'INTERNAL_ERROR',
    });
  }
});

server.listen(port, () => {
  console.log(`[demo-server] 已启动 http://localhost:${port}`);
  console.log(`[demo-server] 日志文件 ${loggerFilePath()}`);
});

async function applyFaultDelay(ms?: number): Promise<void> {
  if (!ms) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function respond(
  res: import('node:http').ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function loggerFilePath(): string {
  return resolve(process.env.DEMO_SERVER_LOG_FILE ?? 'logs/app.log');
}
