# Use an anonymous model with local TrueForge

OVHcloud publishes an OpenAI-compatible endpoint that accepts anonymous chat and function-calling requests. Its published anonymous rate limit is two requests per minute per IP and model. You can use it with a public project without creating a provider account or providing a billing credential. The task, retrieved excerpts, tool schemas, and subsequent tool results go to OVHcloud for inference. [Official function-calling example](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-function-calling) · [Limits](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started)

1. Start TrueForge on your own computer with the loopback configuration in the [main setup guide](../README.md#try-it-in-vs-code).
2. From the ForgeLens source checkout, run the helper below with Node.js 22.14 or later. Leave this terminal open.

   ```sh
   node scripts/ovh-anonymous-provider.mjs
   ```

3. In TrueForge **Settings → Models**, create a custom OpenAI-compatible provider named `anonymous-ovh`. Paste the printed local URL and local access token. Add the model with local name `deepseek-v4-1-flash-1017` and provider model ID `DeepSeek-V4.1-Flash-1017`. The local access token authenticates the connection between TrueForge and the helper. The helper drops the Authorization header before sending a request to OVHcloud. [Model catalogue entry](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/deepseek-v4-1-flash-1017/)
4. Set `forgelens.model` to `anonymous-ovh/deepseek-v4-1-flash-1017` in VS Code User Settings. For a multi-file review, allow enough time for several generations and the published rate limit. A 20-minute overall deadline and a 5-minute generation deadline are suitable starting settings.
5. Open the public project in a local trusted window. Choose **Run agent** for discovery tools or **Draft from context** for a batch of edits to the initially retrieved files. Each tool proposal still goes through TrueForge and VS Code review.

The helper forwards native model requests and streaming responses. It spaces requests by at least 32 seconds and honors provider rate-limit responses. Longer quota holds return to TrueForge with the retry interval. Model availability can change independently of the extension. To select another compatible anonymous model, pass the port and the exact catalogue ID as arguments when starting the helper. Stopping the helper closes the local endpoint. Each restart generates a new local access token.
