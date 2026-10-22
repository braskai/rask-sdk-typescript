/**
 * Quickstart: upload a video by link, dub it, wait for the result.
 *
 *   npm run build
 *   RASK_CLIENT_ID=... RASK_CLIENT_SECRET=... node examples/quickstart.ts https://example.com/video.mp4 es
 *
 * (Node >= 22.18 runs .ts files directly; otherwise use tsx or compile first.)
 */
import {
  MediaStatus,
  ProjectStatus,
  RaskApiError,
  RaskClient,
  type MediaGet,
  type ProjectGet,
} from '@braskai/rask-sdk';

const POLL_INTERVAL_MS = 10_000;

const PROJECT_FAILURES = new Set<string>([
  ProjectStatus.FAILED,
  ProjectStatus.NO_AUDIO,
  ProjectStatus.NO_WORDS,
  ProjectStatus.FORBIDDEN_LINK,
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isProjectFailed = (status: ProjectGet['status']): boolean =>
  !!status && (status.endsWith('_failed') || PROJECT_FAILURES.has(status));

async function waitForMedia(rask: RaskClient, media: MediaGet): Promise<MediaGet> {
  while (media.status === MediaStatus.PROCESSING) {
    await sleep(POLL_INTERVAL_MS);
    media = await rask.getMedia({ media_id: media.id });
  }
  if (media.status !== MediaStatus.READY) {
    throw new Error(`Media ${media.id} failed: ${JSON.stringify(media.meta)}`);
  }
  return media;
}

async function waitForProject(rask: RaskClient, project: ProjectGet): Promise<ProjectGet> {
  while (project.status !== ProjectStatus.MERGING_DONE) {
    if (isProjectFailed(project.status)) {
      throw new Error(`Project ${project.id} failed with status ${project.status}`);
    }
    console.log(`project ${project.id}: ${project.status ?? 'pending'}`);
    await sleep(POLL_INTERVAL_MS);
    project = await rask.getProject({ project_id: project.id });
  }
  return project;
}

async function main(): Promise<void> {
  const [link, dstLang = 'es'] = process.argv.slice(2);
  const clientId = process.env.RASK_CLIENT_ID;
  const clientSecret = process.env.RASK_CLIENT_SECRET;
  if (!link || !clientId || !clientSecret) {
    throw new Error('Usage: RASK_CLIENT_ID=... RASK_CLIENT_SECRET=... node examples/quickstart.ts <video-url> [dst_lang]');
  }

  const rask = new RaskClient({ clientId, clientSecret });

  const credits = await rask.getCredits();
  console.log(`minutes left: ${credits.minutes.total - credits.minutes.used}`);

  const media = await waitForMedia(rask, await rask.createMediaLink({ link, kind: 'video' }));
  console.log(`media ready: ${media.id}`);

  const created = await rask.createProject({ video_id: media.id, dst_lang: dstLang });
  const project = await waitForProject(rask, created);

  console.log('translated video:', project.translated_video);
  console.log('translated audio:', project.translated_audio);
  console.log('subtitles (.srt):', project.translation_srt_path);
}

main().catch((error: unknown) => {
  if (error instanceof RaskApiError) {
    console.error(`Rask API error ${error.status}:`, error.detail ?? error.body);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
