// Group presentation only; keep native item order, identity and contents intact.
export const executionTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView']);
export const isCommentary = item => item.type === 'agentMessage' && item.phase === 'commentary';

export function groupMessageItems(items = []) {
  const groups = [];
  for (const item of items) {
    const kind = item.type === 'userMessage' ? 'user'
      : executionTypes.has(item.type) || item.type === 'reasoning' || isCommentary(item) ? 'process'
        : item.type === 'agentMessage' ? 'assistant' : 'item';
    const previous = groups.at(-1);
    if (kind !== 'item' && previous?.kind === kind) previous.items.push(item);
    else groups.push({ kind, key: `${kind}-${item.id}`, items: [item] });
  }
  return groups;
}

export function processMessageGroups(items) {
  const groups = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (isCommentary(item) && previous?.kind === 'commentary') previous.items.push(item);
    else groups.push({ kind: isCommentary(item) ? 'commentary' : 'item', key: item.id, items: [item] });
  }
  return groups;
}

export function processSummary(items) {
  const counts = { commands: 0, files: 0, tools: 0, searches: 0, images: 0, messages: 0, reasoning: 0 };
  let failed = 0, preview = '';
  for (const item of items) {
    if (item.type === 'commandExecution') counts.commands++;
    else if (item.type === 'fileChange') counts.files += item.changes?.length || 0;
    else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') counts.tools++;
    else if (item.type === 'webSearch') counts.searches++;
    else if (item.type === 'imageView') counts.images++;
    else if (item.type === 'reasoning') counts.reasoning++;
    else if (isCommentary(item)) { counts.messages++; if (item.text?.trim()) preview = item.text.trim().replace(/\s+/g, ' '); }
    if (executionTypes.has(item.type) && (['failed', 'declined'].includes(item.status) || item.exitCode != null && item.exitCode !== 0 || item.error || item.success === false)) failed++;
  }
  const detail = [[counts.commands, '次命令'], [counts.files, '个文件变更'], [counts.tools, '次工具调用'], [counts.searches, '次搜索'], [counts.images, '张图片'], [counts.messages, '条过程消息']]
    .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(' · ');
  return { counts, failed, preview, detail, operations: items.filter(item => executionTypes.has(item.type)).length };
}
