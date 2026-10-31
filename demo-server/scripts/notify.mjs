import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({
  path: resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../.env',
  ),
});

const webhookUrl = process.env.PATROL_WEBHOOK_URL ?? '';

const args = process.argv.slice(2);
const textIndex = args.indexOf('--text');
const atIndex = args.indexOf('--at');
const text = textIndex >= 0 ? args[textIndex + 1] : args.join(' ').trim();
const atBotId = atIndex >= 0 ? args[atIndex + 1] : undefined;

if (!webhookUrl) {
  console.error('[notify] 未配置 PATROL_WEBHOOK_URL，跳过推送');
  process.exit(1);
}
if (!text) {
  console.error('[notify] 缺少推送内容');
  process.exit(1);
}

let content = text;
if (atBotId) {
  const identity = readBotIdentity(atBotId);
  if (identity) {
    content = `<at user_id="${identity.openId}">@${atBotId}</at> ${text}`;
  } else {
    console.error(`[notify] 找不到 bot ${atBotId} 的 open_id，无法 @`);
    console.error('[notify] 请确认 HarnessOS 已重启并生成 data/bot-identities.json');
    process.exit(1);
  }
}

const response = await fetch(webhookUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ msg_type: 'text', content: { text: content } }),
});
const result = await response.json();
if (result.code !== 0) {
  console.error('[notify] 推送失败', result.msg ?? JSON.stringify(result));
  process.exit(1);
}
console.log(`[notify] 已推送到运维群${atBotId ? `，并 @ ${atBotId}` : ''}`);

function readBotIdentity(botId) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const identitiesPath = resolve(scriptDir, '../../data/bot-identities.json');
  try {
    const identities = JSON.parse(readFileSync(identitiesPath, 'utf8'));
    return identities?.[botId];
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error(`[notify] 找不到身份文件 ${identitiesPath}`);
    } else {
      console.error(`[notify] 读取身份文件失败: ${error.message}`);
    }
    return undefined;
  }
}
