import { createHash } from 'node:crypto';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

export const reviewSkillManifest: TrueForgeApi.GitSkill = {
  type: 'git',
  name: 'forgelens-review-checklist',
  description: 'Summarize accepted, pending and rejected changes with staged test evidence for a ForgeLens reviewer.',
  url: 'https://github.com/aceholland/forgelens',
  path: 'agent/skills/forgelens-review-checklist',
  ref: 'bcfead660104e687ec72d76b50e5bd2bd762adf8',
};

// The local TrueForge sandbox provider mounts Git skill directories under skills/.
export const reviewSkillReadCommand = `cat skills/${reviewSkillManifest.name}/SKILL.md`;
export const reviewSkillInstructions = `First use the native sandbox exec tool to run exactly: ${reviewSkillReadCommand}. Read the returned checklist, then run its bundled review script as instructed.`;
const checklistSha256 = '3827cb9abad2d3445f5a1f6579d5f70c563925ab8df95296956d1115001381da';

function matchesPin(manifest: TrueForgeApi.SkillManifest) {
  return manifest.type === 'git' && manifest.name === reviewSkillManifest.name && manifest.url === reviewSkillManifest.url &&
    manifest.path === reviewSkillManifest.path && manifest.ref === reviewSkillManifest.ref;
}

/** Register the published skill once. Preserve unrelated or independently configured skills. */
export async function prepareReviewSkill(client: TrueForge, signal?: AbortSignal): Promise<TrueForgeApi.Skill> {
  const skills = client.settings.skills;
  const options = { abortSignal: signal, timeoutInSeconds: 15, maxRetries: 0 };
  const existing = async () => (await skills.list(options)).data.find(skill => skill.name === reviewSkillManifest.name);
  let configured = await existing();
  if (!configured) {
    try {
      configured = (await skills.create({ manifest: reviewSkillManifest }, options)).data;
    } catch (error) {
      // Another VS Code window may have performed the same registration concurrently.
      if (typeof error !== 'object' || !error || !('statusCode' in error) || error.statusCode !== 409) throw error;
      configured = await existing();
    }
  }
  if (!configured || !matchesPin(configured.manifest)) {
    throw Error(`The TrueForge skill ${reviewSkillManifest.name} has a different source. Check its repository, path and revision in TrueForge Settings.`);
  }
  return { name: reviewSkillManifest.name, preload: false };
}

/** TrueForge wraps sandbox stdout in its provider's result envelope. */
export function nativeSandboxOutput(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.success === true && parsed.response?.exitCode === 0 && typeof parsed.response.result === 'string') {
      return parsed.response.result;
    }
  } catch { /* A tool error or an unrelated response is not an execution receipt. */ }
  return undefined;
}

/** Match the actual tool call, its successful response and the content of the pinned file. */
export function createReviewSkillReadTracker() {
  const pending = new Set<string>();
  let verified = false;
  return {
    observe(event: TrueForgeApi.TurnStreamingEvent) {
      if (event.type === 'model.message') {
        for (const call of event.toolCalls ?? []) {
          if (call.toolInfo.type !== 'truefoundry-system' || call.toolInfo.name !== 'exec') continue;
          try {
            const input = JSON.parse(call.function.arguments);
            if (input?.command === reviewSkillReadCommand && typeof input.intent === 'string' &&
                input.cwd === undefined && input.env === undefined) pending.add(JSON.stringify([event.threadId, call.id]));
          } catch { /* Ignore incomplete arguments in a streaming tool call. */ }
        }
      } else if (event.type === 'tool.response' && pending.delete(JSON.stringify([event.threadId, event.toolCallId]))) {
        const text = nativeSandboxOutput(event.content);
        if (text && createHash('sha256').update(text.replace(/\r\n/g, '\n').trimEnd()).digest('hex') === checklistSha256) verified = true;
      }
    },
    verified: () => verified,
  };
}
