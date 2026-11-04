const $ = id => document.getElementById(id);
$('type').onchange = () => { $('criteria').disabled = $('type').value === 'noul'; };
$('form').onsubmit = async event => {
  event.preventDefault();
  $('submit').disabled = true;
  $('error').textContent = '';
  $('answer').textContent = '';
  $('status').textContent = 'Waiting for JEV…';
  try {
    const type = $('type').value;
    const lines = $('criteria').value.split('\n').map(line => line.trim()).filter(Boolean);
    let criteria;
    if (type === 'choice') {
      const pairs = lines.map(line => { const index = line.indexOf(':'); if (index < 1) throw new Error('Use name: description for each choice.'); return [line.slice(0, index).trim(), line.slice(index + 1).trim()]; });
      if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error('Choice names must be unique.');
      criteria = Object.fromEntries(pairs);
    } else if (type === 'score') criteria = lines;
    const response = await fetch('/api/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: $('state').value, instructions: $('instructions').value, type, criteria }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const answer = result.answers.result;
    $('answer').textContent = type === 'choice' ? answer.choice : type === 'noul' ? `${Math.round(answer.noul * 100)}% yes` : `Score: ${answer.score}`;
    $('status').textContent = `${result.model} · ${result.elapsedMs} ms · ${result.usage.input_tokens + result.usage.output_tokens} tokens`;
    $('raw').textContent = JSON.stringify(result, null, 2);
  } catch (error) { $('status').textContent = 'Decision failed.'; $('error').textContent = error.message; }
  finally { $('submit').disabled = false; }
};
