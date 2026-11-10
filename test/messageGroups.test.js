import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMessageItems, processMessageGroups, processSummary } from '../shared/messageGroups.js';

test('message grouping preserves original chronology across inputs, process runs and final answers', () => {
  const items = [
    { id: 'u1', type: 'userMessage' }, { id: 'u2', type: 'userMessage' },
    { id: 'c1', type: 'agentMessage', phase: 'commentary', text: 'checking' },
    { id: 'reason', type: 'reasoning', summary: ['inspect'] },
    { id: 'cmd', type: 'commandExecution' },
    { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: 'answer' },
    { id: 'a2', type: 'agentMessage', text: 'additional reply' },
    { id: 'notice', type: 'contextCompaction' },
    { id: 'u3', type: 'userMessage' },
    { id: 'c2', type: 'agentMessage', phase: 'commentary', text: 'follow-up' },
  ];
  const original = structuredClone(items), groups = groupMessageItems(items);
  assert.deepEqual(groups.map(group => group.kind), ['user', 'process', 'assistant', 'item', 'user', 'process']);
  assert.deepEqual(groups.flatMap(group => group.items), items);
  for (const item of groups.flatMap(group => group.items)) assert.equal(item, items.find(candidate => candidate.id === item.id));
  assert.deepEqual(items, original);
});

test('streaming a process run retains its grouping key when commentary grows into tool execution', () => {
  const items = [{ id: 'first', type: 'agentMessage', phase: 'commentary', text: '' }];
  const key = groupMessageItems(items)[0].key;
  items[0].text = 'Preparing'; items.push({ id: 'next', type: 'commandExecution', status: 'inProgress' });
  assert.equal(groupMessageItems(items)[0].key, key);
  items.push({ id: 'reply', type: 'agentMessage', phase: 'final_answer', text: 'Done' });
  assert.equal(groupMessageItems(items)[0].key, key);
  assert.deepEqual(groupMessageItems(items).map(group => group.kind), ['process', 'assistant']);
});

test('only adjacent commentary messages stack, leaving intervening tools and reasoning in place', () => {
  const items = [
    { id: 'c1', type: 'agentMessage', phase: 'commentary' }, { id: 'c2', type: 'agentMessage', phase: 'commentary' },
    { id: 'cmd', type: 'commandExecution' },
    { id: 'c3', type: 'agentMessage', phase: 'commentary' }, { id: 'c4', type: 'agentMessage', phase: 'commentary' },
  ];
  const groups = processMessageGroups(items);
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [['c1', 'c2'], ['cmd'], ['c3', 'c4']]);
  assert.equal(processMessageGroups([...items, { id: 'c5', type: 'agentMessage', phase: 'commentary' }])[2].key, groups[2].key);
});

test('process summaries report real operation counts and failures without counting messages as commands', () => {
  const items = [
    { id: 'c1', type: 'agentMessage', phase: 'commentary', text: 'Started' },
    { id: 'r', type: 'reasoning' },
    { id: 'cmd1', type: 'commandExecution', exitCode: 0 },
    { id: 'cmd2', type: 'commandExecution', exitCode: 1 },
    { id: 'files', type: 'fileChange', changes: [{ path: 'a' }, { path: 'b' }] },
    { id: 'tool', type: 'mcpToolCall', error: { message: 'failed' } },
    { id: 'search', type: 'webSearch' },
    { id: 'c2', type: 'agentMessage', phase: 'commentary', text: 'Latest\nprogress' },
  ];
  const summary = processSummary(items);
  assert.equal(summary.operations, 5); assert.equal(summary.failed, 2); assert.equal(summary.preview, 'Latest progress');
  assert.deepEqual(summary.counts, { commands: 2, files: 2, tools: 1, searches: 1, images: 0, messages: 2, reasoning: 1 });
  assert.match(summary.detail, /2 次命令/); assert.match(summary.detail, /2 个文件变更/);
  assert.equal(groupMessageItems([]).length, 0);
});
