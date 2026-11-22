# Use an anonymous model with local TrueForge

Kilo's public gateway accepts requests without a provider account for models whose IDs end in `:free`. Its published anonymous limit is 200 requests per hour per IP. The task, retrieved source excerpts, tool schemas and subsequent tool results go to the remote model provider. Use this option for public code you are authorized to send. [Authentication](https://kilo.ai/docs/gateway/authentication) · [Free model billing and limits](https://kilo.ai/docs/gateway/usage-and-billing) · [Live catalogue](https://ai-gateway.kilo.ai/api/v1/models)

1. Start local TrueForge using the loopback configuration in the [main setup guide](../README.md#try-it-in-vs-code).
2. In a second terminal, run the helper from the ForgeLens source checkout with Node.js 22.14 or later.

   ```sh
   node scripts/anonymous-model-provider.mjs
   ```

3. In TrueForge **Settings → Models**, create a custom OpenAI-compatible provider named `anonymous-kilo`. Paste the local URL and access token printed in that terminal. Add the model with local name `recursive-flint-v1-0-free` and provider model ID `recursive/flint-v1.0:free`. Set the model context to 64,000 tokens and the maximum output to 24,576. The helper uses the token only to authenticate TrueForge on your machine. It forwards no Authorization header to Kilo. [Example model configuration](../agent/model.example.json)
4. In VS Code User Settings, set `forgelens.model` to `anonymous-kilo/recursive-flint-v1-0-free`. For a multi-file review with several generations, a 20-minute overall deadline and 5-minute generation deadline are reasonable starting settings.
5. Open the public project in a trusted local window. Choose **Run agent** for discovery tools or **Draft from context** to ask for edits to the files in the initial context. Proposed changes still go through normal TrueForge and VS Code review.

The helper forwards native model requests and streaming responses, including tool calls. It pins the configured model and spaces Kilo calls by at least 18.1 seconds. For a temporary 429, it honors the retry interval. Longer quota holds return to TrueForge with the provider's wait time. To use a different free coding model, pass `kilo`, its exact `:free` catalogue ID and the local port as arguments. Restarting the helper generates a new local token.

Kilo sometimes returns an account-wide notice asking anonymous users to come back later. The helper forwards it immediately and observes the supplied retry time. If Kilo omits a reset time, the helper pauses for the published one-hour rate window. All free-model requests from the same IP share this quota. [Kilo rate limits](https://kilo.ai/docs/gateway/usage-and-billing#rate-limiting)

### OVHcloud

OVHcloud also documents anonymous function calling at two requests per minute per IP and model. For that endpoint, use `node scripts/anonymous-model-provider.mjs ovh DeepSeek-V4.1-Flash-1017 18940` and set the matching provider model ID in TrueForge. The helper spaces OVH requests by 32 seconds. In our evaluation an anonymous synthetic tool call succeeded, but the full Task B request encountered HTTP 429 with a longer provider quota hold. [Official anonymous example](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-function-calling) · [Limits](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started)
