/**
 * Drops older completed tool-call rounds (an assistant tool batch plus all of
 * its results) from a model conversation, keeping the most recent rounds.
 * Incomplete rounds are always kept so no tool call loses its result.
 */
export function compactCompletedRounds(messages, retainedRounds = 4) {
  const rounds = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    const ids = message.toolCalls.map(call => call.id);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) continue;
    const resultIndices = [];
    for (let next = index + 1; next < messages.length && messages[next].role === 'tool'; next++) if (ids.includes(messages[next].toolCallId)) resultIndices.push(next);
    if (resultIndices.length === ids.length && ids.every(id => resultIndices.filter(i => messages[i].toolCallId === id).length === 1)) rounds.push({ index, results: resultIndices });
  }
	const keep = Number.isFinite(Number(retainedRounds)) ? Math.max(1, Math.floor(Number(retainedRounds))) : 4;
	const remove = new Set(rounds.slice(0, -keep).flatMap(round => [round.index, ...round.results]));
  return messages.filter((_message, index) => !remove.has(index));
}
