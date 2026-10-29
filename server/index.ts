import { LiveProviderRuntime } from './live-provider.js';
import { createApp } from './app.js';
import { TaskService } from './service.js';
import { TaskStore } from './store.js';

const store = new TaskStore(process.env.DATABASE_PATH || '.data/workbench.sqlite');
const requestedTimeout = Number(process.env.TRANSLATION_TIMEOUT_MS || 30000);
const timeout = Number.isFinite(requestedTimeout)
  ? Math.max(100, Math.min(30000, requestedTimeout))
  : 30000;
const runtime = new LiveProviderRuntime(store);
const adapter = runtime.adapter;
const service = new TaskService(store, adapter, timeout);
const port = Number(process.env.PORT || 3001);
const app = createApp(service, process.env.APP_ORIGIN || `http://127.0.0.1:${port}`, runtime);
const server = app.listen(port, '127.0.0.1', () => {
  console.info(
    `IR 翻译工作台已启动：http://127.0.0.1:${port}（${adapter.mode === 'mock' ? '模拟模式，不产出真实译文' : '真实服务模式'}）`,
  );
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await service.shutdown();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
