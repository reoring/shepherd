import {
  type Api,
  createProvider,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { type ProviderStream, SharedRunLimits } from "./shared-limits.ts";

export interface LimitedModelProvider {
  model: Model<Api>;
  provider: Provider;
}

export async function createLimitedModelProvider(
  modelRuntime: ModelRuntime,
  sourceModel: Model<Api>,
  providerId: string,
  limits: SharedRunLimits,
): Promise<LimitedModelProvider> {
  const sourceProvider = modelRuntime.getProvider(sourceModel.provider);
  if (!sourceProvider) {
    throw new Error(`No upstream Pi provider is registered for ${sourceModel.provider}`);
  }

  const sourceAuth = await modelRuntime.getAuth(sourceModel, { signal: limits.signal });
  if (!sourceAuth) {
    throw new Error(`Authentication is unavailable for ${sourceModel.provider}/${sourceModel.id}`);
  }

  const model: Model<Api> = { ...sourceModel, provider: providerId };
  const upstreamStream: ProviderStream<StreamOptions> = (requestModel, context, options) =>
    sourceProvider.stream(
      { ...requestModel, provider: sourceModel.provider },
      context,
      options,
    );
  const upstreamSimpleStream: ProviderStream<SimpleStreamOptions> = (
    requestModel,
    context,
    options,
  ) =>
    sourceProvider.streamSimple(
      { ...requestModel, provider: sourceModel.provider },
      context,
      options,
    );

  const provider = createProvider({
    id: providerId,
    name: `Limited ${sourceProvider.name}`,
    auth: {
      apiKey: {
        name: `Forwarded ${sourceProvider.name} authentication`,
        check: async () => ({ source: sourceAuth.source, type: "api_key" }),
        resolve: async () => sourceAuth,
      },
    },
    models: [model],
    api: {
      stream: limits.wrapProvider(upstreamStream),
      streamSimple: limits.wrapProvider(upstreamSimpleStream),
    },
  });

  return { model, provider };
}
