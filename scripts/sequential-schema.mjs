// A follow-up uses the editor's native receipt. User text cannot switch generation modes.
export function sequentialSchema(parameters, messages) {
  if (parameters?.properties?.files?.maxItems !== 1 || !parameters.properties.plan) return;
  const system = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const hasMarker = system.some(m => typeof m.content === 'string'
    ? m.content.includes('Use the sequential file plan.')
    : Array.isArray(m.content) && m.content.some(p => p.type === 'text' && p.text?.includes('Use the sequential file plan.')));
  if (!hasMarker || !messages.some(m => m.role === 'user')) return;
  if (messages.every(m => ['user','system','developer'].includes(m.role))) {
    return {...parameters, required:[...new Set([...(parameters.required ?? []),'plan'])]};
  }
  const receipt = messages.at(-1);
  const assistant = messages.at(-2);
  if (receipt?.role !== 'tool' || !receipt.tool_call_id || assistant?.role !== 'assistant' ||
      !assistant.tool_calls?.some(c => c.id === receipt.tool_call_id && c.function?.name === 'propose_changes')) return;
  let content = receipt.content;
  if (typeof content === 'string' && /^[{\[]/.test(content.trimStart())) {
    try { content = JSON.parse(content); } catch { /* A plain-text receipt can begin with a bracket. */ }
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) content=content.content;
  if (Array.isArray(content)) content = content.at(-1)?.text;
  if (typeof content !== 'string' || !content.trimEnd().endsWith('\nForgeLens sequential draft: continue')) return;
  const {plan, ...properties} = parameters.properties;
  return {...parameters,properties,required:parameters.required?.filter(key=>key!=='plan')};
}
