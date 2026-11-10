// The README's worked example. After a build: RASK_API_KEY=... node examples/quickstart.ts talk.mp4 es-es dubbed.mp4
// (Node 24, Bun or Deno; import.meta.main is newer than Node 22.)
import { writeFile } from 'node:fs/promises';
import { Rask } from '@braskai/api';

// BEGIN README
export async function dub(rask: Rask, path: string, targetLanguage: string, outputPath: string) {
  // Upload the file. completeUpload answers with a media_import job.
  const { data: importJob } = await rask.uploads.uploadFile(path, {
    onProgress: (sent, total) => console.log(`uploaded ${Math.round((100 * sent) / total)}%`),
  });
  const { data: imported } = await rask.jobs.wait(importJob.id);
  if (imported.result?.type !== 'media_import') throw new Error('The import has no result.');
  const mediaId = imported.result.media_id;

  // Ask what it costs, then create the project. It dubs automatically.
  const body = { media_id: mediaId, target_language: targetLanguage };
  const { data: estimate } = await rask.projects.estimateProject({ body });
  const { data: projectJob } = await rask.projects.createProject({
    body: { ...body, expected_cost_minutes: estimate.total_minutes },
  });

  // Wait for it: this can take a while, and jobs.wait gives it 4 hours by default.
  await rask.jobs.wait(projectJob.id);
  const projectId = projectJob.project_id as string;

  // Download the result. A presigned URL needs no key, so plain fetch does it.
  const { data: outputs } = await rask.exports.listProjectOutputs({ path: { project_id: projectId } });
  const video = outputs.data.find((output) => output.kind === 'dubbed_video' && output.url);
  if (!video?.url) throw new Error('The project has no dubbed video yet.');
  const download = await fetch(video.url);
  await writeFile(outputPath, new Uint8Array(await download.arrayBuffer()));
  return { projectId, outputPath };
}
// END README

if (import.meta.main) {
  const [path = 'talk.mp4', language = 'es-es', output = 'dubbed.mp4'] = process.argv.slice(2);
  // RASK_API_KEY and, if you use one, RASK_BASE_URL.
  await dub(new Rask(), path, language, output);
}
