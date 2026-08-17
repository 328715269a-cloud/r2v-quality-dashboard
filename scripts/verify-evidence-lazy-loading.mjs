import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const source = await readFile(path.join(repo, 'app.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const evidenceCell = source.match(/function appealEvidenceCell\(c\)\{[^\n]+/u)?.[0] || '';
assert(evidenceCell, '未找到 appealEvidenceCell');
assert(!evidenceCell.includes('<img'), '申诉列表仍会创建图片元素');
assert(!evidenceCell.includes('src='), '申诉列表仍包含图片地址');
assert(evidenceCell.includes('查看 ${images.length} 张图片'), '申诉列表未显示按需查看按钮');

const openCase = source.match(/function openCase\(key\)\{[\s\S]*?\nfunction closeDrawer/u)?.[0] || '';
assert(openCase, '未找到 openCase');
assert(openCase.includes('loading="lazy"'), 'Case 图片缺少 loading="lazy"');
assert(openCase.includes('decoding="async"'), 'Case 图片缺少 decoding="async"');

const closeDrawer = source.match(/function closeDrawer\(\)\{[^\n]+/u)?.[0] || '';
assert(closeDrawer.includes("$('drawerContent').replaceChildren()"), '关闭详情后未移除图片 DOM');

const implementations = source.match(/(?:async function extractAndUploadImages|extractAndUploadImages\s*=\s*async function)/gu) || [];
assert(implementations.length === 1, `extractAndUploadImages 应只有一个实现，实际为 ${implementations.length}`);

console.log('Verified click-only evidence loading and a single image upload implementation.');
