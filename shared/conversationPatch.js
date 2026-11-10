export function mergeConversationPatch(previous, update) {
  const turns = [...(previous?.turns || [])];
  for (const turn of update.turns || []) {
    const index = turns.findIndex(item => item.id === turn.id);
    if (index < 0) turns.push(turn); else turns[index] = turn;
  }
  return { ...previous, ...update.conversation, turns };
}
