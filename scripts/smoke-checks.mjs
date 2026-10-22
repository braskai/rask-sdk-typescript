// Runtime smoke test for the built package (no network: fetch is faked).
// Used by `npm run test:dist` and the CI runtime-compat job (Node 18+, Bun, Deno).
const TOKEN_URL = 'https://rask-prod.auth.us-east-2.amazoncognito.com/oauth2/token';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const assert = (condition, message) => {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
};

export async function runSmoke(sdk, label) {
  const { RaskClient, RaskApiError, ProjectStatus } = sdk;
  const seen = [];
  let tokens = 0;

  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.url === TOKEN_URL) {
      tokens += 1;
      const form = new URLSearchParams(await request.text());
      assert(form.get('grant_type') === 'client_credentials', 'grant_type');
      return json({ access_token: `tok-${tokens}`, expires_in: 3600 });
    }
    const auth = request.headers.get('authorization');
    seen.push(`${request.method} ${url.pathname}${url.search} ${auth}`);
    if (auth === 'Bearer tok-1' && url.pathname === '/v2/credits') return json({ detail: 'expired' }, 401);
    if (url.pathname === '/api/library/v1/media') {
      const form = await request.formData();
      assert((await form.get('data').text()) === 'bytes', 'multipart data field');
      return json({ id: 'media-1', name: form.get('name') });
    }
    if (url.pathname === '/v2/projects' && request.method === 'POST') {
      const body = await request.json();
      return json({ id: 'project-1', status: 'created', dst_lang: body.dst_lang });
    }
    if (url.pathname === '/v2/projects/missing') return json({ detail: 'Project not found' }, 404);
    return json({ ok: true });
  };

  const rask = new RaskClient({ clientId: 'id', clientSecret: 'secret', fetch });

  const media = await rask.createMediaFile({ data: new Blob(['bytes']), name: 'video.mp4', kind: 'video' });
  assert(media.id === 'media-1' && media.name === 'video.mp4', 'createMediaFile result');

  const project = await rask.createProject({ video_id: media.id, dst_lang: 'es' });
  assert(project.dst_lang === 'es' && project.status === ProjectStatus.CREATED, 'createProject result');

  await rask.getProjectTranscription({ project_id: 'p', segment_ids: ['a', 'b'] });
  assert(seen.at(-1).startsWith('GET /v2/projects/p/transcription?segment_ids=a&segment_ids=b'), 'segment_ids');

  // tok-1 is rejected for /v2/credits: one refresh + retry.
  const credits = await rask.getCredits();
  assert(credits.ok === true && tokens === 2, '401 refresh-and-retry');

  let error;
  try {
    await rask.getProject({ project_id: 'missing' });
  } catch (e) {
    error = e;
  }
  assert(error instanceof RaskApiError && error.status === 404 && error.detail === 'Project not found', 'RaskApiError');

  console.log(`[${label}] smoke OK (${seen.length} API calls, ${tokens} token calls)`);
}
