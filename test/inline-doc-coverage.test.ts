import test from 'node:test';
import assert from 'node:assert/strict';
import { pythonDocCoverageIssues } from '../src/inlineDocCoverage';

const request = 'Document all inputs that return false.';
const sample = (doc:string, lookup = 'options.get("badge")', body = 'return bool(token and token.casefold() not in {"skip", "pause", "false"})') =>
  'def active(options) -> bool:\n    """'+doc+'"""\n    token = '+lookup+'\n    '+body;

test('reports missing short-circuit conditions and literal names from the candidate', () => {
  const issues = pythonDocCoverageIssues(request, sample('Return False for "skip" and "pause".'));
  assert.match(issues.join(' '), /empty/i);
  assert.match(issues.join(' '), /missing/i);
  assert.match(issues.join(' '), /"false"/i);
  assert.doesNotMatch(issues.join(' '), /"skip"|"pause"/i);
});

test('accepts absent keys, empty strings and arbitrary spellings with explicit false meaning', () => {
  const doc = 'Returns False when the key is absent, the string has zero length, or the value is `skip`, `pause`, or `false`. Other values return True.';
  assert.deepEqual(pythonDocCoverageIssues(request, sample(doc)), []);
  assert.deepEqual(pythonDocCoverageIssues(request, sample(doc, 'options.get("badge", None)', 'if not token:\n        return False\n    return token.lower() not in ["skip", "pause", "false"]')), []);
});

test('derives whether the lookup default itself follows the false branch', () => {
  const doc = 'Disabled for a blank string or "skip", "pause" and "false".';
  assert.deepEqual(pythonDocCoverageIssues(request, sample(doc, 'options.get(config_key, "keep")')), []);
  for (const defaultValue of ['""','None','"SKIP"']) {
    assert.match(pythonDocCoverageIssues(request, sample(doc, 'options.get(config_key, '+defaultValue+')')).join(' '),/missing/i);
  }
});

test('does not credit conditions described as true or names mentioned only as the result', () => {
  const doc = 'An absent key or blank string returns True. Return False for "skip" and "pause".';
  const issues = pythonDocCoverageIssues(request, sample(doc)).join(' ');
  assert.match(issues, /missing/i); assert.match(issues, /empty/i); assert.match(issues, /"false"/i);
});

test('accepts true-unless phrasing and recognizes missing and empty independently', () => {
  const doc = 'Returns True unless the key is not provided, the string is empty, or its value is skip, pause, or false.';
  assert.deepEqual(pythonDocCoverageIssues(request, sample(doc)), []);
  const guard = 'if token is None:\n        return False\n    return token.lower() not in ("skip", "pause", "false")';
  assert.deepEqual(pythonDocCoverageIssues(request, sample('Return False for a missing key or "skip", "pause", "false".','options.get("badge")',guard)), []);
});

test('abstains from unsupported control flow and documentation requests unrelated to exhaustive false behavior', () => {
  const doc = 'A description.';
  for(const body of ['if ready():\n        return token\n    return token not in {"pause"}', 'return bool(token and arbitrary(token))', 'return token and token not in {"skip"}']) {
    assert.deepEqual(pythonDocCoverageIssues(request, sample(doc, 'options.get("badge")', body)), []);
  }
  for(const task of ['Change the log output.', 'Update the docstring example.', 'Implement all false outputs without changing documentation.', 'Cover every false input, but do not update the docstring.']) {
    assert.deepEqual(pythonDocCoverageIssues(task, sample(doc)), []);
  }
});

test('distinguishes negative English phrases and exact case-sensitive literals from named inputs', () => {
  const body = 'return bool(token and token not in {"no", "STOP"})';
  const doc = 'Return False if there is no entry, the string is empty, or the value is "stop".';
  const issues = pythonDocCoverageIssues(request, sample(doc, 'options.get("entry")', body)).join(' ');
  assert.match(issues, /"no"/); assert.match(issues, /"STOP"/);
  const correct = 'Returns False for a missing key, a blank string, "no", or "STOP". A present, non-empty string otherwise returns True.';
  assert.deepEqual(pythonDocCoverageIssues(request, sample(correct,'options.get("entry")',body)), []);
  const denied = 'An empty string does not return False. A missing key, "no" and "STOP" return False.';
  assert.match(pythonDocCoverageIssues(request, sample(denied, 'options.get("entry")',body)).join(' '),/empty/i);
});

test('keeps a reStructuredText or Markdown false-value list separate from the following wrapped prose', () => {
  const heading = 'The following labels are treated as ``False`` (ignoring case):';
  const bullets = ['skip','pause','false'].map(v=>'- ``"'+v+'"``').join('\n');
  const explanation = 'Any other non-empty string is treated as ``True``. A blank string or missing\n    configuration entry results in ``False``.';
  const valid = [heading,bullets,explanation].join('\n\n');
  assert.deepEqual(pythonDocCoverageIssues(request,sample(valid)), []);
  assert.deepEqual(pythonDocCoverageIssues(request,sample(valid.replaceAll('- ``"', '- The value is ``"'))), []);
  assert.deepEqual(pythonDocCoverageIssues(request,sample(valid.replaceAll('\n\n','\n'))), []);
  const wrongList = pythonDocCoverageIssues(request,sample(valid.replace('as ``False','as ``True'))).join(' ');
  assert.match(wrongList, /"skip"/); assert.match(wrongList, /"pause"/);
  const wrongBranch = pythonDocCoverageIssues(request,sample(valid.replace('results in ``False','results in ``True'))).join(' ');
  assert.match(wrongBranch, /empty/i); assert.match(wrongBranch, /missing/i);
  const omitted = valid.replace('A blank string or missing\n    configuration entry','A missing entry');
  assert.match(pythonDocCoverageIssues(request,sample(omitted)).join(' '), /empty/i);
});

test('follows straight-line aliases and case conversions around guarded false returns', () => {
  const source = (doc:string, lookup:string) => sample(doc,lookup,
    'saved = token\n    if not saved:\n        return False\n    folded = saved.upper()\n    again = folded\n    return again not in {"HOLD", "RETRY"}');
  const missing = pythonDocCoverageIssues(request,source('Return False for HOLD or RETRY.', 'options.get("gate")')).join(' ');
  assert.match(missing,/empty string/); assert.match(missing,/missing lookup key/);
  assert.doesNotMatch(missing,/"HOLD"|"RETRY"/);
  assert.deepEqual(pythonDocCoverageIssues(request,source('Return False for a missing key, an empty string, hold, or retry.', 'options.get("gate")')),[]);
  assert.deepEqual(pythonDocCoverageIssues(request,source('Return False for an empty string, hold, or retry.', 'options.get("gate", "go")')),[]);
});

test('an eager transform on a missing value can raise before a later guard', () => {
  const body = 'clean = token.casefold()\n    if not clean:\n        return False\n    return clean not in {"quiet"}';
  assert.deepEqual(pythonDocCoverageIssues(request,sample('Return False for an empty string or quiet.', 'options.get("gate")', body)),[]);
  assert.match(pythonDocCoverageIssues(request,sample('Return False for quiet.', 'options.get("gate")', body)).join(' '),/empty string/);
});

test('additive requests check the original contract against a rewritten body when it cannot be traced', () => {
  const original = sample('Original behavior.');
  const doc = 'Return False for skip, pause, and false.';
  const rewritten = sample(doc, 'options.get("badge")', 'return custom_parser(token)');
  const additive = 'Also treat sleeping as false. Update the docstring to list every false value.';
  const missing = pythonDocCoverageIssues(additive,rewritten,original).join(' ');
  assert.match(missing,/original implementation/i); assert.match(missing,/empty string/); assert.match(missing,/missing lookup key/);
  assert.doesNotMatch(missing,/sleeping/);
  const repaired = rewritten.replace(doc, 'Return False for an empty string, a missing key, skip, pause, false, or sleeping.');
  assert.deepEqual(pythonDocCoverageIssues(additive,repaired,original),[]);
  for(const instruction of ['Replace the previous rules with a new parser and also return false for quiet.', 'Remove the old guards, then also treat quiet as false.', 'Change the default to true, and also accept quiet as false.', 'Also update the docstring.']) {
    assert.deepEqual(pythonDocCoverageIssues(instruction+' Document every false value.',rewritten,original),[]);
  }
  assert.deepEqual(pythonDocCoverageIssues(additive,rewritten.replace('def active','def archived'),original),[]);
  assert.deepEqual(pythonDocCoverageIssues(additive,rewritten,sample('Unknown.', 'options.get("badge")','return other(token)')),[]);
});
