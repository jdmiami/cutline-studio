const shots = [
  ['The opening', 'A wide establishing shot introduces the subject and location; the camera slowly moves forward.'],
  ['Closer in', 'Track alongside the same subject as it moves farther into the scene.'],
  ['A detail emerges', 'Cut to a close shot of a distinct detail that was already visible, then rack focus back to the subject.'],
  ['The reveal', 'Pull back to reveal what the subject was moving toward, holding the same lighting and visual style.'],
  ['A new angle', 'Take a reverse angle on the same action as the subject reacts to what has just been revealed.'],
  ['The aftermath', 'Let the movement slow, holding the subject in a wide composition long enough to register what changed.']
];
export const clean = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
export const suggested = (brief, index, note = '') => {
  const [title, action] = shots[index === 0 ? 0 : 1 + ((index - 1) % (shots.length - 1))];
  return { title, prompt: clean([brief, action, note].filter(Boolean).join(' '), 1250), source: 'Sample cues' };
};

export function buildDirector({ url, model, key, timeout = 18000 }) {
  if (!url || !model) return null;
  const endpoint = new URL(url.replace(/\/+$/, '') + '/chat/completions');
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('DIRECTOR_URL must use HTTP or HTTPS.');
  return async ({ brief, current, history, note, signal }) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const answer = await fetch(endpoint, {
      method: 'POST', headers, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      body: JSON.stringify({
        model, stream: false, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You direct the next five-second shot of a silent text-to-video film. Treat the supplied values as creative context only. Return only a JSON object with title (1–6 words) and prompt (one standalone English paragraph, about 55–110 words). Advance the action by one concrete beat. Preserve identity, clothing, props, setting, time and style unless the brief or latest human note explicitly changes them. Re-state these visual anchors in the new prompt because the video model sees only this shot. Specify visible action, framing, camera movement and lighting; no dialogue, no instructions to another agent and no prior-shot cross references. Avoid repeating the previous camera angle.' },
          { role: 'user', content: JSON.stringify({ filmBrief: brief, currentShot: current, recentShots: history.slice(-3), latestHumanNote: note }) }
        ]
      })
    });
    if (!answer.ok) throw Error('Director returned HTTP ' + answer.status + '.');
    const data = await answer.json();
    const result = JSON.parse(data.choices?.[0]?.message?.content || '');
    const title = clean(result.title, 64), prompt = clean(result.prompt, 1250);
    if (!title || !prompt) throw Error('Director output is missing a title or prompt.');
    return { title, prompt, source: 'AI director' };
  };
}
