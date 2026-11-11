// The README's worked example. After a build: RASK_API_KEY=... node examples/quickstart.ts talk.mp4 es-es dubbed.mp4
// (Node 24, Bun or Deno; import.meta.main is newer than Node 22.)
import { readFile, writeFile } from 'node:fs/promises';
import { Rask } from '@braskai/api';

// BEGIN README
export async function dub(rask: Rask, path: string, targetLanguage: string, outputPath: string) {
  // Progress is saved next to the video, so a run that stops can be started again without paying twice: the media, the
  // price you accepted, createProject's Idempotency-Key and the job it started. Delete the file to dub anew.
  const progressPath = `${path}.${targetLanguage}.json`;
  const saved: { mediaId?: string; maxMinutes?: number; createKey?: string; projectJobId?: string } = JSON.parse(
    await readFile(progressPath, 'utf8').catch(() => '{}'),
  );
  const save = () => writeFile(progressPath, JSON.stringify(saved));

  // Upload the file. completeUpload answers with a media_import job.
  if (saved.mediaId === undefined) {
    const { data: importJob } = await rask.uploads.uploadFile(path, {
      onProgress: (sent, total) => console.log(`uploaded ${Math.round((100 * sent) / total)}%`),
    });
    const { data: imported } = await rask.jobs.wait(importJob.id);
    if (imported.result?.type !== 'media_import') throw new Error('The import has no result.');
    saved.mediaId = imported.result.media_id;
    await save();
  }
  const body = { media_id: saved.mediaId, target_language: targetLanguage };

  // Ask what it costs. That price is the cap: the dub that follows is skipped, uncharged, if it would cost more.
  if (saved.maxMinutes === undefined || saved.createKey === undefined) {
    const { data: estimate } = await rask.projects.estimateProject({ body });
    saved.maxMinutes = estimate.total_minutes;
    saved.createKey = crypto.randomUUID();
    await save();
  }

  // Create the project. It dubs automatically after translation. Sent again with the same key within 24 hours, the
  // request gets the job it already started, not a second project.
  if (saved.projectJobId === undefined) {
    const { data: projectJob } = await rask.projects.createProject({
      body: { ...body, expected_cost_minutes: saved.maxMinutes },
      idempotencyKey: saved.createKey,
    });
    saved.projectJobId = projectJob.id;
    await save();
  }

  // Its job ends when translation ends, and the dub is a job of its own. jobs.wait gives each 4 hours by default.
  const { data: processed } = await rask.jobs.wait(saved.projectJobId);
  if (processed.result?.type !== 'project_processing') throw new Error('The project job has no result.');
  const { project_id: projectId, auto_dub: autoDub } = processed.result;
  if (autoDub.state !== 'dispatched' || autoDub.dub_job_id === null) {
    // skipped: the price or the balance changed after the request, and nothing was charged.
    throw new Error(
      `Project ${projectId} was not dubbed: auto_dub is ${autoDub.state} (${autoDub.skipped_reason}). ` +
        `Call estimateDub, then createDub within the same cap of ${saved.maxMinutes} minutes.`,
    );
  }
  await rask.jobs.wait(autoDub.dub_job_id);

  // Download the result. A presigned URL needs no key, so plain fetch does it.
  const { data: outputs } = await rask.exports.listProjectOutputs({ path: { project_id: projectId } });
  const video = outputs.data.find((output) => output.kind === 'dubbed_video' && output.url);
  if (!video?.url) throw new Error('The project has no dubbed video yet.');
  const download = await fetch(video.url);
  if (!download.ok) throw new Error(`The download answered ${download.status}.`);
  await writeFile(outputPath, new Uint8Array(await download.arrayBuffer()));
  return { projectId, outputPath };
}
// END README

if (import.meta.main) {
  const [path = 'talk.mp4', language = 'es-es', output = 'dubbed.mp4'] = process.argv.slice(2);
  // RASK_API_KEY and, if you use one, RASK_BASE_URL.
  await dub(new Rask(), path, language, output);
}
