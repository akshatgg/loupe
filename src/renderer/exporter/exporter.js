// The hidden export window's entry point. Main opens this page for one
// export: it asks for the job, runs the pipeline, sends the file's bytes and
// progress back, and says when it is done or why it failed. Main closes the
// window afterwards (or to cancel).

import { exportProject } from './pipeline.js';

const bridge = window.loupeExporter;

async function run() {
  const job = await bridge.job();
  const summary = await exportProject(job, {
    write: (position, bytes) => bridge.write(position, bytes),
    progress: (p) => bridge.progress(p)
  });
  await bridge.done(summary);
}

run().catch((err) => {
  console.error(err);
  bridge.fail(err?.message ?? String(err));
});
