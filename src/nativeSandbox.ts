import { TrueForgeApi, type TrueForge } from '@truefoundry/trueforge-sdk';

/** The caller supplies a redirect-blocking SDK client bound to its trusted loopback endpoint. */
export async function assertLocalNativeSandbox(client: TrueForge, signal: AbortSignal): Promise<void> {
  const options = {abortSignal: signal, maxRetries: 0, timeoutInSeconds: 5};
  const {data: caps} = await client.server.getCapabilities(options);
  if (!caps.sandbox.enabled) {
    throw Error('TrueForge reports no native sandbox. Start standalone TrueForge on Linux or macOS. On Windows, run the service inside WSL2 Linux with bubblewrap, socat, ripgrep and Python 3 with venv.');
  }

  // Managed TrueFoundry can supply a platform sandbox even without a Daytona settings record.
  const {data: identity} = await client.auth.me(options);
  if (identity.type !== 'default' || !caps.settings.sandboxProviders.manageProviders) {
    throw Error('This review requires a standalone TrueForge service with its local sandbox.');
  }
  try {
    await client.settings.sandboxProviders.get(options);
  } catch (error) {
    // The standalone server uses the probed local OS backend only when this record is absent.
    if (error instanceof TrueForgeApi.NotFoundError &&
        error.body?.error?.message === 'No sandbox provider configured') return;
    throw error;
  }
  throw Error('TrueForge has a configured external sandbox provider. Use a standalone service with the built-in local sandbox for this free review.');
}
