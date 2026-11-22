// Node feeds this reporter the same test events used by its built-in TAP reporter.
const path = require('node:path');

module.exports = async function* outcomes(events) {
  const parents = new Map();
  for await (const {type, data} of events) {
    if (!data.file) continue;
    const file = path.relative(process.cwd(), data.file).split(path.sep).join('/');
    const names = parents.get(file) || [];
    if (type === 'test:start') {
      names.length = data.nesting;
      names[data.nesting] = data.name;
      parents.set(file, names);
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type === 'suite' || data.details?.error?.failureType === 'subtestsFailed') continue;
    const name = path.isAbsolute(data.name) ? path.relative(process.cwd(), data.name).split(path.sep).join('/') : data.name;
    const id = [file, ...names.slice(0, data.nesting), name].join('::');
    const state = data.skip || data.todo ? 'skipped' : type === 'test:fail' ? 'failed' : 'passed';
    yield JSON.stringify([id, state]) + '\n';
  }
  yield '"complete"\n';
};
